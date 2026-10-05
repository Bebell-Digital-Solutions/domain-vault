# Going live

Everything the product needs is built and tested locally. What's left is
configuration that only the business owner can provide, plus deploying it in
the right order.

## Status — 2026-10-05: moved to the client's Supabase project

Production is moving from `gscyjgujprtzjmblwgnx` (developer account) to
**`gqxzawcxuhzcodvuiyzf`** (the client's account, eu-central-1). On the new
project, as of 2026-10-05:

| Step | State |
|---|---|
| All 9 migrations | ✅ applied to an empty database |
| Function settings (encryption key, cron secret, site URL, origins, Resend, PayPal mode) | ✅ copied from `.env.production`; **same encryption key**, so registrar passwords can be copied across |
| Functions `api`, `lookup`, `billing-webhook`, `reminders`, `calendar` | ✅ deployed, JWT verification as in §2b |
| Reminder schedule (Vault entries, cron jobs) | ✅ created |
| End-to-end check through `api.js` (20 checks, probe account deleted) | ✅ |
| Auth settings: Site URL, redirect URL `/app/**`, minimum password length 10, Resend SMTP (§2d) | ✅ set (first attempts hit a transient HTTP 544) |
| Resend: client's API key on the new project and in `.env.production` | ✅ |
| Resend: `elnegocio.digital` added to the client's Resend account | ⏳ DNS records must be added in Cloudflare, then **Verify** in Resend. Until then no email reaches customers |
| `config.js` pointing at the new project | ⏳ ready locally, not yet published |
| Existing accounts on the old project | ⏳ copy across or ask users to re-register |
| Owner items (§1) | ⏳ unchanged |

The PayPal `notify_url` in §3 now points at the new project.

## Status — 2026-09-17 (old project)

| Step | State |
|---|---|
| Database migrations on production | ✅ all 7 applied |
| Functions deployed, correct JWT settings | ✅ v3 (`api`, `billing-webhook`, `reminders` off; `lookup` on) |
| Production encryption key, cron secret, site URL, allowed origin, PayPal mode | ✅ set (values in `backend/.env.production`, git-ignored) |
| Reminder schedule reads from Vault | ✅ entries created, job verified |
| `config.js` production key | ✅ publishable key set |
| Production backend verified end to end (20 checks, probe account deleted) | ✅ |
| Placeholder `PAYPAL_RECEIVER_EMAIL` / `ADMIN_EMAIL` / `ADMIN_PHONE` removed from production | ✅ Until a real receiver is set, the webhook answers 500, so PayPal keeps retrying instead of the payment being discarded |
| Resend API key set on production; sending verified end to end | ✅ but see §1 item 5 — the sending domain is still unverified |
| Renewal reminders: milestone logic, digests, per-user preferences | ✅ deployed and verified through the scheduler |
| Owner items: prices, PayPal buttons, receiver email, admin email, Resend domain | ⏳ §1 |
| Auth dashboard settings (Site URL, SMTP) | ⏳ §2d, needs the Resend key |
| First admin, button ids in `config.js`, merge to `main`, live checks | ⏳ §2e, §4, §5 |
| Desktop client (Electron) + release pipeline built; Linux build verified | ✅ tag `desktop-v*` to build all three, then §7 |
| Code-signing certificates for macOS / Windows | ⏳ §7 |
| **2026-10-05 release** — calendar feed (new migration + `calendar` function), password reset/change, `api` and email-link fixes | ⏳ §2b again (`db push`, deploy all five functions), §2d redirect URLs + password length |

**Back up `CREDENTIAL_ENCRYPTION_KEY` from `backend/.env.production` in a
password manager now.**

When the owner's values arrive, fill in the empty lines in
`.env.production` and run `supabase secrets set --env-file .env.production`
again. Everything else in §2a–2c is already done.

Steps are tagged by who does them:
- **[owner]** Bebell, the business owner
- **[tech]** whoever deploys

---

## 1. Information and accounts needed from the owner

| # | What | Why | Without it |
|---|---|---|---|
| 1 | **Prices** for Start-up, Business and Agency, and the currency | The webhook only accepts payments that match these exactly | No pack can be bought |
| 2 | **PayPal "Buy Now" buttons**, one per pack (see §3) | Checkout | The upgrade button says "not available yet" |
| 3 | **PayPal account email** that receives the money | The webhook ignores payments to any other account | Every payment is ignored |
| 4 | **Admin email** for alerts (refunds, chargebacks, rejected payments, new sign-ups) | Someone has to act on them | Alerts go nowhere |
| 5 | **Verify `elnegocio.digital` in Resend** (the API key is already set) | All email: welcome, activation, reminders, receipts | Mail only reaches the Resend account owner's own address; **no customer receives anything** |
| 6 | **Supabase plan decision** (Pro, about $25/month) and who owns the account | The free tier pauses projects after a week without activity | The live site goes down whenever it's quiet |
| 7 | **Who is the first admin** (their email) | Activating users, prices, sales | Nobody can run the business |
| 8 | Decision: **move `backend/` to a private repository?** | The repo is public, and GitHub Pages also serves `backend/` from the site | Schema, code and SECURITY.md are publicly readable |

Items 1–5 and 7 block launch. 6 and 8 should be decided before launch.

---

## 2. Deploy the backend  [tech]

```bash
cd backend
supabase link --project-ref gqxzawcxuhzcodvuiyzf
```

### 2a. Production secrets

Create `backend/.env.production`. It's git-ignored; never commit it.

```bash
CREDENTIAL_ENCRYPTION_KEY=        # openssl rand -base64 32   (NEW key, not the local one)
CREDENTIAL_KEY_VERSION=1
CRON_SECRET=                      # openssl rand -hex 32
SITE_URL=https://domain-vault.elnegocio.digital
ALLOWED_ORIGINS=https://domain-vault.elnegocio.digital
ADMIN_EMAIL=                      # owner item 4
RESEND_API_KEY=                   # owner item 5
MAIL_FROM=Domain Vault <noreply@elnegocio.digital>
PAYPAL_ENV=live
PAYPAL_RECEIVER_EMAIL=            # owner item 3
WHATSAPP_ACCESS_TOKEN=            # optional
WHATSAPP_PHONE_NUMBER_ID=         # optional
```

**Store `CREDENTIAL_ENCRYPTION_KEY` in a password manager now.** If it's
lost, every stored registrar password is unrecoverable.

```bash
supabase secrets set --env-file .env.production
```

### 2b. Database and functions

```bash
supabase db push
supabase functions deploy api lookup billing-webhook reminders calendar
```

Then confirm that gateway JWT verification is **off** for `api`,
`billing-webhook`, `reminders` and `calendar`, and **on** for `lookup`:

```bash
supabase functions list
```

### 2c. Reminder schedule

In the Supabase dashboard's SQL editor:

```sql
select vault.create_secret('https://gqxzawcxuhzcodvuiyzf.supabase.co/functions/v1', 'dv_functions_base_url');
select vault.create_secret('<CRON_SECRET from .env.production>', 'dv_cron_secret');
```

### 2d. Auth settings (dashboard → Authentication)

- **URL Configuration → Site URL:** `https://domain-vault.elnegocio.digital`
- **URL Configuration → Redirect URLs:** add
  `https://domain-vault.elnegocio.digital/app/**`. Password-reset links return
  to the app. (Without it they land on the Site URL; the landing page forwards
  them to `/app/`, so it still works, one redirect later.)
- **Providers → Email → Minimum password length:** `10`, matching sign-up.
  Password resets go straight to Auth, so this is what enforces it there.
- **SMTP Settings:** enable custom SMTP with Resend (host `smtp.resend.com`,
  port 465, user `resend`, password = the Resend API key). Supabase's built-in
  mailer is for testing only and is heavily rate limited. Password-reset
  emails go through this.

### 2e. First admin

The owner registers on the live site. Then, in the SQL editor:

```sql
update profiles set status = 'active', is_admin = true where email = '<owner email>';
```

The owner then opens `/app/admin.html` → **Prices** and enters the prices
(owner item 1).

---

## 3. PayPal buttons  [owner]

In PayPal (Pay & Get Paid → PayPal Buttons → Buy Now), create one button
per pack:

| Setting | Start-up | Business | Agency |
|---|---|---|---|
| Item name | Domain Vault Start-up | Domain Vault Business | Domain Vault Agency |
| Item ID | `startup` | `business` | `agency` |
| Price / currency | exactly as set in Admin → Prices | ← | ← |
| Return URL (on success) | `https://domain-vault.elnegocio.digital/app/?payment=success` | ← | ← |
| Advanced variable | `notify_url=https://gqxzawcxuhzcodvuiyzf.supabase.co/functions/v1/billing-webhook` | ← | ← |

Also turn on IPN for the account (Account Settings → Notifications → Instant
Payment Notifications) with the same notification URL.

Send the three **hosted button ids** to tech.

> **Prices must match.** If a button charges 49.00 and Admin → Prices says
> 45.00, customers are charged and **not** upgraded. The payment appears in
> Admin → Sales as "rejected". Whenever a price changes, change it in both
> places.

---

## 4. Configure and publish the site  [tech]

Edit `config.js` (repo root):

```js
anonKey: '<publishable/anon key>',   // supabase projects api-keys --project-ref gqxzawcxuhzcodvuiyzf
buttons: {
  'Start-up': '<hosted_button_id>',
  'Business': '<hosted_button_id>',
  'Agency':   '<hosted_button_id>'
}
```

The anon key is public by design. **Never** put the service role key there.

Merge `dev` into `main`. GitHub Pages republishes on the same domain, so no DNS
change is needed.

---

## 5. Verify on the live site  [tech + owner]

Tick each one:

- [ ] Register a test account → "pending activation" message → welcome email arrives
- [ ] Admin panel lists it under "Waiting for activation" → Activate → activation email arrives
- [ ] Log in, add a domain, add a provider with a password, reveal it
- [ ] "Forgot your password?" → email arrives → link opens "Set new password" → log in with it
- [ ] Settings → Security: change the password; another browser that was signed in is signed out
- [ ] Calendar → Sync to Google → "Add to Google Calendar" → the renewals appear in Google Calendar (allow a few minutes)
- [ ] Upgrade modal shows the three prices
- [ ] **Real purchase** of the cheapest pack → returned to the site → plan badge updates within a minute → receipt email → Admin → Sales shows it `completed`
- [ ] Refund that payment in PayPal → plan drops back → admin alert email → Sales shows `refunded`
- [ ] Trigger reminders by hand. With a test domain renewing in 7 days:
      `curl -X POST https://gqxzawcxuhzcodvuiyzf.supabase.co/functions/v1/reminders -H "x-cron-secret: <CRON_SECRET>"`
      → reminder email arrives
- [ ] Next day: Dashboard → Integrations → Cron → `domain-vault-reminders` shows a successful run
- [ ] Phone: the menu button opens the navigation
- [ ] Delete the test account (Authentication → Users)

---

## 6. After launch

- **Old data:** if the old Google Sheet had real customers, import them
  (README → "Migrating the old Google Sheet") and tell them to reset their
  password and change their registrar passwords.
- **Old endpoint:** the Apps Script deployment already returns 404. Keep it
  archived.
- **Backups:** Supabase Pro keeps daily backups for 7 days. Keep the
  encryption key backed up separately, because a database backup can't be
  decrypted without it.
- **Review weekly:** Admin → Sales for `rejected` / `unmatched` payments
  (customers who paid and got nothing).

---

## 7. Desktop clients  [tech + owner]

Built and tested: `desktop/` (Electron shell with native renewal reminders,
tray icon, launch at login) and `.github/workflows/desktop-release.yml`.

**[tech]** Cut a release:

```bash
git tag desktop-v1.0.0 && git push origin desktop-v1.0.0
```

GitHub Actions builds the `.dmg` (Intel + Apple Silicon), the Windows `.exe`
and the Linux `.AppImage`/`.deb` on their own runners, and opens a **draft**
release with all of them attached. Publish it, then set `downloads` in
`config.js` to those asset URLs — until then the download page honestly says
"Coming soon".

**[owner]** Decide about code signing. Unsigned apps warn users at launch
("unidentified developer" on macOS, SmartScreen on Windows), which is a poor
look for a product holding registrar passwords:

| | Yearly cost |
|---|---|
| Apple Developer Program | ~$99 |
| Windows code-signing certificate | ~$100–400 |

Add the certificates as repository secrets (names in `desktop/README.md`) and
the pipeline signs and notarises automatically. Without them, releases still
build and work.
