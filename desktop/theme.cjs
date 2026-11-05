'use strict';
// THE ACCOUNT'S THEME, READ IN THE MAIN PROCESS, FOR THE WINDOW THAT HAS NO SERVER YET.
//
// THE DEFECT THIS EXISTS FOR (ticket c28be1de, Owen 2026-11-05: "before connecting to the
// e-server instance, the e-app shell does not match my user settings theme"). The client's own
// window - the account card and the list of e-servers - painted the OS answer and nothing else,
// because desktop/vendor/launcher/theme/theme-early.js resolves
// `matchMedia('(prefers-color-scheme: light)')` and that was the whole of the shell's theme
// logic. An account saved on `dark` got a light shell on a light machine until it connected to
// an e-server whose page told it otherwise.
//
// WHAT THIS MODULE IS. One read of the account's own settings document, on the Easter Company
// accounts service, through the Company session the main process already holds. Every interface
// of this company reads that one document; `desktop/company.cjs`'s `credential()` is the single
// door to the token, and this module is handed it rather than reaching for the session, so the
// token leaves the main process only as the Bearer of one request and never reaches a renderer.
//
// WHY NOT THE VENDORED account-client.mjs: that file is a byte-identical copy of the launcher
// site's own client (desktop/vendor/launcher/VENDORED.sha256, enforced by
// tests/vendored-account.test.cjs) and its OPERATIONS table is the launcher's policy for the
// routes the launcher calls - adding a route there would be editing the owner's module. So, for
// exactly the reason desktop/connections.cjs gives, the transport is this app's own, it borrows
// only the API origin from the vendored client, and it keeps the same read/write rules: a READ
// may be repeated (it changes nothing server side), every call is bounded, and an answer is never
// repeated.
//
// THE WIRE SHAPE IS NESTED. `GET /v2/accounts/settings` answers
// `{"settings":{...},"revision":<int>,"updatedAt":"..."}` (easter-co-cloud
// api/settings_routes.py:13). The FLAT document the settings panel reads is e-server's own
// translation of it (`/api/me/settings`), and it is NOT the shape to expect here - reading
// `document.theme` off the nested body is the bug that made every panel save repaint `system`
// over the account's real choice on 2026-11-04. So the preference is `document.settings.theme`,
// and nothing else.
//
// NOT E-SERVER, EVER. This module never asks a connected server what the theme is: one document,
// every interface, and the server is not that document.
const ACCOUNT_SETTINGS_PATH = '/v2/accounts/settings';
//: The themes the document may hold. `light` and `dark` are absolute; `system` is resolved
//: through the platform on every ask (desktop/main.cjs and desktop/theme-shell.js).
const THEMES = ['light', 'dark', 'system'];
//: The cache file, beside settings.json in the app's own config directory, mode 0600.
const THEME_CACHE_FILE = 'theme.json';
//: A read the person is waiting on, and one this app repeats once on a cold or dropped
//: connection. The gateway cuts an integration at 30 s; ten is already a service that is not
//: answering, and a theme nobody could read costs the person nothing but the OS answer.
const READ_TIMEOUT_MS = 10000;

/** The document's value, or null when it is not a theme this client knows. */
function normalise(value) {
  return THEMES.includes(value) ? value : null;
}

/**
 * What a preference resolves to on this machine. `light`/`dark` are absolute - the account's
 * word wins over the OS - and `system` (or nothing known yet) is the OS's own answer.
 */
function resolve(preference, osDark) {
  if (preference === 'light' || preference === 'dark') return preference;
  return osDark ? 'dark' : 'light';
}

/**
 * The last answer the account gave, read SYNCHRONOUSLY.
 *
 * Synchronous on purpose and for one reason: it is read from a preload bridge before the shell
 * document parses, so the first painted frame already carries the account's theme instead of the
 * OS answer followed by a correction. `fs.readFileSync` of one small file, once per window.
 *
 * A missing, unreadable or unparsable file is not an error to report: it is the first launch of
 * an account, and the OS answer is the truth until the account has answered.
 */
function readCache(file) {
  try {
    const text = require('node:fs').readFileSync(file, 'utf8');
    const document = JSON.parse(text);
    return normalise(document && document.theme);
  } catch {
    return null;
  }
}

/**
 * Remember the account's answer so the NEXT launch's first paint is already right, in the same
 * shape `settings.json` is written (a temp file, mode 0600, then a rename, so a half-written
 * cache is never read) and in the same neighbourhood: the app's own config directory.
 */
async function writeCache(file, preference) {
  const theme = normalise(preference);
  if (!theme) return false;
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const crypto = require('node:crypto');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), 'theme-' + crypto.randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, JSON.stringify({ theme }), { mode: 0o600 });
    await fs.rename(temporary, file);
    return true;
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

/** The named refusals, as codes: a theme read is never allowed to throw a sentence at a person. */
class ThemeError extends Error {
  constructor(code, { status = 0, detail = '' } = {}) {
    super(detail || code);
    this.name = 'ThemeError';
    this.code = code;
    this.status = status;
    this.detail = detail || code;
  }
}

/**
 * The one call this client makes to the account document, through the session the main process
 * holds. `credential()` is read per call so a re-signed-in session is used without rebuilding it.
 */
class AccountTheme {
  constructor({ origin, credential, fetch: fetchImpl, timeout = READ_TIMEOUT_MS } = {}) {
    if (!origin) throw Error('An account theme read needs the accounts API origin.');
    this.origin = String(origin).replace(/\/+$/, '');
    this.credential = credential || (() => '');
    this.fetch = fetchImpl || ((url, init) => fetch(url, init));
    this.timeout = timeout;
  }

  async read() {
    const token = this.credential();
    if (!token) throw new ThemeError('invalid_session');
    const attempt = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await this.fetch(this.origin + ACCOUNT_SETTINGS_PATH, {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
        const text = await response.text().catch(() => '');
        let document = null;
        try { document = text ? JSON.parse(text) : null; } catch { document = null; }
        if (!response.ok) {
          const code = (document && typeof document.error === 'string' && document.error) || 'invalid_response';
          const detail = document && typeof document.message === 'string' ? document.message : '';
          throw new ThemeError(code, { status: response.status, detail });
        }
        if (!document || typeof document !== 'object') throw new ThemeError('invalid_response');
        // NESTED: the document is `settings.theme`. A flat body is not this service.
        const settings = document.settings && typeof document.settings === 'object' ? document.settings : null;
        if (!settings) throw new ThemeError('invalid_response');
        return {
          preference: normalise(settings.theme) || 'system',
          revision: Number(document.revision) || 0,
        };
      } catch (error) {
        if (error instanceof ThemeError) throw error;
        if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw new ThemeError('timeout');
        throw new ThemeError('unreachable');
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await attempt();
    } catch (error) {
      // One repeat, and only for the two outcomes a second identical read can honestly fix: the
      // service was cold, or the connection dropped. An answer (any 4xx/5xx it stated) is not.
      if (!['unreachable', 'timeout'].includes(error.code)) throw error;
      return attempt();
    }
  }
}

module.exports = {
  AccountTheme,
  ThemeError,
  normalise,
  resolve,
  readCache,
  writeCache,
  THEMES,
  THEME_CACHE_FILE,
  ACCOUNT_SETTINGS_PATH,
  READ_TIMEOUT_MS,
};
