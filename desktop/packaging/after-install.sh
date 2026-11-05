#!/bin/sh
# fpm --after-install / --after-upgrade for the deb and pacman targets: this runs as ROOT when the
# package is installed, which is the only moment the update privilege can be put where polkit reads
# it. It is the packaging half of ticket 06becd1e and it touches exactly two things:
#
#   1. /usr/share/polkit-1/rules.d/49-e-app-registry-stamp.rules — the rule that lets the desktop
#      session run resources/e-app-registry-stamp as root through pkexec without a prompt. Without
#      it desktop/registry.cjs reports the registry as NOT stamped rather than prompting a player.
#   2. the mode of resources/e-app-registry-stamp, so the helper is executable however the archive
#      was unpacked. A non-executable helper is reported as missing by the app, never attempted.
#
# Nothing else is written: no registry file, no configuration, no service. Uninstalling removes the
# rule again (after-remove.sh beside this file).
set -u
PREFIX=${E_APP_INSTALL_DIR:-/opt/e-server}
RESOURCES=$PREFIX/resources
RULES=/usr/share/polkit-1/rules.d
RULE=49-e-app-registry-stamp.rules
HELPER=e-app-registry-stamp

if [ -f "$RESOURCES/$RULE" ]; then
 install -d -m 0755 "$RULES" || exit 0
 install -m 0644 "$RESOURCES/$RULE" "$RULES/$RULE" || exit 0
fi
[ -f "$RESOURCES/$HELPER" ] && chmod 0755 "$RESOURCES/$HELPER" || true
exit 0
