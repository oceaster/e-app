# Company account before server selection

The client starts at the shared Easter Company sign-in controls. Direct username/email
and password, Microsoft, Google, Steam and Discord use the launcher's existing account
contracts. New provider accounts finish their username/password before unlocking the client.
Microsoft uses the launcher's native PKCE/state/loopback implementation, stopping at Company
identity: no Minecraft login, entitlement check, game mint or refresh-token handover occurs.

Global session credentials stay in the main process and its OS-keyring encrypted vault.
Without a secure keyring the session stays in memory. Saved sessions are verified at startup;
expiry locks the client again. There is no periodic global-account polling. Server selection,
remembered-server startup, retry and deep-link handling all enforce the main-process gate.
Remote server frames have no access to global-account IPC. Their browser partitions are
separated by Company identity as well as server origin. A selected server never receives the
global Company session token as page content, an argument, a URL or a stored value; its own
PIN and access checks remain in place. The one amendment to that rule is below.

The native File/Edit/View menu is removed. App controls remain in the tray menu. Ctrl+,
(Command+, on macOS development environments) opens server selection; the setup view also
has a sign-out action. Updates wait while that account/setup view is visible.

The default server already supports verified HTTPS. Older splash pages advertised their
internal reverse-proxy HTTP scheme. The client upgrades only the known default hostname on
HTTP port 80 to its HTTPS origin; other HTTP origins remain refused outside loopback tests.
The companion backend PR fixes the advertised scheme using only its trusted proxy peer.

## The global bridge: one sign-in and one sign-out (2026-10-29)

The e-server page already calls two actions on the server window's preload bridge and falls
back honestly when either is missing (`api/profile_assets/handoff.mjs` and `signout.mjs` on
the server; the half here is `desktop/bridge.cjs`). Both are main-frame only, through the same
`remote(event)` guard every other `client:*` command uses: the connected server's main frame
gets an answer, anything else gets a refusal. Both answer a promise and never reject into the
page, because the page's fallback is its `catch` and a named code is more honest.

`window.eServerClient.bindSession(next)` — the main process POSTs the Company session token it
already holds to `/desktop/auth/company` on the connected origin as `Authorization: Bearer`,
with `{"next": "<path>"}`, `Content-Type: application/json`, `X-Easter-Desktop: e-server/1`
and `X-Easter-Desktop-Request: 1`. The PIN cookie rides along because the request is made
through the connected server's own Electron session, exactly like `/desktop/auth/microsoft`.
No redirect is followed and the call is bounded (`HANDOFF_TIMEOUT_MS`, 10 s). `200` resolves
`{ok: true, next}`; every refusal resolves `{ok: false, error}` with the server's own code —
`company_sign_in_required` (401), `account_incomplete` / `refused` (403), `bound` (409),
`rate_limited` (429), `too_large` (413), `invalid_request` (400), `unavailable` (503) — plus
`timeout`/`unavailable` when the request never reached an answer.

`window.eServerClient.signOut()` — the client's OWN half ends FIRST (`company.signOut()`: memory
token cleared, keyring entry removed, app back at its own sign-in screen), and only then does
the main process make `POST /profiles/logout` itself with `X-Easter-Desktop: e-server/1` and
`X-Easter-Desktop-Global-Signout: ended`, bounded (`SIGNOUT_TIMEOUT_MS`, 5 s) and resolving
`{ok, instance, global}`. If that request fails it still answers
`{ok: true, instance: 'ended', global: 'not_ended'}`: the client's half genuinely ended and it
must not claim the server's did. The tray's "Sign out of Easter Company" runs the same code
path, so the menu and the top-nav sign-out cannot drift apart; the confirmation dialog stays
with the tray, where a menu item is a destructive action, and the page's bridge call adds none.

THE TOKEN RULE, AMENDED IN PLACE. `desktop/company.cjs` line 2 used to read "Server origins
never receive this token", which was absolute while the app only spoke to the accounts service.
It is now narrower and still absolute: the token leaves the main process ONLY as the Bearer
credential of that one main-process POST, to the origin already connected, so that the server
can ask the accounts service who it is and bind the PIN session. It never reaches a renderer, a
URL, a redirect, a log line or an update payload — the page that triggers the call never sees
it, and `credential()` in `desktop/company.cjs` is the single door out of the main process.
`tests/bridge.test.cjs` greps the preload bridge for the word and asserts the answers carry no
credential, and the proof it did leave is the fake server that receives it.

Version 1.0.1 is prepared for Delta to review, merge and release. No tag or release is created
by this work. Native keyless integration covers login-before-server, IPC refusal, the removed
menu, server PIN/Microsoft flow and renderer isolation. Real provider accounts and fresh-OS
installer execution remain manual release checks.

## The list between sign-in and connection (2026-11-03)

Owen: "when you login, before you connect to any e-server, there should be an intermediary view
where users can select which e-server instance they want to connect to ... there should be an
option to remove an existing instance ... and a button to go to a 2nd new view, which allows the
user to add a new e-server instance ... Once you select an instance to connect to that's when you
will be prompted for the instances pin if it has one."

So a signed-in client no longer reconnects to the last server. It opens the list of e-servers the
Easter Company ACCOUNT holds (`GET /v2/accounts/connections`), and `settings.json`'s `server`
field drops to what it should always have been: this machine's memory of the last server, used to
offer one quiet way through when the list cannot be read. The list itself is not the disk's - sign
in on a second machine and the same rows are there.

The three moving parts, and where each lives:

* `desktop/connections.cjs` is the client's half of that API: the five calls, the origin
  normalization (one address, one row), the retry policy (a read and a delete may be repeated, a
  write may not) and every refusal code the service names. It is deliberately NOT in the vendored
  `api/accounts.mjs`, whose OPERATIONS table is the launcher's policy for the routes the launcher
  calls; the accounts API origin is read from that vendored module rather than written down twice.
* `desktop/main.cjs` owns the list's state and the three actions: `refreshServers()`,
  `addServer()` (which normalizes the address, proves an e-server answers at `GET /healthz` and
  only then stores the row) and `removeServer()` (a native confirmation first, because a menu-style
  destructive action does not belong in a page). `client:view` is the one place a heading changes
  with a view.
* `desktop/shell.html` + `desktop/connections.css` are the two views. Every row is a real button
  and the remove control names the server it removes, so the list is usable by keyboard and by a
  screen reader. An empty list still offers the only thing to do; a list that cannot be read says
  so, offers a retry, and offers the last server by name.

THE PIN IS STILL THE SERVER'S. Choosing a row loads that origin in the server window, and the
instance's own gate asks for the PIN - the app never holds one, asks for one, or forwards one.
Nothing about the PIN contract in the sections above changed.

ONE MIGRATION, ONCE: a client that already had a configured server adds it to the account's list
the first time the list comes back empty (`config.connectionMigrated`), so an upgrade cannot lose
the only address a person had.
