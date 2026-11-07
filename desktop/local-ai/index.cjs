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

/**
 * WHAT CROSSES THE BRIDGE, AND WHAT NEVER DOES.
 *
 * A person's own hardware is theirs to read — the card in their own machine, the RAM they bought —
 * but OUR stack is not: the backend (CUDA / Vulkan / Metal / ROCm), the quant ladder, the KV layouts,
 * the loop count and the arithmetic that chose them are the design, and they are not in any shape the
 * page can read. `capabilities()` answers availability, a placement, one sentence, a context size and
 * a download size; `status()` answers state and error; everything else stays in `diagnostics()`, which
 * exists for whoever maintains this and is reachable only from the trusted page's main frame.
 */
const BACKEND_WORD = /\b(CUDA|Vulkan|Metal|ROCM)\s+/g;
const plain = (text) => String(text == null ? '' : text).replace(BACKEND_WORD, '');
const gib = (bytes) => (bytes == null ? null : Math.round((Number(bytes) / 1024 ** 3) * 10) / 10);

/** The machine as its owner may see it: their own parts, and whether each is in use. */
function publicMachine(hw) {
  return {
    platform: hw.platform,
    arch: hw.arch,
    cpu: hw.cpu.model,
    threads: hw.cpu.logical,
    ramGiB: gib(hw.ramTotal),
    ramFreeGiB: gib(hw.ramFree),
    unifiedMemory: !!hw.unifiedMemory,
    gpus: (hw.gpus || []).map((gpu) => ({
      name: gpu.name,
      totalGiB: gib(gpu.totalBytes),
      freeGiB: gpu.freeKnown ? gib(gpu.freeBytes) : null,
      presentsDisplay: !!gpu.display,
      inUse: gpu.busy ? { by: plain(gpu.busyOwner), kind: gpu.busy } : null,
    })),
    streaming: { active: !!(hw.streaming && hw.streaming.active) },
  };
}

/**
 * THE SENTENCE THE PAGE GETS IS NOT THE PLANNER'S SENTENCE. The planner's `why` explains itself to a
 * maintainer — the quant, the loops, the cache layout — and none of that reaches a person: these are
 * the tiers as a product states them, plus whatever the machine's owner needs to know about their
 * own hardware.
 */
const TIER_SENTENCE = {
  0: 'Runs on the CPU, using half of it, so the rest of this computer keeps up.',
  1: 'The light setting: a small local model in the background, at low priority.',
  2: 'The fast setting: one graphics card, full-precision conversation memory, long conversations.',
  3: 'The most capable setting this computer can hold, with the longest conversation memory.',
};

function publicWhy(plan) {
  const parts = [TIER_SENTENCE[plan.tier] || ''];
  if ((plan.displayGpus || []).length) parts.push('It also drives the display, so some of its memory is left for that.');
  const skipped = (plan.skippedGpus || [])[0];
  if (skipped) parts.push(`${plain(skipped.why)}.`.replace(/\.\.$/, '.'));
  return parts.filter(Boolean).join(' ').trim();
}

/** One rung, as the page may see it: no quant, no backend, no loop count, no estimate. */
function publicTier(plan) {
  if (!plan.ok) {
    return { tier: plan.tier, label: plan.label, available: false, reason: plain(plan.reason) };
  }
  return {
    tier: plan.tier,
    label: plan.label,
    available: true,
    placement: plain(plan.placement),
    why: publicWhy(plan),
    contextTokens: plan.ctx,
    download: plan.download,
  };
}
const merge = (base, over) => {
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
  return out;
};
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

async function loadManifest({ manifest, manifestUrl, cacheFile }) {
  if (manifest) return manifest;
  if (!manifestUrl) throw new Error('E_MANIFEST: no manifest source is configured');
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`E_MANIFEST: HTTP ${res.status}`);
    const body = await res.json();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(body));
    return body;
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { throw new Error(`E_MANIFEST: unavailable (${e.message}) and nothing cached`); }
  }
}

function createLocalAI({ app, ipcMain, BrowserWindow, config = {}, manifest, manifestUrl, trustedOrigins = [], allowInsecureHttp = false, wireIpc = true, exec, probe }) {
  // `exec` and `probe` exist for ONE reason: a test must be able to drive this whole stack (probes ->
  // planner -> tiers) against a synthetic machine, because no test in this repository may read the
  // hardware of the computer it happens to run on. `probe` carries a machine's platform/arch/os, which
  // is everything `detect` would otherwise take from the host.
  const probeHardware = () => detect({ cfg, ...(exec ? { exec } : {}), ...(probe || {}) });
  const cfg = merge(defaults, config);
  // NOTHING HERE IS NAMED FOR WHAT IT IS. A person can open their own AppData / Application Support
  // folder, so the engine's directory, cache, pidfile and log are opaque and short: `e1` is the local
  // engine, and the file names say nothing about what runs inside it. (The ticket's rule, and the
  // reason the readable sources are excluded from the packaged build.)
  const dataDir = path.join(app.getPath('userData'), 'e1');
  const data = { dir: dataDir, cacheFile: path.join(dataDir, 'c'), manifest, manifestUrl };
  const runtime = new Runtime({
    pidFile: path.join(dataDir, 'p'),
    logFile: path.join(dataDir, 'l', 'l'),
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
      }).map(publicTier);
      return { hardware: publicMachine(hw), manifest: { state: manifestState.state, reason: manifestState.reason }, tiers };
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
    /** The public status: what is running, on which rung, how much room it has — nothing else. */
    status() {
      const current = runtime.status();
      const plan = runtime.plan;
      return {
        state: current.state,
        tier: current.tier,
        label: current.label,
        ready: current.state === 'ready',
        contextTokens: plan ? plan.effectiveCtx || plan.ctx : null,
        placement: plan ? plain(plan.placement) : null,
        error: current.error,
      };
    },
    endpoint: () => (runtime.state === 'ready' ? { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey } : null),
    // DELIBERATELY FULL: hardware, the whole plan, the redacted argv, the KV calibration and 40+40 log
    // lines. It is the maintainer's view (a bug report needs it) and it is answered only to the
    // trusted page's main frame.
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
