// ===== local-ai bridge — THIS WHOLE BLOCK GOES INSIDE desktop/preload.cjs =====================
// Self-contained on purpose: it requires only 'electron' (contextBridge + ipcRenderer), declares
// nothing at module scope, and returns early when this document is not on a trusted e-server. That
// shape is what makes it safe in a `sandbox: true` preload, where a relative module import would not
// resolve at all: a sandboxed preload runs in an isolated world with no filesystem of its own, so the
// main-process module (desktop/local-ai/index.cjs) is reached through IPC and never by requiring it.
//
// THE TRUST ANSWER IS ASKED, NOT ASSUMED. `localai:isTrusted` is a synchronous question to the main
// process, which compares this frame's origin against the trusted list it reads LIVE on every call —
// so switching e-servers needs no preload change, and a page that is not the person's e-server never
// gets a bridge at all. The two listeners are the only push channels and each returns its own
// unsubscribe, so a page that reloads cannot stack handlers.
(() => {
  const { contextBridge, ipcRenderer } = require('electron');
  let trusted = false;
  try { trusted = ipcRenderer.sendSync('localai:isTrusted') === true; } catch (_) { /* main not ready */ }
  if (!trusted) return;

  // THIS IS A BRIDGE AND NOTHING ELSE: no parsing, no painting, no policy. A sandboxed preload is a
  // security surface (desktop/bridge.test.cjs pins what it may mention), so anything that reads an
  // engine answer belongs to the main process — local-ai/context-window.cjs is where that lives.
  contextBridge.exposeInMainWorld('localAI', {
    capabilities: () => ipcRenderer.invoke('localai:capabilities'),
    start: (tier) => ipcRenderer.invoke('localai:start', tier),
    stop: () => ipcRenderer.invoke('localai:stop'),
    status: () => ipcRenderer.invoke('localai:status'),
    endpoint: () => ipcRenderer.invoke('localai:endpoint'),     // { baseUrl, apiKey } or null
    diagnostics: () => ipcRenderer.invoke('localai:diagnostics'),
    selfTest: () => ipcRenderer.invoke('localai:selftest'),
    onStatus: (cb) => {
      const listener = (_event, status) => cb(status);
      ipcRenderer.on('localai:status', listener);
      return () => ipcRenderer.removeListener('localai:status', listener);
    },
    onProgress: (cb) => {
      const listener = (_event, progress) => cb(progress);
      ipcRenderer.on('localai:progress', listener);
      return () => ipcRenderer.removeListener('localai:progress', listener);
    },
  });
})();
// ===== end local-ai bridge ==================================================================
