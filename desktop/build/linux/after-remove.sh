#!/bin/bash
# Debian post-remove script. electron-builder's default, plus removing the
# AppArmor profile that after-install.sh installed.
# (Shell variables are written $like_this; see after-install.sh.)

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# On removal only: during an upgrade the new version's post-install script
# replaces the profile itself.
profile='/etc/apparmor.d/${executable}'
if [ "$1" = remove ] || [ "$1" = purge ]; then
    if [ -f "$profile" ]; then
        if hash apparmor_parser 2>/dev/null; then
            apparmor_parser -R "$profile" 2>/dev/null || true
        fi
        rm -f "$profile"
    fi
fi
