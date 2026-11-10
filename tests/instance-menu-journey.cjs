'use strict';
// THE INSTANCE MENU'S JOURNEY, IN THE REAL CLIENT WINDOW.
//
// Owen, 2026-11-09: the instance menu is the first screen after sign-in; every instance carries a
// display name and a domain; the owner renames and deletes (the plan cancels at the end of the paid
// period) and a member leaves; a new instance is created through a full page with a plan and
// Stripe. This drives that page with the same published state the main process publishes and
// asserts what the person can SEE and what the page ASKS the main process to do.
//
// The service itself is desktop/instances.cjs's own contract, proved by tests/instances.test.cjs
// against a transport double; this file proves the other half — the screen.
//
// Not part of `node --test`: it needs Electron and a display.
//   xvfb-run -a npx electron tests/instance-menu-journey.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const SHELL = process.env.INSTANCE_MENU_SHELL || path.join(ROOT, 'desktop', 'shell.html');
const PRELOAD = path.join(__dirname, 'fixtures', 'shell-bridge.cjs');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-menu-shots-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-menu-home-'));
app.setPath('userData', home);

const ACCOUNT = { id: 7, username: 'oceaster', name: 'Owen Easter', roles: ['owner'], providers: ['microsoft'], picture: null };
const INSTANCES = [
  {
    id: 'cy', displayName: 'Cy', domain: 'cy.instance.easter.company', origin: 'https://cy.instance.easter.company',
    role: 'owner', owned: true, state: 'active',
    plan: { key: 'family', name: 'Family', includedTokensBillions: 0 },
    billing: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-01T00:00:00Z' },
    deletion: { scheduledFor: null },
  },
  {
    id: 'studio', displayName: 'Studio', domain: 'studio.instance.easter.company',
    origin: 'https://studio.instance.easter.company', role: 'owner', owned: true, state: 'active',
    plan: { key: 'professional', name: 'Professional', includedTokensBillions: 10 },
    billing: { status: 'pending', cancelAtPeriodEnd: false, currentPeriodEnd: null },
    deletion: { scheduledFor: null },
  },
  {
    id: 'workshop', displayName: 'Workshop', domain: 'workshop.instance.easter.company',
    origin: 'https://workshop.instance.easter.company', role: 'member', owned: false, state: 'active',
    plan: { key: 'personal', name: 'Personal', includedTokensBillions: 1 },
    billing: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: null },
    deletion: { scheduledFor: null },
  },
  // AN INSTANCE THAT PREDATES DOMAINS: the service publishes null rather than inventing one.
  {
    id: 'legacy', displayName: 'Legacy', domain: null, origin: null, role: 'member', owned: false,
    state: 'active', plan: null, billing: { status: 'none', cancelAtPeriodEnd: false, currentPeriodEnd: null },
    deletion: { scheduledFor: null },
  },
];
const SERVERS = {
  state: 'ready', limit: 50, fallback: '',
  rows: [{ id: 'c1', label: 'legacy', origin: 'https://legacy.example:8443' }],
};
const PLANS = {
  loaded: true, configured: true, mode: 'test', error: '',
  rows: [
    { key: 'family', name: 'Family', monthlyPence: 1299, currency: 'GBP', includedTokensBillions: 0, description: 'Metered usage', price: '£12.99 / month' },
    { key: 'personal', name: 'Personal', monthlyPence: 499, currency: 'GBP', includedTokensBillions: 1, description: 'One billion tokens', price: '£4.99 / month' },
  ],
};
const BASE = {
  phase: 'setup', account: ACCOUNT, accountReady: true, version: '0.0.0-test', theme: 'dark',
  title: 'Your e-servers.', view: 'servers', servers: SERVERS,
  instances: { state: 'ready', rows: INSTANCES, error: '', available: true },
  plans: { loaded: false, configured: false, mode: null, rows: [], error: '' },
};

const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({
    width: 680, height: 900, show: false,
    webPreferences: { preload: PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  win.setContentSize(680, 900);
  await settle(120);
  await win.loadFile(SHELL);
  await settle(350);

  const run = (code) => win.webContents.executeJavaScript(code, true);
  const push = async (next) => { await run(`window.__barTest.push(${JSON.stringify(next)})`); await settle(); };
  const calls = () => run('window.__barTest.calls()');
  const shot = async (name) => {
    const file = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    return file;
  };
  const report = { shots: [] };

  // ── the sign-in page RESPONDS. The regression this fixes was a module that threw before it
  //    subscribed to state, so the form looked alive and nothing ever happened. The real page's
  //    own form is submitted here, and the call it makes is the proof the module is wired.
  const signedInCall = await run(`(() => {
    const form = document.querySelector('#account-root form');
    const identifier = form.querySelector('input[name="identifier"]');
    const password = form.querySelector('input[name="password"]');
    if (!form || !identifier || !password) return { ok: false, form: !!form };
    identifier.value = 'oceaster';
    password.value = 'correct horse battery staple';
    form.querySelector('button[type="submit"]').click();
    return { ok: true };
  })()`);
  assert.equal(signedInCall.ok, true, 'the sign-in page still carries its form, identifier and password fields');
  await settle(200);
  const login = (await calls()).find(call => call[0] === 'login');
  assert.deepEqual(login, ['login', 'oceaster', 'correct horse battery staple'], `submitting the form asks the main process to sign in, calls=${JSON.stringify(await calls())}`);

  await push(BASE);

  // ── the first screen: one row per instance, name and domain, and the actions each role has ──
  const menu = await run(`(() => {
    const rows = [...document.querySelectorAll('#server-list .server-row')].map(row => ({
      name: row.querySelector('.server-name')?.textContent || '',
      domain: row.querySelector('.server-origin')?.textContent || '',
      role: row.querySelector('.server-role')?.textContent || '',
      actions: [...row.querySelectorAll('.server-actions button')].map(b => b.textContent),
      connect: !!row.querySelector('.server-connect'),
    }));
    return {
      rows,
      create: document.getElementById('instance-create')?.textContent || '',
      add: document.getElementById('server-add')?.textContent || '',
      state: document.getElementById('client-servers')?.dataset.state,
      heading: document.getElementById('title')?.textContent || '',
    };
  })()`);
  report.menu = menu;
  report.shots.push(await shot('680x900-instance-menu'));
  assert.equal(menu.state, 'ready', 'the menu is a ready list');
  assert.equal(menu.heading, 'Your e-servers.', 'the first screen is the account’s e-servers');
  assert.equal(menu.rows.length, 5, `four instances and one address-only row, measured ${JSON.stringify(menu.rows.map(r => r.name))}`);
  assert.deepEqual(menu.rows[0], { name: 'Cy', domain: 'cy.instance.easter.company', role: 'Owner', actions: ['Rename', 'Delete'], connect: true }, 'the owned instance: display name, domain, and only the owner actions');
  assert.deepEqual(menu.rows[1], { name: 'Studio', domain: 'studio.instance.easter.company', role: 'Owner', actions: ['Rename', 'Delete'], connect: true }, 'a SECOND owned instance is a normal row with the owner actions (no cap)');
  assert.deepEqual(menu.rows[2], { name: 'Workshop', domain: 'workshop.instance.easter.company', role: 'Member', actions: ['Leave'], connect: true }, 'the member instance offers Leave and no owner action');
  assert.deepEqual(menu.rows[3], { name: 'Legacy', domain: 'No domain yet', role: 'Member', actions: ['Leave'], connect: true }, 'an instance that predates domains says so, rather than inventing an address');
  assert.equal(await run(`document.querySelectorAll('#server-list .server-row')[3].querySelector('.server-connect').disabled`), true, 'and its Connect is disabled: there is nowhere to go');
  assert.deepEqual(menu.rows[4], { name: 'legacy', domain: 'legacy.example:8443', role: '', actions: ['Remove'], connect: true }, 'an address the instance service does not know keeps Remove');
  assert.match(menu.create, /Create a new e-server/i, 'the create action is on the menu');
  assert.match(menu.add, /Add an existing e-server/i, 'so is the existing add action');

  // ── rename: the page opens with the current name, and sends the new one ─────────────────────
  await run(`document.querySelectorAll('#server-list .server-row')[0].querySelector('.server-rename').click()`);
  await settle();
  const renameOpen = await run(`(() => ({ view: document.getElementById('client-servers').dataset.state,
    shown: !document.getElementById('rename-instance-view').hidden,
    value: document.getElementById('rename-name').value }))()`);
  assert.equal(renameOpen.shown, true, 'Rename opens the rename page');
  assert.equal(renameOpen.value, 'Cy', 'prefilled with the display name');
  report.shots.push(await shot('680x900-rename'));
  await run(`(() => { const input = document.getElementById('rename-name'); input.value = 'Cyan'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('rename-instance').requestSubmit(); return true; })()`);
  await settle(300);
  const afterRename = await calls();
  assert.deepEqual(afterRename.find(call => call[0] === 'renameInstance'), ['renameInstance', 'cy', 'Cyan'], `the page asked for one rename, calls=${JSON.stringify(afterRename)}`);

  // ── delete: the confirmation is the main process's, the page asks once, and the sentence names
  //    the end of the paid period rather than a deletion that has not happened ─────────────────
  await push(BASE);
  await run(`document.querySelectorAll('#server-list .server-row')[0].querySelector('.server-delete').click()`);
  await settle(300);
  const afterDelete = await calls();
  assert.deepEqual(afterDelete.find(call => call[0] === 'deleteInstance'), ['deleteInstance', 'cy'], 'the page asked to delete that instance');
  const deletedSentence = await run(`document.getElementById('servers-status').textContent`);
  assert.match(deletedSentence, /when its paid period ends on Dec 15, 2026/i, `the sentence names the deadline, measured "${deletedSentence}"`);

  // ── leave: the member's one action ─────────────────────────────────────────────────────────
  await push(BASE);
  await run(`document.querySelectorAll('#server-list .server-row')[2].querySelector('.server-leave').click()`);
  await settle(300);
  const afterLeave = await calls();
  assert.deepEqual(afterLeave.find(call => call[0] === 'leaveInstance'), ['leaveInstance', 'workshop'], 'the page asked to leave that instance');

  // ── create: a full page, the service's plans, and one request that names all three fields ───
  await push({ ...BASE, view: 'servers', plans: PLANS });
  await run(`document.getElementById('instance-create').click()`);
  await settle();
  const createOpen = await run(`(() => ({
    shown: !document.getElementById('create-instance-view').hidden,
    plans: [...document.querySelectorAll('#plan-list .plan-option')].map(o => ({
      name: o.querySelector('.plan-name')?.textContent || '',
      price: o.querySelector('.plan-price')?.textContent || '',
      checked: o.querySelector('input')?.checked === true,
    })),
    submitDisabled: document.getElementById('create-submit').disabled,
  }))()`);
  report.create = createOpen;
  report.shots.push(await shot('680x900-create'));
  assert.equal(createOpen.shown, true, 'Create opens the full create page');
  assert.deepEqual(createOpen.plans.map(p => [p.name, p.price]), [['Family', '£12.99 / month'], ['Personal', '£4.99 / month']], 'the plans are the service’s, with the service’s prices');
  assert.equal(createOpen.plans[0].checked, true, 'the first plan is selected, so the button can work');
  assert.equal(createOpen.submitDisabled, false, 'and the action is available');

  await run(`(() => {
    const name = document.getElementById('create-name'); name.value = 'Studio'; name.dispatchEvent(new Event('input', { bubbles: true }));
    const domain = document.getElementById('create-domain'); domain.value = 'studio.instance.easter.company'; domain.dispatchEvent(new Event('input', { bubbles: true }));
    const second = document.querySelectorAll('#plan-list input')[1]; second.checked = true; second.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('create-instance').requestSubmit();
    return true;
  })()`);
  await settle(350);
  const afterCreate = await calls();
  assert.deepEqual(afterCreate.find(call => call[0] === 'createInstance'),
    ['createInstance', { displayName: 'Studio', domain: 'studio.instance.easter.company', plan: 'personal' }],
    `the create request carries the display name, the domain and the chosen plan, calls=${JSON.stringify(afterCreate)}`);
  const afterCreateSentence = await run(`document.getElementById('servers-status').textContent`);
  assert.match(afterCreateSentence, /Finish the payment in your browser/i, `the page says where the payment happens, measured "${afterCreateSentence}"`);
  assert.equal(await run(`document.getElementById('create-instance-view').hidden`), true, 'and returns to the menu');

  // ── a service without the plane says so, and does not offer an action it cannot honour ──────
  await push({ ...BASE, instances: { state: 'empty', rows: [], error: '', available: false } });
  const unavailable = await run(`(() => ({
    note: !document.getElementById('instances-unavailable').hidden,
    create: document.getElementById('instance-create').hidden,
    rows: document.querySelectorAll('#server-list .server-row').length,
  }))()`);
  report.unavailable = unavailable;
  assert.equal(unavailable.note, true, 'the capability sentence is shown');
  assert.equal(unavailable.create, true, 'and the create action is withdrawn');
  assert.equal(unavailable.rows, 1, 'the address-only row still connects');

  // ── the signed-out bar is glass ────────────────────────────────────────────────────────────
  await push({ phase: 'auth', account: null, accountReady: false, view: 'servers', servers: { state: 'idle', rows: [] }, instances: { state: 'idle', rows: [] } });
  // The parsing stays in Node: a regex inside a template literal is escaped by the literal, and
  // the page only has to answer what its computed style says.
  const glass = await run(`(() => {
    const bar = document.querySelector('.sf-bar');
    const style = getComputedStyle(bar);
    return {
      state: document.body.dataset.accountState,
      background: style.backgroundColor,
      backdrop: style.backdropFilter || style.webkitBackdropFilter || '',
      pill: document.getElementById('account-pill').getBoundingClientRect().height,
    };
  })()`);
  const alphaOf = (value) => {
    const text = String(value || '');
    const rgba = /rgba?\(([^)]+)\)/.exec(text);
    if (rgba) { const parts = rgba[1].split(',').map(part => part.trim()); return parts.length === 4 ? Number(parts[3]) : 1; }
    const color = /color\([^)]*\/\s*([0-9.]+)\s*\)/.exec(text);
    return color ? Number(color[1]) : 1;
  };
  glass.alpha = alphaOf(glass.background);
  report.glass = glass;
  report.shots.push(await shot('680x900-signed-out-glass'));
  assert.equal(glass.state, 'signed-out', 'the document knows nobody is signed in');
  assert.ok(glass.alpha < 1, `the signed-out bar is translucent, measured ${glass.background}`);
  assert.match(glass.backdrop, /blur/, `and blurs what is behind it, measured "${glass.backdrop}"`);
  assert.equal(glass.pill, 32, 'the account pill is still the glass row’s one control');

  console.log(JSON.stringify({ ok: true, ...report }, null, 1));
  console.log('SHOTS ' + SHOTS);
}

main().then(() => app.quit()).catch((error) => {
  console.error('JOURNEY FAILED:', error && error.message ? error.message : error);
  console.error(error && error.stack ? error.stack : '');
  if (error && error.actual !== undefined) console.error('actual', error.actual, '\nexpected', error.expected);
  console.error('SHOTS ' + SHOTS);
  app.exit(1);
});
