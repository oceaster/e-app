// THE CHROME DOCUMENT'S TWO FACTS, read before the controller runs.
//
// The e-app opens this file as the connected window's top-level document and tells it which
// instance it is attached to (`?origin=…`). Nothing else is read from the URL except the
// optional `?route=` deep link, which the controller resolves through the registry.
//
// `window.eServerChrome.account` is the account action: in a packaged run the preload that owns
// this window replaces it with the app's own account surface. Until it exists, the controller
// keeps the person in the app (no navigation away from the chrome) and says so in the pill's
// tooltip rather than loading a page.
(function () {
  var params = new URLSearchParams(location.search);
  window.SERVER_ORIGIN = String(params.get('origin') || '').replace(/\/+$/, '');
  window.INSTANCE_KEY = window.SERVER_ORIGIN;
  window.eServerChrome = window.eServerChrome || {};
  if (!window.SERVER_ORIGIN) {
    document.documentElement.setAttribute('data-chrome-error', 'no-origin');
  }

  // THE PILL SHOWS A PERSON, OR IT DOES NOT SHOW. The bar is painted before the main process
  // answers, so the account button starts hidden (`hidden` in chrome.html) and is revealed only
  // when the app publishes the account it is actually signed in to. An empty pill with the app
  // icon was a pretend user control (measured 2026-11-09).
  function adopt(state) {
    var account = state && state.account ? state.account : null;
    // The state answer can beat the controller's listener (both scripts are defer). Keep the
    // last answer on the document so `chrome-host` paints it immediately when it starts.
    window.__eappAccount = account;
    window.dispatchEvent(new CustomEvent('e-app:account', {detail: account}));
  }
  try {
    if (window.eServerSetup) {
      if (typeof window.eServerSetup.state === 'function') {
        window.eServerSetup.state().then(adopt).catch(function () {});
      }
      if (typeof window.eServerSetup.onState === 'function') window.eServerSetup.onState(adopt);
    }
  } catch (error) { /* a chrome without the bridge still paints its bar */ }
})();
