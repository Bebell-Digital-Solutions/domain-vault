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

# No mail key while the suites run: they register accounts at example.com,
# and with the real key every welcome email and receipt would be sent and
# bounce, which counts against the sending domain's reputation.
#
# The reminder suite needs real sending. With MAIL_TESTS=1 it runs last, on
# its own, with the production key borrowed from .env.production; it only
# ever writes to Resend's test inbox (delivered@resend.dev).
ENV_FILE="$LOG_DIR/functions.env"
grep -v -E '^(RESEND_API_KEY|MAIL_FROM)=' supabase/tests/functions.env > "$ENV_FILE"
MAIL_ENV_FILE="$LOG_DIR/functions-mail.env"
MAIL_READY=0
if [ "${MAIL_TESTS:-0}" = "1" ] && [ -f .env.production ] && grep -qE '^RESEND_API_KEY=.+' .env.production; then
  cp "$ENV_FILE" "$MAIL_ENV_FILE"
  grep -E '^(RESEND_API_KEY|MAIL_FROM)=' .env.production >> "$MAIL_ENV_FILE"
  MAIL_READY=1
fi

serve_functions() {
  if [ -n "$SERVE_PID" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
    sleep 2
    docker rm -f supabase_edge_runtime_backend >/dev/null 2>&1 || true
  fi
  supabase functions serve --env-file "$1" >>"$LOG_DIR/serve.log" 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -X POST http://127.0.0.1:54321/functions/v1/api \
      -H 'Content-Type: application/json' -d '{"action":"getPrices"}' || true)
    [ "$code" = "200" ] && return 0
    sleep 2
  done
}

echo "serving functions (test environment, no mail)..."
serve_functions "$ENV_FILE"

if ! curl -s -o /dev/null -m 2 http://127.0.0.1:5500/ 2>/dev/null; then
  echo "serving site on :5500..."
  (cd "$ROOT" && python3 -m http.server 5500 --bind 127.0.0.1 >"$LOG_DIR/http.log" 2>&1) &
  HTTP_PID=$!
fi

# A browser run that was interrupted leaves its accounts behind, and their
# domains would show up in the reminder sweep below.
docker exec -i supabase_db_backend psql -U postgres -qtA \
  -c "delete from auth.users where email like 'ui-%@example.com';" >/dev/null

echo; echo "=== client + admin ==="; node scripts/smoke-test.mjs
echo; echo "=== payments ===";       node scripts/webhook-test.mjs
echo; echo "=== browser ===";        node scripts/ui-test.mjs
echo; echo "=== reminders ==="
if [ "$MAIL_READY" = "1" ]; then
  echo "re-serving functions with the mail key..."
  serve_functions "$MAIL_ENV_FILE"
  REMINDER_ENV="$MAIL_ENV_FILE" node scripts/reminders-test.mjs
else
  echo "  skipped: run with MAIL_TESTS=1 (and RESEND_API_KEY in .env.production) to exercise real sending"
fi
echo; echo "END-TO-END SUITE PASSED"
