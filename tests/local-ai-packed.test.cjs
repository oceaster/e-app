'use strict';
// THE SHIPPED ARTIFACT IS THE BUNDLE, AND THE BUNDLE IS MEASURED HERE.
//
// Owen, 2026-11-07: "obfuscate the local AI stuff as much as possible … hide as much user touchable
// code/tech/design". So the app loads ONE file (desktop/local-ai/bundle/index.cjs) built from the
// readable sources beside it, and this suite proves three things about it without trusting the build
// script's own opinion:
//
//   1. IT IS CURRENT — the shipped bytes are what the committed sources build (`--check`).
//   2. IT IS OPAQUE — no comments, no source map, no module file names, no design identifiers, and
//      nothing a person can read that names our engine, our model or our arithmetic.
//   3. IT BEHAVES LIKE THE SOURCES — the same synthetic machines produce the same tiers through the
//      bundle as through `index.cjs`, and capabilities answers the same wire shape.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'desktop', 'local-ai');
const BUNDLE = path.join(MODULE, 'bundle', 'index.cjs');
const build = require('../desktop/local-ai/build.cjs');
const fixtures = require('../desktop/local-ai/fixtures.cjs');
const cfg = require('../desktop/local-ai/config.cjs');
const { detect } = require('../desktop/local-ai/hardware.cjs');
const { planAll } = require('../desktop/local-ai/planner.cjs');
const { createLocalAI: fromSources } = require('../desktop/local-ai/index.cjs');
const { createLocalAI: fromBundle } = require('../desktop/local-ai/bundle/index.cjs');

const MODULE_FILES = ['config.cjs', 'hardware.cjs', 'planner.cjs', 'runtime.cjs', 'store.cjs', 'downloader.cjs',
  'proc.cjs', 'selftest.cjs', 'context-window.cjs', 'index.cjs', 'build.cjs', 'fixtures.cjs', 'preview.cjs',
  'preload-block.cjs', 'fake-llama-server.cjs'];
const read = (file) => fs.readFileSync(file, 'utf8');
const bundle = () => read(BUNDLE);

test('the shipped bundle is exactly what the committed sources build', () => {
  execFileSync(process.execPath, [path.join(MODULE, 'build.cjs'), '--check'], { stdio: 'pipe' });
  assert.strictEqual(bundle(), build.build(), 'bundle/index.cjs is stale: run `npm run build:local-ai`');
});

test('ONE bundle: no source maps, no comments, and nothing but required whitespace', () => {
  const text = bundle();
  assert.ok(!/sourceMappingURL|sourceURL/.test(text), 'a source map would hand the whole thing back');
  assert.ok(text.split('\n').length <= 3, `the bundle is ${text.split('\n').length} lines: not minified`);
  // Comments: the lexer's own scanner decides what a comment is (so a `//` inside a URL is never
  // counted), and the shipped file has none.
  assert.deepStrictEqual(build.comments(text), [], 'a comment survived minification');
  for (const sentence of ['a one-sentence', 'KILL_ON_JOB_CLOSE', 'sliding-window', 'the maintainer', 'Owen,']) {
    assert.ok(!text.includes(sentence), `the bundle still carries the comment text "${sentence}"`);
  }
});

test('the readable module names and the design identifiers are not in it', () => {
  const text = bundle();
  for (const file of ['planner.cjs', 'hardware.cjs', 'runtime.cjs', 'store.cjs', 'config.cjs', 'index.cjs']) {
    assert.ok(!text.includes(file), `the bundle names ${file}`);
  }
  for (const name of ['planTier', 'planAll', 'kvBytes', 'chooseQuant', 'classifyBusy', 'unifiedBudget', 'buildServerArgs',
    'detect', 'downloadVerified', 'validateManifest', 'estimateOf', 'gpuRoom', 'ramRoom', 'whySentence',
    'usableGpus', 'publicTier', 'publicMachine', 'loadManifest', 'runSelfTest']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `the bundle still declares/uses the design name ${name}`);
  }
  // The arithmetic's NAMES are mangled out of the top level; the config module's own keys survive
  // (they are read as `cfg.<key>` throughout, so renaming them would rename foreign properties too).
  // What matters is that they never reach a wire shape, which the gate below proves by reading the
  // page's answer. This assertion pins the documented limit rather than pretending it is closed.
  for (const word of ['slidingWindow', 'recurrentLayers', 'bytesPerParam']) {
    assert.ok(text.includes(word), `the config knob ${word} left the bundle: update this note if that is deliberate`);
  }
});

test('nothing a person can reach names the engine, the model or our stack', () => {
  // THE ONE THING THAT CANNOT BE RENAMED IS THE ENGINE'S OWN PROTOCOL, and it must stay exactly as
  // it is: the pinned binary's file name (the manifest ships it and the pidfile check compares it),
  // the build-family marker the manifest must declare, and the `--override-kv` keys that address the
  // model's own metadata. Those are pinned here so a future edit cannot quietly add a vendor name.
  const text = bundle();
  // Vendor TOOLS are protocol (nvidia-smi, vulkaninfo, rocm-smi, system_profiler are what we must
  // call), and the backend ids are the manifest's own pack keys; neither is our design and neither
  // reaches a person through the product. What must not be readable is the engine, the model and the
  // sentences that explain our arithmetic.
  for (const forbidden of ['llama.cpp', 'Dory', 'GGUF', 'ggml', 'quantize', 'NVIDIA GPU', 'AMD GPU',
    'does not carry the pinned', 'sliding-window-aware', 'the maintainer', 'lower-priority']) {
    assert.ok(!text.includes(forbidden), `the bundle names ${forbidden}`);
  }
  assert.ok(text.includes('llama-server'), 'the pinned binary name is the engine\'s, and the pidfile check needs it');
  assert.ok(!/override-kv[^)]*dory\.(?:num_loops|recurrent)/.test(text) === false, 'the override keys are the model\'s protocol');
  assert.ok(text.includes("'e1'"), 'the engine directory under userData must be the opaque one');
  for (const dir of ['local-ai', 'engine.log', 'manifest.json', 'engine.pid.json']) {
    assert.ok(!text.includes(dir), `a person can read the path/name ${dir}`);
  }
  // Our failures are codes, not explanations of our design.
  for (const code of ['E_ENGINE_BUILD', 'E_ENGINE_HASH', 'E_VERIFY', 'E_DOWNLOAD', 'E_PACK', 'E_MODEL', 'E_MANIFEST']) {
    assert.ok(text.includes(code), `the failure ${code} is not named`);
  }
  assert.ok(!/does not carry the pinned|not the pinned Dory/.test(text));
});

test('the capabilities wire shape the page can read carries no backend, quant or KV arithmetic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-packed-'));
  const handlers = new Map();
  const app = Object.assign(new EventEmitter(), { getPath: () => dir, quit: () => {} });
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c), on() {}, removeAllListeners() {} };
  const ai = fromBundle({
    app, ipcMain, BrowserWindow: { getAllWindows: () => [] },
    trustedOrigins: () => ['https://one.example'],
    manifest: {
      engine: {
        version: '1.0.0', llamaCommit: '43e865ec059a', features: ['dory'],
        platforms: { [`${process.platform}-${process.arch}-cuda`]: { files: [{ name: 'llama-server', url: 'https://example.invalid/e', sha256: 'a'.repeat(64), size: 9 }] } },
      },
      models: { Q8_0: { name: 'm.gguf', url: 'https://example.invalid/m', sha256: 'b'.repeat(64), size: 100 } },
    },
    exec: fixtures.stubExec(fixtures.byId('two-nvidia-gpus')),
    probe: { platform: 'win32', arch: 'x64', os: fixtures.byId('two-nvidia-gpus').os },
  });
  const snapshot = await ai.capabilities();
  assert.ok(snapshot.hardware.gpus.length === 2);
  const text = JSON.stringify(snapshot);
  for (const leak of ['"backend"', 'quant', 'kvq', 'cache', 'loops', 'estimate', 'rejectedQuants', 'skippedGpus', 'cuda', 'vulkan', 'metal', 'rocm']) {
    assert.ok(!text.includes(leak), `the wire shape exposes ${leak}`);
  }
  const available = snapshot.tiers.filter((tier) => tier.available);
  assert.ok(available.length >= 1);
  for (const tier of available) {
    assert.ok(tier.placement && tier.why && Number.isInteger(tier.contextTokens));
    assert.ok(!/CUDA|Vulkan|Metal|ROCm/.test(`${tier.placement} ${tier.why}`), 'a backend name reached the page');
  }
  // The maintainer's view still tells the whole truth.
  const diagnostics = ai.diagnostics();
  assert.ok('hardware' in diagnostics && 'plan' in diagnostics && 'argv' in diagnostics);
});

test('the bundle answers the SAME tiers as the readable sources on every synthetic machine', async () => {
  const opsOf = (machine) => ({
    manifest: {
      engine: {
        version: '1.0.0', llamaCommit: '43e865ec059a', features: ['dory'],
        platforms: { [`${process.platform}-${process.arch}-cuda`]: { files: [{ name: 'llama-server', url: 'https://example.invalid/e', sha256: 'a'.repeat(64), size: 9 }] } },
      },
      models: Object.fromEntries(Object.entries(fixtures.INVENTORY).map(([quant, entry]) => [quant,
        { name: `${quant}.gguf`, url: 'https://example.invalid/m', sha256: 'b'.repeat(64), size: entry.bytes }])),
    },
    trustedOrigins: () => ['https://one.example'],
    exec: fixtures.stubExec(machine),
    probe: { platform: machine.platform, arch: machine.arch, os: machine.os },
  });
  for (const machine of fixtures.MACHINES) {
    const options = opsOf(machine);
    const hw = await detect(fixtures.optionsFor(machine, cfg));
    const expected = planAll(hw, cfg, fixtures.INVENTORY).map((plan) => (plan.ok
      ? { ok: true, tier: plan.tier, placement: plan.placement, why: plan.why, ctx: plan.ctx, quant: plan.quant }
      : { ok: false, tier: plan.tier, reason: plan.reason }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-parity-'));
    const app = Object.assign(new EventEmitter(), { getPath: () => dir, quit: () => {} });
    const ipcMain = { handle() {}, removeHandler() {}, on() {}, removeAllListeners() {} };
    const ai = fromBundle({ app, ipcMain, BrowserWindow: { getAllWindows: () => [] }, ...options });
    const snapshot = await ai.capabilities();
    assert.strictEqual(snapshot.tiers.length, expected.length);
    snapshot.tiers.forEach((tier, index) => {
      const want = expected[index];
      assert.strictEqual(tier.tier, want.tier);
      assert.strictEqual(tier.available, want.ok, `${machine.id} tier ${tier.tier}: bundle and source disagree`);
      if (want.ok) {
        assert.strictEqual(tier.contextTokens, want.ctx, `${machine.id} tier ${tier.tier} context`);
        assert.ok(tier.placement.length > 3 && tier.why.length > 20);
      } else {
        assert.ok(tier.reason.length > 8);
      }
    });
    await ai.stop();
  }
});

test('MEASURED: a packed app carries the bundle and none of the readable sources', (t) => {
  // `npm run pack` writes this; the gate is real whenever somebody has packed, and honestly silent
  // (reported as skipped) when they have not, rather than pretending to have measured it.
  const asar = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asar)) {
    t.skip('no packed app here: run `npm run pack` to measure the archive');
    return;
  }
  // The packaged tree's own asar CLI (electron-builder dependency): no PATH guessing, no shell.
  const cli = [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
    path.join(ROOT, 'node_modules', 'asar', 'bin', 'asar.js')].find((candidate) => fs.existsSync(candidate));
  assert.ok(cli, 'no asar CLI is installed: cannot measure the archive');
  const listing = execFileSync(process.execPath, [cli, 'list', asar], { encoding: 'utf8' })
    .split('\n');
  const localAi = listing.filter((line) => line.includes('local-ai'));
  assert.ok(localAi.includes('/desktop/local-ai/bundle/index.cjs'), 'the bundle is not in the app');
  for (const file of MODULE_FILES) {
    assert.ok(!localAi.includes(`/desktop/local-ai/${file}`), `${file} shipped in the app: the readable sources leaked`);
  }
  assert.ok(!localAi.some((line) => /\.test\.cjs$|fixtures\.cjs$/.test(line)), 'a test or fixture shipped in the app');
});

test('both entry points exist and only the bundle is packaged', () => {
  assert.strictEqual(typeof fromSources, 'function');
  assert.strictEqual(typeof fromBundle, 'function');
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const files = pkg.build.files;
  assert.ok(files.includes('!desktop/local-ai/**'), 'the readable sources must be excluded from the app');
  assert.ok(files.indexOf('desktop/local-ai/bundle/**') > files.indexOf('!desktop/local-ai/**'),
    'the bundle must be re-included AFTER the exclusion, or it is not shipped either');
  assert.strictEqual(pkg.scripts['build:local-ai'], 'node desktop/local-ai/build.cjs');
});
