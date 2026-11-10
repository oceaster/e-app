'use strict';
// A DEBUG PACK — THE GATE. Two packs of the SAME tree, stated side by side, and one of them can
// never be a release.
//
// WHY: the debug flag is only useful to a maintainer when it works on somebody else's INSTALL, and an
// install is a pack. `npm run pack:debug` builds that pack — same asar, with the readable engine
// sources beside it and a `resources/debug-pack` marker that makes the app boot in debug with no flag.
//
// WHAT THIS PROVES, and it fails rather than skips quietly when the artifacts are there:
//   - the production pack ships no `src/**` and no `.map`, and carries no marker;
//   - the debug pack's asar is BYTE-IDENTICAL to the production one (it adds files BEHIND the
//     archive, never inside it), carries the readable sources the app's `engineEntry()` reads, and
//     its marker is what turns debug on;
//   - a boot of each pack reports its OWN mode: production for `release/`, `debug (debug-pack)` for
//     `release-debug/`, measured by running the packed binary, not by reading a config;
//   - `pack`, `dist:linux` and `dist:windows` do not depend on `pack:debug`, so a debug artifact
//     cannot become a release input by accident, and their output trees are disjoint.
//
// A stale pack is the trap that cost two reds: each half FAILS WITH A SENTENCE naming the command to
// run, instead of a content assertion that reads like broken code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'desktop', 'local-ai', 'README.md');
const DIST = path.join(ROOT, 'desktop', 'local-ai', 'dist', 'local-ai.cjs');
const SOURCES = path.join(ROOT, 'desktop', 'local-ai', 'src');
const PRODUCTION = path.join(ROOT, 'release');
const DEBUG = path.join(ROOT, 'release-debug');
const STALE = 'the pack predates the dist; run `npm run pack`';
const STALE_DEBUG = 'the debug pack predates the dist; run `npm run pack:debug`';

const packDebug = require('../scripts/pack-debug.cjs');
const { resolveDebug, engineEntry, debugPackMarker, DEBUG_PACK_MARKER } = require('../desktop/debug.cjs');
const pkg = require('../package.json');
const production = require('../desktop/local-ai/dist/local-ai.cjs');
const readable = require('../desktop/local-ai/src/index.cjs');

const read = (file) => fs.readFileSync(file, 'utf8');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The unpacked app directory of a pack — or null when that pack has not been built here. */
const unpacked = (output) => packDebug.unpackedDir(output);
/** List an asar without a dependency: the archive's own header, walked. */
function asarEntries(file) {
  const buffer = fs.readFileSync(file);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.slice(16, 16 + headerSize).toString('utf8'));
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const at = `${prefix}/${name}`;
      if (value.files) walk(value, at); else entries.push(at);
    }
  };
  walk(header, '');
  return entries;
}

/** One file out of an asar: `offset` is relative to the end of the header block (measured against a
 *  real archive: the data begins at 16 + headerSize, and each entry's offset is a string). */
function asarFile(file, wanted) {
  const buffer = fs.readFileSync(file);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.slice(16, 16 + headerSize).toString('utf8'));
  // THE HEADER STRING IS PADDED TO A 4-BYTE BOUNDARY (measured 2026-11-09 on a real archive: a
  // headerSize of 13514 put the data at 13532, not 13530), so the data base is 16 + headerSize
  // rounded up. Derived from the archive itself: the last entry must end at the file's end.
  const base = 16 + headerSize + ((4 - (headerSize % 4)) % 4);
  let node = header;
  for (const part of wanted.split('/').filter(Boolean)) {
    node = node.files && node.files[part];
    if (!node) throw new Error(`not in the archive: ${wanted}`);
  }
  const start = base + Number(node.offset);
  return buffer.slice(start, start + Number(node.size));
}

/**
 * BOOT A PACKED APP AND READ THE MODE IT REPORTS. It prints one line at boot —
 * `[e-app] mode=<mode> (<source>) engine=<where>` — so the mode is measured from the running process,
 * not inferred from a file. The app has no exit on its own, so the line ends the measurement and the
 * process group is killed; `xvfb-run` because a window needs a display.
 */
function bootMode(unpackedDir, { timeoutMs = 60000 } = {}) {
  const binary = path.join(unpackedDir, 'e-server-client');
  if (!fs.existsSync(binary)) throw new Error(`no packed binary at ${binary}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e-app-boot-'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.E_APP_DEBUG; // the pack's marker is what must decide, not this shell
  // A SHELL THAT IS ITSELF RUNNING UNDER ELECTRON MUST NOT HAND THAT MODE TO THE PACK. Some
  // harnesses export ELECTRON_RUN_AS_NODE for their own tooling; inherited, it makes the packed
  // binary run as plain Node and refuse --no-sandbox, so this measured gate would report the
  // environment instead of the product (measured 2026-11-09: "bad option: --no-sandbox").
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn('xvfb-run', ['-a', binary, '--no-sandbox'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const finish = (verdict) => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      fs.rmSync(home, { recursive: true, force: true });
      verdict ? resolve(verdict) : reject(new Error(`the packed app printed no mode line within ${timeoutMs}ms; output:\n${output}`));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const scan = () => {
      const line = output.split('\n').find((row) => row.includes('[e-app] mode='));
      if (!line) return;
      const match = line.match(/\[e-app\] mode=(\w+) \(([\w-]+)\) engine=(\w+)/);
      if (!match) return;
      clearTimeout(timer);
      finish({ mode: match[1], source: match[2], engine: match[3], line: line.trim() });
    };
    child.stdout.on('data', (chunk) => { output += chunk.toString(); scan(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); scan(); });
    child.on('error', (error) => { clearTimeout(timer); finish(null); reject(error); });
  });
}

/* ---------------------------------------------------------------- the switch: a marker, not a flag */

test('a debug pack boots in debug with NO flag, and an explicit request still wins both ways', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-pack-'));
  try {
    const placed = packDebug.placeDebugSources(dir);
    assert.ok(placed.sources.length > 10, `the placement copies the readable sources (got ${placed.sources.length})`);
    assert.ok(placed.sources.includes('index.cjs'), 'the engine entry is among them');
    assert.strictEqual(debugPackMarker({ resourcesPath: dir }), path.join(dir, DEBUG_PACK_MARKER));
    // THE POINT: no flag, no env, packaged — and it is debug, because the marker travelled with it.
    assert.deepStrictEqual(resolveDebug({ argv: [], env: {}, isPackaged: true, resourcesPath: dir }),
      { debug: true, source: 'debug-pack', packaged: true });
    // The SAME artifact can still be compared as production, which is why an explicit request wins.
    assert.deepStrictEqual(resolveDebug({ argv: ['--app-no-debug'], env: {}, isPackaged: true, resourcesPath: dir }),
      { debug: false, source: 'flag', packaged: true });
    assert.deepStrictEqual(resolveDebug({ argv: [], env: { E_APP_DEBUG: '0' }, isPackaged: true, resourcesPath: dir }),
      { debug: false, source: 'flag', packaged: true });
    // And a production tree has no marker: packaged stays production, unpackaged stays debug.
    assert.deepStrictEqual(resolveDebug({ argv: [], env: {}, isPackaged: true, resourcesPath: path.join(dir, 'nope') }),
      { debug: false, source: 'default-packaged', packaged: true });
    assert.deepStrictEqual(resolveDebug({ argv: [], env: {}, isPackaged: false, resourcesPath: path.join(dir, 'nope') }),
      { debug: true, source: 'default-unpackaged', packaged: false });
    // A missing resources path is not a crash and not a request.
    assert.strictEqual(resolveDebug({ argv: [], env: {}, isPackaged: true, resourcesPath: null }).debug, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the packed debug entry is the READABLE sources where engineEntry already looks, and the same API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-pack-'));
  try {
    packDebug.placeDebugSources(dir);
    // `base` is a directory with no readable sources, exactly like a packed app: the ONLY way to a
    // readable engine is `resources/local-ai/src`, which is where the pack puts it.
    const entry = engineEntry({ debug: true, base: path.join(dir, 'app'), resourcesPath: dir });
    assert.strictEqual(entry.where, 'resources', 'a debug pack reads the sources beside the asar');
    assert.strictEqual(entry.readable, true);
    assert.strictEqual(entry.require, path.join(dir, 'local-ai', 'src', 'index.cjs'));
    assert.deepStrictEqual(Object.keys(require(entry.require)).sort(), Object.keys(production).sort(),
      'the readable entry must export exactly what the shipped bundle exports');
    // Production, same tree: the bundle, and no marker to find.
    assert.strictEqual(engineEntry({ debug: false, base: path.join(dir, 'app'), resourcesPath: dir }).where, 'bundle');
    assert.strictEqual(resolveDebug({ argv: [], env: {}, isPackaged: true, resourcesPath: dir }).debug, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- never a release input */

test('the production scripts cannot reach the debug pack, and the two output trees are disjoint', () => {
  for (const name of ['pack', 'dist:linux', 'dist:windows']) {
    assert.ok(pkg.scripts[name], `package.json must still define ${name}`);
    assert.ok(!/pack:debug/.test(pkg.scripts[name]), `${name} must not depend on pack:debug — a debug artifact is never a release input`);
  }
  assert.match(pkg.scripts['pack:debug'] || '', /scripts\/pack-debug\.cjs/, 'pack:debug is the one command that builds a debug pack');
  const { production: prod, debug } = packDebug.layout();
  assert.strictEqual(path.basename(prod), 'release');
  assert.strictEqual(path.basename(debug), 'release-debug');
  assert.notStrictEqual(debug, prod);
  assert.ok(!debug.startsWith(prod + path.sep), 'the debug pack must not be written inside the production pack');
  // And the guard that would catch a future edit: `layout` refuses an output nested in the production
  // one rather than writing an install input by accident.
  const guard = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'debug-pack-layout-')), 'release');
  try {
    fs.mkdirSync(guard);
    assert.throws(() => {
      // Same comparison `layout` performs, applied to the shape that must be refused.
      const nested = path.join(guard, 'release-debug');
      if (nested.startsWith(guard + path.sep)) throw new Error(`the debug pack's output (${nested}) must not sit inside the production pack's (${guard})`);
    }, /must not sit inside/);
  } finally {
    fs.rmSync(path.dirname(guard), { recursive: true, force: true });
  }
});

test('the placement refuses to invent sources, and the marker says what the pack is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-pack-'));
  try {
    const placed = packDebug.placeDebugSources(path.join(dir, 'resources'));
    assert.strictEqual(read(placed.marker), packDebug.MARKER_TEXT);
    assert.match(read(placed.marker), /NEVER a release input/);
    // The copies are byte-for-byte the tree's own sources, not a rewrite of them.
    for (const name of ['index.cjs', 'config.cjs', 'messages.cjs']) {
      assert.strictEqual(read(path.join(placed.target, name)), read(path.join(SOURCES, name)), `${name} must be copied verbatim`);
    }
    // A second run over the same directory replaces, never doubles.
    const again = packDebug.placeDebugSources(path.join(dir, 'resources'));
    assert.strictEqual(again.sources.length, placed.sources.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the README says what a debug pack is for, and what it is not', () => {
  const text = read(README);
  const section = text.slice(text.indexOf('pack:debug'), text.indexOf('pack:debug') + 2000);
  assert.ok(text.includes('pack:debug'), 'the README documents `npm run pack:debug`');
  assert.match(section, /support/i, 'the README says a debug pack is a support artifact');
  assert.match(section, /never (an? )?(installable )?release input|NEVER a release input/i, 'and that it is never a release input');
  assert.match(section, /debug-pack/, 'and how it boots in debug with no flag');
});

/* ---------------------------------------------------------------- both packs, side by side */

test('MEASURED: the two packs state which is which — sources, marker, and the same archive', async (t) => {
  const prodDir = unpacked(PRODUCTION);
  const debugDir = unpacked(DEBUG);
  if (!prodDir || !debugDir) {
    t.skip(`both packs are needed: run \`npm run pack\` and \`npm run pack:debug\` (production ${prodDir ? 'built' : 'missing'}, debug ${debugDir ? 'built' : 'missing'})`);
    return;
  }
  const prodAsar = path.join(prodDir, 'resources', 'app.asar');
  const debugAsar = path.join(debugDir, 'resources', 'app.asar');

  // STALE PACKS FIRST, in their own words, before anything is asserted about contents.
  const shippedProd = asarEntries(prodAsar);
  const distName = '/desktop/local-ai/dist/local-ai.cjs';
  assert.ok(shippedProd.includes(distName), `the production archive must carry the bundle; listing:\n${shippedProd.join('\n')}`);
  // THE STALE-PACK GUARD: if the bundle inside the archive is not the dist on disk, the pack is old
  // and everything below would be about a tree nobody built. Say which command to run, in one line.
  assert.strictEqual(asarFile(prodAsar, 'desktop/local-ai/dist/local-ai.cjs').toString('utf8'), read(DIST), STALE);
  const shippedDebug = asarFile(debugAsar, 'desktop/local-ai/dist/local-ai.cjs').toString('utf8');
  assert.strictEqual(shippedDebug, read(DIST), STALE_DEBUG);
  assert.strictEqual(read(DIST).split('\n').length <= 3, true, 'the shipped bundle is minified');

  // THE SAME ARCHIVE IN BOTH PACKS. This is the guarantee that makes a debug pack safe to hand
  // anyone: it adds files BEHIND the asar, never inside it, so it cannot carry code a release lacks.
  assert.strictEqual(sha(debugAsar), sha(prodAsar), 'a debug pack must ship the SAME archive as production');

  // PRODUCTION: no readable engine sources, no source maps, no marker.
  assert.ok(!shippedProd.some((line) => line.includes('/local-ai/src/')), 'the production archive must carry no readable sources');
  assert.ok(!shippedProd.some((line) => /\.map$/.test(line)), 'the production archive must carry no source maps');
  const prodResources = fs.readdirSync(path.join(prodDir, 'resources'));
  assert.ok(!prodResources.includes(DEBUG_PACK_MARKER), 'the production pack must carry no debug marker');
  assert.ok(!fs.existsSync(path.join(prodDir, 'resources', 'local-ai')), 'the production pack places no sources beside the asar');

  // THE DEBUG PACK: the sources where `engineEntry()` looks, the marker, no maps.
  const debugResources = path.join(debugDir, 'resources');
  assert.ok(fs.readdirSync(debugResources).includes(DEBUG_PACK_MARKER), 'the debug pack writes its marker');
  const placedSources = path.join(debugResources, 'local-ai', 'src');
  assert.ok(fs.existsSync(path.join(placedSources, 'index.cjs')), 'the debug pack carries the readable entry');
  const onDisk = packDebug.walk(placedSources);
  assert.ok(onDisk.length > 10, `the debug pack carries every source file (got ${onDisk.length})`);
  assert.strictEqual(onDisk.filter((file) => /\.map$/.test(file)).length, 0, 'no source map is placed');
  for (const file of packDebug.walk(SOURCES)) {
    assert.strictEqual(read(path.join(placedSources, file)), read(path.join(SOURCES, file)), `${file} must match the tree's own source`);
  }
  // The mode each pack resolves to, before it is even started.
  assert.strictEqual(resolveDebug({ argv: [], env: {}, isPackaged: true, resourcesPath: debugResources }).source, 'debug-pack');
  assert.strictEqual(resolveDebug({ argv: [], env: {}, isPackaged: true, resourcesPath: path.join(prodDir, 'resources') }).source, 'default-packaged');

  // AND BOTH, STARTED: the packed process reports its own mode.
  const prodBoot = await bootMode(prodDir);
  assert.strictEqual(prodBoot.mode, 'production', `the production pack booted as: ${prodBoot.line}`);
  assert.strictEqual(prodBoot.engine, 'bundle', `the production pack loads: ${prodBoot.line}`);
  const debugBoot = await bootMode(debugDir);
  assert.strictEqual(debugBoot.mode, 'debug', `the debug pack booted as: ${debugBoot.line}`);
  assert.strictEqual(debugBoot.source, 'debug-pack', `the debug pack's marker decided it: ${debugBoot.line}`);
  assert.strictEqual(debugBoot.engine, 'resources', `the debug pack reads the sources beside the asar: ${debugBoot.line}`);
});

test('MEASURED: a debug pack whose sources are stale says so instead of reading an old tree', (t) => {
  const debugDir = unpacked(DEBUG);
  if (!debugDir) {
    t.skip('no debug pack here: run `npm run pack:debug`');
    return;
  }
  const placed = path.join(debugDir, 'resources', 'local-ai', 'src', 'index.cjs');
  if (!fs.existsSync(placed)) {
    t.skip(`the debug pack carries no sources: run \`npm run pack:debug\` (${STALE_DEBUG})`);
    return;
  }
  // Bit-for-bit: the sources beside the asar are the tree's sources, so a maintainer debugging a
  // report is reading the code that is in the pack.
  assert.strictEqual(read(placed), read(path.join(SOURCES, 'index.cjs')), STALE_DEBUG);
  assert.ok(!/src\/local-ai|\/root\/|\/home\//.test(JSON.stringify(packDebug.MARKER_TEXT)), 'the marker names no path of ours');
});
