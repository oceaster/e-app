'use strict';
// THE CLIENT ATTACHES TO THE INSTANCE'S SHELL — the static half of the gate.
//
// ticket 2ce8df20, stage 2 of Owen's persistent top nav: once connected, the window shows
// `${instance}/shell` ONCE and every navigation after that happens inside `<iframe id="shell-frame">`.
// The MEASURED half is tests/shell-attach-journey.cjs (a real Electron window, a loopback instance
// serving the frozen contract, and a count of top-level navigations). This file holds what a journey
// cannot: that the client's wiring is the wiring that was proved, that the client adds no second
// source of truth for the bar, and that its hardening is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'desktop', 'main.cjs');
const MODULE = path.join(ROOT, 'desktop', 'shell-attach.cjs');
const JOURNEY = path.join(ROOT, 'tests', 'shell-attach-journey.cjs');
const read = (file) => fs.readFileSync(file, 'utf8');
const attach = require(MODULE);

const ORIGIN = 'https://instance.example:8443';

/** A window-shaped stub: the module only ever asks a window for its webContents. */
function fakeWindow(url = 'about:blank') {
  const contents = { destroyed: false, isDestroyed: () => false, getURL: () => contents.url, url };
  return { destroyed: false, isDestroyed: () => false, webContents: contents };
}

test('the connected document is the e-app’s OWN chrome, and never an e-server route', () => {
  const chrome = attach.shellURL(ORIGIN);
  assert.equal(chrome.startsWith('file://'), true, `the top-level document must be local, measured ${chrome}`);
  assert.equal(chrome.endsWith('/desktop/chrome.html?origin=' + encodeURIComponent(ORIGIN)), true, chrome);
  assert.throws(() => attach.shellURL('not a url'), /not valid/);
  assert.throws(() => attach.shellURL('ftp://instance.example'), /must be https/);
  // one chrome serves every instance: the instance travels in the query, and a chrome opened for
  // ANOTHER instance is not ours.
  assert.equal(attach.isShell(chrome, ORIGIN), true);
  assert.equal(attach.isShell(attach.shellURL('https://other.example'), ORIGIN), false);
  assert.equal(attach.isShell(ORIGIN + '/shell', ORIGIN), false, 'no e-server route is the top document any more');
  assert.equal(attach.isShell('about:blank', ORIGIN), false);
});

test('the first document is the shell only when a PIN session exists', async () => {
  const window = fakeWindow();
  assert.equal(await attach.startURL({ origin: ORIGIN, cookie: async () => '', window }), ORIGIN + '/');
  assert.equal(await attach.startURL({ origin: ORIGIN, cookie: async () => 'session', window: fakeWindow() }), attach.shellURL(ORIGIN));
});

test('attach is ONE-SHOT per window: no loop, and no second load after a redirect', async () => {
  const loads = [];
  const load = async (window, url) => { loads.push(url); window.webContents.url = url; };

  // no session yet: the server's own gate is in front of the person, nothing is loaded
  const gateWindow = fakeWindow();
  assert.equal(await attach.attach({ window: gateWindow, origin: ORIGIN, cookie: async () => '', load }), 'waiting');
  assert.deepEqual(loads, [], 'without a session nothing is loaded and nothing is attempted');

  // the PIN lands: exactly one shell load
  const win = fakeWindow();
  const chrome = attach.shellURL(ORIGIN);
  assert.equal(await attach.attach({ window: win, origin: ORIGIN, cookie: async () => 'session', load }), 'loading');
  assert.deepEqual(loads, [chrome]);
  assert.equal(await attach.attach({ window: win, origin: ORIGIN, cookie: async () => 'session', load }), 'already');
  assert.deepEqual(loads, [chrome], 'a second attach never loads again');

  // a window that was HANDED the shell by startURL counts as attached (the expired-session case)
  const handed = fakeWindow();
  const url = await attach.startURL({ origin: ORIGIN, cookie: async () => 'session', window: handed });
  assert.equal(url, chrome);
  assert.equal(await attach.attach({ window: handed, origin: ORIGIN, cookie: async () => 'session', load }), 'already');
  assert.equal(loads.length, 1, 'and it does not load the shell a second time');

  // already on the shell is attached, and it is RECORDED (this is what narrows the policy)
  const onShell = fakeWindow(chrome);
  assert.equal(await attach.attach({ window: onShell, origin: ORIGIN, cookie: async () => '', load }), 'already');
  assert.equal(attach.topLevelAllowed({ window: onShell, origin: ORIGIN, url: ORIGIN + '/messages' }), false);
});

test('the connected window keeps one document: same-origin navigation is refused AFTER the attach', async () => {
  const win = fakeWindow(attach.shellURL(ORIGIN));
  // BEFORE the attach the server's own gate has to be able to hand over to its app.
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: ORIGIN + '/' }), true);
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: ORIGIN + '/account' }), true);
  // AFTER it, the shell is the only top-level document.
  await attach.attach({ window: win, origin: ORIGIN, cookie: async () => '', load: async () => {} });
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: attach.shellURL(ORIGIN) }), true, 'the chrome itself is allowed (a reload of it is still the chrome)');
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: ORIGIN + '/agents' }), false);
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: ORIGIN + '/messages?x=1' }), false);
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: 'https://elsewhere.example/login' }), false,
    'an authentication-expiry redirect to another origin is never framed');
  assert.equal(attach.topLevelAllowed({ window: win, origin: ORIGIN, url: 'about:blank' }), true);
});

test('main.cjs wires the module that was proved, in the three places that exist', () => {
  const source = read(MAIN);
  assert.match(source, /const shellAttach=require\('\.\/shell-attach\.cjs'\);/, 'the module is required');
  // the first document of a connection
  assert.match(source, /const startURL=current=>shellAttach\.startURL\(\{origin:config\.server,cookie:sessionCookie,window:current\}\)/);
  assert.match(source, /await loadServerPage\(current,await startURL\(current\)\);/, 'connect() opens the shell (or the gate) as its FIRST document');
  // the handover when the PIN cookie lands, and the did-finish-load fallback
  assert.match(source, /shellCookieListener=\(_event,cookie,_cause,removed\)=>\{[\s\S]*?cookie\.name!=='sec_session'[\s\S]*?void attachShell\(current\);/);
  assert.match(source, /activeSession\.cookies\.on\('changed',shellCookieListener\);/);
  assert.match(source, /await attachShell\(current\);\n  await startFeed\(current\);/, 'did-finish-load attaches before it starts the feed');
  // and the policy
  assert.match(source, /if\(shellAttach\.topLevelAllowed\(\{window:current,origin:config\.server,url\}\)\)return;/);
  assert.match(source, /current\.webContents\.on\('will-attach-webview',event=>event\.preventDefault\(\)\);/,
    'the webview denial is untouched: the shell is an iframe, not a webview');
  // a server without the shell is answered by its own root, ONCE
  assert.match(source, /if\(httpResponseCode!==404\|\|win!==current\|\|current\.isDestroyed\(\)\)return;/);
  assert.match(source, /if\(!shellAttach\.isShell\(url,config\.server\)\)return;/);
  assert.ok(source.includes("void loadServerPage(current,config.server+'/').catch(()=>{});"), 'the fallback loads the server’s own root');
  // the listener is removed with the window, so a switch of server starts clean
  assert.match(source, /current\.once\('closed',\(\)=>\{if\(shellCookieListener&&activeSession\)activeSession\.cookies\.removeListener\('changed',shellCookieListener\);shellCookieListener=null;\}\);/);
});

test('the client invents no second source of truth and no bar of its own', () => {
  const module = read(MODULE);
  for (const forbidden of ['setInterval', 'setTimeout', 'fetch(', 'requestAnimationFrame']) {
    assert.equal(module.includes(forbidden), false, `shell-attach.cjs must not poll or fetch (found ${forbidden})`);
  }
  // ONE timer in the whole connected path, and it is the idle lock that already existed.
  const timers = (read(MAIN).match(/setInterval\(/g) || []).length;
  assert.equal(timers, 1, `main.cjs must keep its one interval (the idle lock), found ${timers}`);
  // The connected bar is the SERVER's document: the client has no markup for it.
  const html = read(path.join(ROOT, 'desktop', 'shell.html'));
  for (const serverSide of ['id="shell-bar"', 'id="shell-frame"', 'sf-right', 'sf-orb']) {
    assert.equal(html.includes(serverSide), false, `the client's own document must not build the connected bar (found ${serverSide})`);
  }
  const shell = read(path.join(ROOT, 'desktop', 'shell.mjs'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/getElementById\(['"](shell-bar|shell-frame)['"]\)|sf-(bar|left|right|orb)\b/.test(shell), false,
    'and its script must not touch the connected shell (comments may name it)');
});

test('the client’s hardening is unchanged, and the shell is same-origin', () => {
  const source = read(MAIN);
  assert.match(source, /const preferences=\(ses\)=>\(\{session:ses,preload:path\.join\(__dirname,'preload\.cjs'\),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false\}\);/);
  assert.match(source, /current\.webContents\.setWindowOpenHandler\(\(\{url\}\)=>\{void openExternal\(url\);return \{action:'deny'\};\}\);/);
  // The shell is fetched from the SAME origin the window is already on, so no new origin, permission
  // or preload surface is created for it: the permission handlers still name `config.server`.
  assert.match(source, /if\(from!==config\.server&&requesting!==captureDocument\)return false;/);
  const html = read(path.join(ROOT, 'desktop', 'shell.html'));
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'/);
});

test('the journey that measures all of this is committable and parses', () => {
  assert.ok(fs.existsSync(JOURNEY));
  // A CLAIMED GATE IS NOT A RUN.
  execFileSync(process.execPath, ['--check', JOURNEY], { stdio: 'pipe' });
  const journey = read(JOURNEY);
  for (const claim of ['exactly one top-level load', 'the shell loaded once', 'must be the SAME node',
    'a same-origin top-level navigation must be refused after the attach', 'never loaded again']) {
    assert.ok(journey.includes(claim), `the journey must still assert: ${claim}`);
  }
  assert.equal(fs.readdirSync(__dirname).includes('shell-attach-journey.test.cjs'), false, 'it runs under Electron, not node --test');
});
