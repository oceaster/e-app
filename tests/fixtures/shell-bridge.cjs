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

contextBridge.exposeInMainWorld('eServerSetup', {
  // The whole published state, exactly the channel the main process uses (`client:state`).
  state: async () => current,
  onState: (listener) => { listeners.push(listener); return () => {}; },
  providers: async () => ({ providers: [] }),
  theme: 'dark',
  themeRefresh: async () => ({ ok: true }),
  // Every other call is a no-op that resolves, so a view can be drawn without a main process.
  login: async () => {}, provider: async () => {}, finish: async () => {}, cancelAccount: async () => {},
  signOut: async () => {}, view: async () => {}, refresh: async () => {}, connect: async () => {},
  addServer: async () => ({ ok: false, error: 'fixture' }), removeServer: async () => {}, retry: async () => {},
  download: async () => {},
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
});
