#!/usr/bin/env bash
# ============================================================================
# Verify a built Linux app actually runs.
#
# Starts the AppImage inside a Debian container on a virtual display, then
# drives the live window over the DevTools protocol (test/app-smoke.mjs).
#
#   npm run build:linux && ./verify-build.sh
#
# Needs Docker, and the site served locally on :5500 (from the repo root:
#   python3 -m http.server 5500 --bind 127.0.0.1).
#
# --disable-gpu is required: Chromium aborts with "GPU process isn't usable"
# in a container. That is an artefact of the test environment, not the app.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

APPIMAGE=$(ls dist/*.AppImage 2>/dev/null | head -1)
[ -n "$APPIMAGE" ] || { echo "No AppImage in dist/. Run: npm run build:linux"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required."; exit 1; }

CONTAINER=dv-verify-$$
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cat > dist/.run-app.sh <<'INNER'
set -e
apt-get update -qq >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  xvfb xauth libgtk-3-0 libnotify4 libnss3 libxss1 libasound2 libatk-bridge2.0-0 \
  libgbm1 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libpango-1.0-0 ca-certificates >/dev/null 2>&1
cd /work && rm -rf squashfs-root
./*.AppImage --appimage-extract >/dev/null 2>&1
cd squashfs-root
Xvfb :77 -screen 0 1400x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 3
DISPLAY=:77 DOMAIN_VAULT_URL="${DOMAIN_VAULT_URL:-http://127.0.0.1:5500}" \
  ./domain-vault-desktop --no-sandbox --disable-gpu --disable-software-rasterizer \
  --disable-dev-shm-usage --remote-debugging-port=9222 --remote-allow-origins='*' \
  > /work/app.log 2>&1
INNER

echo "starting the app in a container (first run installs X libraries)..."
docker run -d --name "$CONTAINER" --network host -v "$PWD/dist:/work" \
  debian:12 bash /work/.run-app.sh >/dev/null

for _ in $(seq 1 90); do
  (echo > /dev/tcp/127.0.0.1/9222) 2>/dev/null && break
  sleep 2
done
(echo > /dev/tcp/127.0.0.1/9222) 2>/dev/null || {
  echo "the app never opened its debugging port; log:"; tail -20 dist/app.log; exit 1; }

node test/app-smoke.mjs
