# e-app backlog

Pending work for the desktop client, with what "done" means. Rules live in `README.md` and
`docs/COMPANY_LOGIN.md`; this file is what is left, not what is true.

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
1. **Integrate Diana's design for the two views** (her files are in her studio, listed above). `desktop/connections.css` is a placeholder of shape, not
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
