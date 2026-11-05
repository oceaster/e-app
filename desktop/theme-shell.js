/**
 * THE SHELL'S THEME, BESIDE THE VENDORED SCRIPT THAT PAINTS THE OS ANSWER.
 *
 * desktop/vendor/launcher/theme/theme-early.js is copied byte for byte from the launcher site
 * (desktop/vendor/launcher/VENDORED.sha256, enforced by tests/vendored-account.test.cjs), so the
 * account's answer cannot live inside it: a change there would either be re-vendored from
 * upstream or lost on the next copy. It lives here - the client's own adapter, loaded
 * immediately after it by desktop/shell.html - exactly as desktop/connections.cjs is the
 * client's own transport beside the vendored account client. The vendored file is untouched and
 * still paints the OS answer first; this file then says what the ACCOUNT says, before the first
 * frame, and keeps saying it.
 *
 * IT IS A BLOCKING CLASSIC SCRIPT, not a module, for the same reason theme-early.js is: it is the
 * only shape that finishes before the first paint, so the cached answer from the last launch
 * lands on the first painted frame instead of one frame later. The cache itself is read
 * synchronously out of the main process by desktop/preload.cjs (window.eServerSetup.theme) and
 * written by desktop/theme.cjs, which is the only writer.
 *
 * THE RULE IS THE HOUSEHOLD'S, not this file's invention: `light` and `dark` are absolute and the
 * account's word wins over the OS; `system` resolves through `prefers-color-scheme` ON EVERY ASK,
 * and it keeps resolving while the window is open - the listener below repaints on an OS change
 * and only while the preference is `system`. The palette is published the one way every surface
 * publishes it: `html[data-easter-theme="light"|"dark"]` plus `html.style.color-scheme`, which is
 * what theme.css's light block and launcher-light.css key on.
 *
 * WHO ELSE WRITES IT. desktop/shell.mjs calls `easterShellTheme.paint(preference)` every time the
 * main process publishes the account's answer (the same `client:state` channel the account card
 * and the e-server list already use), so a sign-in, a save in e-server's settings panel or a
 * re-read repaints this window with no reload. Last writer wins, and the writer that knows more
 * is always the one that arrives later.
 *
 * A DOCUMENT THAT REFUSES THE ATTRIBUTE keeps whatever the vendored script painted: a theme that
 * cannot be published is not a reason to blank the page.
 */
(function () {
  var LIGHT_QUERY = '(prefers-color-scheme: light)';
  var THEMES = ['light', 'dark', 'system'];
  var preference = null;

  function osAnswer() {
    try {
      return window.matchMedia && window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
    } catch (error) {
      return 'dark';
    }
  }

  function resolved(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return osAnswer();
  }

  function paint(value) {
    var next = resolved(value);
    try {
      document.documentElement.dataset.easterTheme = next;
      document.documentElement.style.colorScheme = next;
    } catch (error) { /* a document that refuses the attribute keeps its own look */ }
    return next;
  }

  /** The last answer the account gave, cached for this launch. '' when nothing is known yet. */
  function cached() {
    try {
      var value = window.eServerSetup && window.eServerSetup.theme;
      return THEMES.indexOf(value) === -1 ? '' : value;
    } catch (error) {
      return '';
    }
  }

  var known = cached();
  if (known) {
    // THE ACCOUNT HAS ALREADY ANSWERED, on a previous launch: this overrides the OS answer the
    // vendored script painted a moment ago, still before the first frame.
    preference = known;
    paint(preference);
  }

  window.easterShellTheme = {
    /** Publish a preference, or nothing when the main process has no answer yet. */
    paint: function (value) {
      if (THEMES.indexOf(value) === -1) return null;
      preference = value;
      return paint(preference);
    },
    /** What is being worn: the account's preference, or null while only the OS has spoken. */
    preference: function () {
      return preference;
    },
  };

  // THE OS IS FOLLOWED LIVE, and only when the account said `system`: an account saved on `dark`
  // must not be repainted light by a machine that changes its appearance underneath it.
  try {
    var query = window.matchMedia && window.matchMedia(LIGHT_QUERY);
    var follow = function () {
      if (preference === 'system') paint(preference);
    };
    if (query) {
      if (typeof query.addEventListener === 'function') query.addEventListener('change', follow);
      else if (typeof query.addListener === 'function') query.addListener(follow);
    }
  } catch (error) { /* no matchMedia: the preference above still paints */ }
})();
