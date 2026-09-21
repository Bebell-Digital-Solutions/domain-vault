# Going live

Everything the product needs is built and tested locally. What's left is
configuration that only the business owner can provide, plus deploying it in
the right order.

## Status — 2026-09-17

| Step | State |
|---|---|
| Database migrations on production | ✅ all 7 applied |
| Functions deployed, correct JWT settings | ✅ v3 (`api`, `billing-webhook`, `reminders` off; `lookup` on) |
| Production encryption key, cron secret, site URL, allowed origin, PayPal mode | ✅ set (values in `backend/.env.production`, git-ignored) |
| Reminder schedule reads from Vault | ✅ entries created, job verified |
| `config.js` production key | ✅ publishable key set |
| Production backend verified end to end (20 checks, probe account deleted) | ✅ |
| Placeholder `PAYPAL_RECEIVER_EMAIL` / `ADMIN_EMAIL` / `ADMIN_PHONE` removed from production | ✅ Until a real receiver is set, the webhook answers 500, so PayPal keeps retrying instead of the payment being discarded |
| Owner items: prices, PayPal buttons, receiver email, admin email, Resend | ⏳ §1 |
| Auth dashboard settings (Site URL, SMTP) | ⏳ §2d, needs the Resend key |
| First admin, button ids in `config.js`, merge to `main`, live checks | ⏳ §2e, §4, §5 |
| Desktop client (Electron) + release pipeline built; Linux build verified | ✅ tag `desktop-v*` to build all three, then §7 |
| Code-signing certificates for macOS / Windows | ⏳ §7 |

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
| 5 | **Resend account** + API key, and the sending domain verified in Resend | All email: welcome, activation, reminders, receipts | **No email is sent at all, including renewal reminders**, which are the core of the product |
| 6 | **Supabase plan decision** (Pro, about $25/month) and who owns the account | The free tier pauses projects after a week without activity | The live site goes down whenever it's quiet |
| 7 | **Who is the first admin** (their email) | Activating users, prices, sales | Nobody can run the business |
| 8 | Decision: **move `backend/` to a private repository?** | The repo is public, and GitHub Pages also serves `backend/` from the site | Schema, code and SECURITY.md are publicly readable |

Items 1–5 and 7 block launch. 6 and 8 should be decided before launch.

---

## 2. Deploy the backend  [tech]

```bash
cd backend
supabase link --project-ref gscyjgujprtzjmblwgnx
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
supabase functions deploy api lookup billing-webhook reminders
```

Then confirm that gateway JWT verification is **off** for `api`,
`billing-webhook` and `reminders`, and **on** for `lookup`:

```bash
supabase functions list
```

### 2c. Reminder schedule

In the Supabase dashboard's SQL editor:

```sql
select vault.create_secret('https://gscyjgujprtzjmblwgnx.supabase.co/functions/v1', 'dv_functions_base_url');
select vault.create_secret('<CRON_SECRET from .env.production>', 'dv_cron_secret');
```

### 2d. Auth settings (dashboard → Authentication)

- **URL Configuration → Site URL:** `https://domain-vault.elnegocio.digital`
- **SMTP Settings:** enable custom SMTP with Resend (host `smtp.resend.com`,
  port 465, user `resend`, password = the Resend API key). Supabase's built-in
  mailer is for testing only and is heavily rate limited. Password-reset
  emails go through this.

### 2e. First admin

The owner registers on the live site. Then, in the SQL editor:

```sql
update profiles set status = 'active', is_admin = true where email = '<owner email>';
```

The owner then opens `/admin.html` → **Prices** and enters the prices
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
| Return URL (on success) | `https://domain-vault.elnegocio.digital/?payment=success` | ← | ← |
| Advanced variable | `notify_url=https://gscyjgujprtzjmblwgnx.supabase.co/functions/v1/billing-webhook` | ← | ← |

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
anonKey: '<publishable/anon key>',   // supabase projects api-keys --project-ref gscyjgujprtzjmblwgnx
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
- [ ] Upgrade modal shows the three prices
- [ ] **Real purchase** of the cheapest pack → returned to the site → plan badge updates within a minute → receipt email → Admin → Sales shows it `completed`
- [ ] Refund that payment in PayPal → plan drops back → admin alert email → Sales shows `refunded`
- [ ] Trigger reminders by hand. With a test domain renewing in 7 days:
      `curl -X POST https://gscyjgujprtzjmblwgnx.supabase.co/functions/v1/reminders -H "x-cron-secret: <CRON_SECRET>"`
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
