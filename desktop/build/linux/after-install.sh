#!/bin/bash
# Debian post-install script. electron-builder's default (alternatives link,
# MIME and desktop databases) plus an AppArmor profile.
#
# Why the profile: Ubuntu 24.04+ restricts unprivileged user namespaces
# (kernel.apparmor_restrict_unprivileged_userns=1), and Chromium's sandbox
# needs them. The default script tests namespaces as root, where they always
# work, so it leaves chrome-sandbox without its setuid bit, and the app then
# aborts on launch for every normal user ("The SUID sandbox helper binary was
# found, but is not configured correctly"). Ubuntu's own fix, used for Chrome,
# VS Code and Slack, is a profile granting `userns` to the application.
#
# electron-builder fills in ${executable} and ${sanitizedProductName} and
# rejects any other dollar-brace name, so shell variables here are written
# $like_this.

app_dir='/opt/${sanitizedProductName}'
app_bin="$app_dir/${executable}"
profile='/etc/apparmor.d/${executable}'

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' "$app_bin" 100 || ln -sf "$app_bin" '/usr/bin/${executable}'
else
    ln -sf "$app_bin" '/usr/bin/${executable}'
fi

# AppArmor 4 (Ubuntu 24.04+) knows the userns rule; older systems need nothing.
profile_loaded=0
if [ -f /etc/apparmor.d/abi/4.0 ] && hash apparmor_parser 2>/dev/null; then
    cat > "$profile" <<EOF
# Installed by the ${sanitizedProductName} package. Allows the user namespaces
# Chromium's sandbox needs; the app is otherwise unconfined.

abi <abi/4.0>,
include <tunables/global>

profile ${executable} "$app_bin" flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
EOF
    if apparmor_parser -r -T -W "$profile" 2>/dev/null; then
        profile_loaded=1
    fi
fi

if [ "$profile_loaded" = 1 ]; then
    # Namespaces are allowed for the app now; no setuid helper needed.
    chmod 0755 "$app_dir/chrome-sandbox" || true
elif ! { [[ -L /proc/self/ns/user ]] && unshare --user true; } \
    || [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    # Normal users get no namespaces (and root's test above proves nothing
    # when AppArmor restricts them): fall back to the setuid sandbox helper.
    chmod 4755 "$app_dir/chrome-sandbox" || true
else
    chmod 0755 "$app_dir/chrome-sandbox" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
