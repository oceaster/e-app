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
})();
