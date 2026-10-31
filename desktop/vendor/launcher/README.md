These account contracts, sign-in controls, PKCE loopback implementation, provider
broker and OS-keyring vault are reused from Easter Co. SMP's desktop launcher.
Source revision: 5fd2c7c35ab35272af6dd3f3177ac11e2e59647b.

The account client is loaded only by the main process. The setup renderer receives
only the shared sign-in controls. Keep these files unchanged when syncing upstream.
CompanyMicrosoft stops the Microsoft flow at Company identity; e-server never asks
for Minecraft entitlement and never hands over a Microsoft refresh token.

## account/ — the sign-in page itself

The setup renderer's sign-in screen IS the household's account page, so the page's own
files are vendored here verbatim rather than reimplemented. Copied from
/root/easter-co-smp.github.io at revision 6328d4c9e3ae91076f11af440b0ff2fd32dffcb7
(the merge of feat/phoenix, "The phoenix is the artwork in both themes", 2026-10-31),
byte for byte; tests/vendored-account.test.cjs compares them against that checkout and
names the first differing byte when they drift - which it did on 2026-10-31, when the
adapter's mark section changed under an earlier copy of this ticket.

- account.css          <- site/account/account.css (335 lines, 51 rules). The sheet that
                          paints the panel, the overline, the heading, the wait line, the
                          alert region, the sign-in rows and the footer. desktop/shell.html
                          carries site/account/index.html's markup for it, including
                          `body class="account"`, which is load-bearing: the sheet is
                          scoped under `.account`.
- microsoft-signin.mjs <- site/account/microsoft-signin.mjs. The page's half of the
                          Microsoft flow (the registered redirect literal, the callback
                          reader, the not-configured sentence). The client's Microsoft
                          sign-in runs in the main process (desktop/company-microsoft.cjs)
                          because it holds the PKCE verifier and the loopback listener, so
                          nothing here imports this file: it is vendored so the gate can
                          prove the page's copy is still the page's, and so a future host
                          that needs that half starts from the site's bytes.

## theme/ — the household's palette, its adapter, and the wait mark's owner

Same source revision, same rule: copied byte for byte, never edited here.

- launcher-light.css        <- site/launcher-light.css. Diana's light palette, which every
                               page of the site links. It is the home of every colour the
                               light theme uses (--bg #eef2f9, --surface, --ink, --gold,
                               --control-line, --danger ... ) and every rule in it is scoped
                               to html[data-easter-theme="light"], so a dark desktop paints
                               exactly what it painted before. The site's copy is held to
                               her studio file (/home/diana/Desktop/launcher-light/) by the
                               launcher repository's tests/test_launcher_light.py; this
                               client's copy is held to the site's copy by
                               tests/vendored-account.test.cjs, never to the studio directly.
- launcher-light-adapter.css <- site/launcher-light-adapter.css. Delta's correction for the
                               sheets her palette was not drawn against - the account card's
                               five --account-* tokens, the card's ground, the CTA's measured
                               gold-on-white pair, the inputs, the alert. It is the reason the
                               sign-in card turns light at all; without it the palette swaps
                               the page and the card stays dark.
- account-control.css       <- site/account-control.css. It owns `.wait-feedback-mark`, the
                               ring the account page shows while a sign-in is in flight (the
                               site loads this sheet through its nav control; this window
                               links it). The rest of it is the account menu, which this
                               window does not draw.
- theme-early.js            <- site/theme-early.js. The pre-paint script: it reads
                               prefers-color-scheme and sets html[data-easter-theme] plus
                               style.color-scheme before the first paint. This is the whole
                               theme contract - no client mechanism of its own, and the same
                               attribute the site's stylesheets answer.

The client supplies those sheets with one thing they expect from a host: the four --app-*
tokens site/web.css publishes under `.web-mode` (site/web.js puts that class on <html> for
the account page too). They live in desktop/shell.css's base block, and the gate compares
their values against site/web.css rather than trusting the copy.

What is NOT vendored, deliberately: site/account/account.mjs. Its job is the browser
page's - the OAuth callback, the return target, webAccount, navigating to the site root on
success - and this window has none of those. desktop/shell.mjs is the client's adapter for
that job, and desktop/shell.css is the client's own sheet (the window's controls only). No
site/account file is edited anywhere: every client difference lives in those two files.
