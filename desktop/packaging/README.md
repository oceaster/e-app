# desktop/packaging — the root helper the update needs, and how the package grants it

The e-server client updates itself: `desktop/updater.cjs` verifies a downloaded payload, writes
`~/.config/Easter Company/e-server-client/updates/current.json`, and `desktop/bootstrap.cjs` loads
that payload as the app path on the next start. The package manager never hears about it, so one
install ends up telling three different versions at once — measured on this machine 2026-11-05:
`pacman -Q e-app` said `e-app 1.0.8-1`, `/opt/e-server/resources/app.asar` said 1.0.14, and the
running client was 1.0.18. Anyone reading the registry was told a version that was not running.

| File | What it is | Where the package puts it |
|---|---|---|
| `e-app-registry-stamp` | the helper: `e-app-registry-stamp X.Y.Z`, one sentence on stdout, exit code as the verdict | `resources/e-app-registry-stamp` (executable) |
| `49-e-app-registry-stamp.rules` | polkit rule allowing `pkexec` to run **that one program** as root, local active sessions only | copied to `/usr/share/polkit-1/rules.d/` by `after-install.sh` |
| `after-install.sh` / `after-remove.sh` | fpm hooks the deb and pacman targets run as root: install the rule, make the helper executable, remove the rule again on uninstall | named by `build.deb` / `build.pacman` in `package.json` |

The rule's install location is a packaging change, not a runtime one: the app never writes outside
its own config directory, never asks for a password, and never calls `sudo`. `desktop/registry.cjs`
looks for the helper and the rule before anything else, so a package that did not install them is
reported (`unprivileged` / `missing-helper`) instead of prompting a player mid-update.

The helper itself:

- takes exactly one strict `X.Y.Z` — anything else exits 12 without touching anything;
- pacman: renames `/var/lib/pacman/local/e-app-<old>-<rel>` to the new version (keeping the
  `pkgrel`) and rewrites `%VERSION%` in its `desc`, after checking the entry's own `%NAME%` is
  `e-app`; dpkg: rewrites the `Version:` field of the `e-app` stanza in `/var/lib/dpkg/status`
  and nothing else in that file;
- is idempotent (a second run writes nothing and says so) and refuses ambiguity (two entries
  claiming `e-app`) or a target that another entry already occupies;
- prints exactly one sentence — success, no-op or refusal — which `desktop/main.cjs` records
  verbatim in the app's update log (`~/.config/Easter Company/e-server-client/update.log`) and in
  the update result;
- is a named no-op (exit 10) on a machine with no entry: an AppImage, a dev run, a Windows build.

## Tests

`tests/registry-stamp.test.cjs` runs the helper against throwaway fixture trees — `E_APP_REGISTRY_ROOT`
roots the pacman database and the dpkg status file — so no test ever writes the live registry:

```sh
node --test tests/registry.test.cjs tests/registry-stamp.test.cjs
```

## The one-time correction of this machine

`scripts/reconcile-package-registry.sh` measures the three numbers and, with `--apply`, installs the
published 1.0.18 pacman artifact whose `resources/app.asar` is byte-identical to the payload the
client is running. Run it without `--apply` to read the decision; the header of that script holds the
measurements and why the artifact — not the helper — is the right mechanism for the install that
drifted before the helper existed.
