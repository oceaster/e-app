/**
 * Publish the theme before the first paint, from the OS alone.
 *
 * site/web.js does this too, on every page, but it is a module: it runs after the document
 * is parsed, so a light-machined visitor saw one dark frame first. This is the same
 * resolution `theme-publish.mjs` calls `system`, done in a blocking classic script, which
 * is the only shape that finishes before the first paint.
 *
 * It never contradicts the account: site/account-control.mjs and the settings panel both
 * publish the account's own preference later, through `publishTheme`, and both go through
 * `html[data-easter-theme]` + `style.color-scheme`, so the last writer wins and the writer
 * is the one that knows more.
 *
 * A host that fails here keeps the dark default rather than an unstyled page.
 */
(function () {
  var resolved = 'dark';
  try {
    resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch (error) { /* no matchMedia: the stylesheet's own default stands */ }
  try {
    document.documentElement.dataset.easterTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch (error) { /* a document that refuses the attribute keeps its own look */ }
})();
