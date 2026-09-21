# Domain Vault — Backend

Supabase backend for Domain Vault (Postgres, Auth, Storage, Edge Functions).
It replaces the old Google Apps Script + Google Sheets setup.

The database is plain Postgres. Moving to Neon or another host later means a
`pg_dump` plus a replacement for Supabase Auth; the schema, policies and
business logic here carry across unchanged.

**Going live?** Follow [LAUNCH.md](LAUNCH.md). It lists what the business owner
has to provide and the deployment steps in order.

---

## What it does

| Area | How |
|---|---|
| Accounts | Supabase Auth (bcrypt). New sign-ups start `pending` until an admin activates them, or until they pay. |
| Data isolation | Row Level Security on every table. A user's token can only ever reach that user's rows. |
| Registrar passwords | Optional. AES-256-GCM encrypted with a key that lives only in the function environment. Reveal is rate limited and audited. |
| Plans | One-time PayPal purchase of a domain pack (no subscription). The plan is **derived from a purchase ledger**, so refunds and chargebacks take back exactly what they granted. |
| Payments | PayPal IPN, verified with PayPal, checked against our receiver account and **against the price list** (amount and currency), deduplicated, and recorded, including the ones refused. |
| Admin | `admin.html`: activate and suspend users, override plans, set prices, sales report with CSV export, audit log. |
| Reminders | Daily pg_cron job emails (and optionally WhatsApp-messages) customers 30, 7 and 1 day before renewal. Idempotent. |
| Lookups | WHOIS / DNS proxied, validated, cached and rate limited. |

The problems in the old backend, and how each one is handled, are covered in
[SECURITY.md](SECURITY.md).

---

## Layout

```
domain-vault/                    (repo root = the website, served by GitHub Pages)
├── index.html  script.js        the app
├── admin.html  admin.js         the admin panel
├── config.js                    public config: backend URL, anon key, PayPal button ids
├── api.js                       browser client for the api function
└── backend/
    ├── LAUNCH.md                go-live checklist
    ├── SECURITY.md              threat model, known gaps, key management
    ├── supabase/
    │   ├── config.toml          local stack + per-function JWT settings
    │   ├── migrations/
    │   │   ├── …000100_init.sql           schema
    │   │   ├── …000200_rls.sql            row level security + grants
    │   │   ├── …000300_logic.sql          triggers, plan limits, sync RPCs, rate limiter
    │   │   ├── …000400_cron.sql           first schedule (superseded by cron_vault)
    │   │   ├── …000500_storage.sql        avatars bucket
    │   │   ├── …0917000100_billing_admin.sql  prices, purchase ledger, admin role, audit
    │   │   └── …0917000200_cron_vault.sql     reminder schedule via Vault
    │   ├── functions/
    │   │   ├── _shared/         cors, crypto, validation, db/auth, email + WhatsApp
    │   │   ├── api/             user + admin actions (index.ts, admin.ts)
    │   │   ├── lookup/          WHOIS + DNS proxy
    │   │   ├── billing-webhook/ PayPal IPN
    │   │   └── reminders/       daily renewal sweep
    │   └── tests/               SQL security tests + test function environment
    └── scripts/
        ├── import-from-sheets.mjs   one-time migration from the old sheet
        ├── smoke-test.mjs           client + admin API journeys
        ├── webhook-test.mjs         payment scenarios
        ├── ui-test.mjs              real-browser tests (headless Chrome)
        └── e2e.sh                   runs all three against the local stack
```

---

## Running it locally

Requires Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
cd backend
npm install

cp .env.example .env
openssl rand -base64 32     # -> CREDENTIAL_ENCRYPTION_KEY
openssl rand -hex 32        # -> CRON_SECRET
# set PAYPAL_ENV=sandbox for local work

supabase start              # first run downloads several GB of images
supabase db reset           # applies every migration from scratch
supabase functions serve --env-file .env
```

In a second terminal, serve the site from the repo root:

```bash
python3 -m http.server 5500 --bind 127.0.0.1
```

Open http://127.0.0.1:5500. Use `127.0.0.1` or `localhost`, not `file://`:
`config.js` picks the local backend based on the hostname.

| Local service | URL |
|---|---|
| App | http://127.0.0.1:5500 |
| Admin panel | http://127.0.0.1:5500/admin.html |
| Supabase Studio (tables, SQL) | http://127.0.0.1:54323 |
| Mail catcher (every outbound email) | http://127.0.0.1:54324 |

### Do not put `SUPABASE_*` values in `.env`

The function runtime injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` itself. Locally, `SUPABASE_URL` is
`http://kong:8000` on the Docker network. Overriding it with
`http://127.0.0.1:54321` makes every call fail with `name resolution failed`,
because inside the container `127.0.0.1` is the container. Hosted projects
reject `SUPABASE_*` secret names outright.

### Your first admin

The first admin has to be created directly in the database, once. After that,
admins manage each other from the Users tab.

```bash
# register normally through the app, then:
docker exec supabase_db_backend psql -U postgres -c \
  "update profiles set status='active', is_admin=true where email='you@example.com';"
```

On the hosted project, run the same `update` in the SQL editor.

### If `functions serve` gets stuck

A `functions serve` whose runtime container has died keeps running and prints
`No such container: supabase_edge_runtime_backend` in a loop. It also blocks a
new one from starting.

```bash
pkill -x supabase; pkill -f "node .*supabase functions"
docker rm -f supabase_edge_runtime_backend
supabase functions serve --env-file .env
```

Always stop `serve` with Ctrl+C before starting another.

---

## Testing

```bash
npm test            # SQL: 7 migrations on a clean Postgres 16 + security assertions
npm run test:e2e    # starts a PayPal stub + test functions, then runs:
                    #   smoke-test   customer and admin journeys through api.js
                    #   webhook-test 17 payment scenarios
                    #   ui-test      index.html + admin.html in headless Chrome
```

`test:e2e` needs `supabase start` first. It serves the functions with
`supabase/tests/functions.env`, a throwaway environment in which PayPal
verification goes to a local stub container. It stops everything it started
when it finishes. Restart your own `functions serve` afterwards.

What the suites prove, among other things:

- one user's token never reaches another user's rows, and a suspended account
  is locked out at the database level;
- users cannot grant themselves a plan, an override, admin rights or a
  purchase;
- plan limits hold even when the browser's limit is bypassed;
- an Agency payment of 0.01, a payment in the wrong currency, a payment to
  another receiver, and an unverified notification all grant nothing;
- a Pending payment that later clears is applied exactly once, and replays
  change nothing;
- a full refund or chargeback withdraws the pack, a partial refund does not,
  and a cancelled chargeback restores it;
- registrar passwords are stored encrypted and never returned except through
  the reveal action;
- the admin panel's actions work end to end, are all audited, and render
  database content as text (no XSS);
- the mobile menu works.

---

## Payments

PayPal only, one-time purchase per pack:

| Pack | Domains | Button `item_number` |
|---|---|---|
| Personal | 5 | free, no button |
| Start-up | 20 | `startup` |
| Business | 50 | `business` |
| Agency | unlimited | `agency` |

1. The admin sets each pack's price in **Admin → Prices**. A pack with no price
   cannot be bought.
2. Each pack has a PayPal "Buy Now" button charging **exactly** that price. Its
   id goes into `config.js`.
3. The site sends the customer to PayPal with their account email in `custom`.
4. PayPal notifies `billing-webhook`. The webhook verifies the notification,
   checks the receiver, pack, amount and currency, records it in `purchases`,
   and recomputes the customer's plan.
5. PayPal returns the customer to `/?payment=success`. The app polls until the
   new plan shows up.

The effective plan is the admin override if one is set, otherwise the
highest-ranked pack with a completed purchase, otherwise Personal. The first
completed purchase also activates a pending account. A downgrade never deletes
domains; the customer just can't add more until they're under the limit again.

Payments the webhook refuses still appear in **Admin → Sales**:

- `rejected`: wrong amount, currency or pack.
- `unmatched`: no account with that email.

The customer was charged in both cases, so refund them in PayPal, or grant
the pack with a plan override.

---

## Scheduled reminders

`…0917000200_cron_vault.sql` schedules the sweep for 08:00 UTC. It reads two
values from Supabase Vault. Create them once per project, in the SQL editor
(locally: Studio, or `docker exec … psql`):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'dv_functions_base_url');
select vault.create_secret('<the CRON_SECRET value>', 'dv_cron_secret');
```

Locally, the base URL is `http://kong:8000/functions/v1`.

Until both entries exist, the job runs and does nothing. To trigger a sweep by
hand:

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/reminders \
  -H "x-cron-secret: $CRON_SECRET"
```

The sweep is idempotent. Each reminder is claimed in `notifications` before it
is sent, so overlapping runs cannot double-send.

---

## Deploying

The full sequence, including what to verify afterwards, is in
[LAUNCH.md](LAUNCH.md). The commands:

```bash
supabase link --project-ref <project-ref>
supabase db push
supabase secrets set --env-file .env.production
supabase functions deploy api lookup billing-webhook reminders
```

`supabase/config.toml` turns gateway JWT verification off for `api`,
`billing-webhook` and `reminders`. Each authenticates callers itself:

- `api` authenticates per action; register, login and prices are public
  because the caller has no token yet.
- `billing-webhook` verifies with PayPal.
- `reminders` checks the cron secret.

With gateway verification on, all three are rejected before our code runs. If
your CLI version ignores `config.toml`, add `--no-verify-jwt` when deploying
those three.

---

## Migrating the old Google Sheet

Run this once in the old Apps Script project and save the output as
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

```bash
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...        # shell only, never a file in the repo
node scripts/import-from-sheets.mjs export.json            # dry run
node scripts/import-from-sheets.mjs export.json --commit
```

**No passwords are imported, by design.** The old backend exposed both
account and registrar passwords, so all of them must be treated as
compromised. See [SECURITY.md](SECURITY.md).

---

## API reference

Every action is a `POST /functions/v1/api` with body `{ "action": "...", ... }`.
Except the public ones, each needs `Authorization: Bearer <access_token>`.

| Action | Who | Payload | Notes |
|---|---|---|---|
| `registerUser` | public | `email`, `password`, `phone`, `location` | Password ≥ 10 chars. 5/hour per IP. |
| `loginUser` | public | `email`, `password` | Returns `user` (incl. `plan`, `isAdmin`) and `session`. |
| `getPrices` | public | — | Pack prices; `amount: null` = not for sale. |
| `getUserData` | user | — | Domains, providers, settings, current `plan`, `isAdmin`, own `purchases`. |
| `saveDomains` | user | `domains[]` | Atomic sync. Plan limit enforced. |
| `saveProviders` | user | `providers[]` | Empty `pass` keeps the stored password; `removePassword: true` deletes it. |
| `saveSettings` | user | `settings{}` | Base64 avatars are moved to Storage. |
| `revealCredential` | user | `providerId` | 10/hour, audited. |
| `adminOverview` | admin | — | Counts by status and plan, domains, sales, payments needing review. |
| `adminListUsers` | admin | `status?`, `search?`, `limit?`, `offset?` | With domain counts. |
| `adminUpdateUser` | admin | `userId`, `status?`, `planOverride?`, `isAdmin?` | Audited. Emails the user on activation. Can't demote or suspend yourself. |
| `adminSales` | admin | `from?`, `to?`, `status?` | Ledger plus totals per currency. |
| `adminGetPrices` / `adminSetPrice` | admin | `plan`, `amount`, `currency` | `amount: null` takes a pack off sale. Audited. |
| `adminAudit` | admin | `limit?` | Recent admin changes, before and after. |

Other endpoints:

- `POST /functions/v1/lookup` with `domain`, `kind`, `types[]` (signed-in users)
- `POST /functions/v1/billing-webhook` (PayPal IPN)
- `POST /functions/v1/reminders` (`x-cron-secret`)
