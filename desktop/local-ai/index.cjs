'use strict';
/**
 * index.cjs — the module the Electron main process creates: measure, plan, install, run, report.
 *
 *   const {createLocalAI} = require('./local-ai/index.cjs');
 *   const ai = createLocalAI({ app, ipcMain, BrowserWindow,
 *     manifestUrl: 'https://<server>/local-ai/manifest.json',   // or manifest: {...}
 *     trustedOrigins: () => [config.server] });                 // a FUNCTION: read live, every call
 *   await ai.recover();                                        // once at boot: adopt or kill an orphan
 *
 * THE TRUST LIST IS READ LIVE AND IT FOLLOWS THE PERSON'S SERVER. `trustedOrigins` is a function, not
 * an array, because the client switches servers at run time (`config.server` in desktop/main.cjs).
 * Every IPC call re-reads it, the preload asks about itself synchronously, and `syncTrust()` — called
 * by the host when the connected server changes — stops the engine if its owner is no longer trusted.
 * The engine also stops when its window navigates off the trusted origin, is destroyed, or the app
 * quits (and `before-quit` is prevented until the kill has actually happened: a llama-server left
 * behind holds VRAM the next launch would then be blamed for).
 *
 * NOTHING A PERSON SEES IS BUILT HERE. This is the engine and its data; the tier control and the
 * download surface are a separate piece of work with their own design.
 */
const fs = require('fs');
const path = require('path');
const defaults = require('./config.cjs');
const { detect } = require('./hardware.cjs');
const { planTier, planAll } = require('./planner.cjs');
const { Store } = require('./store.cjs');
const { Runtime } = require('./runtime.cjs');
const { runSelfTest } = require('./selftest.cjs');

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (base, over) => {
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
  return out;
};
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

async function loadManifest({ manifest, manifestUrl, cacheFile }) {
  if (manifest) return manifest;
  if (!manifestUrl) throw new Error('no manifest is configured (manifestUrl or manifest)');
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(body));
    return body;
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { throw new Error(`cannot load manifest (${e.message}) and no cached copy`); }
  }
}

function createLocalAI({ app, ipcMain, BrowserWindow, config = {}, manifest, manifestUrl, trustedOrigins = [], allowInsecureHttp = false, wireIpc = true, exec }) {
  // `exec` is the probe executor and it exists for ONE reason: a test must be able to drive this
  // whole stack (probes -> planner -> tiers) against a synthetic machine, because no test in this
  // repository may read the hardware of the computer it happens to run on.
  const probeHardware = () => detect(exec ? { cfg, exec } : { cfg });
  const cfg = merge(defaults, config);
  const dataDir = path.join(app.getPath('userData'), 'local-ai');
  const data = { dir: dataDir, cacheFile: path.join(dataDir, 'manifest.json'), manifest, manifestUrl };
  const runtime = new Runtime({
    pidFile: path.join(dataDir, 'engine.pid.json'),
    logFile: path.join(dataDir, 'logs', 'engine.log'),
    imageNames: (cfg.engine && cfg.engine.imageNames) || ['llama-server'],
    vram: () => probeHardware().then((hw) => hw.gpus),
  });
  let store = null;
  let manifestState = { state: 'unknown', reason: null };
  let lastHw = null;
  let abort = null;
  let owner = null;
  let trustOverride = null;
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };

  const broadcast = (ch, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send(ch, payload); } catch { /* closing */ }
    }
  };
  runtime.on('status', (s) => broadcast('localai:status', s));

  async function getStore() {
    if (store) return store;
    const m = await loadManifest(data);
    store = new Store({ dir: dataDir, manifest: m, allowInsecureHttp });
    store.on('progress', (p) => broadcast('localai:progress', p));
    manifestState = { state: 'ready', reason: null };
    return store;
  }

  /** The store if the manifest is readable, else null plus a NAMED state: capabilities never throws. */
  async function storeOrNull() {
    try { return await getStore(); } catch (e) { manifestState = { state: 'unavailable', reason: e.message }; return null; }
  }

  /* ---- trust: a live list, re-evaluated on every call ---- */
  const trustedList = () => {
    try {
      const value = typeof trustedOrigins === 'function' ? trustedOrigins() : trustedOrigins;
      return (trustOverride || value || []).filter(Boolean);
    } catch { return []; }
  };
  const isTrustedOrigin = (o) => !!o && trustedList().includes(o);
  const senderOk = (e) => !!e.senderFrame && e.senderFrame === e.sender.mainFrame && isTrustedOrigin(originOf(e.senderFrame.url));

  function clearOwner() { if (owner) { owner.cleanup(); owner = null; } }
  function setOwner(sender, origin) {
    clearOwner();
    if (!sender) return;
    const onNav = (_e, url) => { if (originOf(url) !== origin) api.stop(); }; // the person switched servers
    const onGone = () => api.stop();
    sender.on('did-navigate', onNav);
    sender.once('destroyed', onGone);
    sender.once('render-process-gone', onGone);
    owner = {
      origin,
      cleanup: () => {
        try {
          if (!sender.isDestroyed()) {
            sender.removeListener('did-navigate', onNav);
            sender.removeListener('destroyed', onGone);
            sender.removeListener('render-process-gone', onGone);
          }
        } catch { /* the window is already gone */ }
      },
    };
  }

  /**
   * Free VRAM already includes our own engine while it runs, so a plan computed mid-run would look
   * poorer than the machine is. Add back exactly what our process holds.
   */
  function withOwnVramBack(hw) {
    const d = runtime.diagnostics();
    if (runtime.state !== 'ready' || !d.vramBefore || !d.vramAfter) return hw;
    const used = new Map(d.vramBefore.map((b) => {
      const after = d.vramAfter.find((x) => x.index === b.index);
      return [b.index, after ? Math.max(0, (b.freeBytes || 0) - (after.freeBytes || 0)) : 0];
    }));
    return {
      ...hw,
      gpus: hw.gpus.map((g) => (used.get(g.index)
        ? { ...g, freeBytes: Math.min(g.totalBytes || Infinity, (g.freeBytes || 0) + used.get(g.index)), freeKnown: true }
        : g)),
    };
  }

  const api = {
    /** What this machine can hold. Never throws; an unreadable manifest is a named state. */
    async capabilities() {
      const storeNow = await storeOrNull();
      const hw = withOwnVramBack(await probeHardware());
      lastHw = hw;
      const inv = storeNow ? storeNow.inventory() : {};
      const tiers = planAll(hw, cfg, inv).map((plan) => {
        if (!plan.ok) return plan;
        const download = { engineBytes: null, modelBytes: (inv[plan.quant] && inv[plan.quant].bytes) || null, state: manifestState.state };
        if (storeNow) {
          try {
            const engine = storeNow.engineInfo(plan.backend);
            download.engineBytes = engine.installed ? 0 : engine.bytes;
            download.modelBytes = inv[plan.quant] && !inv[plan.quant].installed ? inv[plan.quant].bytes : 0;
            download.state = 'ready';
          } catch (e) {
            download.state = 'no-engine-pack';
            download.reason = e.message;
          }
        } else {
          download.reason = manifestState.reason;
        }
        return { ...plan, download };
      });
      return { hardware: hw, manifest: manifestState, tiers, streaming: hw.streaming };
    },

    start(tier, ctxOwner) {
      return serial(async () => {
        const storeNow = await getStore();
        await runtime.stop();                     // measure free VRAM WITHOUT our own engine
        const hw = await detect({ cfg });
        lastHw = hw;
        const plan = planTier(Number(tier), hw, cfg, storeNow.inventory());
        if (!plan.ok) throw new Error(`Tier ${tier} is not available on this computer: ${plan.reason}`);
        abort = new AbortController();
        runtime.setState('installing', { plan, error: null });
        try {
          await storeNow.ensureEngine(plan.backend, { signal: abort.signal });
          await storeNow.ensureModel(plan.quant, { signal: abort.signal });
        } catch (e) {
          runtime.setState('error', { error: e.message });
          throw e;
        }
        if (abort.signal.aborted) { runtime.setState('stopped'); return runtime.status(); }
        let engine;
        try { engine = await storeNow.verifyEngine(plan.backend); } catch (e) { runtime.setState('error', { error: e.message }); throw e; }
        if (ctxOwner) setOwner(ctxOwner.sender, ctxOwner.origin);
        // The model is ALWAYS a local path: `-m <file>` and never `-hf`, because a launch is not a download.
        return runtime.start(plan, { binaryPath: engine.exe, modelArgs: ['-m', storeNow.modelPath(plan.quant)], cfg });
      });
    },

    async stop() { clearOwner(); if (abort) abort.abort(); await runtime.stop(); },
    status: () => runtime.status(),
    endpoint: () => (runtime.state === 'ready' ? { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey } : null),
    diagnostics: () => ({
      hardware: lastHw,
      manifest: manifestState,
      engine: store ? { version: store.manifest.engine.version, commit: store.manifest.engine.llamaCommit } : null,
      ...runtime.diagnostics(),
    }),
    async selfTest() {
      const endpoint = api.endpoint();
      if (!endpoint) throw new Error('the local engine is not running');
      return runSelfTest({ ...endpoint, ctx: (runtime.plan && runtime.plan.effectiveCtx) || 8192 });
    },
    /** Replace the trusted list (a person picked another server). Stops an engine it no longer trusts. */
    setTrustedOrigins(list) { trustOverride = list; api.syncTrust(); },
    /** Re-read the live list and stop the engine if its owner is not on it any more. */
    syncTrust() {
      if (owner && !isTrustedOrigin(owner.origin)) return api.stop();
      return Promise.resolve();
    },
    recover: () => runtime.recover(cfg),
    config: cfg,
    dataDir,
  };

  /* ---- IPC: main-frame senders from a currently-trusted origin only ---- */
  if (wireIpc && ipcMain) {
    const handle = (ch, fn) => {
      try { ipcMain.removeHandler(ch); } catch { /* not registered */ }
      ipcMain.handle(ch, (e, ...a) => { if (!senderOk(e)) throw new Error('untrusted sender'); return fn(e, ...a); });
    };
    try { ipcMain.removeAllListeners('localai:isTrusted'); } catch { /* none */ }
    ipcMain.on('localai:isTrusted', (e) => { e.returnValue = senderOk(e); }); // the preload asks synchronously
    handle('localai:capabilities', () => api.capabilities());
    handle('localai:start', (e, tier) => api.start(Number(tier), { sender: e.sender, origin: originOf(e.senderFrame.url) }));
    handle('localai:stop', () => api.stop());
    handle('localai:status', () => api.status());
    handle('localai:endpoint', () => api.endpoint());
    handle('localai:diagnostics', () => api.diagnostics());
    handle('localai:selftest', () => api.selfTest());
  }

  /* ---- lifetime: never let Electron exit while llama-server still holds VRAM ---- */
  if (app && typeof app.on === 'function') {
    let shuttingDown = false;
    let shutDown = false;
    app.on('before-quit', (e) => {
      if (shutDown) return;                      // the kill is done: let every other handler finish
      e.preventDefault();
      if (shuttingDown) return;                  // a quit is already in flight; its finally re-quits
      shuttingDown = true;
      api.stop().catch(() => {}).finally(() => { shutDown = true; app.quit(); });
    });
    process.on('exit', () => runtime.killSync()); // crash / forced exit backstop (synchronous)
  }

  return api;
}

module.exports = { createLocalAI };
