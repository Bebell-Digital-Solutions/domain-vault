# Security notes

## 1. The old deployment

The Apps Script backend took the caller's email as identity and returned or
overwrote that account's data with no verification. Its URL was public in the
page source. Account passwords and customers' **registrar credentials** (the
logins for GoDaddy, Namecheap and so on) sat in the sheet in plaintext. The
exposure was "someone takes over the domains", not "someone sees a list".

**Status (2026-09-14):** the endpoint returns 404, so it has been retired.
Keep it archived, since creating a new deployment would bring a URL back.

Still owed to anyone who used the old version:

1. Tell them to change their registrar passwords. Those credentials were
   readable for as long as the endpoint was live.
2. Tell them to change any password they reused for Domain Vault.
3. Restrict or delete the old spreadsheet.
4. Check whether a breach notification is required. If any customer is in the
   EU (GDPR) or Japan (APPI), there are disclosure duties with deadlines.

The migration script imports no passwords of either kind for this reason.

---

## 2. What the new design changes

| Old | New |
|---|---|
| Identity = email in the request body | Identity = JWT verified by Supabase Auth |
| Any caller could read any account | RLS makes cross-account reads impossible in the database |
| Account passwords in plaintext | Delegated to Supabase Auth (bcrypt); none stored here |
| Registrar passwords in plaintext | AES-256-GCM, key never in the database, opt-in |
| Plan limits enforced in browser JS | Enforced by a database trigger |
| Plan written straight from an unverified IPN | IPN verified with PayPal; receiver, pack, **amount and currency** checked; deduplicated per transaction and status |
| Any payment labelled "Agency" granted Agency | Plan derived from a purchase ledger; refunds and chargebacks withdraw it |
| Admin work = hand-editing the sheet | Admin panel; server-side admin check; every change audited |
| Users could set any field on their profile | Plan, override, status and admin flag guarded by a trigger |
| Service role key needed for the daily job | Dedicated cron secret, stored in Vault |
| Delete-all-then-reinsert | Atomic upsert + targeted delete |
| Lookups called from the browser | Proxied, validated, cached, rate limited |

---

## 3. Credential storage is still a liability

Encryption reduces the risk; it does not remove it. The Edge Function can
decrypt, so anyone who obtains both the database and the function environment
obtains the passwords.

Three options, in order of preference:

1. **Do not store registrar passwords.** Keep the provider, URL and username.
   Users lose one convenience; the product sheds most of its risk. This is the
   recommended choice and the reason `pass` is optional everywhere.
2. **Store them, opt-in and encrypted** — what is implemented, with reveal
   rate limited to 10/hour and written to `credential_access_log`.
3. **Registrar API tokens instead of passwords.** Scopeable and revocable.
   More work; the direction mature products take.

This is a product decision with legal weight, not a technical one. It should
be made deliberately rather than inherited from the prototype.

---

## 4. Key management

`CREDENTIAL_ENCRYPTION_KEY` is 32 random bytes (`openssl rand -base64 32`).

- It lives in Edge Function secrets and nowhere else. Not in git, not in the
  frontend, not in the database.
- **Lose it and every stored registrar password is unrecoverable.** Keep a
  copy in a password manager.
- To rotate: move the current value to `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`,
  set a new `CREDENTIAL_ENCRYPTION_KEY`, increment
  `CREDENTIAL_KEY_VERSION`. Decryption tries the current key then the previous
  one, so existing rows keep working and migrate as users re-save.

The `SUPABASE_SERVICE_ROLE_KEY` bypasses every policy in this document. Server
side only, forever.

---

## 5. Known gaps

Not built yet. Listed in rough order of importance.

- **No MFA, including for admins.** An admin account can see every customer
  and every sale, and change any plan. Supabase Auth supports TOTP; wiring it
  up (at least mandatory for admins) is the most valuable next step.
- **Public repository.** The repo, and therefore GitHub Pages, serves
  `backend/`, including this file. Nothing secret is committed (`.env*` is
  ignored), but the schema and this list of weaknesses are public. Moving
  `backend/` to a private repository is recommended; the site only needs
  `config.js`, `api.js`, `admin.*`, `index.html` and `script.js`.
- **No email verification.** Registration confirms the address on creation so
  the account is usable, so a user can sign up with an address they don't
  own. The activation gate limits the damage, and a first purchase activates
  an account only for the email PayPal's `custom` field names. A confirmation
  link should still replace it.
- **PayPal IPN is PayPal's older notification system.** It is still supported
  and fully verified here, but the long-term path is PayPal's REST Orders API
  with webhooks.
- **The rate limiter fails open.** If its table is unavailable, requests are
  allowed rather than blocking every user. This is deliberate. Login is also
  protected by Supabase Auth's own limits.
- **Avatars are in a public bucket**, under a path containing the user id.
  Fine for profile pictures; move to signed URLs if that ever matters.
- **Idle local runtime.** Not a security issue, but `supabase functions serve`
  can die when idle and leave a stuck process behind (README explains the
  fix). This does not happen on hosted projects.

---

## 6. Verifying the security properties

```bash
npm test            # migrations + SQL-level assertions on a clean Postgres
npm run test:e2e    # API, payment and browser suites against the local stack
```

Together they check that:

- cross-account reads return nothing, and suspended accounts are locked out
  by the database;
- users can't grant themselves a plan, an override, admin rights or a
  purchase;
- forged, underpaid, wrong-currency and misdirected payments grant nothing,
  and refunds take packs back;
- stored registrar passwords are ciphertext;
- admin actions are refused to customers and audited for admins;
- the admin panel renders database content as text.

Run both after any change to the schema, policies, functions or pages.
