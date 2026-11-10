# e-app backlog

Pending work for the desktop client, with what "done" means. Rules live in `README.md` and
`docs/COMPANY_LOGIN.md`; this file is what is left, not what is true.

## The instance menu (2026-11-09, client built and measured; the cloud half is NOT deployed)

Owen, 2026-11-09, in one message: the top bar is glassy while nobody is signed in and must look
exactly like the legacy SSR bar (whose server-side copy is removed); the login page must respond;
the instance menu is always the first screen after boot or sign-in; every instance has a display
name and a domain; the owner can rename, delete (plan cancels at the end of the paid period) and
create one through a plan + Stripe page; a member can leave, which removes that account's records
and the row.

Landed in this tree: the pre-connection fragment restored (the missing `#account-pill` was the
login page's crash: `shell.mjs` threw before it ever subscribed to state), the signed-out glass
(`shell-bar-adapter.css`, keyed on `body[data-account-state]`), `desktop/instances.cjs` (the
frozen `/v2/accounts/instances` + `/v2/accounts/instance-plans` contract), the six IPC calls, the
merged menu (cloud instances join the account's connections by hostname), the create and rename
pages, and the removal of the `openOnStart` auto-connect so a boot always lands on the menu.
Measured: `tests/instance-menu-journey.cjs` (real window: rows, role actions, both pages, the
glass) and `tests/instances.test.cjs` (the transport); `npm test` green.

STILL OWED, in the order it blocks the feature:

1. **The cloud routes are DEPLOYED (2026-11-09).** `EasterServerCloudStack` is
   UPDATE_COMPLETE with **20** routes (the subscription webhook is the twentieth); all six
   instance-menu routes answer 401 `invalid_session` unauthenticated, so they are live. The owner-index migration has run (account 3 ->
   `easter-server`). The client's "not available yet" sentence is now the fallback for a
   service that is down, not the normal state.
2. **The test catalogue is CONFIGURED** from easter.company's plan carousel: Personal
   $39.99, Professional $99.99, Family $18.99 (the minimum subscription, pay-as-you-go).
   `GET /v2/accounts/instance-plans` answers `configured: true`, `mode: test`, and a
   subscription Checkout Session was opened and expired against the real test key. Business is
   deliberately unset (custom/contact plan). The production switch is a catalogue in
   `production` mode plus `EASTER_STRIPE_MODE=production`; no app change.
3. **The billing lifecycle is LIVE, and the client follows it (1.0.29, 2026-11-09).** The
   cloud webhook activates a paid instance (measured: a test-card Checkout moved a real row
   `pending -> active` in about five seconds), and the hourly cloud reaper purges an instance
   once its recorded deadline arrives. The client polls while any row is `pending`
   (`desktop/instances-poll.cjs`, bounded to 10 minutes, stops when none is) so the menu
   flips to the plan without a manual refresh, and `DELETE` still records
   `cancel_at_period_end` + `deletion.scheduledFor`. **One external blocker:** the current
   Stripe key is agent-tagged, so Stripe pauses the cancellation call for human approval; a
   non-agent key (or approving the request in the Dashboard) is required before the live
   delete step completes. The hosting plane still does not provision a running e-server, so
   an "active" instance is a record + plan, not a deployed box.
4. **No cap on plans per account** (Owen, 2026-11-09). The cloud's one-instance claim and its
   `account_owns_an_instance` refusal are deleted, so the menu's create action is honest for an
   account that already owns an instance; several owned instances are listed together.
5. **The legacy bar's visual parity** is Diana's vendored sheet, byte for byte, and the chrome
   already draws it; the server's `/shell` route is gone and `/shell` answers 404. What is still
   worth measuring is the connected chrome against the pre-removal server bar on a real instance,
   which this session could not do because AWS and the live client credentials were unavailable.

## Live user feeds: the client half (2026-11-06, on `ticket/eapp-live-feeds`, not merged)

Owen: "Each client connected to an e-server instance MUST access it's web camera and create a stream
on the e-server security dashboard ... while logged into e-app and connected to their e-server
instance", and "I can then also login on a secondary client in parallel with another camera".

Landed on the branch: `desktop/live-feed.cjs` (the protocol, from e-server's `api/live_feeds.py`
docstring), the feed's lifecycle in `desktop/main.cjs` (one socket per connected document, the
connection's own `sec_session` cookie on the upgrade, a new epoch per document), the device half in
`desktop/preload.cjs` (getUserMedia, one JPEG per tick, 640x480 @ 15 fps), the app's own permission
question (`client:media-ask`), this install's device id (`device.json`, a UUID — never a hostname,
never the account name), `tests/live-feed.test.cjs` against a fake e-server, and
`scripts/live-feeds-fixture.py` + `scripts/live-feeds-e2e.cjs` for the real-server journey.

DONE and measured (so nobody re-does it): the packaged build publishes to a real e-server publish
socket — feed live, `recording=active`, the dashboard fragment's `data-state="live"`, the MJPEG view
answered with real JPEG bytes, and `{feed_id}_00000.mkv` on disk as h264 640x480 with duration
(0.533 s while live, 5.333 s across a longer run); two isolated installs are two devices under one
person (`people=1`, `connected=2`, her group says "2 devices"), and every feed ends when its window
leaves the page. `npm test`: 104 pass.

STILL OWED:

- **DONE 2026-11-06, after e-server 0.14.0 landed:** the physical camera is measured, dev build and
  packaged build, with no flags. `track-label: HD Pro Webcam C920` (real UVC capabilities:
  colorTemperature 2705, exposureTime 333, pan/tilt/zoom, 30 fps rails), and the segments carry
  9851 and 9047 bytes per frame where the synthetic stream carried 2206 and 2489 — the size
  difference is the sensor's own noise. Segments: `u2-<device>-1_00000.mkv`, 59104 and 54280 bytes,
  h264 High 640x480 yuvj420p 15/1, 6 frames, decode pass clean. Before that deploy the same journey
  could only use `--fake-camera`, because the deployed 0.13.4 held `/dev/video0` exclusively through
  its own ffmpeg (pid 2350, a child of `e-server.service`).
- **Audio is still video-only.** The server's segment muxer encodes `-an`
  (`e_server/streaming/client_feed.py`), so the client proves the microphone's permission and then
  releases it rather than holding a device open for a stream nobody records. When the server accepts
  audio, the client must mux it (a `MediaRecorder`/WebM track beside the JPEG frames is the open
  design question — the protocol has one envelope for JPEG frames today).
- **The recording acknowledgement is the server's to fix.** `api/live_feeds.py` marks a feed's
  recording ACTIVE only when a report arrives after frames were accepted, so the client re-states its
  permission after the first frame to make the dashboard say "Recording" instead of "Recording
  unconfirmed". A server-side ack on the first accepted frame would let that duplicate go.
- **Windows and macOS are unproven** (no camera path exercised; `devicePermissionHandler` is not
  needed on Linux and was not needed here).

## The e-servers list (2026-11-03: API deployed, client verified live, not released)

Owen: after sign-in the client should stop at a list of the e-servers the Easter Company account
holds, with remove and add, and the chosen server's PIN comes after the choice.

Landed on `main` (e-app `02e2347`, `7fb1a28`, `d381fa2`, `7edea95`, `8722292`): the two views,
`desktop/connections.cjs`, the IPC, the four views' states, `tests/connections.test.cjs`,
`scripts/shell-servers.cjs` and its CI step, and a packaged first-screen smoke that now asserts
the views ship hidden.

DONE since this was written (the evidence, so nobody re-does it):

- **The accounts service is deployed.** Cloud ticket `411dfccb` accepted and merged (`db10fed`);
  `./infra/deploy.sh EasterAccountsStack` reached `UPDATE_COMPLETE` with `deploy: PASS`. Measured
  live with the `easter-delta` account: GET 200 `{connections:[], count:0, limit:50}`; POST 201
  with the derived id `c1632babbc0951da2`; the same POST again 409 `connection_exists`; an origin
  with a path 422 `invalid_origin`; PATCH touch 200 with `last_used_at` set; PATCH an unknown id
  404 `connection_not_found`; DELETE 204 twice; GET 200 with zero rows.
- **`scripts/live-connections.cjs` is the repeatable proof** (not in `npm test`: it needs a real
  account and a deployed API). Run it against an account you hold with
  `xvfb-run -a node scripts/live-connections.cjs --account <json> --origin <origin>`; it signs in,
  reads the list, adds the origin, chooses it, and asserts that what appears is the INSTANCE's own
  PIN gate. Its last run: `the server window: "Unlock your e-server" asking for its PIN: true`.
- **The client is verified against it, not against a stub.** Driving the real app (Electron from
  source, isolated HOME, CDP) as `easter-delta`: sign-in through the client's own form, the list
  arrived from the live service, the add view proved `GET /healthz` on
  `https://easter-server.char-istrian.ts.net` and wrote the row, and an independent GET with the
  same account then read that row back (`count: 1`, label derived from the host). Screenshot in
  `/tmp/eapp-e2e-shots/live-list.png`.

**Diana's deliverable has landed** (2026-11-03 00:34, while her turn 2 was still running):
`/home/diana/Desktop/e-app-connections/` holds `connections.css`, `connections.html`, per-state
fixtures (`list-dark.html`, `list-light.html`, `add-dark.html`, `empty-light.html`,
`loading-dark.html`, `error-dark.html`, `narrow-light.html`) and `shots/` with a PNG **and an SVG**
per state. Her route was dead until e-server `9b7fe92690` (the codex app-server refused the
harness's MCP tool names); turn 2 is the first that ever ran.

Still out, in the order it blocks a release:
1. **Diana's design is integrated** (`connections.css` is her studio file byte for byte; two adapter
   blocks in `shell.css` explained below). Remaining evidence before a release: keyboard-only pass,
   360 px, browser zoom, and the no-flash check in the real window — all runnable now with
   `npm run test:servers -- --shots <dir>` plus a manual pass. Her own two caveats are recorded at
   the end of her NOTES.md: her theme snapshot was stale, and her sandbox cannot launch Chromium
   (`setsockopt: Operation not permitted`), so her plates are design plates, not screenshots.
   The token divergence is INTENTIONAL AND RECORDED (Diana, 2026-11-03): her studio sheet keeps
   --ec-gold* and will use canonical names only if she revises it, so `shell.css` carries the
   four-name alias as the integration contract. Do not "tidy" her file; if she revises, re-copy,
   cmp, and delete the alias block. `desktop/connections.css` is a placeholder of shape, not
   of design (its header says so). Her studio file replaces it wholesale; the markup hooks she was
   given are the ones in `desktop/shell.html`. Acceptance: her file in place, `cmp` clean against
   her studio copy, both moods screenshotted through `npm run test:servers --shots <dir>`, and no
   literal colour in it.
2. **Release.** `package.json` is still 1.0.10 and the feature is not in a tag. A release is
   `client-v<version>` from `main` after CI is green; the packaged artifact is a separate check
   from the suite (see 1's acceptance and the smoke step).

## Decisions taken, and the ones left open

- **The PIN is the server's.** Choosing a row loads that origin and the instance's own gate asks
  for the PIN; the app never holds, asks or forwards one. "If it has one" therefore needs no
  client-side branch today — every instance's gate is the same gate. A future instance type with
  no PIN would change the server, not this list.
- **The list is the account's, the last server is the machine's.** `settings.json`'s `server` is
  only this machine's memory, used for the error state's way through and the one-time migration of
  a pre-upgrade install.
- **Not built: ownership in the row.** The cloud's instance plane (`easter-instances`,
  `easter-instance-members`) already knows which instance an account owns, but an instance record
  carries no origin, so a row cannot yet be linked to it. When it can, a row can say "yours" and
  the list can include an owned instance without adding it.
- **Removal confirms natively**, in `desktop/main.cjs`, not in the page: a menu-style destructive
  action does not belong in a web document.
- **`e-server://connect?server=…` adds its origin to the list** (best effort) so a link cannot
  create a server this app knows about but the account's list does not.

## The defect the live run found, and the gate it left behind

`addServer` validated an address with `probe(origin)`, but `main.cjs` already declared the
updater's `probe()` (it asks GitHub for the latest client version). A duplicate top-level function
declaration is silent — the later one wins — so every add compared a server's `/healthz` body
against `1.0.10` and answered "No e-server answered at that address." No unit test could see it:
`main.cjs` only runs inside Electron. Found by driving the real app; `tests/main-shape.test.cjs`
now fails on any duplicated top-level name in the client's unloadable modules, and is
mutation-checked.

## Smaller, unrelated

- The add flow's address field is `type=url` with `novalidate` on the form, so the app's own
  normalization answers every wrong shape with a sentence. Worth revisiting if a person reports a
  browser-level message appearing instead.
- `scripts/shell-servers.cjs` drives the *source* tree. Adding an `--asar` path argument, as
  `scripts/navigation-smoke.cjs` has, would let the packaged build's views be exercised rather
  than only proved present by `scripts/smoke.cjs`.

## Outstanding from the 2026-11-03/04 session

Owen, 2026-11-04: "update any installed apps on this machine for my owen (or just let it
auto-update!)". Two things are owed here and both are client-side; the editor defect itself is
NOT one of them (measured: the client paints the expanded editor correctly in Electron 44.7.2 in
both themes).

- [x] **Tell the person when the page it is showing is an older build than the server's**
  (ticket 7ae869ad) - LANDED on `feat/stale-build-line`, not yet released. `desktop/build-rev.cjs`
  compares the boot-graph rev the document itself carries
  (`window.__AGENT_HARNESS_BOOT__.rev`) against the same field parsed out of the page the server
  serves now, read through the person's own session; two minutes apart, one page read each. Equal
  revs say nothing, an unreadable side says nothing, and a replaced build offers a quiet line
  ("This window is running an older build of <server>." + Reload + dismiss) drawn by
  `desktop/preload.cjs` into a shadow root. Reload is `reloadIgnoringCache()` on the same window,
  so no PIN and no sign-in; the person's place is the page's own hash route
  (`packages/client/ui-inbox/src/client/surface.ts:114`). Gates: `npm test` (tests/build-rev.test.cjs)
  and `npm run test:servers -- --shots <dir>` (section 10 of scripts/shell-servers.cjs).
- [ ] **Edit a connection's name** (ticket f5b2c56a). Diana's design is on disk
  (`/home/diana/Desktop/e-app-connections/`), the row controls and the ids are frozen; the
  in-page rename surface and the `client:servers-rename` IPC are not wired.

