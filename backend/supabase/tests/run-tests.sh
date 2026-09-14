#!/usr/bin/env bash
# Apply every migration to a throwaway Postgres container and assert the
# security properties still hold. Requires Docker; touches nothing else.
#
#   ./supabase/tests/run-tests.sh
set -euo pipefail

CONTAINER=dv-test-$$
MIGRATIONS="$(dirname "$0")/../migrations"
TESTS="$(dirname "$0")"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "starting postgres..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pw postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

docker exec -i "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 < "$TESTS/00_stubs.sql"
echo "stubs loaded"

for f in "$MIGRATIONS"/*.sql; do
  printf '  %-42s' "$(basename "$f")"
  docker exec -i "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 < "$f"
  echo "OK"
done

echo
docker exec -i "$CONTAINER" psql -U postgres < "$TESTS/01_security.sql" 2>&1 \
  | grep -Ev '^(SET|GRANT|INSERT|UPDATE|DO|DELETE)' | grep -v '^$' | tee /tmp/dv-test-out.$$

if grep -q 'FAIL' /tmp/dv-test-out.$$; then
  rm -f /tmp/dv-test-out.$$
  echo; echo "TESTS FAILED"; exit 1
fi
rm -f /tmp/dv-test-out.$$
echo; echo "all tests passed"
