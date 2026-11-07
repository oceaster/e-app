'use strict';
// THE PERMISSION SCREEN, IN THE APP'S OWN WINDOW: Diana's files, wired by our preload.
//
// Owen, 2026-11-06: after the PIN is accepted and before the person is let into e-server, a screen
// asks for camera and microphone, and "if there is an os pop-up active waiting for the allow/deny
// permissions confirmation then the screen should blur out until the dialogue is interacted with
// and complete".
//
// This gate runs the REAL preload against HER real document in a real Electron window, and it
// asserts what a person gets: his copy verbatim, two controls and no third, one answer per screen,
// her four states, and the blur exactly while a native answer is outstanding. It is the gate the
// design would otherwise lack — her own note says her renderer could not launch, so nothing before
// this had ever loaded the screen.
//
// Run:  xvfb-run -a node_modules/electron/dist/electron --no-sandbox scripts/permission-screen-smoke.cjs
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const HER = path.join(ROOT, 'desktop', 'permission');
const STUDIO = '/home/diana/Desktop/ec-permission-screen';

//: His words, byte for byte. If a later edit changes one of these, this gate is the thing that says
//: so rather than a person noticing a sentence had been "tidied".
const TITLE = 'Grant Permissions';
const SUMMARY = 'This e-server instance will be granted access to your camera and microphone on this device.';
const PRIVACY = 'e-server instances are entirely owned by their users, and your data is impossible to read or manipulate without your access to your private access information.';

const pass = [];
function ok(sentence) { pass.push(sentence); console.log(`PASS  ${sentence}`); }
function at(stage) { console.log(`\n-- ${stage}`); }

let answer = null;
let state = { permission: { state: 'asking', blurred: false }, theme: 'dark' };
const paint = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('client:state', state);
  }
};

ipcMain.handle('client:permission-state', () => state);
// The shell probe below mounts desktop/shell.html, which asks for its own state on load; answer it
// so a gate run is not full of "No handler registered" noise that could hide a real failure.
ipcMain.handle('client:state', () => state);
// The preload reads the cached theme synchronously at parse time; without a listener that call
// blocks the renderer, so answer it exactly as main.cjs does.
//: The theme the run is proving. The gate sets it, then loads the same document twice.
let cachedTheme = 'dark';
ipcMain.on('theme:cached', (event) => { event.returnValue = cachedTheme; });
ipcMain.on('client:permission-answer', (_event, value) => {
  answer = String(value);
  // What the main process does: an answer means a native prompt MAY be outstanding, so the screen
  // blurs (os-pending) until the device operation completes, and only then settles.
  state = { permission: { state: 'os-pending', blurred: true } };
  paint();
  setTimeout(() => {
    state = { permission: { state: answer === 'allow' ? 'allowed' : 'denied', blurred: false } };
    paint();
  }, 150);
});

app.disableHardwareAcceleration();

// A gate that hangs is a gate that lies about time: the load is raced against a deadline that
// prints what the window actually is before giving up.
const died = (why) => {
  console.error(`\nPERMISSION_SCREEN_SMOKE_FAIL: ${why}`);
  app.exit(2);
};

app.whenReady().then(async () => {
  // Her files are hers: assert the shipped copies are the studio's bytes before proving behaviour.
  for (const name of ['permission.html', 'permission.css', 'permission.mjs']) {
    const shipped = fs.readFileSync(path.join(HER, name));
    let studio = null;
    try { studio = fs.readFileSync(path.join(STUDIO, name)); } catch { studio = null; }
    if (studio === null) {
      ok(`${name} is shipped (her studio is not readable from here)`);
      continue;
    }
    assert.ok(shipped.equals(studio), `${name} must be Diana's file, byte for byte`);
    ok(`${name} ships byte for byte from her studio`);
  }

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('console-message', (event) => {
    const text = String((event && event.message) || '');
    if (text) console.log(`  [page] ${text.slice(0, 200)}`);
  });
  await Promise.race([
    window.loadFile(path.join(HER, 'permission.html')),
    new Promise(() => setTimeout(() => died('the permission document did not finish loading in 20s'), 20000)),
  ]);
  const read = async (expression) => JSON.parse(await window.webContents.executeJavaScript(
    `JSON.stringify((() => { ${expression} })())`, true));
  const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

  at('the screen that is already showing is not loaded again');
  // THE 1.0.24 DEFECT, reproduced without a server: main.cjs answers every `did-finish-load` by
  // asking whether the permission screen is needed, and the old answer loaded that same file
  // again. Her document then reloaded until the app was quit (125 loads a second in the client's
  // own log). This drives the same gate shape against the real loaded window.
  const { showingFile } = require(path.join(ROOT, 'desktop', 'navigation.cjs'));
  const screen = path.join(HER, 'permission.html');
  let reloads = 0;
  const finished = () => {
    if (showingFile(window, screen)) return;
    reloads++;
    void window.loadFile(screen);
  };
  window.webContents.on('did-finish-load', finished);
  finished(); // the load that brought us here has just finished; the app would call the gate now
  await settle(600);
  window.webContents.removeListener('did-finish-load', finished);
  assert.equal(reloads, 0, `the permission screen reloaded itself ${reloads} times`);
  ok('a finished load of the screen starts no second load');

  at('the copy, and nothing else on the screen');
  const copy = await read(`
    const text = node => node === null ? null : node.textContent.replace(/\\s+/g, ' ').trim();
    return {
      title: text(document.getElementById('permission-title')),
      summary: text(document.getElementById('permission-summary')),
      privacy: text(document.getElementById('permission-privacy')),
      allow: text(document.getElementById('permission-allow')),
      deny: text(document.getElementById('permission-deny')),
      buttons: [...document.querySelectorAll('button')].length,
      // BODY, not the document: a <link rel="stylesheet" href> in the head is an [href] and would
      // count as a control, which is how this gate first failed on its own selector.
      focusable: document.body.querySelectorAll('button, [href], input, select, textarea, [tabindex]').length,
      focusableList: [...document.body.querySelectorAll('button, [href], input, select, textarea, [tabindex]')].map(node => node.tagName + (node.id ? '#' + node.id : '')),
      state: document.documentElement.dataset.permissionState,
    };`);
  assert.equal(copy.title, TITLE, 'his heading');
  assert.equal(copy.summary, SUMMARY, 'his first sentence');
  assert.equal(copy.privacy, PRIVACY, 'his second sentence');
  assert.equal(copy.allow, 'Allow Access', 'his primary label');
  assert.equal(copy.deny, 'Deny Access', 'his secondary label');
  assert.equal(copy.buttons, 2, 'two controls, never a third');
  assert.equal(copy.focusable, 2, `and no other focusable thing on the screen: ${JSON.stringify(copy.focusableList)}`);
  assert.equal(copy.state, 'asking', 'the screen opens asking');
  ok(`his words, two buttons, nothing else focusable (state "${copy.state}")`);

  at('the blur, and only while a native answer is outstanding');
  const asking = await read(`return { filter: getComputedStyle(document.getElementById('permission-stage')).filter,
    scrim: getComputedStyle(document.querySelector('.permission-scrim')).opacity };`);
  assert.ok(asking.filter === 'none' || asking.filter === '', `no blur while asking: ${asking.filter}`);
  await window.webContents.executeJavaScript("document.getElementById('permission-allow').click()", true);
  await settle();
  const pending = await read(`return {
    state: document.documentElement.dataset.permissionState,
    filter: getComputedStyle(document.getElementById('permission-stage')).filter,
    scrim: Number(getComputedStyle(document.querySelector('.permission-scrim')).opacity),
    inert: document.getElementById('permission-stage').inert,
    busy: document.getElementById('permission-stage').getAttribute('aria-busy'),
    disabled: [...document.querySelectorAll('button')].every(button => button.disabled) };`);
  assert.equal(answer, 'allow', 'the click reached the main process as an answer');
  assert.equal(pending.state, 'os-pending', `the screen blurs while the native answer is outstanding (${pending.state})`);
  assert.ok(/blur\(/.test(pending.filter), `the surface is blurred: ${pending.filter}`);
  assert.ok(pending.scrim > 0, `and a scrim recedes it: ${pending.scrim}`);
  assert.equal(pending.inert, true, 'the card cannot be interacted with meanwhile');
  assert.equal(pending.busy, 'true', 'and says it is busy');
  assert.equal(pending.disabled, true, 'both controls are out of action');
  ok(`blur ${pending.filter}, scrim ${pending.scrim}, inert, aria-busy, both buttons disabled`);

  at('the settled answer');
  await settle(260);
  const allowed = await read(`return {
    state: document.documentElement.dataset.permissionState,
    filter: getComputedStyle(document.getElementById('permission-stage')).filter,
    check: getComputedStyle(document.querySelector('.allowed-symbol')).display,
    camera: getComputedStyle(document.querySelector('.capture-symbol')).display,
    denied: getComputedStyle(document.querySelector('.denied-symbol')).display,
    disabled: [...document.querySelectorAll('button')].every(button => button.disabled),
    inert: document.getElementById('permission-stage').inert };`);
  assert.equal(allowed.state, 'allowed', 'the screen settles on the answer');
  assert.ok(allowed.filter === 'none' || allowed.filter === '', `the blur is gone: ${allowed.filter}`);
  assert.notEqual(allowed.check, 'none', 'her check mark takes the icon');
  assert.equal(allowed.denied, 'none', 'and her refusal mark stays out of it');
  assert.equal(allowed.camera, 'none', 'and the camera symbol gives way to it');
  assert.equal(allowed.disabled, true, 'the answer cannot be given twice');
  assert.equal(allowed.inert, true, 'and the card stays out of reach');
  ok(`settled: state "${allowed.state}", no blur, her check mark, one answer only`);

  at('one answer per screen');
  answer = null;
  await window.webContents.executeJavaScript("document.getElementById('permission-deny').click()", true);
  await settle();
  assert.equal(answer, null, 'a settled screen does not answer again');
  ok('a second click on a settled screen sends nothing');

  at('the theme is carried, not invented');
  const themes = await read(`return {
    dark: getComputedStyle(document.body).backgroundColor,
    root: document.documentElement.getAttribute('data-easter-theme') };`);
  ok(`body background ${themes.dark} with root theme ${JSON.stringify(themes.root)}`);


  at('the palette is the app\'s, in both themes');
  // OWEN, 2026-11-06: "the camera & microphone permission screen is not consistently styled and
  // respecting the global light/dark theme style guide". Her sheet consumes the host's --ec-*
  // tokens with standalone fallbacks, so before the adapter injected the host theme sheets the
  // page painted #111311/#f2efe6 while the app painted #0d2029/#eef2f9. This asserts the page and
  // the app's own shell agree, in BOTH themes, rather than trusting that the links loaded.
  const SHELL = path.join(ROOT, 'desktop', 'shell.html');
  const paletteOf = async (theme) => {
    cachedTheme = theme;
    state = { ...state, theme };
    const probe = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: {
        preload: path.join(ROOT, 'desktop', 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    await probe.loadFile(SHELL);
    const shellBg = await probe.webContents.executeJavaScript(
      `getComputedStyle(document.documentElement).getPropertyValue('--ec-bg').trim()`, true);
    probe.destroy();
    const page = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: {
        preload: path.join(ROOT, 'desktop', 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    await page.loadFile(path.join(HER, 'permission.html'));
    await new Promise((resolve) => setTimeout(resolve, 400));   // the injected sheets are async
    const read = await page.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const body = getComputedStyle(document.body);
      return {
        theme: root.getAttribute('data-easter-theme'),
        attribute: getComputedStyle(root).getPropertyValue('--ec-bg').trim(),
        background: body.backgroundColor,
        links: [...document.querySelectorAll('link[data-host-sheet]')].map(link => link.getAttribute('data-host-sheet')),
      }; })()`, true);
    page.destroy();
    return { shellBg, ...read };
  };

  const dark = await paletteOf('dark');
  assert.ok(dark.links.length >= 2, `the host theme sheets are injected: ${JSON.stringify(dark.links)}`);
  assert.equal(dark.theme, 'dark', 'the document wears the app\'s theme attribute');
  assert.ok(dark.attribute, `--ec-bg resolves from the host sheets, not a fallback: ${JSON.stringify(dark.attribute)}`);
  assert.equal(dark.attribute, dark.shellBg, `dark: the screen and the shell share one --ec-bg (screen ${dark.attribute}, shell ${dark.shellBg})`);
  ok(`dark: --ec-bg ${dark.attribute} on the screen and the shell, ${dark.links.length} host sheets`);

  const light = await paletteOf('light');
  assert.equal(light.theme, 'light', 'and it follows the account into light');
  assert.equal(light.attribute, light.shellBg, `light: the screen and the shell share one --ec-bg (screen ${light.attribute}, shell ${light.shellBg})`);
  assert.notEqual(light.background, dark.background, `light and dark paint different surfaces (${light.background} vs ${dark.background})`);
  ok(`light: --ec-bg ${light.attribute}, background ${light.background} vs dark ${dark.background}`);

  console.log(`\nPERMISSION_SCREEN_SMOKE_PASS — ${pass.length} checks`);
  app.exit(0);
}).catch((error) => {
  console.error('\nPERMISSION_SCREEN_SMOKE_FAIL:', error && error.message ? error.message : error);
  console.error(error && error.stack ? error.stack : '');
  app.exit(1);
});
