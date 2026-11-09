'use strict';
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

/** The connected document. Frozen contract with ticket f1bdcd46: bar in `#shell-bar`, content in
 *  `<iframe id="shell-frame">`, same-origin, `?route=<registry key>` optional as a deep link. */
const SHELL_PATH = '/shell';

/** The one-shot record, keyed by Electron's webContents: a WeakSet so a closed window leaves nothing. */
const tried = new WeakSet();

/** `${origin}/shell`, with the origin validated the way the rest of the app validates one. */
function shellURL(origin) {
  let url;
  try {
    url = new URL(String(origin));
  } catch {
    throw Error('The e-server address is not valid.');
  }
  if (!/^https?:$/.test(url.protocol)) throw Error('The e-server address must be https.');
  return url.origin + SHELL_PATH;
}

/** Is this document the shell for that origin? (The only top-level document a connected window keeps.) */
function isShell(value, origin) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  let at;
  try {
    at = new URL(String(origin)).origin;
  } catch {
    return false;
  }
  return url.origin === at && url.pathname.replace(/\/+$/, '') === SHELL_PATH;
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
  if (isShell(safeURL(contents), origin)) return 'already';
  if (tried.has(contents)) return 'already';
  const session = await cookie();
  if (!session) return 'waiting';
  tried.add(contents);
  await load(window, shellURL(origin));
  return 'loading';
}

/** The URL a connected window should load first: the shell when there is a session, else the gate. */
async function startURL({ origin, cookie }) {
  const session = await cookie();
  return session ? shellURL(origin) : String(origin).replace(/\/+$/, '') + '/';
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

module.exports = { SHELL_PATH, shellURL, isShell, attach, startURL, topLevelAllowed, reset };
