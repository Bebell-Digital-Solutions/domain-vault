# Domain Vault — Backend

Postgres backend replacing the Google Apps Script + Google Sheets setup.

Built on Supabase (Postgres, Auth, Storage, Edge Functions). Because the
database is plain Postgres, moving to Neon or any other host later is a
`pg_dump` plus a replacement for the Auth layer — the schema, the policies and
the business logic in this directory all carry across unchanged.

---

## Why this exists

The previous backend had three problems that could not be patched in place:

1. **No authorization.** The Apps Script endpoint is public in the page source
   and accepted the caller's own email as identity. Anyone could read or
   overwrite any account's data by passing a different address.
2. **Plaintext passwords.** Both account passwords and customers' *registrar*
   credentials sat in spreadsheet cells in clear text.
3. **Destructive writes.** Every save deleted all of a user's rows and
   re-appended them. An Apps Script timeout mid-write lost the lot.

Each is addressed structurally here rather than by adding checks: identity
comes from a signed JWT, Row Level Security makes cross-account reads
impossible at the database level, passwords are delegated to Supabase Auth,
registrar secrets are encrypted with a key the database never sees, and writes
are atomic.

---

## Layout

```
backend/
├── supabase/
│   ├── migrations/
│   │   ├── 20260912000100_init.sql      schema
│   │   ├── 20260912000200_rls.sql       row level security + grants
│   │   ├── 20260912000300_logic.sql     triggers, entitlements, sync RPCs
│   │   ├── 20260912000400_cron.sql      scheduled jobs
│   │   └── 20260912000500_storage.sql   avatars bucket
│   └── functions/
│       ├── _shared/                     cors, crypto, validation, db, notify
│       ├── api/                         main router (replaces doPost)
│       ├── lookup/                      WHOIS + DNS proxy with caching
│       ├── billing-webhook/             verified PayPal IPN
│       └── reminders/                   daily renewal sweep
├── scripts/import-from-sheets.mjs       one-time data migration
└── web/api.js                           frontend client
```

---

## Running it locally

Everything runs on your machine — no Supabase account needed. Requires Docker.

```bash
# 1. Install the CLI (skip if `supabase --version` already works)
npm install -g supabase        # or: brew install supabase/tap/supabase

# 2. Configure
cp .env.example .env
openssl rand -base64 32        # paste into CREDENTIAL_ENCRYPTION_KEY

# 3. Start Postgres, Auth, Storage and the API gateway.
#    First run downloads several GB of images and takes a few minutes.
supabase start
```

`supabase start` prints a local `API URL`, `anon key` and `service_role key`.
Copy those three into `.env` — the placeholders from `.env.example` are not
real keys:

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key from the output>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from the output>
```

Then apply the schema and serve the functions:

```bash
supabase db reset                        # runs every migration from scratch
supabase functions serve --env-file .env
```

Useful local endpoints:

| What | URL |
|---|---|
| Studio (browse tables, run SQL) | http://127.0.0.1:54323 |
| API | http://127.0.0.1:54321 |
| Inbucket (catches every outbound email) | http://127.0.0.1:54324 |

### Smoke test

With `functions serve` running, in a second terminal:

```bash
API=http://127.0.0.1:54321/functions/v1/api

# 1. Register. Accounts start pending, by design.
curl -s -X POST $API -H 'Content-Type: application/json' \
  -d '{"action":"registerUser","email":"you@example.com","password":"correct-horse-battery"}'
# -> {"success":true,"message":"Account created! Pending admin activation."}

# 2. Logging in now is refused, and says why.
curl -s -X POST $API -H 'Content-Type: application/json' \
  -d '{"action":"loginUser","email":"you@example.com","password":"correct-horse-battery"}'
# -> {"success":false,"message":"Account pending activation by Admin."}

# 3. Activate (normally an admin action; there is no admin panel yet).
docker exec supabase_db_backend psql -U postgres \
  -c "update public.profiles set status='active' where email='you@example.com';"

# 4. Log in and keep the token.
TOKEN=$(curl -s -X POST $API -H 'Content-Type: application/json' \
  -d '{"action":"loginUser","email":"you@example.com","password":"correct-horse-battery"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"]["access_token"])')

# 5. Use it.
curl -s -X POST $API -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d '{"action":"getUserData"}'
```

Worth confirming the properties yourself:

```bash
# No token: refused.
curl -s -X POST $API -H 'Content-Type: application/json' -d '{"action":"getUserData"}'
# -> {"success":false,"message":"Not signed in."}

# Plan limits are enforced by the database, not the browser.
curl -s -X POST $API -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"action":"saveDomains","domains":[{"name":"d1.com"},{"name":"d2.com"},{"name":"d3.com"},
       {"name":"d4.com"},{"name":"d5.com"},{"name":"d6.com"}]}'
# -> "You have reached the domain limit for the Personal plan."

# Stored registrar passwords are ciphertext at rest.
docker exec supabase_db_backend psql -U postgres -c "select * from public.provider_secrets;"
```

Register a second user and call `getUserData` with the first user's token: you
get your own rows, never theirs. That is Row Level Security doing it, not
application code — which is exactly what the old backend could not do.

### Stopping

```bash
supabase stop             # keeps data
supabase stop --no-backup # wipes the local database
```

---

## Deploying to a hosted project

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF

supabase db push                          # apply migrations
supabase secrets set --env-file .env      # push secrets to the function runtime
supabase functions deploy api lookup billing-webhook reminders
```

`api` and `billing-webhook` must run with gateway JWT verification **off**.
`supabase/config.toml` already declares this, so the deploy command above
picks it up. If your CLI version ignores that, deploy those two explicitly:

```bash
supabase functions deploy api --no-verify-jwt
supabase functions deploy billing-webhook --no-verify-jwt
```

This is not a hole. `api` authenticates every action itself — only
`registerUser` and `loginUser` are public, and they have to be, because the
caller has no token yet. `billing-webhook` authenticates by posting the
message back to PayPal for confirmation. Gateway verification would simply
reject both before our code could run.

Never put `SUPABASE_SERVICE_ROLE_KEY` in the frontend. The anon key is public
by design; the service role key bypasses every policy in the database.

---

## Scheduled jobs

`20260912000400_cron.sql` registers two pg_cron jobs: the daily reminder sweep
at 08:00 UTC and a nightly cache purge. pg_cron needs two settings to know
where to call:

```sql
alter database postgres set app.functions_base_url =
  'https://YOUR-PROJECT-REF.supabase.co/functions/v1';
alter database postgres set app.service_role_key = 'your-service-role-key';
```

If pg_cron is unavailable the migration logs a notice and does nothing. In that
case call the endpoint from any external scheduler:

```bash
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/reminders \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

The sweep is idempotent — a duplicate run cannot send a duplicate reminder —
so overlapping schedules are harmless.

---

## Migrating the existing data

### Exporting the old sheet

Run this once in the existing Apps Script project and copy the output into
`export.json`:

```javascript
function exportAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = {};
  ['Users', 'Domains', 'Providers', 'Settings'].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const rows = sheet.getDataRange().getValues();
    const headers = rows.shift();
    out[name] = rows.map(function (row) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
  });
  Logger.log(JSON.stringify(out));
}
```

### Importing

```bash
npm install
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...

node scripts/import-from-sheets.mjs export.json            # dry run first
node scripts/import-from-sheets.mjs export.json --commit
```

**No passwords are imported, by design.** Account passwords and registrar
credentials were both exposed by the old backend, so every one of them must be
treated as compromised. Accounts are created with a random password and a
recovery link; registrar passwords are left out entirely and users re-enter the
ones they still want stored, *after rotating them at the registrar*. See
[SECURITY.md](SECURITY.md).

---

## Wiring up the frontend

See [INTEGRATION.md](INTEGRATION.md). The short version: the action names and
response shapes are unchanged, so the change to `script.js` is a config block,
a three-line replacement of `apiCall`, and two small edits for the credential
handling.

---

## API

All actions POST to `/functions/v1/api` as `{ "action": "...", ... }`.
Everything except `registerUser` and `loginUser` requires
`Authorization: Bearer <access_token>`.

| Action | Payload | Notes |
|---|---|---|
| `registerUser` | `email`, `password`, `phone`, `location` | Password min 10 chars. 5/hour per IP. |
| `loginUser` | `email`, `password` | Returns the user and a session. |
| `getUserData` | — | Domains, providers, settings. Never returns stored passwords. |
| `saveDomains` | `domains[]` | Atomic sync. Enforces the plan limit. |
| `saveProviders` | `providers[]` | Empty `pass` leaves a stored password untouched. |
| `saveSettings` | `settings{}` | Base64 avatars are moved to Storage. |
| `revealCredential` | `providerId` | One registrar password. 10/hour, audited. |

Separate endpoints: `POST /functions/v1/lookup` (`domain`, `kind`,
`types[]`) and `POST /functions/v1/billing-webhook` (PayPal IPN).

---

## Still to do

Not built here, and worth scoping before the next phase:

- **Admin panel.** Activating a user is currently a SQL update.
- **Stripe.** Needed for Japan; PayPal alone is a poor fit there
  (Konbini, JCB, and JPY pricing).
- **Automated tests.** The SQL has been validated against Postgres 16, but
  there is no test suite for the Edge Functions yet.
- **Rotating the exposed Apps Script deployment**, which keeps serving until
  it is explicitly retired.
