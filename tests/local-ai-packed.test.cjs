'use strict';
// THE SHIPPED ARTIFACT IS THE DIST BUNDLE, AND THE DIST BUNDLE IS MEASURED HERE.
//
// Owen, 2026-11-07: "obfuscate the local AI stuff as much as possible … hide as much user touchable
// code/tech/design". So the layout is: desktop/local-ai/src/ (readable, reviewable, imported by these
// suites) -> scripts/build-local-ai.cjs -> desktop/local-ai/dist/local-ai.cjs (ONE minified file,
// the only thing the app loads and the only thing that ships). This suite proves four things without
// trusting the build script's own opinion:
//
//   1. THE DIST IS CURRENT — the shipped bytes are what the committed sources build (`--check`).
//   2. THE DIST IS OPAQUE — no comments, no source map, no module file names, no design identifiers,
//      no engine/model/vendor word a person can reach, opaque paths, failure codes.
//   3. IT BEHAVES LIKE THE SOURCES — the same synthetic machines produce the same tiers, and the wire
//      shape the page can read carries no arithmetic.
//   4. THE PACKED APP CONTAINS THE DIST AND THE NOTICES, NOT THE SOURCES — measured by listing the
//      real asar rather than asserted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'desktop', 'local-ai');
const SRC = path.join(MODULE, 'src');
const DEV = path.join(MODULE, 'dev');
const DIST = path.join(MODULE, 'dist', 'local-ai.cjs');
const NOTICE = path.join(MODULE, 'ATTRIBUTION.md');
const BUILD = path.join(ROOT, 'scripts', 'build-local-ai.cjs');
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');

const build = require('../scripts/build-local-ai.cjs');
const fixtures = require('../desktop/local-ai/dev/fixtures.cjs');
const { ENGINE_META } = fixtures;
const cfg = require('../desktop/local-ai/src/config.cjs');
const { detect } = require('../desktop/local-ai/src/hardware.cjs');
const { planAll } = require('../desktop/local-ai/src/planner.cjs');
const { createLocalAI: fromSources } = require('../desktop/local-ai/src/index.cjs');
const { createLocalAI: fromDist } = require('../desktop/local-ai/dist/local-ai.cjs');

const read = (file) => fs.readFileSync(file, 'utf8');
const dist = () => read(DIST);

const manifestFor = () => ({
  engine: {
    version: '1.0.0',
    build: '43e865ec059a',
    family: ENGINE_META.family, overrides: { ...ENGINE_META.overrides },
    platforms: {
      [`${process.platform}-${process.arch}-${cfg.ids.backend.cuda}`]: {
        files: [{
          name: process.platform === 'win32' ? cfg.ids.binary.win32 : cfg.ids.binary.unix,
          url: 'https://example.invalid/e', sha256: 'a'.repeat(64), size: 9,
        }],
      },
    },
  },
  models: Object.fromEntries(Object.entries(fixtures.INVENTORY).map(([quant, entry]) => [
    `${cfg.ids.model}-${quant}`,
    { name: `${cfg.ids.model}-${quant}.bin`, url: 'https://example.invalid/m', sha256: 'b'.repeat(64), size: entry.bytes },
  ])),
});

function electronStub(dir) {
  const handlers = new Map();
  const app = Object.assign(new EventEmitter(), { getPath: () => dir, quit() {} });
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    on() {}, removeAllListeners() {},
  };
  return { app, ipcMain, BrowserWindow: { getAllWindows: () => [] }, handlers };
}

test('the shipped dist is exactly what the committed sources build', () => {
  execFileSync(process.execPath, [BUILD, '--check'], { stdio: 'pipe' });
  assert.strictEqual(dist(), build.build(), 'the dist is stale: run `npm run build:local-ai`');
});

test('ONE file: no source maps, no comments, nothing but required whitespace', () => {
  const text = dist();
  assert.ok(!/sourceMappingURL|sourceURL/.test(text), 'a source map would hand the whole thing back');
  assert.ok(text.split('\n').length <= 3, `the dist is ${text.split('\n').length} lines: not minified`);
  assert.deepStrictEqual(build.comments(text), [], 'a comment survived minification');
  for (const sentence of ['a one-sentence', 'KILL_ON_JOB_CLOSE', 'sliding-window', 'the maintainer', 'Owen,']) {
    assert.ok(!text.includes(sentence), `the dist still carries the comment text "${sentence}"`);
  }
});

test('the module file names and the design identifiers are not in it', () => {
  const text = dist();
  for (const file of ['planner.cjs', 'hardware.cjs', 'runtime.cjs', 'store.cjs', 'config.cjs', 'index.cjs']) {
    assert.ok(!text.includes(file), `the dist names ${file}`);
  }
  for (const name of ['planTier', 'planAll', 'kvBytes', 'chooseQuant', 'classifyBusy', 'unifiedBudget', 'buildServerArgs',
    'detect', 'downloadVerified', 'validateManifest', 'estimateOf', 'gpuRoom', 'ramRoom', 'whySentence',
    'usableGpus', 'publicTier', 'publicMachine', 'loadManifest', 'runSelfTest']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `the dist still declares/uses the design name ${name}`);
  }
});

test('the documented limit is ONLY the vendor probe tools and the backend pack-key ids', () => {
  // TWO THINGS CANNOT MOVE, and they are pinned here with their reasons rather than left implicit:
  //   1. the vendor TOOLS a machine has to be measured with — we call them by name, so the name is in
  //      the binary by necessity: nvidia-smi, vulkaninfo, rocm-smi, system_profiler.
  //   2. the backend pack-key ids — the download must ask for the right pack, so its id crosses the
  //      wire. They are already opaque (`b0`..`b4`), never a backend word.
  //
  // WHERE THE MODEL FAMILY AND THE --override-kv KEYS WENT (they used to be literals here):
  //   the downloaded manifest, as `engine.family` and `engine.overrides.loops` / `.cache`, read at
  //   start by Store.launchData() and passed to the engine as data. The bundle no longer knows them,
  //   and a manifest that omits them is refused by name (E_MANIFEST) instead of launching with an
  //   empty override.
  const text = dist();
  for (const tool of ['nvidia-smi', 'vulkaninfo', 'rocm-smi', 'system_profiler']) {
    assert.ok(text.includes(tool), `the probe tool ${tool} is how a machine is measured: it must be callable`);
  }
  for (const code of Object.values(cfg.ids.backend)) {
    assert.ok(new RegExp(`['"\`]-${code}`).test(text) || text.includes(`'${code}'`), `the pack id ${code} must be askable`);
  }
  assert.ok(!/-(cuda|vulkan|metal|rocm)['"`]/.test(text), 'a pack key must never name a backend');

  // AND THE FAMILY IS NOT IN THE BUNDLE AT ALL: no family word, no metadata key, no default.
  for (const forbidden of ['llama', 'Llama', 'Dory', 'dory', 'Nemotron', 'GGUF', 'gguf',
    'BF16', 'Q8_0', 'Q5_K_M', 'Q4_K_M', 'quantize', ENGINE_META.family,
    ENGINE_META.overrides.loops, ENGINE_META.overrides.cache]) {
    assert.ok(!text.includes(forbidden), `the dist names ${forbidden}`);
  }
  // The flag is still there — built from variables, never from a literal key.
  assert.ok(text.includes('--override-kv'), 'the override flag itself is the engine\'s interface');
  // Opaque paths and names: this is what a person browsing their own data folder reads.
  assert.ok(text.includes("'e1'"), 'the engine directory under userData must be the opaque one');
  for (const leak of ['local-ai', 'engine.log', 'manifest.json', 'engine.pid.json', '.gguf']) {
    assert.ok(!text.includes(leak), `a person can read the path/name ${leak}`);
  }
  for (const code of ['E_ENGINE_BUILD', 'E_ENGINE_HASH', 'E_VERIFY', 'E_DOWNLOAD', 'E_PACK', 'E_MODEL', 'E_MANIFEST']) {
    assert.ok(text.includes(code), `the failure ${code} is not named`);
  }
  assert.ok(text.includes("'m1'") && text.includes("'q2'") && text.includes("'b1'"), 'the opaque ids are not in the bundle');
});

test('the wire shape the page can read carries no backend, quant or KV arithmetic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-packed-'));
  const electron = electronStub(dir);
  const machine = fixtures.byId('two-nvidia-gpus');
  const ai = fromDist({
    app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow,
    trustedOrigins: () => ['https://one.example'],
    manifest: manifestFor(),
    exec: fixtures.stubExec(machine),
    probe: { platform: machine.platform, arch: machine.arch, os: machine.os },
  });
  const snapshot = await ai.capabilities();
  assert.strictEqual(snapshot.hardware.gpus.length, 2);
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
  const diagnostics = ai.diagnostics();
  for (const key of ['hardware', 'plan', 'argv']) assert.ok(key in diagnostics, `diagnostics lost ${key}`);
});

test('the dist answers the SAME tiers as the sources on every synthetic machine', async () => {
  for (const machine of fixtures.MACHINES) {
    const hw = await detect(fixtures.optionsFor(machine, cfg));
    const expected = planAll(hw, cfg, fixtures.INVENTORY).map((plan) => (plan.ok
      ? { ok: true, tier: plan.tier, ctx: plan.ctx }
      : { ok: false, tier: plan.tier, reason: plan.reason }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-parity-'));
    const electron = electronStub(dir);
    const ai = fromDist({
      app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.BrowserWindow,
      trustedOrigins: () => ['https://one.example'],
      manifest: manifestFor(),
      exec: fixtures.stubExec(machine),
      probe: { platform: machine.platform, arch: machine.arch, os: machine.os },
    });
    const snapshot = await ai.capabilities();
    assert.strictEqual(snapshot.tiers.length, expected.length);
    snapshot.tiers.forEach((tier, index) => {
      const want = expected[index];
      assert.strictEqual(tier.tier, want.tier);
      assert.strictEqual(tier.available, want.ok, `${machine.id} tier ${tier.tier}: dist and source disagree`);
      if (want.ok) assert.strictEqual(tier.contextTokens, want.ctx, `${machine.id} tier ${tier.tier} context`);
      else assert.ok(tier.reason.length > 8);
    });
    await ai.stop();
  }
});

test('the app loads the dist; the build runs from npm scripts before every pack', () => {
  const main = read(path.join(ROOT, 'desktop', 'main.cjs'));
  assert.match(main, /require\('\.\/local-ai\/dist\/local-ai\.cjs'\)/, 'the app must load the dist bundle, not the sources');
  assert.strictEqual(typeof fromSources, 'function');
  assert.strictEqual(typeof fromDist, 'function');
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.strictEqual(pkg.scripts['build:local-ai'], 'node scripts/build-local-ai.cjs');
  for (const script of ['pack', 'dist:linux', 'dist:windows']) {
    assert.match(pkg.scripts[script], /^npm run build:local-ai && /, `${script} must rebuild the dist first`);
  }
  const files = pkg.build.files;
  assert.ok(files.includes('!desktop/local-ai/src/**'), 'the readable sources must be excluded from the app');
  assert.ok(files.indexOf('desktop/local-ai/dist/**') > files.indexOf('!desktop/local-ai/**'),
    'the dist must be re-included AFTER the exclusion, or it is not shipped either');
  assert.ok(files.includes('desktop/local-ai/ATTRIBUTION.md'), 'the licence notices must ship');
});

test('the notices the licences require are present and readable', () => {
  const notice = read(NOTICE);
  assert.match(notice, /OpenMDW-1\.1/, 'the model licence must be named');
  assert.match(notice, /licence/i);
  assert.match(notice, /not modified|byte for byte/i, 'the engine licence must stay unmodified beside the binary');
  assert.ok(notice.split('\n').length > 10, 'a notice nobody can read is not a notice');
  assert.ok(!/obfuscated|minified/i.test(notice.split('## Third-party components')[0].replace(/no licence notice is\nobfuscated, minified or moved/gi, '')),
    'the notice must not claim to be hidden');
});

test('MEASURED: the packed app carries the dist and the notices, and none of the sources', (t) => {
  if (!fs.existsSync(ASAR)) {
    t.skip('no packed app here: run `npm run pack` to measure the archive');
    return;
  }
  const cli = [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
    path.join(ROOT, 'node_modules', 'asar', 'bin', 'asar.js')].find((candidate) => fs.existsSync(candidate));
  assert.ok(cli, 'no asar CLI is installed: cannot measure the archive');
  const listing = execFileSync(process.execPath, [cli, 'list', ASAR], { encoding: 'utf8' }).split('\n');
  const localAi = listing.filter((line) => line.includes('local-ai'));
  assert.ok(localAi.includes('/desktop/local-ai/dist/local-ai.cjs'), 'the dist bundle is not in the app');
  assert.ok(localAi.includes('/desktop/local-ai/ATTRIBUTION.md'), 'the licence notices are not in the app');
  for (const name of fs.readdirSync(SRC)) {
    assert.ok(!localAi.includes(`/desktop/local-ai/src/${name}`), `${name} shipped in the app: the readable sources leaked`);
  }
  for (const name of fs.readdirSync(DEV)) {
    assert.ok(!localAi.some((line) => line.endsWith(`/dev/${name}`)), `${name} shipped in the app: a dev tool leaked`);
  }
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-asar-'));
  execFileSync(process.execPath, [cli, 'extract-file', ASAR, 'desktop/local-ai/dist/local-ai.cjs'], { cwd: extracted, stdio: 'pipe' });
  const files = fs.readdirSync(extracted);
  assert.strictEqual(files.length, 1, 'the archive extraction produced more than the one dist file');
  const shipped = read(path.join(extracted, files[0]));
  assert.deepStrictEqual(build.comments(shipped), [], 'the shipped file carries comments');
  assert.strictEqual(shipped, dist(), 'the shipped file is not the committed dist');
  // THE MEASUREMENT THE TICKET ASKS FOR: grep the dist that a copier would actually get, out of the
  // archive they can open, for the model family marker and the metadata keys. Nothing.
  for (const marker of [ENGINE_META.family, ENGINE_META.overrides.loops, ENGINE_META.overrides.cache, 'dory']) {
    if (!marker) continue;
    assert.ok(!shipped.includes(marker), `the packed dist still names ${marker}`);
  }
});
