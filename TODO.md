# e-app backlog

Pending work for the desktop client, with what "done" means. Rules live in `README.md` and
`docs/COMPANY_LOGIN.md`; this file is what is left, not what is true.

## The e-servers list (built 2026-11-03, not released)

Owen: after sign-in the client should stop at a list of the e-servers the Easter Company account
holds, with remove and add, and the chosen server's PIN comes after the choice.

Landed on `main` (e-app `02e2347`, `7fb1a28`, `d381fa2`, `7edea95`, `8722292`): the two views,
`desktop/connections.cjs`, the IPC, the four views' states, `tests/connections.test.cjs`,
`scripts/shell-servers.cjs` and its CI step, and a packaged first-screen smoke that now asserts
the views ship hidden.

Still out, in the order it blocks a release:

1. **The accounts service must be deployed with `/v2/accounts/connections`.** The client is written
   against it and reads it first thing after sign-in; until the route exists the list shows its own
   honest error state with a retry and the last server. Ticket: cloud `411dfccb` (branch
   `ticket/connections-api`), deployed by Delta with `./infra/deploy.sh EasterAccountsStack`.
   Acceptance: a real signed-in GET answers 200 with an empty list, a POST answers 201, a second
   POST of the same origin answers 409, and a DELETE answers 204.
2. **Diana's design for the two views.** `desktop/connections.css` is a placeholder of shape, not
   of design (its header says so). Her studio file replaces it wholesale; the markup hooks she was
   given are the ones in `desktop/shell.html`. Acceptance: her file in place, `cmp` clean against
   her studio copy, both moods screenshotted through `npm run test:servers --shots <dir>`, and no
   literal colour in it.
3. **Release.** `package.json` is still 1.0.10 and the feature is not in a tag. A release is
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

## Smaller, unrelated

- The add flow's address field is `type=url` with `novalidate` on the form, so the app's own
  normalization answers every wrong shape with a sentence. Worth revisiting if a person reports a
  browser-level message appearing instead.
- `scripts/shell-servers.cjs` drives the *source* tree. Adding an `--asar` path argument, as
  `scripts/navigation-smoke.cjs` has, would let the packaged build's views be exercised rather
  than only proved present by `scripts/smoke.cjs`.
