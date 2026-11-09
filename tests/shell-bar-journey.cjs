'use strict';
// THE BAR'S JOURNEY, IN THE REAL CLIENT WINDOW — stage 1 (the client's own screens).
//
// Owen, 2026-11-08: "the top nav bar should always be present while logged in via e-app, especially
// during the e-server instance selection screen and such things. Just only the user button is
// available when not connected to an e-server instance :)"
//
// This runs the REAL document (desktop/shell.html + the vendored theme and Diana's own bar sheet +
// desktop/shell.mjs) in a REAL Electron window with an isolated HOME, and pushes the same published
// states the main process pushes — signed out, signed in with the e-server list, the add view, and a
// list that failed — through tests/fixtures/shell-bridge.cjs. Then it MEASURES the bar: its height,
// the account pill's rendered box, the absence of anything on the right, the same bar node across
// every state, and the second grid row scrolling.
//
// Not part of `node --test`: it needs Electron and a display.
//   xvfb-run -a npx electron tests/shell-bar-journey.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
// THE DOCUMENT UNDER TEST, and by default the working tree's. SHELL_BAR_SHELL points it at the copy
// inside a packed app.asar, so the same journey can say "it ships" instead of "it works here":
//   SHELL_BAR_SHELL=$PWD/release/linux-unpacked/resources/app.asar/desktop/shell.html \
//     xvfb-run -a npx electron --no-sandbox tests/shell-bar-journey.cjs
const SHELL = process.env.SHELL_BAR_SHELL || path.join(ROOT, 'desktop', 'shell.html');
const PRELOAD = path.join(__dirname, 'fixtures', 'shell-bridge.cjs');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-bar-shots-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-bar-home-'));
app.setPath('userData', home);

const ACCOUNT = { id: 7, username: 'oceaster', name: 'Owen Easter', roles: ['owner'], providers: ['microsoft'], picture: null };
const SERVERS = {
  state: 'ready',
  rows: [
    { id: 'a', label: 'easter-server', origin: 'https://easter-server.example:8443' },
    { id: 'b', label: 'workshop', origin: 'https://workshop.example:8443' },
  ],
  limit: 5,
  fallback: '',
};

/** Everything the ticket asks to be measured, read out of the live document. */
const MEASURE = `(() => {
  const bar = document.querySelector('.sf-bar');
  const pill = document.getElementById('account-pill');
  const face = pill && pill.querySelector('.web-account-face');
  const local = document.querySelector('main.account-main');
  const right = bar ? bar.querySelector('.sf-right') : null;
  const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
  const focusables = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(node => { const s = getComputedStyle(node); return s.display !== 'none' && s.visibility !== 'hidden' && node.getClientRects().length > 0; })
    .map(node => node.id || node.className || node.tagName);
  const barFocusables = bar ? [...bar.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(node => node.getClientRects().length > 0).map(node => node.id || node.tagName) : [];
  return {
    bodyClass: document.body.className,
    bar: rect(bar),
    barBorderBottom: bar ? getComputedStyle(bar).borderBottomWidth : null,
    barBackground: bar ? getComputedStyle(bar).backgroundColor : null,
    pill: rect(pill),
    pillLabel: pill ? pill.getAttribute('aria-label') : null,
    pillTitle: pill ? pill.getAttribute('title') : null,
    pillState: pill ? pill.dataset.state : null,
    face: rect(face),
    faceText: face ? face.textContent : null,
    facePicture: face ? !face.querySelector('.web-account-picture').hidden : null,
    barNodeIdentity: bar ? bar.__journeyId || null : null,
    rightCluster: !!right,
    rightClusterChildren: right ? right.children.length : 0,
    orb: !!document.querySelector('.sf-orb'),
    marks: document.querySelectorAll('.sf-agents,.agent-pill,.swarm-pill,.processes-pill').length,
    menu: !!document.querySelector('.sf-menu,.sf-menu-wrap,#shell-menu-button'),
    barFocusables,
    barChildCount: bar ? bar.children.length : 0,
    local: rect(local),
    panelGround: (() => { const p = document.querySelector('.account-panel'); return p ? getComputedStyle(p).backgroundColor : null; })(),
    localScroll: local ? { clientHeight: local.clientHeight, scrollHeight: local.scrollHeight, overflowY: getComputedStyle(local).overflowY } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentScroll: { innerHeight: window.innerHeight, bodyScroll: document.body.scrollHeight },
    panels: { card: !!document.querySelector('.account-panel'), servers: !!document.getElementById('client-servers'),
      serversHidden: document.getElementById('client-servers') ? document.getElementById('client-servers').hidden : null,
      rows: document.querySelectorAll('#server-list .server-row').length,
      addView: document.getElementById('add-server-view') ? !document.getElementById('add-server-view').hidden : null,
      retry: document.getElementById('servers-retry') ? !document.getElementById('servers-retry').hidden : null,
      accountRow: document.getElementById('account-status') ? !document.getElementById('account-status').hidden : null },
    focusables,
  };
})()`;

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 680, height: 860, show: false,
    webPreferences: { preload: PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  // THE WINDOW IS THE CLIENT'S OWN SHAPE: 680x860 at rest (desktop/main.cjs's minWidth 360,
  // minHeight 500 is the floor the narrow measurement below drives to).
  win.setContentSize(680, 860);
  await settle(150);
  const navigations = [];
  win.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => { if (isMainFrame) navigations.push(url); });
  await win.loadFile(SHELL);
  await settle(400);

  const measure = async () => win.webContents.executeJavaScript(MEASURE, true);
  const push = async (next) => { await win.webContents.executeJavaScript(`window.__barTest.push(${JSON.stringify(next)})`, true); await settle(220); };
  const shot = async (name) => {
    const image = await win.webContents.capturePage();
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  const report = { sizes: {}, states: {}, shots: [], navigations: navigations.length };

  // ── the state the window boots in: signed out, the sign-in panel ────────────────────────────
  const signedOut = await measure();
  report.states.signedOut = signedOut;
  report.shots.push(await shot('680x860-signed-out'));
  // THE BODY IS THE SITE'S ACCOUNT PAGE, and the bar is its first row (ticket d470ba67).
  assert.equal(signedOut.bodyClass.trim(), 'account', `the document is the site’s account page, measured class="${signedOut.bodyClass}"`);
  assert.ok(signedOut.bar, 'the bar must be present while signed out');
  assert.equal(signedOut.bar.height, 56, `bar height must be Diana's 56px, measured ${signedOut.bar && signedOut.bar.height}`);
  assert.deepEqual(signedOut.pill, { x: 12, y: 12, width: 52, height: 32 }, `the account pill must be 52x32 at x=12 y=12, measured ${JSON.stringify(signedOut.pill)}`);
  assert.equal(signedOut.rightCluster, false, 'nothing may sit on the right before an instance is connected');
  assert.equal(signedOut.orb, false, 'no orb: there is no instance whose state could be read');
  assert.equal(signedOut.marks, 0, 'no agent marks, no menu and no destinations before an instance is connected');
  assert.equal(signedOut.menu, false, 'no menu before an instance is connected');
  assert.deepEqual(signedOut.barFocusables, ['account-pill'], `the only focusable thing in the bar is the account pill, found ${JSON.stringify(signedOut.barFocusables)}`);
  assert.ok(signedOut.panels.card, 'the sign-in card is still the screen');
  assert.equal(signedOut.local.y, 56, `the page content starts at the bar's own edge, measured y=${signedOut.local && signedOut.local.y}`);
  assert.equal(signedOut.localScroll.overflowY, 'auto', 'the page owns its scrolling in its own row');
  assert.equal(signedOut.pillLabel, 'Account', 'signed out, the pill is just the account control');

  const barId = await win.webContents.executeJavaScript(`(() => { const bar = document.querySelector('.sf-bar'); bar.__journeyId = 'bar-' + Date.now(); return bar.__journeyId; })()`, true);
  report.barNodeId = barId;

  // ── signed in, on the e-server list ─────────────────────────────────────────────────────────
  await push({ phase: 'setup', account: ACCOUNT, accountReady: true, title: 'Your e-servers.', servers: SERVERS, view: 'servers' });
  const signedIn = await measure();
  report.states.signedIn = signedIn;
  report.shots.push(await shot('680x860-servers'));
  assert.equal(signedIn.bar.height, 56, 'the bar is the same height on the instance list');
  assert.deepEqual(signedIn.pill, signedOut.pill, 'the account pill sits in exactly the same box on both screens');
  assert.deepEqual(signedIn.bar, signedOut.bar, 'the bar itself did not move between the screens');
  assert.equal(signedIn.barNodeIdentity, barId, 'the bar is the SAME DOM node, not a redrawn one');
  assert.equal(signedIn.pillLabel, 'Owen Easter', 'the pill carries the account name as its accessible name');
  assert.equal(signedIn.pillTitle, 'Owen Easter', 'and as its tooltip');
  assert.equal(signedIn.faceText, 'O', 'the face is the first letter of the name when the account carries no picture');
  assert.equal(signedIn.panels.rows, 2, 'the e-server list still draws its rows');
  assert.equal(signedIn.panels.accountRow, true, 'the account row this window already had is unchanged');
  assert.equal(signedIn.rightCluster, false, 'still nothing on the right');
  assert.deepEqual(signedIn.barFocusables, ['account-pill'], 'still the account pill is the bar’s only control');
  assert.equal(signedIn.localScroll.overflowY, 'auto', 'the list scrolls in the page’s row, not the document');
  assert.equal(signedIn.documentScroll.bodyScroll <= signedIn.viewport.height + 1, true,
    `the document itself must not grow taller than the window (body ${signedIn.documentScroll.bodyScroll} vs ${signedIn.viewport.height})`);

  // ── the pill works: it takes the person to the account this window shows ────────────────────
  const focused = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('account-pill').click();
    const active = document.activeElement;
    return { id: active && active.id, text: active ? (active.textContent || '').trim().slice(0, 60) : '' };
  })()`, true);
  report.pillAction = focused;
  assert.equal(focused.id, 'account-status', `pressing the pill must land on the account row, focus went to ${focused.id || focused.text}`);

  // ── the add view, and a list that failed ───────────────────────────────────────────────────
  await push({ view: 'add' });
  const addView = await measure();
  report.states.add = addView;
  report.shots.push(await shot('680x860-add'));
  assert.equal(addView.panels.addView, true, 'the add view is the screen');
  assert.deepEqual(addView.pill, signedOut.pill, 'and the pill is in the same place again');
  assert.equal(addView.barNodeIdentity, barId, 'the bar survives the view change');

  await push({ view: 'servers', servers: { state: 'error', rows: [], error: 'Your e-servers did not load. Try again.', fallback: '' } });
  const failed = await measure();
  report.states.failed = failed;
  report.shots.push(await shot('680x860-list-error'));
  assert.equal(failed.panels.retry, true, 'a failed list still offers Try again');
  assert.equal(failed.bar.height, 56, 'and the bar is unmoved by a failure');
  assert.equal(failed.barNodeIdentity, barId, 'the bar node is the same one');

  // ── a sign-in that failed: the page's own alert region, and the bar still there ─────────────
  await push({ phase: 'auth', account: null, accountReady: false, servers: { state: 'idle', rows: [] }, accountError: 'Sign-in cancelled.' });
  const signInFailed = await measure();
  report.states.signInFailed = signInFailed;
  report.shots.push(await shot('680x860-sign-in-failed'));
  assert.equal(signInFailed.bar.height, 56, 'a failed sign-in keeps the bar');
  assert.equal(signInFailed.barNodeIdentity, barId, 'and the same node');
  assert.equal(signInFailed.pillLabel, 'Account', 'the pill is the account control again');
  assert.equal(signInFailed.panels.card, true, 'the sign-in screen is still the screen');
  assert.equal(await win.webContents.executeJavaScript(`(() => { const e = document.getElementById('account-error'); return { hidden: e.hidden, text: e.textContent.trim() }; })()`, true)
    .then((alert) => alert.hidden === false && alert.text === 'Sign-in cancelled.'), true,
    'the page’s own alert region still carries the failure sentence');

  // ── the narrow window, where Diana's arithmetic has to hold ────────────────────────────────
  win.setContentSize(360, 500);
  await settle(300);
  const narrow = await measure();
  report.sizes.narrow = narrow;
  report.shots.push(await shot('360x500-list-error'));
  assert.equal(narrow.viewport.width, 360, `the window must measure 360 wide, measured ${narrow.viewport.width}`);
  assert.equal(narrow.bar.height, 56, 'the bar is still 56px at 360');
  assert.deepEqual(narrow.pill, { x: 12, y: 12, width: 52, height: 32 }, `the pill is still 52x32 at x=12 y=12 at 360, measured ${JSON.stringify(narrow.pill)}`);
  assert.equal(narrow.documentScroll.bodyScroll <= narrow.viewport.height + 1, true,
    `at 360x500 the document must not grow past the window (body ${narrow.documentScroll.bodyScroll} vs ${narrow.viewport.height})`);
  assert.equal(narrow.rightCluster, false, 'nothing appears on the right at 360 either');

  // ── signed out again: the bar stays, and the pill goes back to the mark ────────────────────
  win.setContentSize(680, 860);
  await settle(200);
  await push({ phase: 'auth', account: null, accountReady: false, servers: { state: 'idle', rows: [] } });
  const back = await measure();
  report.states.signedOutAgain = back;
  report.shots.push(await shot('680x860-signed-out-again'));
  assert.equal(back.bar.height, 56, 'a sign-out does not take the bar away');
  assert.equal(back.barNodeIdentity, barId, 'and does not redraw it');
  assert.equal(back.pillLabel, 'Account', 'the pill is the account control again');
  assert.equal(back.panels.card, true, 'and the sign-in screen is back');

  // ── nothing above reloaded the document ────────────────────────────────────────────────────
  report.navigations = navigations.length;
  assert.equal(navigations.length, 1, `the document loaded once and stayed (navigations: ${navigations.join(', ')})`);

  console.log(JSON.stringify(report, null, 1));
  console.log(`SHOTS ${SHOTS}`);
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => {
  console.error('JOURNEY FAILED:', error && error.message);
  console.error(`SHOTS ${SHOTS}`);
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(1);
});
