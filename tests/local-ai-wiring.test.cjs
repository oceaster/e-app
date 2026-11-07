'use strict';
// WIRED INTO THE APP, NOT VENDORED BESIDE IT.
//
// desktop/main.cjs and desktop/preload.cjs cannot be executed by a unit test (they only run inside
// Electron), so this suite does two things a static check cannot: it DRIVES createLocalAI with fake
// app / ipcMain / BrowserWindow objects through a synthetic machine, and it pins the shape of the
// two files the app actually loads — the preload bridge is one self-contained block requiring only
// 'electron', the trust list is read LIVE, and the engine stops on a server switch, a window going
// away, and a quit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'desktop', 'local-ai');
const { createLocalAI } = require('../desktop/local-ai/index.cjs');
const fixtures = require('../desktop/local-ai/fixtures.cjs');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ------------------------------------------------------------------ a fake Electron */

function fakeElectron({ userData }) {
  const handlers = new Map();
  const listeners = new Map();
  const app = new EventEmitter();
  app.getPath = () => userData;
  app.quitCalls = 0;
  app.quit = () => { app.quitCalls += 1; app.emit('before-quit', { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }); };
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  ipcMain.on = (channel, fn) => { const list = listeners.get(channel) || []; list.push(fn); listeners.set(channel, list); return ipcMain; };
  ipcMain.removeAllListeners = (channel) => { listeners.delete(channel); return ipcMain; };
  const BrowserWindow = { getAllWindows: () => [] };
  return { app, ipcMain, BrowserWindow, handlers, listeners };
}

/** A frame the main process would consider: spec-compliant enough for `senderFrame === mainFrame`. */
const frame = (url) => ({ url });
function event(origin) {
  const main = frame(`${origin}/chat`);
  return { senderFrame: main, sender: { mainFrame: main, isDestroyed: () => false, on() {}, once() {}, removeListener() {} } };
}

const MACHINE = fixtures.byId('two-nvidia-gpus');

/** The message a call refuses with, whether it threw synchronously or rejected. */
async function refusal(fn) {
  try { await fn(); } catch (error) { return error.message; }
  return '';
}
const options = (dir, extra = {}) => ({
  config: {},
  manifest: {
    engine: {
      version: '1.0.0', llamaCommit: '43e865ec059a', features: ['dory'],
      platforms: { [`${process.platform}-${process.arch}-cuda`]: { files: [{ name: 'llama-server', url: 'https://example.invalid/llama-server', sha256: 'a'.repeat(64), size: 10 }] } },
    },
    models: { Q8_0: { name: 'dory-Q8_0.gguf', url: 'https://example.invalid/m.gguf', sha256: 'b'.repeat(64), size: 1000 } },
  },
  wireIpc: true,
  exec: fixtures.stubExec(MACHINE),
  ...extra,
});

/* ------------------------------------------------------------------ the live trust surface */

test('the bridge answers ONLY a main frame on a currently trusted origin, read live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-wire-'));
  let server = 'https://one.example';
  const electron = fakeElectron({ userData: dir });
  createLocalAI({ app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow, trustedOrigins: () => [server], ...options(dir) });

  const status = electron.handlers.get('localai:status');
  assert.ok(status, 'the status channel is registered');

  const allowed = await status(event(server));
  assert.strictEqual(allowed.state, 'stopped');

  // The person switches servers: the SAME handler now refuses the old origin, with no restart.
  server = 'https://two.example';
  assert.match(await refusal(() => status(event('https://one.example'))), /untrusted sender/);
  await status(event('https://two.example'));

  // A sub-frame is never trusted, whatever its origin.
  const main = frame(`${server}/chat`);
  const sub = { senderFrame: frame(`${server}/child`), sender: { mainFrame: main, isDestroyed: () => false, on() {}, once() {}, removeEventListener() {}, removeListener() {} } };
  assert.match(await refusal(() => status(sub)), /untrusted sender/);

  // The preload's synchronous question answers the same way.
  const trust = electron.listeners.get('localai:isTrusted')[0];
  const answer = (url) => { const e = event(url); trust(e); return e.returnValue; };
  assert.strictEqual(answer(server), true);
  assert.strictEqual(answer('https://one.example'), false);
  assert.strictEqual(answer('file:///tmp/x.html'), false);
});

test('capabilities on a synthetic machine reaches the planner: tiers carry placement, why and downloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-wire-'));
  const electron = fakeElectron({ userData: dir });
  const ai = createLocalAI({ app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow, trustedOrigins: () => ['https://one.example'], ...options(dir) });
  const snapshot = await ai.capabilities();
  assert.strictEqual(snapshot.hardware.gpus.length, 2, 'the fake machine had two cards');
  assert.strictEqual(snapshot.manifest.state, 'ready');
  for (const tier of snapshot.tiers) {
    if (tier.ok) {
      assert.ok(tier.placement && tier.why, `tier ${tier.tier} lost its placement or why on the way out`);
      assert.ok(tier.download && tier.download.state === 'ready');
      assert.ok(Number.isInteger(tier.download.engineBytes) && Number.isInteger(tier.download.modelBytes));
    } else {
      assert.ok(tier.reason);
    }
  }
  // The manifest is loadable but nothing is installed: the engine download is the whole pack.
  const flash = snapshot.tiers.find((t) => t.tier === 2);
  assert.strictEqual(flash.ok, true, flash.reason);
  assert.ok(flash.download.engineBytes > 0);
});

test('a manifest that cannot be read is a NAMED state, not a thrown capabilities()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-wire-'));
  const electron = fakeElectron({ userData: dir });
  const ai = createLocalAI({ app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow, trustedOrigins: () => ['https://one.example'], config: {}, exec: fixtures.stubExec(MACHINE) });
  const snapshot = await ai.capabilities();
  assert.strictEqual(snapshot.manifest.state, 'unavailable');
  assert.match(snapshot.manifest.reason, /no manifest is configured/);
  assert.ok(snapshot.tiers.every((t) => typeof t.ok === 'boolean'));
  // Sizes are ESTIMATED from the model's parameter count when there is no manifest to read.
  const plan = snapshot.tiers.find((t) => t.ok);
  assert.ok(plan.estimate.weightsGiB > 0);
});

/* ------------------------------------------------------------------ lifetime */

test('quit is PREVENTED until the engine is gone, and then allowed through once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-wire-'));
  const electron = fakeElectron({ userData: dir });
  createLocalAI({ app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow, trustedOrigins: () => [], ...options(dir) });

  const first = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  electron.app.emit('before-quit', first);
  assert.strictEqual(first.defaultPrevented, true, 'the first quit must be prevented so the kill can finish');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(electron.app.quitCalls, 1, 'quit is attempted after the engine stopped');

  const later = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  electron.app.emit('before-quit', later);
  assert.strictEqual(later.defaultPrevented, false, 'a quit after the kill must not be blocked again');
});

test('an engine started under a trusted origin stops when that window navigates away, on destroy, and on a server switch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-live-'));
  const http = require('node:http');
  const crypto = require('node:crypto');
  // A REAL start: the fake engine and a model are served over loopback and installed into userData,
  // so this exercises download -> verify -> spawn -> /health -> ready, and then the three lifetime
  // rules the ticket names. It costs about a second and proves the wiring end to end.
  const files = {
    'llama-server': fs.readFileSync(path.join(MODULE, 'fake-llama-server.cjs')),
    'dory-Q4_K_M.gguf': crypto.randomBytes(4096),
  };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const srv = http.createServer((req, res) => {
    const buf = files[req.url.slice(1)];
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Length': buf.length });
    return res.end(buf);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sha256 = '43e865ec059a'.padEnd(64, '0').slice(0, 64);
  const manifest = {
    engine: {
      version: '1.0.0', llamaCommit: '43e865ec059a', features: ['dory'],
      platforms: { [`${process.platform}-${process.arch}-cuda`]: { files: [{ name: 'llama-server', url: `${base}/llama-server`, sha256: sha(files['llama-server']), size: files['llama-server'].length }] } },
    },
    models: { Q4_K_M: { name: 'dory-Q4_K_M.gguf', url: `${base}/dory-Q4_K_M.gguf`, sha256: sha(files['dory-Q4_K_M.gguf']), size: files['dory-Q4_K_M.gguf'].length } },
  };
  let server = 'https://one.example';
  const electron = fakeElectron({ userData: dir });
  const ai = createLocalAI({
    app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow,
    trustedOrigins: () => [server, 'https://two.example'], allowInsecureHttp: true, manifest,
    config: { quant: { cpu: ['Q4_K_M'], t1: ['Q4_K_M'] }, server: { healthIntervalMs: 50 } },
    exec: fixtures.stubExec(fixtures.byId('no-gpu')),
  });
  const sender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });
  try {
    const window = sender();
    const started = await ai.start(0, { sender: window, origin: 'https://one.example' });
    assert.strictEqual(started.state, 'ready', `the engine did not start: ${started.error}`);
    assert.ok(ai.endpoint() && ai.endpoint().baseUrl.startsWith('http://127.0.0.1:'), 'a ready engine publishes its endpoint');

    // 1. the window navigated to another origin: the engine is not that window's any more.
    window.emit('did-navigate', {}, 'https://elsewhere.example/');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(ai.status().state, 'stopped', 'navigating away from the trusted origin must stop the engine');

    // 2. the window went away.
    const second = sender();
    await ai.start(0, { sender: second, origin: 'https://one.example' });
    assert.strictEqual(ai.status().state, 'ready');
    second.emit('destroyed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(ai.status().state, 'stopped', 'a destroyed window must stop the engine');

    // 3. the person switched server: the live trust list no longer holds the engine's origin.
    const third = sender();
    await ai.start(0, { sender: third, origin: 'https://one.example' });
    assert.strictEqual(ai.status().state, 'ready');
    server = 'https://three.example';
    await ai.syncTrust();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(ai.status().state, 'stopped', 'a server switch must retire the engine of the old origin');
    assert.strictEqual(ai.endpoint(), null);
  } finally {
    await ai.stop();
    srv.close();
  }
});

/* ------------------------------------------------------------------ the two files Electron loads */

test('main.cjs creates the engine with a LIVE trust list and adopts an orphan at boot', () => {
  const main = read('desktop/main.cjs');
  assert.match(main, /const \{createLocalAI\}=require\('\.\/local-ai\/index\.cjs'\)/);
  assert.match(main, /localAI=createLocalAI\(\{app,ipcMain,BrowserWindow,trustedOrigins:\(\)=>\[config\.server\]\.filter\(Boolean\)\}\)/,
    'trustedOrigins must be a FUNCTION reading config.server, not a snapshot of it');
  assert.match(main, /await localAI\.recover\(\)/, 'a crash may leave an engine holding VRAM: adopt or kill it at boot');
  assert.match(main, /localAI\?\.syncTrust\(\)/, 'switching servers must retire the engine of the old one');
});

test('the preload bridge is ONE self-contained block: only electron, no relative require', () => {
  const preload = read('desktop/preload.cjs');
  const vendored = fs.readFileSync(path.join(MODULE, 'preload-block.cjs'), 'utf8');
  assert.ok(preload.includes(vendored.trim()), 'the block shipped in preload.cjs is not the block the module documents');
  assert.ok(!/require\(['"]\.{1,2}\//.test(preload), 'a sandboxed preload cannot resolve a relative require');
  const requires = [...preload.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(requires)], ['electron'], `preload requires ${requires.join(', ')}`);
  assert.match(vendored, /contextBridge\.exposeInMainWorld\('localAI'/);
  assert.match(vendored, /if \(!trusted\) return;/, 'an untrusted document must get nothing at all');
  assert.match(vendored, /sendSync\('localai:isTrusted'\)/, 'trust is asked of main, never assumed from the URL');
  // Both files must PARSE: a claimed gate is not a run.
  for (const file of ['desktop/main.cjs', 'desktop/preload.cjs']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  }
});

test('the module ships no UI of its own, and the app gained no window or page', () => {
  const files = fs.readdirSync(MODULE);
  for (const name of files) {
    assert.ok(!/\.(html?|css|mjs|jsx|tsx|svg|png)$/i.test(name), `${name} is a user-visible asset in the engine module`);
  }
  const main = read('desktop/main.cjs');
  const created = (main.match(/new BrowserWindow\(/g) || []).length;
  assert.strictEqual(created, 3, `main.cjs creates ${created} windows; the engine must not add one`);
  assert.ok(!/localAI.*BrowserWindow/.test(main.replace(/localAI=createLocalAI\(\{[^}]*\}\)/, '')));
  const block = fs.readFileSync(path.join(MODULE, 'preload-block.cjs'), 'utf8');
  assert.ok(!/document\.|createElement|appendChild|insertAdjacentHTML/.test(block), 'the bridge must paint nothing');
});

test('the model is ALWAYS a local path: -m, never -hf, anywhere in the module', () => {
  for (const name of fs.readdirSync(MODULE).filter((n) => n.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(MODULE, name), 'utf8');
    const live = source.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/'(-hf|--hf)'/.test(live), `${name} can pass -hf to the engine`);
  }
  assert.match(read('desktop/local-ai/index.cjs'), /modelArgs: \['-m', storeNow\.modelPath\(plan\.quant\)\]/);
});

test('the app test entry reaches these suites', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.scripts.test, 'node --test tests/*.test.cjs');
  for (const suite of ['local-ai-planner', 'local-ai-hardware', 'local-ai-matrix', 'local-ai-store', 'local-ai-runtime', 'local-ai-wiring']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', `${suite}.test.cjs`)), `tests/${suite}.test.cjs is missing`);
  }
});
