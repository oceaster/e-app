'use strict';
// THE INSTANCE MENU'S STATIC GATE — the wiring no browser is needed to prove.
//
// The measured half is tests/instance-menu-journey.cjs (the real document in a real Electron
// window: rows, role actions, the create and rename pages, the glass bar). This file holds the
// things a screenshot cannot: the document carries every view the code addresses, the preload
// exposes exactly the six calls the page names, the main process registers them behind the one
// door, and the boot no longer has a path that skips the menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const CHROME = read('desktop/shell.html');
const SHELL = read('desktop/shell.mjs');
const PRELOAD = read('desktop/preload.cjs');
const MAIN = read('desktop/main.cjs');
const JOURNEY = path.join(ROOT, 'tests', 'instance-menu-journey.cjs');

test('the document carries the menu, the create page and the rename page', () => {
  for (const id of ['client-servers', 'servers', 'server-list', 'instance-create', 'create-instance-view',
    'create-instance', 'create-name', 'create-domain', 'plan-list', 'create-summary', 'create-submit',
    'rename-instance-view', 'rename-instance', 'rename-name', 'rename-submit', 'instances-unavailable',
    'instances-error', 'instances-retry']) {
    assert.ok(CHROME.includes(`id="${id}"`), `the document must carry #${id}`);
  }
  // THE ROW ACTIONS ARE BUILT IN THE RENDERER, from the service's own `role`; the document must
  // not ship a hard-coded owner or member action that could disagree with it.
  assert.equal(/server-rename"|server-delete"|server-leave"/.test(CHROME), false, 'row actions are not frozen into the markup');
});

test('the renderer names the six calls and draws every part of a row', () => {
  for (const call of ['bridge.instances()', 'bridge.plans()', 'bridge.createInstance(',
    'bridge.renameInstance(', 'bridge.deleteInstance(', 'bridge.leaveInstance(']) {
    assert.ok(SHELL.includes(call), `shell.mjs must call ${call}`);
  }
  // One row carries the requirement's two identifiers and the role: display name, domain, role.
  for (const part of ["className='server-name'", "className='server-origin'", "className='server-role'",
    "className='server-actions'", "className='server-billing'"]) {
    assert.ok(SHELL.includes(part), `a row must include ${part}`);
  }
  // OWNER AND MEMBER ARE THE SERVICE'S `role`, never a guess from who is signed in.
  assert.match(SHELL, /inst\.owned\?'Owner':'Member'/, 'the role word comes from the instance');
  // The plan list is the service's and the page never invents a price.
  assert.match(SHELL, /const ready=plans\.loaded&&plans\.configured/, 'the create action needs a configured catalogue');
  // The signed-out mood is one body attribute, set from the account the main process publishes.
  assert.match(SHELL, /document\.body\.dataset\.accountState=signedIn\?'signed-in':'signed-out'/, 'the bar mood is the account state');
});

test('the preload exposes the instance calls and nothing secret', () => {
  const setup = PRELOAD.slice(PRELOAD.indexOf("exposeInMainWorld('eServerSetup'"), PRELOAD.indexOf("exposeInMainWorld('eServerChrome'"));
  assert.match(setup, /instances:\(\)=>ipcRenderer\.invoke\('client:instances-refresh'\)/);
  assert.match(setup, /plans:\(\)=>ipcRenderer\.invoke\('client:instance-plans'\)/);
  assert.match(setup, /createInstance:payload=>ipcRenderer\.invoke\('client:instance-create',payload\)/);
  assert.match(setup, /renameInstance:\(id,name\)=>ipcRenderer\.invoke\('client:instance-rename',id,name\)/);
  assert.match(setup, /deleteInstance:id=>ipcRenderer\.invoke\('client:instance-delete',id\)/);
  assert.match(setup, /leaveInstance:id=>ipcRenderer\.invoke\('client:instance-leave',id\)/);
  assert.doesNotMatch(setup, /token|bearer|authorization|credential/i, 'no credential crosses this bridge');
});

test('the main process registers all six behind the setup window door', () => {
  for (const channel of ['client:instances-refresh', 'client:instance-plans', 'client:instance-create',
    'client:instance-rename', 'client:instance-delete', 'client:instance-leave']) {
    assert.ok(MAIN.includes(`ipcMain.handle('${channel}'`), `main.cjs must handle ${channel}`);
  }
  // EVERY handler is wrapped in `answered`, which is `local(event)` + a sentence-shaped refusal.
  const block = MAIN.slice(MAIN.indexOf("ipcMain.handle('client:instances-refresh'"), MAIN.indexOf("ipcMain.handle('client:instance-leave'") + 200);
  for (const line of block.split('\n').filter((text) => text.includes('ipcMain.handle'))) {
    assert.ok(line.includes('answered('), `every instance handler goes through the answered door: ${line.trim()}`);
  }
  // The owner's delete confirmation names the paid period, because the instance is NOT gone yet.
  assert.match(MAIN, /stays active until the paid period ends/, 'the delete confirmation says what actually happens');
});

test('the instance menu is the first screen of a signed-in boot, with no auto-connect path', () => {
  // THE RETIRED BEHAVIOUR: a stored `openOnStart` used to send the app straight to the last
  // server. Owen, 2026-11-09: the menu is always the first screen after boot or sign-in.
  assert.equal(/config\.openOnStart\s*=/.test(MAIN), false, 'nothing sets openOnStart any more');
  assert.equal(/openOnStart\s*&&/.test(MAIN), false, 'nothing branches on openOnStart any more');
  assert.match(MAIN, /if\(company\?\.authorized\(\)\)await afterCompany\(\);else await connect\(\);/, 'a signed-in boot opens the account screens');
  assert.match(MAIN, /setupWindow\(\);await Promise\.all\(\[refreshServers\(\),refreshInstances\(\)\]\)/, 'the menu reads both sources when it opens');
});

test('the measured journey is committable, parses, and is not swept into node --test', () => {
  assert.ok(fs.existsSync(JOURNEY), 'tests/instance-menu-journey.cjs is the measured half');
  execFileSync(process.execPath, ['--check', JOURNEY], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', path.join(__dirname, 'fixtures', 'shell-bridge.cjs')], { stdio: 'pipe' });
  const journey = fs.readFileSync(JOURNEY, 'utf8');
  for (const claim of ['submitting the form asks the main process to sign in',
    'the owned instance: display name, domain, and only the owner actions',
    'the member instance offers Leave and no owner action',
    'the page asked for one rename',
    'the sentence names the deadline',
    'the plans are the service’s',
    'the create request carries the display name, the domain and the chosen plan',
    'the signed-out bar is translucent']) {
    assert.ok(journey.includes(claim), `the journey must still assert: ${claim}`);
  }
  assert.equal(fs.readdirSync(__dirname).includes('instance-menu-journey.test.cjs'), false, 'the journey is not a node --test file');
});

test('the transport keeps the account token out of every answer', () => {
  const source = read('desktop/instances.cjs');
  assert.match(source, /Authorization:'Bearer '\+bearer/, 'one bearer header');
  assert.equal((source.match(/this\.credential\(\)/g) || []).length, 1, 'one door to the Company token');
  assert.doesNotMatch(source, /console\.log|console\.error/, 'no request or answer is logged');
});
