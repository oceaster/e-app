'use strict';
/**
 * THE ONE DEBUG SWITCH — and the rule that production never exposes detail.
 *
 * Owen, 2026-11-07: "make sure both e-server and e-app have 'debug mode' flags which deliver
 * non-obfuscated & minified files for debugging, in production mode these things should never have
 * exposing error messages or transparent whatevers."
 *
 * ONE SWITCH, RESOLVED ONCE AT BOOT (`resolveDebug`), in this order:
 *   1. `--debug` on the command line, or `E_APP_DEBUG=1`            -> debug ON
 *   2. `--no-debug`, or `E_APP_DEBUG=0`                            -> debug OFF
 *   3. otherwise the DEFAULT: production when the app is packaged, debug in an unpackaged dev tree
 *
 * `app.isPackaged` STAYS A SEPARATE FACT. It only feeds that default. A person running a PACKAGED
 * build with `--debug` gets debug behaviour, and a packaged release without the flag can never get it.
 *
 * WHAT DEBUG CHANGES, and only this: DETAIL.
 *   - the readable engine sources are used instead of the minified bundle (see `engineEntry`);
 *   - a failure carries its code, message and stack, and the local engine answers `diagnostics()`;
 *   - log lines keep the full text.
 * It never changes AUTHORITY: no new permission, no secret becomes readable (the engine redacts its
 * own api key), and the shape of what the page receives does not change — only whether a `detail`
 * field is filled in.
 *
 * The failure rule (one sentence and a next step in production, full detail in debug) lives in the
 * engine bundle — desktop/local-ai/src/messages.cjs — because the engine is where the failures are
 * born. This file only decides WHICH mode we are in and WHICH engine entry that implies.
 */
const path = require('node:path');
const fs = require('node:fs');

const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off']);

/**
 * TWO SPELLINGS, and the reason: Electron OWNS `--debug` in its own Chromium/node switch namespace.
 * Measured 2026-11-07 on a packed build: `e-server-client --debug` printed node's "`node --debug` ...
 * is invalid" notice and never reached the app's own argv, so the app could not see its own flag. The
 * namespaced `--app-debug` / `--app-no-debug` therefore do the work, and the plain spelling is still
 * honoured when it does arrive (a dev tree, or `electron . -- --debug`).
 */
const ON_FLAGS = ['--app-debug', '--debug'];
const OFF_FLAGS = ['--app-no-debug', '--no-debug'];

/** The explicit request, if the command line or the environment makes one; otherwise null. */
function explicit({ argv = [], env = {} } = {}) {
  const args = (argv || []).map(String);
  if (args.some((arg) => ON_FLAGS.includes(arg))) return true;
  if (args.some((arg) => OFF_FLAGS.includes(arg))) return false;
  const raw = String(env.E_APP_DEBUG == null ? '' : env.E_APP_DEBUG).trim().toLowerCase();
  if (ON.has(raw)) return true;
  if (OFF.has(raw)) return false;
  return null;
}

/**
 * THE decision. Called once, at boot, with the three facts it needs — nothing may re-derive it.
 * @returns {{debug: boolean, source: 'flag'|'env'|'default-packaged'|'default-unpackaged', packaged: boolean}}
 */
function resolveDebug({ argv = process.argv, env = process.env, isPackaged = false } = {}) {
  const wanted = explicit({ argv, env });
  if (wanted === true) {
    const byFlag = (argv || []).map(String).some((arg) => ON_FLAGS.includes(arg));
    return { debug: true, source: byFlag ? 'flag' : 'env', packaged: !!isPackaged };
  }
  if (wanted === false) return { debug: false, source: 'flag', packaged: !!isPackaged };
  return {
    debug: !isPackaged,
    source: isPackaged ? 'default-packaged' : 'default-unpackaged',
    packaged: !!isPackaged,
  };
}

/**
 * WHICH ENGINE ENTRY THE APP LOADS.
 * Production: the one minified file built by `scripts/build-local-ai.cjs` and shipped in the asar.
 * Debug: the READABLE sources — from the app tree, or from `resources/local-ai/src` when this is a
 * debug pack (`npm run pack:debug` copies them beside the asar). If the sources are not there, debug
 * falls back to the bundle rather than failing to start: a missing extra is not a reason to refuse.
 */
function engineEntry({ debug = false, base = __dirname, resourcesPath = process.resourcesPath } = {}) {
  const dist = path.join(base, 'local-ai', 'dist', 'local-ai.cjs');
  const src = path.join(base, 'local-ai', 'src', 'index.cjs');
  const packed = resourcesPath ? path.join(resourcesPath, 'local-ai', 'src', 'index.cjs') : null;
  if (debug) {
    if (fs.existsSync(src)) return { require: src, readable: true, where: 'app' };
    if (packed && fs.existsSync(packed)) return { require: packed, readable: true, where: 'resources' };
  }
  return { require: dist, readable: false, where: 'bundle' };
}

module.exports = { resolveDebug, explicit, engineEntry };
