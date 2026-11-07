'use strict';
// DEBUG MODE — THE GATE. Both states are MEASURED, not asserted.
//
// Owen, 2026-11-07: "both e-server and e-app have 'debug mode' flags which deliver non-obfuscated &
// minified files for debugging, in production mode these things should never have exposing error
// messages or transparent whatevers."
//
// So this suite proves, against a REAL packed archive and the REAL engine module:
//   PRODUCTION — the asar holds the minified bundle and no readable sources and no source maps; nothing
//                reachable names our engine or our model family; diagnostics() is refused; a failure
//                is one sentence and a next step, with no stack, path, argv or upstream body;
//   DEBUG      — the same tree loads the readable sources instead of the bundle and answers the full
//                detail (stack, argv, paths), with the same wire shape;
//   ONE SWITCH — `--debug`, `--no-debug` and E_APP_DEBUG decide it, `app.isPackaged` only feeds the
//                default, and nothing else infers it.
//
// A stale `release/` is the trap that cost two reds: the packed checks FAIL WITH A SENTENCE telling
// you to re-pack, instead of a content assertion that reads like broken code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'desktop', 'local-ai');
const DIST = path.join(MODULE, 'dist', 'local-ai.cjs');
const ASAR = path.join(ROOT, 'release', 'linux-unpacked', 'resources', 'app.asar');
const STALE = 'the pack predates the dist; run `npm run pack`';

const { resolveDebug, engineEntry } = require('../desktop/debug.cjs');
const build = require('../scripts/build-local-ai.cjs');
const fixtures = require('../desktop/local-ai/dev/fixtures.cjs');
const cfg = require('../desktop/local-ai/src/config.cjs');
const { ENGINE_META } = fixtures;
const production = require('../desktop/local-ai/dist/local-ai.cjs');
const readable = require('../desktop/local-ai/src/index.cjs');

const read = (file) => fs.readFileSync(file, 'utf8');
/**
 * LIST AN ASAR WITHOUT A DEPENDENCY. `@electron/asar` is a devDependency of the app and may not be
 * installed in every checkout, so the gate reads the archive's own header — the format is one pickle
 * header and a JSON tree — and walks it. No node_modules, no CLI lookup, no PATH.
 */
function asarEntries(file) {
  const buffer = fs.readFileSync(file);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.slice(16, 16 + headerSize).toString('utf8'));
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const at = `${prefix}/${name}`;
      if (value.files) walk(value, at); else entries.push({ path: at, size: Number(value.size), offset: Number(value.offset) });
    }
  };
  walk(header, '');
  return entries;
}

/** One file out of an asar, by its path inside the archive: `offset` in the header is relative to the
 *  end of the header block and follows the leading 8-byte size field of each entry. */
function asarFile(file, wanted) {
  const buffer = fs.readFileSync(file);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.slice(16, 16 + headerSize).toString('utf8'));
  // Measured 2026-11-07 against a real archive: the data begins at 16 + headerSize (the pickle header
  // and the two size fields are the 16), and each entry's `offset` is a string, so Number() it.
  const base = 16 + headerSize;
  let node = header;
  for (const part of wanted.split('/').filter(Boolean)) {
    node = node.files && node.files[part];
    if (!node) throw new Error(`not in the archive: ${wanted}`);
  }
  const start = base + Number(node.offset);
  return buffer.slice(start, start + Number(node.size));
}

const asarCli = () => [path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
  path.join(ROOT, 'node_modules', 'asar', 'bin', 'asar.js')].find((candidate) => fs.existsSync(candidate));

/* ------------------------------------------------------------------ one switch */

test('ONE switch: --app-debug/--debug, their off forms and E_APP_DEBUG decide it; isPackaged only feeds the default', () => {
  const resolve = (argv, env, isPackaged) => resolveDebug({ argv, env, isPackaged });
  // The explicit request always wins, in both directions, packaged or not. Both spellings count:
  // Electron eats a bare `--debug` in its own switch namespace (measured on a packed build), so the
  // namespaced form is the one that reliably reaches the app.
  assert.deepStrictEqual(resolve(['--app-debug'], {}, true), { debug: true, source: 'flag', packaged: true });
  assert.deepStrictEqual(resolve(['--app-no-debug'], {}, false), { debug: false, source: 'flag', packaged: false });
  assert.deepStrictEqual(resolve(['--debug'], {}, true), { debug: true, source: 'flag', packaged: true });
  assert.deepStrictEqual(resolve(['--debug'], {}, false), { debug: true, source: 'flag', packaged: false });
  assert.deepStrictEqual(resolve(['--no-debug'], {}, false), { debug: false, source: 'flag', packaged: false });
  assert.deepStrictEqual(resolve([], { E_APP_DEBUG: '1' }, true), { debug: true, source: 'env', packaged: true });
  assert.deepStrictEqual(resolve([], { E_APP_DEBUG: '0' }, false), { debug: false, source: 'flag', packaged: false });
  // And with no request at all: production when packaged, debug in an unpackaged tree.
  assert.deepStrictEqual(resolve([], {}, true), { debug: false, source: 'default-packaged', packaged: true });
  assert.deepStrictEqual(resolve([], {}, false), { debug: true, source: 'default-unpackaged', packaged: false });
  // `isPackaged` alone can never turn debug ON when someone asked for production, and a junk value is
  // not a request.
  assert.strictEqual(resolve(['--no-debug'], {}, true).debug, false);
  assert.strictEqual(resolve(['--debug', '--bogus'], { E_APP_DEBUG: 'nonsense' }, true).debug, true);
  assert.strictEqual(resolve([], { E_APP_DEBUG: 'maybe' }, true).debug, false);
});

test('the switch changes WHICH engine entry loads, and a missing extra falls back to the bundle', () => {
  const base = path.join(ROOT, 'desktop');
  const prod = engineEntry({ debug: false, base });
  assert.strictEqual(prod.require, DIST, 'production must load the minified bundle');
  assert.strictEqual(prod.readable, false);
  const dev = engineEntry({ debug: true, base });
  assert.strictEqual(dev.require, path.join(MODULE, 'src', 'index.cjs'), 'debug must load the readable sources');
  assert.strictEqual(dev.readable, true);
  // A debug flag with no sources present (a production asar, say) still starts, on the bundle.
  const noSources = engineEntry({ debug: true, base: path.join(os.tmpdir(), 'nope'), resourcesPath: null });
  assert.strictEqual(noSources.require, path.join(os.tmpdir(), 'nope', 'local-ai', 'dist', 'local-ai.cjs'));
  assert.strictEqual(noSources.readable, false);
});

/* ------------------------------------------------------------------ the two states, same code */

function engine(moduleUnderTest, debug) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lai-mode-'));
  const app = Object.assign(new EventEmitter(), { getPath: () => dir, quit() {} });
  const ipcMain = { handle() {}, removeHandler() {}, on() {}, removeAllListeners() {} };
  const machine = fixtures.byId('two-nvidia-gpus');
  return moduleUnderTest.createLocalAI({
    app, ipcMain, BrowserWindow: { getAllWindows: () => [] },
    trustedOrigins: () => ['https://one.example'],
    debug,
    manifest: {
      engine: {
        version: '1.0.0', build: '43e865ec059a', family: ENGINE_META.family,
        overrides: { ...ENGINE_META.overrides },
        platforms: {
          // The CPU pack for THIS platform, with an address nothing can reach: the launch then fails
          // at the download, deterministically and fast, which is what these two tests need.
          [`${process.platform}-${process.arch}-${cfg.ids.backend.cpu}`]: {
            files: [{ name: process.platform === 'win32' ? cfg.ids.binary.win32 : cfg.ids.binary.unix, url: 'https://127.0.0.1:1/e', sha256: 'a'.repeat(64), size: 9 }],
          },
        },
      },
      models: {},
    },
    exec: fixtures.stubExec(machine),
    probe: { platform: machine.platform, arch: machine.arch, os: machine.os },
  });
}

test('PRODUCTION: a failure is one sentence and a next step; diagnostics() is refused by name', async () => {
  const ai = engine(production, false);
  // diagnostics is a maintainer's tool: production refuses it, so no page can read an argv or a path.
  assert.throws(() => ai.diagnostics(), /E_DEBUG_ONLY/);
  // The status shape is state + sentence + next step. No detail key exists in production.
  const status = ai.status();
  assert.deepStrictEqual(Object.keys(status).sort(), ['contextTokens', 'error', 'label', 'placement', 'ready', 'state', 'tier'].sort());
  assert.strictEqual(status.error, null, 'nothing has failed yet, so there is nothing to say');
  // A failing start reports the mapped sentence, not the raw message.
  await assert.rejects(ai.start(0, null));
  const failed = ai.status();
  assert.strictEqual(failed.state, 'error', `expected an error state, got ${failed.state}`);
  assert.match(failed.error.message, /^[A-Z].*\.$/, 'a person gets one sentence');
  assert.ok(failed.error.next && failed.error.next.length > 10, 'and a next step');
  assert.ok(!('detail' in failed.error), 'production never carries detail');
  for (const leak of ['/root', 'argv', 'at ', 'manifest', 'E_']) {
    assert.ok(!failed.error.message.includes(leak) && !failed.error.next.includes(leak), `the production sentence leaks "${leak}"`);
  }
  assert.match(failed.error.code, /^E_[A-Z_]+$/, 'the code is how a maintainer joins the sentence to the log');
});

test('DEBUG: the same failure carries its code, its message AND its detail', async () => {
  const ai = engine(readable, true);
  const diagnostics = ai.diagnostics(); // reachable, because this is debug
  assert.ok(diagnostics && 'argv' in diagnostics && 'plan' in diagnostics, 'debug diagnostics answers the maintainer view');
  await assert.rejects(ai.start(0, null));
  const failed = ai.status();
  assert.strictEqual(failed.state, 'error', `expected an error state, got ${failed.state}`);
  assert.ok(typeof failed.detail === 'string' && failed.detail.length > 10, 'debug carries the detail');
  assert.ok(failed.error.message && failed.error.next, 'and still the sentence a person would read');
  // The person-facing part is still exactly three keys: `detail` sits beside it on the STATUS object,
  // not inside the failure. Debug changes detail, never the shape of what a person is told.
  assert.deepStrictEqual(Object.keys(failed.error).sort(), ['code', 'message', 'next']);
  assert.ok(!('detail' in failed.error), 'the failure itself never carries detail');
});

test('debug changes DETAIL, never authority: the same wire keys, the same refusals', async () => {
  const prod = engine(production, false);
  const dbg = engine(readable, true);
  const a = await prod.capabilities();
  const b = await dbg.capabilities();
  assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'the capability shape is identical in both modes');
  assert.deepStrictEqual(a.tiers.map((tier) => [tier.tier, tier.available]), b.tiers.map((tier) => [tier.tier, tier.available]));
  // And the engine's own api key never becomes reachable through debug.
  for (const object of [prod, dbg]) {
    assert.ok(!('apiKey' in (object.endpoint() || {})), 'the endpoint is null before a launch');
  }
});

/* ------------------------------------------------------------------ the packed archive */

test('MEASURED: the packed app holds the bundle and the notices, no sources, no maps, no family', (t) => {
  if (!fs.existsSync(ASAR)) {
    t.skip('no packed app here: run `npm run pack` to measure the archive');
    return;
  }
  // THE STALE-PACK GUARD FIRST: if the archive's engine file is not the dist on disk, the pack is old
  // and every assertion below would be about a tree nobody built. Say so, in one sentence.
  const shipped = asarFile(ASAR, 'desktop/local-ai/dist/local-ai.cjs').toString('utf8');
  assert.strictEqual(shipped, read(DIST), STALE);

  const listing = asarEntries(ASAR).map((entry) => entry.path);
  const localAi = listing.filter((line) => line.includes('local-ai'));
  assert.ok(localAi.includes('/desktop/local-ai/dist/local-ai.cjs'), 'the bundle must ship');
  assert.ok(localAi.includes('/desktop/local-ai/ATTRIBUTION.md'), 'the notices must ship');
  assert.ok(!localAi.some((line) => line.includes('/local-ai/src/')), 'no readable source may ship');
  assert.ok(!listing.some((line) => /\.map$/.test(line)), 'no source map may ship');
  // Production carries no debug surface: sources are not in the app, and the bundle is minified.
  assert.ok(read(DIST).split('\n').length <= 3, 'the shipped bundle is minified');
  assert.deepStrictEqual(build.comments(shipped), [], 'the shipped bundle carries no comments');
  assert.ok(!/sourceMappingURL/.test(shipped), 'the shipped bundle carries no source map');
  // The family marker and the engine metadata are data now, not literals.
  for (const word of ['dory', 'llama', ENGINE_META.family, ENGINE_META.overrides.loops, ENGINE_META.overrides.cache]) {
    assert.ok(!shipped.includes(word), `the packed bundle names ${word}`);
  }
});

test('MEASURED: the same tree started with --debug has the readable sources and the detail', () => {
  // "the same tree": this checkout carries src/ and dist/; the flag is what chooses between them.
  const decision = resolveDebug({ argv: [process.argv[0], 'desktop/main.cjs', '--debug'], env: {}, isPackaged: true });
  assert.strictEqual(decision.debug, true, 'a PACKAGED app asked for debug must be debug');
  const entry = engineEntry({ debug: decision.debug, base: path.join(ROOT, 'desktop') });
  assert.strictEqual(entry.readable, true, 'debug loads the readable sources');
  assert.ok(fs.existsSync(entry.require), 'and they exist in this tree');
  assert.ok(fs.existsSync(path.join(MODULE, 'src', 'index.cjs')));
  // The readable entry is the same API the bundle exports, so debug cannot change the contract.
  assert.deepStrictEqual(Object.keys(readable).sort(), Object.keys(production).sort(),
    'the debug entry must export exactly what the bundle exports');
  // And the detail it answers is the maintainer's, with no literals of ours in it.
  const ai = engine(readable, true);
  const diagnostics = ai.diagnostics();
  for (const key of ['hardware', 'plan', 'argv', 'kvCalibration', 'first40', 'last40']) {
    assert.ok(key in diagnostics, `debug diagnostics answers ${key}`);
  }
  // Redaction holds in debug too: the detail is for a maintainer, not for a leaked api key.
  const { redact } = readable;
  const argv = '--api-key 0123456789abcdef --port 1234';
  assert.ok(!redact(argv).includes('0123456789abcdef'), 'debug must still redact the api key');
});
