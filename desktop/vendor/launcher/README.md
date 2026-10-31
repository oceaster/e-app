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
/root/easter-co-smp.github.io at revision dc0e074541322c73f0459d50b00705e689cb2d6d
("Launcher 1.0.56", 2026-10-31), byte for byte; tests/vendored-account.test.cjs
compares them against that checkout and names the first differing byte when they drift.

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

What is NOT vendored, deliberately: site/account/account.mjs. Its job is the browser
page's - the OAuth callback, the return target, webAccount, navigating to the site root on
success - and this window has none of those. desktop/shell.mjs is the client's adapter for
that job, and desktop/shell.css is the client's own sheet (the window's controls only). No
site/account file is edited anywhere: every client difference lives in those two files.
