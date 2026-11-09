'use strict';
// ONE DOCUMENT LOAD PER CONNECTION — the journey, in a real Electron window.
//
// ticket 2ce8df20, stage 2 of Owen's persistent top nav (2026-11-08): "the top nav bar should always
// be present while logged in via e-app ... that top nav bar reload on each nav is so ugly and
// annoying". The connected window must show `${instance}/shell` ONCE and every navigation after that
// must happen inside `<iframe id="shell-frame">` — so this counts TOP-LEVEL `did-start-navigation`
// events on the main frame and asserts `#shell-bar`'s DOM node identity across the journey. A
// browser-only test cannot prove either.
//
// IT DRIVES THE REAL CODE, not a copy of it: `desktop/shell-attach.cjs` decides the first document,
// `desktop/navigation.cjs` performs the loads, and the window is created with the same hardening the
// client uses (sandbox, contextIsolation, no node integration, no webview). The INSTANCE it attaches
// to is a loopback fake serving the frozen contract from ticket f1bdcd46 — `/shell` with `#shell-bar`
// and `<iframe id="shell-frame">` — because the gate has to run without a real e-server, a PIN and an
// accounts service. The bar's own sheet is DIANA'S file, read off disk and served by the fake, so the
// 56px row and the pill at x=12 y=12 measured here are her geometry and not a fixture's invention.
//
//   xvfb-run -a npx electron --no-sandbox tests/shell-attach-journey.cjs
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const THEME_DIR = path.join(ROOT, 'desktop', 'vendor', 'launcher', 'theme');
const SHEETS = {
  // Diana's bar sheet, plus the household theme and its bridge: without the palette every
  // `var(--ec-*)` her sheet reads is empty and the bar paints nothing. The real shell links the
  // same files, so what the screenshots show here is her bar, not a fixture's sketch of one.
  '/shell-frame.css': fs.readFileSync(path.join(THEME_DIR, 'shell-frame.css')),
  '/theme.css': fs.readFileSync(path.join(THEME_DIR, 'theme.css')),
  '/launcher-bindings.css': fs.readFileSync(path.join(THEME_DIR, 'launcher-bindings.css')),
};
const shellAttach = require(path.join(ROOT, 'desktop', 'shell-attach.cjs'));
const { loadServerPage } = require(path.join(ROOT, 'desktop', 'navigation.cjs'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-attach-home-'));
app.setPath('userData', home);

const DESTINATIONS = [
  ['nav-messages', '/messages', 'Messages'],
  ['nav-files', '/files', 'File Storage'],
  ['nav-menu-system', '/system', 'System'],
  ['nav-menu-billing', '/billing', 'Billing'],
];

/** The shell document: the frozen contract, painted by Diana's own sheet. */
const SHELL = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/launcher-bindings.css"><link rel="stylesheet" href="/shell-frame.css"></head>
<body class="shell-frame">
<header class="sf-bar" id="shell-bar" aria-label="Application">
 <div class="sf-left">
  <button class="sf-control sf-account" id="shell-pill" type="button" aria-label="Owen Easter" title="Owen Easter">O</button>
  <nav aria-label="Agent views"><a class="sf-control" id="nav-agents" href="/agents" target="shell-frame" aria-label="Agents" title="Agents"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5H19L5 19H19" fill="none" stroke="currentColor" stroke-width="2"/></svg></a></nav>
 </div>
 <nav class="sf-right" aria-label="Application views">
  ${DESTINATIONS.map(([id, href, name]) => `<a class="sf-control" id="${id}" href="${href}" target="shell-frame" aria-label="${name}" title="${name}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/></svg></a>`).join('\n  ')}
 </nav>
</header>
<main class="sf-content" id="shell-content" aria-label="Page content"><iframe id="shell-frame" name="shell-frame" title="Page content" src="/agents"></iframe></main>
</body></html>`;

const bare = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:14px/1.5 sans-serif;padding:24px}main{height:1600px}</style></head>
<body><h1 id="page">${title}</h1><main>${'content '.repeat(60)}</main></body></html>`;

const GATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PIN</title></head>
<body><h1 id="page">This e-server asks for its PIN</h1></body></html>`;

let expiredShell = false;

function fakeInstance() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (body, type = 'text/html; charset=utf-8') => { response.writeHead(200, { 'content-type': type }); response.end(body); };
    if (SHEETS[url.pathname]) { response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); response.end(SHEETS[url.pathname]); return; }
    if (url.pathname === '/shell') {
      // AN EXPIRED SESSION IS A SERVER-SIDE REDIRECT, not a client decision — the case the client's
      // navigation policy has to survive without framing an external login page.
      if (expiredShell) { response.writeHead(302, { location: '/account' }); response.end(); return; }
      send(SHELL);
      return;
    }
    if (url.pathname === '/account') { send(bare('Your account')); return; }
    if (url.pathname === '/') {
      // The server's own PIN gate: answering it is what sets the session cookie, exactly as the real
      // one does when a person types their PIN.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sec_session=journey-session; Path=/; HttpOnly; SameSite=Lax' });
      response.end(GATE);
      return;
    }
    const found = DESTINATIONS.find(([, href]) => href === url.pathname);
    send(bare(found ? found[2] : 'Page'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, { timeout = 15000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await settle(100);
  }
};

const MEASURE = `(() => {
  const bar = document.getElementById('shell-bar');
  const pill = document.getElementById('shell-pill');
  const frame = document.getElementById('shell-frame');
  const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
  let inner = null;
  try { inner = frame.contentDocument ? { url: frame.contentWindow.location.pathname, heading: frame.contentDocument.getElementById('page') ? frame.contentDocument.getElementById('page').textContent : '' } : null; } catch (error) { inner = { error: String(error.message) }; }
  return {
    url: location.pathname,
    bar: rect(bar), pill: rect(pill), frame: rect(frame),
    barNodeId: bar ? (bar.__journeyId || null) : null,
    bars: document.querySelectorAll('#shell-bar').length,
    frames: document.querySelectorAll('#shell-frame').length,
    theme: document.documentElement.dataset.theme,
    viewport: { width: innerWidth, height: innerHeight },
    documentScroll: { height: document.scrollingElement.scrollHeight, client: document.scrollingElement.clientHeight },
    content: inner,
  };
})()`;

function makeWindow(ses) {
  return new BrowserWindow({
    width: 680, height: 860, show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, webSecurity: true },
  });
}

/** Scenario 1: a window that ALREADY holds the PIN session — the case that must be ONE load. */
async function attachedJourney({ origin, report, ses, win }) {
  await ses.cookies.set({ url: origin, name: 'sec_session', value: 'journey-session', httpOnly: true });
  const cookie = async () => { const rows = await ses.cookies.get({ name: 'sec_session', url: origin }); return rows && rows[0] ? rows[0].value : ''; };
  const started = [];
  const committed = [];
  win.webContents.on('did-start-navigation', (_e, url, inPlace, main) => { if (main && !inPlace) started.push(url); });
  win.webContents.on('did-navigate', (_e, url) => committed.push(url));

  // THE CLIENT'S OWN FIRST-DOCUMENT RULE, not a literal in this file.
  const first = await shellAttach.startURL({ origin, cookie, window: win });
  assert.equal(first, origin + '/shell', 'a window holding the PIN session opens the shell first');
  await loadServerPage(win, first);
  await waitFor(async () => win.webContents.executeJavaScript("!!document.getElementById('shell-bar')", true), { label: 'the bar' });
  // THE SAME CALL main.cjs MAKES FROM `did-finish-load`: on the shell it is a no-op that records the
  // window as attached, which is what narrows the navigation policy below.
  assert.equal(await shellAttach.attach({ window: win, origin, cookie, load: loadServerPage }), 'already');
  await settle(400);

  // The shell's own bar, from Diana's sheet served by the instance.
  const before = await win.webContents.executeJavaScript(MEASURE, true);
  report.shell = before;
  await win.webContents.executeJavaScript("document.getElementById('shell-bar').__journeyId = 'bar-' + Date.now()", true);
  const stamped = await win.webContents.executeJavaScript(MEASURE, true);
  const barId = stamped.barNodeId;
  assert.equal(before.bar.height, 56, `the shell's bar must be 56px, measured ${before.bar && before.bar.height}`);
  assert.deepEqual(before.pill, { x: 12, y: 12, width: 52, height: 32 }, `the shell's account pill must be 52x32 at x=12 y=12, measured ${JSON.stringify(before.pill)}`);

  // ── the four destinations, INSIDE the frame ────────────────────────────────────────────────
  const visited = [];
  for (const [id, href, name] of DESTINATIONS) {
    await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`, true);
    const seen = await waitFor(async () => {
      const state = await win.webContents.executeJavaScript(MEASURE, true);
      return state.content && state.content.url === href ? state : false;
    }, { label: 'the frame to show ' + name });
    visited.push({ destination: name, href, topURL: seen.url, barNodeId: seen.barNodeId, heading: seen.content.heading });
    assert.equal(seen.url, '/shell', `a nav to ${name} must NOT reload the window (top document is ${seen.url})`);
    assert.equal(seen.barNodeId, barId, `the bar must be the SAME node after ${name}`);
    assert.equal(seen.bars, 1, 'exactly one bar');
    assert.equal(seen.frames, 1, 'exactly one content frame');
    assert.equal(seen.content.heading, name, `the frame shows ${name}`);
  }
  report.visited = visited;
  report.navigations = { started: started.slice(), committed: committed.slice() };

  // ── the policy: a page-initiated top-level navigation away from the shell is refused ───────
  win.webContents.on('will-navigate', (event, url) => {
    if (shellAttach.topLevelAllowed({ window: win, origin, url })) return;
    try { if (new URL(String(url)).origin === origin) return event.preventDefault(); } catch {}
    event.preventDefault();
  });
  await win.webContents.executeJavaScript("location.href = '/messages'", true).catch(() => {});
  await settle(600);
  const afterAttempt = await win.webContents.executeJavaScript(MEASURE, true);
  report.refusedTopLevel = { url: afterAttempt.url, barNodeId: afterAttempt.barNodeId, attempted: started.filter((u) => u.endsWith('/messages')) };
  assert.equal(afterAttempt.url, '/shell', 'a same-origin top-level navigation must be refused after the attach');
  assert.equal(afterAttempt.barNodeId, barId, 'and the bar is still the same node');

  // ── the two sizes, in both palettes, and no double scrollbar ───────────────────────────────
  const sizes = {};
  for (const [width, height] of [[680, 860], [360, 500]]) {
    for (const theme of ['dark', 'light']) {
      win.setContentSize(width, height);
      await settle(250);
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`, true);
      await settle(150);
      const at = await win.webContents.executeJavaScript(MEASURE, true);
      sizes[`${width}x${height}-${theme}`] = { bar: at.bar, pill: at.pill, frame: at.frame, viewport: at.viewport, documentScroll: at.documentScroll };
      assert.equal(at.viewport.width, width, `the window is ${width} wide`);
      assert.equal(at.bar.height, 56, `the bar is 56px at ${width}x${height} (${theme})`);
      assert.deepEqual(at.pill, { x: 12, y: 12, width: 52, height: 32 }, `the pill is 52x32 at x=12 y=12 at ${width}x${height} (${theme}), measured ${JSON.stringify(at.pill)}`);
      assert.equal(at.frame.height, height - 56, `the frame takes the window minus the bar at ${width}x${height} (${theme})`);
      assert.ok(at.documentScroll.height <= at.viewport.height + 1,
        `no double scrollbar: the top document must not scroll (${at.documentScroll.height} vs ${at.viewport.height}) at ${width}x${height} (${theme})`);
    }
  }
  report.sizes = sizes;
  const image = await win.webContents.capturePage();
  report.shot = path.join(os.tmpdir(), 'shell-attach-' + Date.now() + '.png');
  fs.writeFileSync(report.shot, image.toPNG());

  // ONE top-level DOCUMENT for the whole journey, whatever the frame did. The refused attempt
  // appears in `started` — Electron emits did-start-navigation BEFORE the policy veto — and must
  // never appear in `committed`, which is the number that means "a document loaded".
  assert.deepEqual(committed.map((url) => url.replace(origin, '')), ['/shell'],
    `exactly one top-level load, measured ${committed.length}: ${committed.join(', ')}`);
  assert.deepEqual(started.map((url) => url.replace(origin, '')), ['/shell', '/messages'],
    `the shell loaded once; the refused top-level attempt is the only other start: ${started.join(', ')}`);
  win.destroy();
}

/** Scenario 2: no session yet — the server's gate first, the shell ONCE when the PIN cookie lands. */
async function gateThenShell({ origin, report, ses, win }) {
  const cookie = async () => { const rows = await ses.cookies.get({ name: 'sec_session', url: origin }); return rows && rows[0] ? rows[0].value : ''; };
  const navs = [];
  win.webContents.on('did-start-navigation', (_e, url, inPlace, main) => { if (main && !inPlace) navs.push(url); });
  const committed = [];
  win.webContents.on('did-navigate', (_e, url) => committed.push(url));
  const first = await shellAttach.startURL({ origin, cookie });
  assert.equal(first, origin + '/', 'with no session the first document is the server’s own gate');
  await loadServerPage(win, first);
  await settle(400);
  // The gate answered: the cookie is in the jar. This is the same call main.cjs makes from its
  // `sec_session` listener and from `did-finish-load`.
  const state = await shellAttach.attach({ window: win, origin, cookie, load: loadServerPage });
  report.gateAttach = state;
  await waitFor(async () => win.webContents.executeJavaScript("[location.pathname, !!document.getElementById('shell-bar')]", true).then(([p, bar]) => p === '/shell' && bar), { label: 'the shell after the PIN' });
  await settle(300);
  // ONE-SHOT: a second attach (the did-finish-load path arriving late) must not load again.
  assert.equal(await shellAttach.attach({ window: win, origin, cookie, load: loadServerPage }), 'already');
  assert.equal(state, 'loading');
  report.gateNavigations = { started: navs.map((url) => url.replace(origin, '')), committed: committed.map((url) => url.replace(origin, '')) };
  assert.deepEqual(committed.map((url) => url.replace(origin, '')), ['/', '/shell'],
    `the gate then the shell, once each, and no third load: ${committed.join(', ')}`);
  win.destroy();
}

/** Scenario 3: `/shell` answers with the server's sign-in page — no attach loop. */
async function expiredSession({ origin, report, ses, win }) {
  expiredShell = true;
  await ses.cookies.set({ url: origin, name: 'sec_session', value: 'journey-session', httpOnly: true });
  const cookie = async () => { const rows = await ses.cookies.get({ name: 'sec_session', url: origin }); return rows && rows[0] ? rows[0].value : ''; };
  const navs = [];
  win.webContents.on('did-start-navigation', (_e, url, inPlace, main) => { if (main && !inPlace) navs.push(url); });
  const committed = [];
  win.webContents.on('did-navigate', (_e, url) => committed.push(url));
  await loadServerPage(win, await shellAttach.startURL({ origin, cookie, window: win }));
  await settle(400);
  const landed = await win.webContents.executeJavaScript('location.pathname', true);
  // The window is on the server's own account page, NOT on the shell — and the client must not try
  // to attach again, which is what would make a loop.
  const again = await shellAttach.attach({ window: win, origin, cookie, load: loadServerPage });
  await settle(400);
  const still = await win.webContents.executeJavaScript('location.pathname', true);
  report.expired = { landed, attach: again, still, started: navs.map((url) => url.replace(origin, '')), committed: committed.map((url) => url.replace(origin, '')) };
  assert.equal(landed, '/account', 'the server’s own redirect decides where the window lands');
  assert.equal(again, 'already', 'a window that already tried the shell is never loaded again');
  assert.equal(still, '/account', 'and it stays where the server put it — no loop');
  assert.ok(committed.length <= 2, `one load and its redirect, measured ${committed.length}: ${committed.join(', ')}`);
  win.destroy();
  expiredShell = false;
}

async function main() {
  await app.whenReady();
  const server = await fakeInstance();
  const origin = 'http://127.0.0.1:' + server.address().port;
  const report = { origin };
  // Created before anything loads: see the note above `makeWindow`.
  const rooms = ['a', 'b', 'c'].map((name) => {
    const ses = session.fromPartition('shell-attach-' + name + '-' + Date.now());
    return { ses, win: makeWindow(ses) };
  });
  await attachedJourney({ origin, report, ...rooms[0] });
  await gateThenShell({ origin, report, ...rooms[1] });
  await expiredSession({ origin, report, ...rooms[2] });
  server.close();
  console.log(JSON.stringify(report, null, 1));
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => {
  console.error('JOURNEY FAILED:', error && error.message);
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(1);
});
