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

# The reminder suite needs a working mail provider. If production credentials
# are present locally, borrow just those two values; mail goes to Resend's
# test inbox, never to a real person.
ENV_FILE="$LOG_DIR/functions.env"
grep -v -E '^(RESEND_API_KEY|MAIL_FROM)=' supabase/tests/functions.env > "$ENV_FILE"
MAIL_READY=0
if [ -f .env.production ] && grep -qE '^RESEND_API_KEY=.+' .env.production; then
  grep -E '^(RESEND_API_KEY|MAIL_FROM)=' .env.production >> "$ENV_FILE"
  MAIL_READY=1
fi

echo "serving functions (test environment)..."
supabase functions serve --env-file "$ENV_FILE" >"$LOG_DIR/serve.log" 2>&1 &
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

# A browser run that was interrupted leaves its accounts behind, and their
# domains would show up in the reminder sweep below.
docker exec -i supabase_db_backend psql -U postgres -qtA \
  -c "delete from auth.users where email like 'ui-%@example.com';" >/dev/null

echo; echo "=== client + admin ==="; node scripts/smoke-test.mjs
echo; echo "=== payments ===";       node scripts/webhook-test.mjs
echo; echo "=== reminders ==="
if [ "$MAIL_READY" = "1" ]; then
  REMINDER_ENV="$ENV_FILE" node scripts/reminders-test.mjs
else
  echo "  skipped: no RESEND_API_KEY in .env.production (sending cannot be exercised)"
fi
echo; echo "=== browser ===";        node scripts/ui-test.mjs
echo; echo "END-TO-END SUITE PASSED"
