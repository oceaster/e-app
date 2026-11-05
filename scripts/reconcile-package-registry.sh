#!/bin/sh
# ONE-TIME RECONCILIATION OF THIS MACHINE'S e-app PACKAGE REGISTRY (ticket 06becd1e).
#
# THE DEFECT, MEASURED HERE ON 2026-11-05 — one app, three versions, and a registry that names the
# wrong one:
#
#   $ pacman -Q e-app
#   e-app 1.0.8-1
#   $ grep -A1 '^%VERSION%' /var/lib/pacman/local/e-app-1.0.8-1/desc
#   %VERSION%
#   1.0.8-1
#   $ node -e "const {extractFile}=require('@electron/asar');..."   # installed bundle
#   1.0.14
#   $ cat "/home/diana/.config/Easter Company/e-server-client/updates/current.json"
#   {"version":"1.0.18",...,"size":456256,"sha256":"334eded1…"}
#
# The running client is the 1.0.18 payload bootstrap.cjs loads (footer prints e-app 1.0.18), the
# package on disk is 1.0.14, and pacman is told 1.0.8-1.
#
# THE MECHANISM CHOSEN, AND WHY IT IS NOT THE HELPER: install the published artifact.
#   $ ls -l /tmp/e-app-1.0.18.pacman.tar.zst
#   $ tar --zstd -xOf /tmp/e-app-1.0.18.pacman.tar.zst .PKGINFO | grep pkgver
#   pkgver = 1.0.18-1
#   $ sha256sum /tmp/.../opt/e-server/resources/app.asar
#   334eded1319f9ac267d80614f4266738393e8279f11a79d876b54218f9414154
#   $ sha256sum "/home/diana/.config/Easter Company/e-server-client/updates/334eded1….asar"
#   334eded1319f9ac267d80614f4266738393e8279f11a79d876b54218f9414154
# The artifact's own app.asar IS the payload the client is running — byte for byte, 456256 bytes —
# so installing it makes all three numbers the same version (registry 1.0.18-1, installed bundle
# 1.0.18, running payload 1.0.18) with no behavioural change to the app. Stamping the helper to
# 1.0.18 instead would move pacman to 1.0.18 while /opt/e-server/resources/app.asar still said
# 1.0.14: the registry and the installed package would still disagree, which is the ticket's own
# acceptance ("all three numbers equal"), not a fix for it. The helper is the mechanism for every
# FUTURE self-update (desktop/registry.cjs at activation); this script is the correction of the
# install that drifted before the helper existed, and the artifact is the one thing on this machine
# that already contains the bytes the client runs.
#
# HOW TO RUN IT (the repair needs root; this script does not run itself for you):
#   scripts/reconcile-package-registry.sh                  # measure only, changes nothing
#   scripts/reconcile-package-registry.sh --verify-artifact # prove the artifact is the running build
#   sudo scripts/reconcile-package-registry.sh --apply
# It never edits /var/lib/pacman by hand, never stamps a version the artifact does not carry, and
# refuses to install an artifact whose app.asar is not the payload the client is running.
set -u

ARTIFACT=${E_APP_ARTIFACT:-/tmp/e-app-1.0.18.pacman.tar.zst}
PREFIX=${E_APP_INSTALL_PREFIX:-/opt/e-server}
REPO=$(cd "$(dirname "$0")/.." && pwd)
ASAR="$PREFIX/resources/app.asar"
CONFIG=${E_APP_CONFIG_DIR:-/home/diana/.config/Easter Company/e-server-client}
CURRENT="$CONFIG/updates/current.json"
MODE=${1:---check}

say(){ printf '%s\n' "$1"; }
fail(){ printf '%s\n' "$1" >&2; exit 1; }

# The version inside an app.asar, read the way the app reads it: its own package.json.
asar_version(){
 node -e '
  const asar=require(process.argv[1]);
  const {version}=JSON.parse(asar.extractFile(process.argv[2],"package.json").toString("utf8"));
  process.stdout.write(version);
 ' "$REPO/node_modules/@electron/asar" "$1" 2>/dev/null
}
json_field(){
 node -e '
  const fs=require("node:fs");
  try{process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[process.argv[2]]??""));}catch{process.stdout.write("");}
 ' "$1" "$2" 2>/dev/null
}
registry_version(){
 if command -v pacman >/dev/null 2>&1 && pacman -Q e-app >/dev/null 2>&1; then
  pacman -Q e-app | awk '{print $2}'
 elif command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Version}\n' e-app >/dev/null 2>&1; then
  dpkg-query -W -f='${Version}\n' e-app
 fi
}

measure(){
 REGISTRY=$(registry_version);REGISTRY=${REGISTRY:-none}
 INSTALLED=$(asar_version "$ASAR");INSTALLED=${INSTALLED:-none}
 PAYLOAD=$(json_field "$CURRENT" version);PAYLOAD=${PAYLOAD:-none}
 SHORTSHA=$(json_field "$CURRENT" sha256)
 say "registry (pacman -Q e-app / dpkg-query) : $REGISTRY"
 say "installed $ASAR         : $INSTALLED"
 say "running payload ($CURRENT) : $PAYLOAD${SHORTSHA:+ (sha256 $SHORTSHA)}"
}
payload_file(){
 [ -n "${SHORTSHA:-}" ] || return 1
 [ -f "$CONFIG/updates/$SHORTSHA.asar" ] || return 1
 printf '%s' "$CONFIG/updates/$SHORTSHA.asar"
}

check_artifact(){
 [ -f "$ARTIFACT" ] || fail "No artifact at $ARTIFACT — nothing to install."
 ARTIFACT_VERSION=$(tar --zstd -xOf "$ARTIFACT" .PKGINFO 2>/dev/null | awk -F' = ' '/^pkgver/{print $2}')
 [ -n "$ARTIFACT_VERSION" ] || fail "Could not read .PKGINFO from $ARTIFACT: refusing to install an artifact it cannot identify."
 STAGE=$(mktemp -d "${TMPDIR:-/tmp}/e-app-reconcile.XXXXXX") || fail "Could not make a staging directory."
 trap 'rm -rf "$STAGE"' EXIT
 tar --zstd -xf "$ARTIFACT" -C "$STAGE" opt/e-server/resources/app.asar 2>/dev/null || fail "The artifact carries no $PREFIX/resources/app.asar."
 ARTIFACT_BUNDLE_VERSION=$(asar_version "$STAGE$ASAR")
 ARTIFACT_BUNDLE_SHA=$(sha256sum "$STAGE$ASAR" | awk '{print $1}')
 say "artifact $ARTIFACT                 : $ARTIFACT_VERSION, bundle $ARTIFACT_BUNDLE_VERSION, asar $ARTIFACT_BUNDLE_SHA"
 [ "$ARTIFACT_BUNDLE_VERSION" = "$PAYLOAD" ] || fail "The artifact's bundle is $ARTIFACT_BUNDLE_VERSION but the client is running $PAYLOAD: refusing to install a different version than the one running."
 RUNNING_PAYLOAD_FILE=$(payload_file) || fail "No payload file beside $CURRENT, so the running version cannot be proved: refusing."
 RUNNING_SHA=$(sha256sum "$RUNNING_PAYLOAD_FILE" | awk '{print $1}')
 [ "$RUNNING_SHA" = "$ARTIFACT_BUNDLE_SHA" ] || fail "The artifact's app.asar ($ARTIFACT_BUNDLE_SHA) is not the running payload ($RUNNING_SHA): refusing."
 say "the artifact's app.asar IS the running payload (sha256 $RUNNING_SHA)"
}

say "== before"
measure
BEFORE_REGISTRY=$REGISTRY;BEFORE_INSTALLED=$INSTALLED;BEFORE_PAYLOAD=$PAYLOAD

# The artifact's identity can be checked without installing anything: it reads the archive, the
# running payload and nothing else. An operator can therefore see the whole decision before root.
if [ "$MODE" = "--verify-artifact" ]; then
 say ""
 say "== artifact"
 check_artifact
 say "The artifact can reconcile this install: it carries the version the client is running."
 exit 0
fi

if [ "$MODE" != "--apply" ]; then
 say ""
 if [ "$REGISTRY" = "$INSTALLED" ] && [ "$INSTALLED" = "$PAYLOAD" ]; then
  say "All three numbers already agree: nothing to reconcile."
  exit 0
 fi
 say "They disagree. Run: sudo $0 --apply"
 exit 2
fi

[ "$(id -u)" = 0 ] || fail "Installing the artifact needs root: run sudo $0 --apply. Nothing was changed."
say ""
say "== artifact"
check_artifact
command -v pacman >/dev/null 2>&1 || fail "This script installs a pacman artifact and pacman is not on this machine. Nothing was changed."
say ""
say "== installing $ARTIFACT"
pacman -U --noconfirm "$ARTIFACT" || fail "pacman refused the artifact. Nothing beyond pacman's own state was changed."
say ""
say "== after"
measure
# The verdict derives from the measurements, not from pacman's exit code.
[ "$REGISTRY" = "$INSTALLED" ] && [ "$INSTALLED" = "$PAYLOAD" ] || fail "After the install the three numbers still disagree: registry=$REGISTRY installed=$INSTALLED payload=$PAYLOAD"
[ "$PAYLOAD" = "$BEFORE_PAYLOAD" ] || fail "The running payload changed under the repair ($BEFORE_PAYLOAD -> $PAYLOAD): the app is now a different version than the one this script intended to reconcile."
say ""
say "Reconciled: registry = installed = running = $PAYLOAD (was registry=$BEFORE_REGISTRY installed=$BEFORE_INSTALLED running=$BEFORE_PAYLOAD)."
