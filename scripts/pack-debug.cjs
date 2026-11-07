'use strict';
/**
 * A DEBUG PACK: the same tree, the same asar, with the readable engine sources beside it.
 *
 * WHY THIS EXISTS. The debug flag (ticket 700a9c9) is proven where it matters — a dev tree in debug,
 * a production pack in production — but a maintainer reading a bug report is looking at SOMEBODY
 * ELSE'S INSTALL, and that install is a pack. A debug pack is the same tree packed the same way, with
 * `desktop/local-ai/src/**` copied to `resources/local-ai/src` where `desktop/debug.cjs:engineEntry()`
 * already looks, plus a `resources/debug-pack` marker so the app boots in debug with no flag (a
 * person double-clicks an executable; no environment variable set in a build shell travels with it).
 *
 * IT IS NEVER A RELEASE INPUT, and that is by construction rather than by memory:
 *   - it writes to `release-debug/`, which no release script names (§ `RELEASE_SCRIPTS` below is only
 *     documentation; `tests/debug-pack.test.cjs` asserts that `pack`, `dist:linux` and `dist:windows`
 *     do not mention `pack:debug`, and that the two output trees are disjoint);
 *   - the ASAR IN A DEBUG PACK IS BYTE-IDENTICAL TO THE PRODUCTION ONE. The debug pack adds files
 *     BEHIND the archive, never inside it, so a debug pack cannot ship code a release does not have.
 *
 * THE LAYOUT IT PRODUCES (linux; the unpacked directory name differs per platform, so it is found):
 *   release-debug/linux-unpacked/resources/
 *     app.asar                    the production archive, unchanged
 *     debug-pack                  the marker `resolveDebug` reads
 *     local-ai/src/**             the readable sources `engineEntry` reads in debug
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = path.join(ROOT, 'desktop', 'local-ai', 'src');
const PRODUCTION_OUT = 'release';
const DEBUG_OUT = 'release-debug';
const MARKER = 'debug-pack';
const MARKER_TEXT = [
  'e-app debug pack',
  'readable engine sources beside the asar; boots in debug mode with no flag.',
  'NEVER a release input.',
  '',
].join('\n');

/** Every file under `dir`, relative and posix-form, so a copy can be counted and compared. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(at, name)); else out.push(name);
  }
  return out;
}

/** The one place the placement happens: sources and the marker INTO the packed `resources/` dir. */
function placeDebugSources(resourcesDir) {
  if (!fs.existsSync(SOURCES)) throw new Error(`no readable sources at ${SOURCES}; nothing to place`);
  const target = path.join(resourcesDir, 'local-ai', 'src');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(SOURCES, target, { recursive: true });
  const marker = path.join(resourcesDir, MARKER);
  fs.writeFileSync(marker, MARKER_TEXT);
  return { sources: walk(target), target, marker };
}

/** The unpacked directory electron-builder made: the one holding `resources/app.asar`. */
function unpackedDir(outputDir) {
  if (!fs.existsSync(outputDir)) return null;
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(outputDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'resources', 'app.asar'))) return candidate;
  }
  return null;
}

/** Where each pack lives, with the disjointness the whole guarantee rests on asserted before any write. */
function layout({ root = ROOT } = {}) {
  const production = path.resolve(root, PRODUCTION_OUT);
  const debug = path.resolve(root, DEBUG_OUT);
  if (debug === production || debug.startsWith(production + path.sep)) {
    throw new Error(`the debug pack's output (${debug}) must not sit inside the production pack's (${production})`);
  }
  return { production, debug };
}

function main() {
  const { debug } = layout();
  const builder = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (!fs.existsSync(builder)) {
    console.error(`[pack:debug] electron-builder is not installed (${builder}); run \`npm ci\` first.`);
    process.exit(1);
  }
  // The SAME config the production pack uses, with only the output directory moved: no build.files
  // override, no extraResources, nothing that could make this archive differ from a release's.
  const run = spawnSync(process.execPath, [builder, '--dir', `-c.directories.output=${DEBUG_OUT}`], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`[pack:debug] electron-builder failed (exit ${run.status}); no debug pack was written.`);
    process.exit(run.status || 1);
  }
  const unpacked = unpackedDir(debug);
  if (!unpacked) {
    console.error(`[pack:debug] electron-builder produced no unpacked app under ${debug}.`);
    process.exit(1);
  }
  const placed = placeDebugSources(path.join(unpacked, 'resources'));
  const asar = path.join(unpacked, 'resources', 'app.asar');
  console.log(`[pack:debug] ${path.relative(ROOT, unpacked)}: asar ${fs.statSync(asar).size} bytes, ${placed.sources.length} readable source files, marker ${path.relative(ROOT, placed.marker)}`);
  console.log('[pack:debug] a support artifact: it boots in debug mode and is NEVER a release input.');
}

module.exports = { placeDebugSources, unpackedDir, layout, walk, MARKER, MARKER_TEXT, PRODUCTION_OUT, DEBUG_OUT, SOURCES, ROOT };

if (require.main === module) main();
