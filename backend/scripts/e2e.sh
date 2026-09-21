#!/usr/bin/env bash
# ============================================================================
# Full end-to-end run against the local stack:
#   1. PayPal verification stub container
#   2. Edge functions served with the throwaway test environment
#   3. Static server for the site
#   4. Client/admin smoke test, webhook tests, real-browser UI tests
# Everything started here is stopped again on exit.
#
#   npm run test:e2e          (requires `supabase start` first)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
LOG_DIR="$(mktemp -d)"
SERVE_PID=""; HTTP_PID=""

cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null || true
  sleep 1
  docker rm -f dv-paypal-mock supabase_edge_runtime_backend >/dev/null 2>&1 || true
  echo "logs: $LOG_DIR"
}
trap cleanup EXIT

# A previous `functions serve` would hold the runtime container. Match by
# process name: a plain `pkill -f` would also match any shell whose command
# line merely mentions it.
for pid in $(pgrep -f "functions serve" || true); do
  case "$(ps -o comm= -p "$pid" 2>/dev/null)" in node|supabase) kill "$pid" 2>/dev/null || true ;; esac
done
docker rm -f dv-paypal-mock supabase_edge_runtime_backend >/dev/null 2>&1 || true

echo "starting PayPal stub..."
docker run -d --name dv-paypal-mock --network supabase_network_backend node:22-alpine node -e "
require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{
  s.end(/(^|&)forged=1(&|$)/.test(b)?'INVALID':(b.startsWith('cmd=_notify-validate&')?'VERIFIED':'INVALID'));
});}).listen(8080)" >/dev/null

echo "serving functions (test environment)..."
supabase functions serve --env-file supabase/tests/functions.env >"$LOG_DIR/serve.log" 2>&1 &
SERVE_PID=$!

if ! curl -s -o /dev/null -m 2 http://127.0.0.1:5500/ 2>/dev/null; then
  echo "serving site on :5500..."
  (cd "$ROOT" && python3 -m http.server 5500 --bind 127.0.0.1 >"$LOG_DIR/http.log" 2>&1) &
  HTTP_PID=$!
fi

for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -X POST http://127.0.0.1:54321/functions/v1/api \
    -H 'Content-Type: application/json' -d '{"action":"getPrices"}' || true)
  [ "$code" = "200" ] && break
  sleep 2
done

echo; echo "=== client + admin ==="; node scripts/smoke-test.mjs
echo; echo "=== payments ===";       node scripts/webhook-test.mjs
echo; echo "=== browser ===";        node scripts/ui-test.mjs
echo; echo "END-TO-END SUITE PASSED"
