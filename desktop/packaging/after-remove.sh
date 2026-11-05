#!/bin/sh
# fpm --after-remove for the deb and pacman targets: the rule the package installed is the package's
# own policy, so it leaves with the package. The helper it grants lives under the install prefix and
# goes with the rest of it.
set -u
RULE=49-e-app-registry-stamp.rules
rm -f "/usr/share/polkit-1/rules.d/$RULE" || true
exit 0
