'use strict';
// THE ENGINE'S LIFETIME, AGAINST A SERVER THAT MISBEHAVES ON PURPOSE.
//
// fake-llama-server.cjs can OOM, hang, die, fail to bind, go unhealthy or answer slowly, so every
// rule the runtime has is a gate rather than a hope: the half-context retry, the fresh-port retry,
// the timeout that does not repeat, the kill that actually removes the process and its pidfile, the
// orphan adopt-or-kill, and never killing a pid whose image is not ours. The fixture runs as `node`,
// which is why the image-name list here is ['node']: production passes the opaque stem ['en'].

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const path_ = require('path');
const ROOT = path_.resolve(__dirname, '..', 'desktop', 'local-ai', 'dev');
const cfg0 = require('../desktop/local-ai/src/config.cjs');
const { Runtime } = require('../desktop/local-ai/src/runtime.cjs');
const proc = require('../desktop/local-ai/src/proc.cjs');
const { runSelfTest } = require('../desktop/local-ai/src/selftest.cjs');

const cfg = { ...cfg0, server: { ...cfg0.server, startTimeoutMs: 6000, healthIntervalMs: 40 } };
const IMAGES = ['node']; // the fixture runs under node; production uses the opaque binary stem ('en')

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-'));
  // The engine is installed and killed under its ID, never its real name (config.ids.binary).
  let bin = path.join(dir, process.platform === 'win32' ? 'en.exe' : 'en');
  fs.copyFileSync(path.join(ROOT, 'fake-llama-server.cjs'), bin);
  if (process.platform === 'win32') { fs.writeFileSync(path.join(dir, 'en.cmd'), '@node "%~dp0en.exe" %*\r\n'); bin = path.join(dir, 'en.cmd'); } else fs.chmodSync(bin, 0o755);
  return { dir, bin, pidFile: path.join(dir, 'pid.json'), logFile: path.join(dir, 'engine.log') };
}
const mkPlan = (o = {}) => ({ ok: true, tier: 2, label: 't', backend: 'cuda', gpus: [0], quant: 'q2', loops: 2, cache: 'per_loop', kvq: 'f16', ctx: 8192,
  threads: 1, priority: 'normal', nkvo: false, tensorSplit: null, estimate: { kvGiB: 0.3 }, ...o });
const mkRt = (f) => new Runtime({ pidFile: f.pidFile, logFile: f.logFile, imageNames: IMAGES });
const launch = (f, env = {}, c = cfg) => ({ binaryPath: f.bin, modelArgs: ['-m', 'x.gguf'], cfg: c, env });
const np = cfg.server.parallel;

test('starts, reports the ctx the server accepted, redacts the key, parses KV size', async () => {
  const f = fixture(); const rt = mkRt(f);
  try {
    const s = await rt.start(mkPlan(), launch(f));
    assert.strictEqual(s.state, 'ready');
    assert.strictEqual(s.plan.effectiveCtx, 8192);                       // /props n_ctx = (-c)/np
    assert.strictEqual(s.plan.effectiveCtxSource, 'server /props');
    const d = rt.diagnostics();
    assert.ok(d.first40.length > 0 && d.first40.length <= 40);
    assert.ok(!JSON.stringify(d).includes(rt.apiKey), 'api key leaked in diagnostics');
    assert.ok(!fs.readFileSync(f.logFile, 'utf8').includes(rt.apiKey), 'api key leaked in log file');
    assert.match(d.argv, /--api-key \*\*\*/);
    assert.ok(d.kvCalibration.measuredMiB > 0);
  } finally { await rt.stop(); }
});

test('OOM at launch retries once at half the context', async () => {
  const f = fixture(); const rt = mkRt(f);
  try {
    const s = await rt.start(mkPlan({ ctx: 8192 }), launch(f, { FAKE_OOM_ABOVE: String(8192 * np - 1) }));
    assert.strictEqual(s.state, 'ready'); assert.strictEqual(s.plan.ctx, 4096);
    assert.strictEqual(rt.diagnostics().attempts[0].ctx, 8192);
  } finally { await rt.stop(); }
});

test('port bind race retries on a fresh port with the SAME context', async () => {
  const f = fixture(); const rt = mkRt(f);
  try {
    const s = await rt.start(mkPlan(), launch(f, { FAKE_BIND_FAIL_MARKER: path.join(f.dir, 'bound') }));
    assert.strictEqual(s.state, 'ready'); assert.strictEqual(s.plan.ctx, 8192);
    assert.strictEqual(rt.diagnostics().attempts[0].kind, 'bind');
  } finally { await rt.stop(); }
});

test('hang: times out, kills the process, does not burn a second timeout', async () => {
  const f = fixture(); const rt = mkRt(f);
  const t = Date.now();
  await assert.rejects(rt.start(mkPlan(), launch(f, { FAKE_HANG: '1' }, { ...cfg, server: { ...cfg.server, startTimeoutMs: 700 } })), /E_TIMEOUT/);
  assert.ok(Date.now() - t < 2500);
  assert.strictEqual(rt.state, 'error'); assert.strictEqual(rt.pid, null);
  assert.ok(!fs.existsSync(f.pidFile));
});

test('slow start still succeeds within the timeout', async () => {
  const f = fixture(); const rt = mkRt(f);
  try { assert.strictEqual((await rt.start(mkPlan(), launch(f, { FAKE_DELAY_MS: '600' }))).state, 'ready'); } finally { await rt.stop(); }
});

test('engine dying after ready flips state to error', async () => {
  const f = fixture(); const rt = mkRt(f);
  await rt.start(mkPlan(), launch(f, { FAKE_DIE_AFTER_MS: '500' }));
  await proc.sleep(1200);
  assert.strictEqual(rt.state, 'error'); assert.match(rt.error, /E_EXIT/);
});

test('stop() kills the process and removes the pidfile', async () => {
  const f = fixture(); const rt = mkRt(f);
  await rt.start(mkPlan(), launch(f));
  const pid = rt.pid; assert.ok(proc.isAlive(pid));
  await rt.stop();
  assert.ok(!proc.isAlive(pid)); assert.ok(!fs.existsSync(f.pidFile)); assert.strictEqual(rt.state, 'stopped');
});

test('orphan recovery: a healthy engine left by a crashed app is ADOPTED, then killable', async () => {
  const f = fixture(); const a = mkRt(f); const b = mkRt(f);
  await a.start(mkPlan(), launch(f));
  const pid = a.pid;                                  // "app crashes": a is abandoned, process lives on
  const r = await b.recover(cfg);
  assert.strictEqual(r.action, 'adopted'); assert.strictEqual(b.state, 'ready'); assert.strictEqual(b.baseUrl, a.baseUrl);
  await b.stop();
  assert.ok(!proc.isAlive(pid));
});

test('orphan recovery: an unhealthy leftover engine is KILLED (so tier 3 stops blaming a phantom game)', async () => {
  const f = fixture(); const a = mkRt(f); const b = mkRt(f);
  await a.start(mkPlan(), launch(f, { FAKE_UNHEALTHY_AFTER_MS: '700' }));
  const pid = a.pid;
  await proc.sleep(900);
  const r = await b.recover(cfg);
  assert.strictEqual(r.action, 'killed'); assert.ok(!proc.isAlive(pid)); assert.ok(!fs.existsSync(f.pidFile));
});

test('orphan recovery never kills a stranger that recycled the pid', async () => {
  const f = fixture();
  const stranger = spawn(process.platform === 'win32' ? 'ping' : 'sleep', process.platform === 'win32' ? ['-n', '30', '127.0.0.1'] : ['30'], { stdio: 'ignore' });
  try {
    proc.writePid(f.pidFile, { pid: stranger.pid, port: 1, apiKey: 'x', plan: {} });
    const rt = new Runtime({ pidFile: f.pidFile, imageNames: ['en'] });
    assert.strictEqual((await rt.recover(cfg)).action, 'pid-reused');
    assert.ok(proc.isAlive(stranger.pid)); assert.ok(!fs.existsSync(f.pidFile));
  } finally { stranger.kill(); }
});

test('real-build proofs (selftest) pass against the fixture: ctx, refusal, stream, tools, -np parallel, cache', async () => {
  const f = fixture(); const rt = mkRt(f);
  try {
    await rt.start(mkPlan(), launch(f));
    const rs = await runSelfTest({ baseUrl: rt.baseUrl, apiKey: rt.apiKey, ctx: rt.plan.effectiveCtx });
    rs.forEach((r) => assert.ok(r.pass, `${r.name}: ${r.detail}`));
    assert.strictEqual(rs.length, 6);
  } finally { await rt.stop(); }
});

test('selftest FAILS loudly when -np is 1 (a long turn would block chat)', async () => {
  const f = fixture(); const rt = mkRt(f);
  try {
    await rt.start(mkPlan(), launch(f, {}, { ...cfg, server: { ...cfg.server, parallel: 1 } }));
    const rs = await runSelfTest({ baseUrl: rt.baseUrl, apiKey: rt.apiKey, ctx: 8192 });
    assert.strictEqual(rs.find((r) => /parallel/.test(r.name)).pass, false);
  } finally { await rt.stop(); }
});
