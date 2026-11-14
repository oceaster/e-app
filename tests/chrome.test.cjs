'use strict';
// THE e-app's OWN CHROME — the static half: her files are hers, the wire is the frozen contract,
// and this privileged document is boxed exactly as Delta's security requirement says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file));
const CHROME = read('desktop/chrome.html').toString('utf8');
const HOST = read('desktop/chrome-host.js').toString('utf8');
const MAIN = read('desktop/main.cjs').toString('utf8');
const E_SERVER = process.env.E_SERVER_ROOT || '/root/e-server';

test('Diana’s bar markup and her sheet are the e-server copies, byte for byte', () => {
  for (const [mine, theirs] of [
    ['desktop/vendor/launcher/theme/shell-frame.html', 'api/profile_assets/shell-frame.html'],
    ['desktop/vendor/launcher/theme/shell-frame.css', 'api/profile_assets/shell-frame.css'],
    ['desktop/vendor/launcher/account-control.mjs', '../easter-co-smp.github.io/site/account-control.mjs'],
  ]) {
    const source = theirs.startsWith('../') ? path.join(ROOT, theirs) : path.join(E_SERVER, theirs);
    assert.ok(fs.existsSync(source), `the source is missing: ${source}`);
    assert.equal(read(mine).equals(fs.readFileSync(source)), true, `${mine} has drifted from ${theirs} — re-vendor it, never edit the copy`);
  }
});

test('the chrome document is boxed: its own CSP, and the connected window’s sandbox', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(CHROME);
  assert.ok(csp, 'the chrome carries a CSP meta of its own');
  for (const rule of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:"]) {
    assert.ok(csp[1].includes(rule), `the chrome CSP must carry ${rule}`);
  }
  // THE ONE ADDITION, named: a document whose whole job is to frame the instance must allow the
  // frame. It is bounded to https plus loopback (the journey's fixture), never `*`.
  assert.match(csp[1], /frame-src https: http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
  assert.equal(/"\*"|frame-src \*/.test(csp[1]), false, 'no wildcard in the chrome CSP');
  assert.match(MAIN, /nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false/,
    'the connected window keeps nodeIntegration:false, contextIsolation:true and sandbox:true');
  assert.match(MAIN, /current\.webContents\.on\('will-attach-webview',event=>event\.preventDefault\(\)\);/);
});

test('the three marks are painted by the legacy rules, not by the SVG defaults', () => {
  // The bar's marks used to be styled by the server's own sheets; the chrome owns the bar now,
  // so those rules had to MOVE here, value for value. Without them Epsilon's orbit dots paint as
  // three little rings at rest and Delta's core loses its .55 opacity and its glow: a different
  // bar from the one Owen asked to look exactly the same.
  const ADAPTER = fs.readFileSync(path.join(ROOT, 'desktop/chrome-adapter.css'), 'utf8');
  // Delta
  assert.match(ADAPTER, /\.sf-bar \.harness-outline \{ opacity: \.55; \}/);
  assert.match(ADAPTER, /\.sf-bar \.harness-core \{[^}]*opacity: \.55;[^}]*filter: drop-shadow\(0 0 2px currentColor\)/);
  // Epsilon: the orbit is INVISIBLE at rest and its core glows - the two rules that were missing.
  assert.match(ADAPTER, /\.sf-bar \.epsilon-orbit \{ fill: currentColor; stroke: none; opacity: 0;/);
  assert.match(ADAPTER, /\.sf-bar \.epsilon-core \{[^}]*filter: drop-shadow\(0 0 3px currentColor\)/);
  // Zeta: hidden at rest, quiet at .25, and the idle/running/queued states the legacy sheet had.
  assert.match(ADAPTER, /\.sf-bar \.zeta-core \{[^}]*opacity: 0;/);
  assert.match(ADAPTER, /\[data-process-state="quiet"\] \.zeta-outline \{ opacity: \.25; \}/);
  for (const state of ['running', 'idle', 'queued', 'closed']) {
    assert.ok(ADAPTER.includes(`data-state="${state}"`), `Delta/Epsilon keep their ${state} rule`);
  }
  // The motion is part of the mark: the legacy keyframes and the reduced-motion fence.
  for (const keyframe of ['delta-trace', 'delta-orbit', 'delta-breathe', 'delta-rest',
    'epsilon-trace', 'epsilon-orbit', 'epsilon-breathe', 'zeta-travel', 'zeta-shuttle',
    'zeta-idle', 'zeta-queued', 'zeta-quiet']) {
    assert.ok(ADAPTER.includes(`@keyframes ${keyframe}`), `the chrome carries @keyframes ${keyframe}`);
  }
  assert.match(ADAPTER, /@media \(prefers-reduced-motion: no-preference\)/);
});

test('the frozen parent contract: one hint, and the three checks before a message is believed', () => {
  // §1 the chrome appends exactly one parameter, on every framed URL
  assert.match(HOST, /\+"&parent="\+encodeURIComponent\(PARENT_HINT\)/);
  assert.ok(HOST.includes('var PARENT_HINT='), 'the hint is computed once');
  assert.ok(HOST.includes('?location.origin:"null";'), 'a real origin is used when there is one, else the literal null');
  // §3 the three checks: source, the INSTANCE origin (never location.origin), token AND navigation id
  assert.match(HOST, /if\(event\.origin!==SERVER_ORIGIN\)return;/);
  assert.match(HOST, /if\(!frame\.contentWindow\|\|event\.source!==frame\.contentWindow\)return;/);
  assert.match(HOST, /if\(String\(data\.token\|\|""\)!==nav\.token\|\|String\(data\.navigationId\|\|""\)!==String\(nav\.id\)\)return;/);
  assert.equal(/event\.origin!==location\.origin/.test(HOST), false, 'the chrome must never compare against its own (opaque) origin');
  // §4 chrome → frame is strict: the instance origin, never '*'
  assert.match(HOST, /function openHarnessSurface\(surface,fallbackKey\)\{/);
  assert.match(HOST, /frame\.contentWindow\.postMessage\(intent,SERVER_ORIGIN\)/);
  assert.equal(/postMessage\([^)]*,'\*'\)/.test(HOST), false, 'the chrome never posts with a wildcard');
  // and the trusted verifier the ported controller keeps
  assert.match(HOST, /arrived\(\)|function arrived\(\)/);
  assert.match(HOST, /TIMEOUT_MS/);
});

test('the account menu opens the owner’s four rows, in the site’s own menu rules', () => {
  for (const row of ['My Profile', 'Linked Accounts', 'Settings', 'Sign out']) {
    assert.ok(HOST.includes(`accountRow("${row}"`), `the menu carries ${row}`);
  }
  assert.match(HOST, /menu\.className="desktop-profile-menu"/, 'the site’s own menu class');
  assert.match(CHROME, /vendor\/launcher\/theme\/account-control\.css/, 'and the site’s own sheet is linked');
  assert.match(HOST, /document\.addEventListener\("keydown"/, 'Escape closes it');
});

test('the harness hop: strict targetOrigin, one acknowledgement window, one honest fallback', () => {
  assert.match(HOST, /frame\.contentWindow\.postMessage\(intent,SERVER_ORIGIN\)/);
  assert.match(HOST, /var DSH_ACK_MS=1500;/);
  assert.match(HOST, /harnessAcknowledged/);
  assert.match(HOST, /nav\.pending===fallbackKey/, 'the fallback cannot clobber a newer navigation');
});

test('the controller is the app’s OWN — the destinations and her copy live here now', () => {
  // THE HANDOVER, ASSERTED IN BOTH DIRECTIONS. Ticket 1b924f2f moved the bar's host half out of
  // e-server and into this app: `api/shell.py` lost `DESTINATIONS`, `COPY`, the wait panes and the
  // `/shell` document, and `desktop/chrome-host.js` became the one author of what a destination is.
  // This test used to read those constants OUT of the server's file — so the day the server deleted
  // them it died with `Cannot read properties of null`, which is a gate reading a file whose subject
  // had moved rather than a product defect. The subject is now this app, and the server is asserted
  // to have GIVEN IT UP: a reintroduction there is the second design this test exists to refuse.
  const rows = [...HOST.matchAll(/\["([a-z-]+)", "([^"]+)", "([^"]+)"\]/g)];
  assert.equal(rows.length, 10, `ten destinations, one per row: ${JSON.stringify(rows.map(r => r[1]))}`);
  assert.match(HOST, /var DESTINATIONS=\[/, 'the controller declares the table itself');
  for (const [, key, label, href] of rows) {
    assert.ok(CHROME.includes(`data-destination="${key}"`) && CHROME.includes(`href="${href}"`),
      `the chrome markup still carries ${key} → ${href}`);
    assert.ok(label && href.startsWith('/'), `${key} carries a label and an absolute path`);
  }
  // The keys are unique and the hub is one of them: two rows naming one page is two designs again.
  assert.equal(new Set(rows.map(([, key]) => key)).size, rows.length, 'the destination keys are unique');
  assert.ok(rows.some(([, key, , href]) => key === 'system' && href === '/system'), 'the hub is a destination');
  // HER COPY, still carried verbatim (the menus and the wait panes say what she wrote).
  for (const sentence of ['Opening {destination}…', 'Waiting for the page.',
                          'Page did not open', 'Sign-in required']) {
    assert.ok(HOST.includes(sentence), `her copy is carried verbatim: ${sentence}`);
  }
  // AND THE SERVER HAS GIVEN IT UP. Read only if the checkout is present (this suite also runs on a
  // machine that has no e-server), and then fail on a reintroduction by name.
  const serverShell = path.join(E_SERVER, 'api/shell.py');
  if (fs.existsSync(serverShell)) {
    const source = fs.readFileSync(serverShell, 'utf8');
    for (const gone of ['DESTINATIONS', 'MENU_DESTINATIONS', 'DEFAULT_DESTINATION', 'HOST_SCRIPT']) {
      assert.equal(new RegExp(`^${gone}\\s*=`, 'm').test(source), false,
        `e-server's api/shell.py still defines ${gone}: the bar's host half moved to this app (ticket 1b924f2f)`);
    }
    // The CHILD contract stays behind, because a framed page still needs it.
    for (const kept of ['MARKER', 'NAV_PARAM', 'TOKEN_PARAM', 'ROUTE_PARAM']) {
      assert.equal(new RegExp(`^${kept}\\s*=`, 'm').test(source), true,
        `e-server keeps the child contract: ${kept} must still be defined`);
    }
  }
});
