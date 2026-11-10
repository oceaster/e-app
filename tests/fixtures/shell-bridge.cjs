'use strict';
// A DISPOSABLE SEAM FOR THE BAR'S JOURNEY — the client's own bridge, scripted.
//
// The journey (tests/shell-bar-journey.cjs) must show the REAL document (desktop/shell.html + its
// vendored sheets + desktop/shell.mjs) in a REAL Electron window, in every state a signed-in person
// can be in before an instance is connected. Signing in for real would need the accounts service and
// a credential, so this preload answers with the same shape desktop/preload.cjs answers with and the
// journey pushes one state at a time through `window.__barTest.push`.
//
// It is a TEST FIXTURE and it ships nowhere: the app's build.files carries desktop/** and
// package.json only, so tests/ is not in the archive.
const { contextBridge } = require('electron');

let current = { phase: 'auth', version: '0.0.0-test', account: null, accountReady: false, accountBusy: false, servers: { state: 'idle', rows: [] }, view: 'servers', theme: 'dark' };
const listeners = []; // desktop/shell.mjs's bridge.onState(render)
let pushes = 0;
const calls = [];

contextBridge.exposeInMainWorld('eServerSetup', {
  // The whole published state, exactly the channel the main process uses (`client:state`).
  state: async () => current,
  onState: (listener) => { listeners.push(listener); return () => {}; },
  providers: async () => ({ providers: [] }),
  theme: 'dark',
  themeRefresh: async () => ({ ok: true }),
  // Every other call is a no-op that resolves, so a view can be drawn without a main process.
  login: async (identifier, password) => { calls.push(['login', identifier, password]); return { ok: true }; },
  provider: async () => {}, finish: async () => {}, cancelAccount: async () => {},
  signOut: async () => {}, view: async (value) => { calls.push(['view', value]); current = { ...current, view: value }; for (const listener of listeners) listener(current); return current; },
  refresh: async () => {}, connect: async (origin) => { calls.push(['connect', origin]); return { ok: true }; },
  addServer: async () => ({ ok: false, error: 'fixture' }), removeServer: async () => {}, retry: async () => {},
  download: async () => {},
  // THE INSTANCE MENU. Each call is recorded so a journey can assert WHAT the page asked the
  // main process to do, then answers the shape desktop/instances.cjs would answer.
  instances: async () => { calls.push(['instances']); return { ok: true }; },
  plans: async () => { calls.push(['plans']); return { ok: true }; },
  createInstance: async (payload) => {
    calls.push(['createInstance', payload]);
    return { ok: true, checkout: true, instance: { id: 'new', displayName: payload.displayName, domain: payload.domain } };
  },
  renameInstance: async (id, name) => { calls.push(['renameInstance', id, name]); return { ok: true, instance: { id, displayName: name } }; },
  deleteInstance: async (id) => { calls.push(['deleteInstance', id]); return { ok: true, deleted: false, deletion: { scheduledFor: '2026-12-15T12:00:00Z' } }; },
  leaveInstance: async (id) => { calls.push(['leaveInstance', id]); return { ok: true }; },
});

// THE JOURNEY'S HANDLE. `executeJavaScript` runs in the main world and this object was bridged into
// it, so a push crosses the context-isolation boundary the same way a real publish does.
contextBridge.exposeInMainWorld('__barTest', {
  push: (next) => {
    current = { ...current, ...next };
    pushes += 1;
    for (const listener of listeners) listener(current);
    return pushes;
  },
  pushes: () => pushes,
  calls: () => calls.slice(),
});
