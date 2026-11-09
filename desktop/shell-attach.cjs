'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// ONE DOCUMENT LOAD PER CONNECTION: the client's half of the persistent bar.
//
// Owen, 2026-11-08: "the top nav bar should always be present while logged in via e-app ... that top
// nav bar reload on each nav is so ugly and annoying".
//
// WHAT THIS DECIDES, and it is the whole of the client's new state — which instance it is attached
// to, and whether it has already loaded that instance's shell:
//
//   * the FIRST document of a connection is `${origin}/shell` when this window already holds the
//     server's PIN session cookie (a reopen, a reload after an idle lock that kept the session, a
//     return from the permission screen): ONE top-level load, and every navigation after it happens
//     inside the shell's `#shell-frame`;
//   * when there is no session yet the first document is the server's own gate (`/`), the person
//     answers the PIN, and the shell load happens ONCE, the moment the `sec_session` cookie lands —
//     still no further top-level document for any navigation;
//   * a window that is already showing the shell is never loaded again: the attach is one-shot per
//     window and per origin, so a server that answers `/shell` with its sign-in page (an expired
//     PIN session) cannot make this file load in a loop;
//   * and after the attach, a TOP-LEVEL navigation away from the shell is refused here rather than
//     followed (`topLevelAllowed`), which is the client's existing navigation policy narrowed to the
//     document it now hosts. Foreign origins were already refused and opened in the OS browser; this
//     adds the same-origin case, because a same-origin top-level load is exactly the reload Owen
//     complained about. Before the attach nothing changes, or the server's own PIN gate could not
//     hand over to the app.
//
// WHAT IT DOES NOT DO: no polling, no status, no copy of the bar. The bar inside `/shell` is the
// server document's own; this file knows one URL and one boolean.
//
// NOT IN SCOPE: the shell's routes, its ready/error protocol, its mark states — all the server's.

/**
 * THE CONNECTED DOCUMENT IS LOCAL NOW. Owen, 2026-11-09: "simply remove the top nav bar from
 * e-server, and make sure all it's code and functionality is moved to e-app." The chrome is
 * `desktop/chrome.html` — a file in `app.asar`, carrying Diana's bar and the one frame — and the
 * instance it is attached to travels in its query string, so one document serves any instance.
 */
const CHROME_FILE = path.join(__dirname, 'chrome.html');

/** The one-shot record, keyed by Electron's webContents: a WeakSet so a closed window leaves nothing. */
const tried = new WeakSet();

/** The chrome document, attached to `origin`, with the origin validated the way the rest of the
 *  app validates one. A `file://` URL: the top-level document must never be an e-server route. */
function shellURL(origin) {
  let url;
  try {
    url = new URL(String(origin));
  } catch {
    throw Error('The e-server address is not valid.');
  }
  if (!/^https?:$/.test(url.protocol)) throw Error('The e-server address must be https.');
  return pathToFileURL(CHROME_FILE).href + '?origin=' + encodeURIComponent(url.origin);
}

/** Is this document the chrome for that origin? (The only top-level document a connected window
 *  keeps.) A chrome opened for ANOTHER instance is not ours. */
function isShell(value, origin) {
  const asked = String(value || '');
  if (!asked.startsWith(pathToFileURL(CHROME_FILE).href)) return false;
  let at;
  try {
    at = new URL(String(origin)).origin;
  } catch {
    return false;
  }
  try {
    return new URL(asked).searchParams.get('origin') === at;
  } catch {
    return false;
  }
}

/**
 * Load the shell ONCE for this window, when a session exists to load it with.
 *
 * @returns {Promise<'loading'|'already'|'waiting'>} `waiting` means there is no PIN session yet: the
 *   server's own gate is the document in front of the person, and `attach` will be called again when
 *   the cookie lands.
 */
async function attach({ window, origin, cookie, load }) {
  if (!window || window.isDestroyed()) return 'waiting';
  const contents = window.webContents;
  if (!contents || contents.isDestroyed()) return 'waiting';
  // ALREADY ON THE SHELL IS ATTACHED — and it must be RECORDED, because a window that opened
  // straight onto the shell (the remembered-session path) is exactly the window whose top-level
  // navigation policy has to be narrowed. Without this line that window stayed permissive and a
  // same-origin `location.href` reloaded it: measured 2026-11-09 by the journey's policy case.
  if (isShell(safeURL(contents), origin)) {
    tried.add(contents);
    return 'already';
  }
  if (tried.has(contents)) return 'already';
  const session = await cookie();
  if (!session) return 'waiting';
  tried.add(contents);
  await load(window, shellURL(origin));
  return 'loading';
}

/**
 * The URL a connected window should load first: the shell when there is a session, else the gate.
 * A window that is GIVEN the shell here is recorded as having tried it — because it has: the load is
 * about to happen. Without this, a server that answers `/shell` with its own sign-in page would have
 * the client load `/shell` a second time from `did-finish-load` (measured 2026-11-09 by the
 * journey's expired-session case), which is a second top-level load for one connection.
 */
async function startURL({ origin, cookie, window }) {
  const session = await cookie();
  if (!session) return String(origin).replace(/\/+$/, '') + '/';
  try {
    const contents = window && !window.isDestroyed() && window.webContents;
    if (contents) tried.add(contents);
  } catch {}
  return shellURL(origin);
}

/**
 * May the CONNECTED window's main frame navigate to `url`? Before the attach the answer is the
 * existing policy's (same origin, yes). After it, only the shell itself and `about:blank`.
 */
function topLevelAllowed({ window, origin, url }) {
  if (url === 'about:blank') return true;
  let target;
  try {
    target = new URL(String(url));
  } catch {
    return false;
  }
  let at;
  try {
    at = new URL(String(origin)).origin;
  } catch {
    return false;
  }
  // THE CHROME IS A FILE, so its "origin" is not the server's: it may be navigated to itself and
  // nothing else.
  if (target.protocol === 'file:') return isShell(target.href, origin);
  if (target.origin !== at) return false;
  if (isShell(target.href, origin)) return true;
  const contents = window && !window.isDestroyed() ? window.webContents : null;
  // BEFORE THE ATTACH: the server's own PIN gate has to be able to hand over to its app.
  return !(contents && tried.has(contents));
}

function safeURL(contents) {
  try {
    return contents.getURL();
  } catch {
    return '';
  }
}

/** Test seam: forget the one-shot record (a fresh window in a journey, nothing in production). */
function reset(window) {
  try {
    if (window && !window.isDestroyed() && window.webContents) tried.delete(window.webContents);
  } catch {}
}

module.exports = { shellURL, isShell, attach, startURL, topLevelAllowed, reset };
