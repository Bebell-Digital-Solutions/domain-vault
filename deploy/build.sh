#!/usr/bin/env bash
# ============================================================================
# Builds the two Cloudflare Pages sites from this repository.
#
#   bash deploy/build.sh site   ->  dist/site   getdomainvault.com
#                                   landing page (EN/ES), legal pages, downloads
#   bash deploy/build.sh app    ->  dist/app    app.getdomainvault.com
#                                   the app and the admin panel, at the root
#
# Cloudflare runs these on every push to main; each Pages project has its own
# build command and output directory. The repository itself stays a single
# site (app under /app/), so GitHub Pages can keep serving the old address
# while we move.
#
# SITE_ORIGIN and APP_ORIGIN override the two addresses.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_ORIGIN="${SITE_ORIGIN:-https://getdomainvault.com}"
APP_ORIGIN="${APP_ORIGIN:-https://app.getdomainvault.com}"
target="${1:-}"
out="dist/$target"

case "$target" in
  site)
    rm -rf "$out" && mkdir -p "$out"
    cp index.html 404.html downloads.html config.js "$out"/
    cp -r es p "$out"/
    # Links into the app go straight to its own domain (keeping ?register),
    # and so does the landing page's forwarder for PayPal returns and
    # password-reset links.
    find "$out" -name '*.html' -exec sed -i \
      -e "s#href=\"/app/#href=\"$APP_ORIGIN/#g" \
      -e "s#location.replace('/app/'#location.replace('$APP_ORIGIN/'#g" {} +
    # Old bookmarks and links in emails already sent still arrive at /app/.
    cat > "$out/_redirects" <<EOF
/app/*  $APP_ORIGIN/:splat  301
/app    $APP_ORIGIN/        301
EOF
    ;;
  app)
    rm -rf "$out" && mkdir -p "$out"
    cp app/index.html app/admin.html app/admin.js config.js api.js script.js "$out"/
    # In the repository the app lives in /app/ and loads its scripts from ../;
    # here it sits at the root, next to them. Links back to the main site
    # (downloads, legal pages) get the site's domain.
    sed -i \
      -e 's#src="\.\./#src="#g' \
      -e "s#href=\"\.\./#href=\"$SITE_ORIGIN/#g" \
      "$out/index.html" "$out/admin.html"
    ;;
  *)
    echo "usage: bash deploy/build.sh site|app" >&2
    exit 64
    ;;
esac

echo "built $out"
