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
| Data isolation | Row Level Security on every table. A user's token can only ever reach that user's rows, and the rows of team vaults they were invited into, within the permissions they were given. |
| Teams | An owner invites people by email into their vault and ticks what each may do (edit domains, edit providers, delete, see passwords, export, manage the team, get renewal reminders); viewing is always included. Seats per plan, owner included: Personal 1, Start-up 2, Business 5, Agency unlimited. No extra seats are sold. One person can be in several teams and switches between vaults in the app. Members' changes are logged for the owner. |
| Registrar passwords | Optional. AES-256-GCM encrypted with a key that lives only in the function environment. Reveal is rate limited and audited. |
| Plans | Yearly PayPal subscriptions (Personal, Start-up, Business, Agency), plus optional one-time "lifetime deals". The plan is **derived from a payment ledger**: each subscription payment grants a year, so a lapsed subscription, a refund or a chargeback takes back exactly what was paid for. |
| Payments | PayPal IPN, verified with PayPal, checked against our receiver account and **against the price list for that kind of payment** (yearly or lifetime; amount and currency), deduplicated, and recorded, including the ones refused. Subscription signups, cancellations, failed renewals and ends of term are tracked. |
| Owner settings | From the admin panel: what accounts without a paid plan get (Personal for free, or Free with no domains), and whether new sign-ups wait for approval. |
| Pay first, sign up after | A payment nobody's account matches (e.g. from the lifetime-deal page) emails the payer a one-time **activation link**; signing up or logging in through it attaches the purchase. |
| Tools & recommendations | Managed in Admin → Tools (`catalog_items`); the app's Tools page and "Recommended providers" read them through `getCatalog`. |
| Live chat | The helpdesk operator widget loads in the admin panel after login; its key comes from the server (`adminSupportWidget`), never from the page source. |
| Admin | `app/admin.html`: activate and suspend users, override plans, set prices, sales report with CSV export, audit log. |
| Reminders | Daily pg_cron job. Fires on the most urgent milestone a domain has *crossed* (default 30/7/1/0 days), so a domain added late or a missed run still produces exactly one reminder. One digest per user, not one email per domain. Per-user opt-out, channels and lead days. |
| Lookups | WHOIS / DNS proxied, validated, cached and rate limited. The app calls only this proxy. |
| Calendar | A private subscription feed per user (`calendar` function). Google, Apple and Outlook poll it, so renewals stay current in the user's own calendar. Resettable. |
| Passwords | Reset by email link (Supabase Auth) and change from Settings, which proves the current password first and signs out every other device. |

The problems in the old backend, and how each one is handled, are covered in
[SECURITY.md](SECURITY.md).

---

## Layout

```
domain-vault/                    (repo root = the website, served by GitHub Pages)
├── index.html  es/  p/          landing page (EN/ES) and legal pages
├── app/index.html               the app (loads ../config.js, ../api.js, ../script.js)
├── app/admin.html  admin.js     the admin panel
├── script.js                    the app's logic
├── config.js                    public config: backend URL, anon key, PayPal button ids
├── api.js                       browser client for the edge functions
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
    │   │   ├── …0917000200_cron_vault.sql     reminder schedule via Vault
    │   │   ├── …0928000100_reminders.sql      milestone reminders, digests, preferences
    │   │   ├── …1005000100_calendar_feed.sql  calendar subscription tokens
    │   │   ├── …1006000100_free_tier.sql      Free tier (enum value only)
    │   │   ├── …1006000200_subscriptions.sql  yearly subscriptions, owner settings
    │   │   ├── …1008000100_purchase_claims.sql activation links (pay first)
    │   │   ├── …1008000200_catalog.sql        tools & recommendations
    │   │   └── …1009000100_teams.sql          team vaults: members, permissions, seats
    │   ├── functions/
    │   │   ├── _shared/         cors, crypto, validation, db/auth, email + WhatsApp
    │   │   ├── api/             user, team + admin actions (index.ts, vault.ts, admin.ts)
    │   │   ├── lookup/          WHOIS + DNS proxy
    │   │   ├── billing-webhook/ PayPal IPN
    │   │   ├── reminders/       daily renewal sweep
    │   │   └── calendar/        private .ics subscription feed
    │   └── tests/               SQL security tests + test function environment
    └── scripts/
        ├── import-from-sheets.mjs   one-time migration from the old sheet
        ├── smoke-test.mjs           client + admin API journeys
        ├── team-test.mjs            team vaults: invitations, permissions, seats
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

Open http://127.0.0.1:5500/app/. Use `127.0.0.1` or `localhost`, not `file://`:
`config.js` picks the local backend based on the hostname.

| Local service | URL |
|---|---|
| Landing page | http://127.0.0.1:5500 |
| App | http://127.0.0.1:5500/app/ |
| Admin panel | http://127.0.0.1:5500/app/admin.html |
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
npm test            # SQL: every migration on a clean Postgres 16 + security assertions
npm run test:e2e    # starts a PayPal stub + test functions (no mail key), then runs:
                    #   smoke-test     customer and admin journeys through api.js,
                    #                  incl. lookups, calendar feed, password change
                    #   team-test      invitations, permissions, seats, leaving
                    #   webhook-test   17 payment scenarios
                    #   reminders-test the daily sweep, end to end; only with
                    #                  MAIL_TESTS=1, which borrows the real mail key
                    #                  and writes only to Resend's test inbox
                    #   ui-test        app + admin panel in headless Chrome, incl. the
                    #                  password-reset email round trip (Mailpit)
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
- a team member reaches only the vaults they were invited into, can do only
  what they were given, loses access at once when removed, and the newest
  members lose access first when the owner's plan has fewer seats; a team
  manager cannot hand out a permission they lack; an invitation works once;
- the mobile menu works;
- a save the server refuses says why and the screen reverts to what is stored;
- a calendar link serves only its owner's renewals, stops working when reset,
  and goes dark when the account is suspended;
- changing a password needs the current one and signs out other devices; a
  reset link sets a new password and is removed from the address bar.

---

## Payments

PayPal only. Every plan is a **yearly subscription**; a plan can also be sold
as a one-time **lifetime deal** once it has a lifetime price and button.

| Plan | Domains | Yearly (USD) | Button `item_number` |
|---|---|---|---|
| Free | 0 | — | not sold; see "Owner settings" |
| Personal | 5 | 29 | `personal` |
| Start-up | 20 | 48 | `start-up` (or `startup`) |
| Business | 50 | 79 | `business` |
| Agency | unlimited | 98 | `agency` |

1. The admin sets each plan's prices in **Admin → Prices**: the yearly price,
   and optionally a lifetime price. A plan with no price for a kind cannot be
   bought that way.
2. Each plan has a PayPal button charging **exactly** that price: a
   "Subscribe" button (yearly) and, for lifetime deals, a "Buy Now" button.
   Their ids go into `config.js` (`buttons` / `lifetimeButtons`).
3. The app sends the customer to PayPal with their account email in `custom`.
4. PayPal notifies `billing-webhook`. The webhook verifies the notification,
   checks the receiver, plan, amount and currency **against the price for
   that kind of payment** (a one-time payment of the yearly price buys
   nothing), records it in `purchases`, and recomputes the customer's plan.
5. PayPal returns the customer to `https://app.getdomainvault.com/?payment=success`.
   The app polls until the new plan shows up.

**Subscriptions.** Each completed subscription payment grants its plan until
a year after the payment plus `billing_config.grace_days` (3), so PayPal's
retries for a late renewal don't interrupt the customer. The next yearly
payment extends it. Cancelling (in PayPal) keeps the plan until the paid year
runs out; PayPal's end-of-term message, or simply the date passing (an hourly
job, `refresh_plans`), takes it back. Failed renewals email the customer and
the admin. A customer who subscribes to a second plan is told to cancel the
first in PayPal, which we cannot do for them.

**Matching payments to accounts.** By `custom` (the account email the app
sends). If a payment carries none — a button used outside the app — the
payer's PayPal email is used when an account has that address; PayPal has
verified it. A renewal always goes to the subscription's owner.

Otherwise the payment is held as `unmatched` and the payer is emailed an
**activation link** (`purchase_claims`, 256-bit token, single use, 30 days).
Signing up or logging in through it (`registerUser` / `loginUser` with
`claimToken`, or `claimPurchase` when already signed in) attaches the payment
and activates the account. This is what makes the lifetime-deal page's
"pay first" buttons work. Unmatched payments are deliberately **not** handed
to whoever registers with the payer's email: sign-up emails are not verified,
so that would let anyone take someone else's payment; the link proves the
person reads the payer's inbox. Payments in newer PayPal checkouts (Pay
Links) that describe the item cart-style (`item_number1`) are recognised too.

The effective plan is the admin override if one is set, otherwise the
highest-ranked plan with a payment that is still running, otherwise the
"unpaid" plan from the owner settings. The first completed payment also
activates a pending account. A downgrade never deletes domains; the customer
just can't add more until they're under the limit again.

**Owner settings** (Admin → Prices → Plan settings, table `billing_config`):

- *Accounts without a paid plan get* `Personal` (5 domains, free — the
  original behaviour) or `Free` (no domains until they subscribe). Changing
  it re-derives every account's plan at once.
- *New sign-ups need approval*: on (original behaviour), or off — accounts
  are active straight away and can subscribe from inside the app.

Payments and subscriptions the webhook refuses still appear in
**Admin → Sales** and are emailed to `ADMIN_EMAIL`:

- `rejected`: wrong amount, currency, period or plan.
- `unmatched`: no account with that email.

The customer was charged in both cases, so refund them in PayPal, or grant
the plan with a plan override.

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

### How it decides

All of it lives in the `due_reminders` SQL function, covered by `npm test`.

- A reminder fires for the **most urgent milestone a domain has crossed** and
  not yet been told about — not for an exact date match. A domain added 20
  days before renewal gets the 30-day reminder immediately; a sweep that never
  ran (outage, paused project) does not lose the milestone.
- Only one fires at a time. Passing several thresholds at once produces the
  most urgent, never a backlog.
- "Already reminded" is keyed on the **renewal date**, so renewing a domain
  starts a fresh cycle. (Without this, reminders worked once per domain, ever.)
- Expired domains are left alone.
- Each user gets **one digest** per sweep listing every due domain, with
  provider, price, and whether auto-renew is on.
- Each reminder is claimed in `notifications` *before* sending; if the send
  fails the claim is released, so the next sweep retries rather than recording
  a delivery that never happened.
- Users choose channels and lead days, or switch reminders off, under
  Settings → Renewal Reminders. Suspended accounts are skipped.
- Sent reminders are purged after 180 days by `purge_transient`.

The sweep is safe to run repeatedly: overlapping runs cannot double-send.

```bash
npm run test:reminders   # needs the functions served with a mail key
```

---

## Deploying

The full sequence, including what to verify afterwards, is in
[LAUNCH.md](LAUNCH.md). The commands:

```bash
supabase link --project-ref <project-ref>
supabase db push
supabase secrets set --env-file .env.production
supabase functions deploy api lookup billing-webhook reminders calendar
```

`supabase/config.toml` turns gateway JWT verification off for `api`,
`billing-webhook`, `reminders` and `calendar`. Each authenticates callers
itself:

- `api` authenticates per action; register, login and prices are public
  because the caller has no token yet.
- `billing-webhook` verifies with PayPal.
- `reminders` checks the cron secret.
- `calendar` checks the feed token in the URL (calendar apps send no headers).

With gateway verification on, all four are rejected before our code runs. If
your CLI version ignores `config.toml`, add `--no-verify-jwt` when deploying
those four.

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
| `registerUser` | public | `email`, `password`, `phone`, `location`, `claimToken?`, `inviteToken?` | Password ≥ 10 chars. 5/hour per IP. With an activation link, attaches the purchase and activates the account. With a team invitation, joins the team and activates the account (`joinedVault`). |
| `requestPasswordReset` | public | `email`, `redirectTo?` | Emails a reset link back to `redirectTo` if its origin is in `ALLOWED_ORIGINS`, else `SITE_URL/app/`. Same answer for unknown addresses. 5/hour per IP, 3 per address. |
| `loginUser` | public | `email`, `password`, `claimToken?`, `inviteToken?` | Returns `user` (incl. `plan`, `isAdmin`) and `session`; `claimedPlan` / `claimMessage`, `joinedVault` / `inviteMessage` when a link was used. |
| `getCatalog` | public | — | Active tools and recommended providers. |
| `getPrices` | public | — | Per plan: `amount` (yearly), `lifetimeAmount` (one-time), `currency`; `null` = not for sale that way. |
| `getUserData` | user | `vaultId?` | Domains and providers of one vault (own by default), the `vault` on screen with the caller's `permissions`, every vault they can open (`vaults`), and their own settings, `plan`, `isAdmin`, `purchases` (with `kind`, `paid_until`) and `subscriptions` (with `paidUntil`). |
| `saveDomain` / `deleteDomain` | user | `vaultId?`, `domain{ id?, name, provider, purchaseDate, renewalDate, purchasePrice, renewalPrice, autoRenew }` / `id` | One item; creates or updates by id. The vault's plan limit applies. Needs *edit domains* / *delete* in a team vault. |
| `saveProvider` / `deleteProvider` | user | `vaultId?`, `provider{ id?, name, url, user, uid, pass?, removePassword? }` / `id` | Empty `pass` keeps the stored password. A rename moves the provider's domains along. A provider with domains cannot be deleted. |
| `saveDomains` / `saveProviders` | user | `domains[]` / `providers[]` | Whole-list sync of the caller's own vault, for clients from before teams. |
| `saveSettings` | user | `settings{}` | Base64 avatars are moved to Storage. |
| `revealCredential` | user | `vaultId?`, `providerId` | 10/hour, audited. Needs *see passwords* in a team vault. |
| `changePassword` | user | `currentPassword`, `newPassword` | Current password checked; ≥ 10 chars. Signs out every other session; `api.js` adopts the returned one. 5 per 15 min. |
| `claimPurchase` | user | `token` | Redeem an activation link while signed in. 10/hour per IP. |
| `getTeam` | user | `vaultId?` | Needs *manage*. Members with permissions and whether they fit the seats, open invitations, `seats{ used, limit }`, last 50 activity entries. |
| `inviteMember` | user | `vaultId?`, `email`, `permissions{}` | Needs *manage* and a free seat. Emails a one-time link (7 days) and returns it as `inviteUrl`. A manager who is not the owner can only grant what they hold. 20/hour. |
| `updateMember` / `removeMember` | user | `vaultId?`, `memberId`, `permissions{}` | Needs *manage*; not on yourself. |
| `cancelInvitation` | user | `vaultId?`, `email` | Needs *manage*. |
| `acceptInvitation` | user | `token` | Join a team while signed in. 10/hour per IP. |
| `leaveTeam` | user | `vaultId` | Works even when the team is over its seats. |
| `getCalendarFeed` | user | — | `{ token }` for the private feed, created on first use. `DomainVaultAPI.calendarFeedUrl(token)` builds the URL. |
| `resetCalendarFeed` | user | — | New token; the old URL returns 404. |
| `adminOverview` | admin | — | Counts by status and plan, domains, sales, payments needing review. |
| `adminListUsers` | admin | `status?`, `search?`, `limit?`, `offset?` | With domain counts, team size (`team_members`) and teams joined (`member_of`). |
| `adminUpdateUser` | admin | `userId`, `status?`, `planOverride?`, `isAdmin?` | Audited. Emails the user on activation. Can't demote or suspend yourself. |
| `adminSales` | admin | `from?`, `to?`, `status?` | Ledger plus totals per currency. |
| `adminGetPrices` / `adminSetPrice` | admin | `plan`, `amount`, `lifetimeAmount`, `currency` | Returns prices and the owner settings (`config`). `null` takes a price off sale; an omitted field is left alone. Audited. |
| `adminListCatalog` / `adminSaveCatalogItem` / `adminDeleteCatalogItem` | admin | `item{ id?, kind, name, url, description, icon, rating, tags, sort, active }` / `id` | Tools & recommendations. Audited. |
| `adminSupportWidget` | admin | — | Helpdesk widget id and operator key from `HELPDESK_WIDGET_ID` / `HELPDESK_ADMIN_API_KEY`. |
| `adminSetBillingConfig` | admin | `unpaidPlan` (`Free`/`Personal`), `requireApproval` | Owner settings. Changing `unpaidPlan` re-derives every plan. Audited. |
| `adminAudit` | admin | `limit?` | Recent admin changes, before and after. |

Other endpoints:

- `POST /functions/v1/lookup` with `domain`, `kind`, `types[]` (signed-in users)
- `POST /functions/v1/billing-webhook` (PayPal IPN)
- `POST /functions/v1/reminders` (`x-cron-secret`)
- `GET /functions/v1/calendar?token=…` (public; `text/calendar`, 404 for unknown
  tokens and suspended accounts)
