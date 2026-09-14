# Security notes

## 1. The old deployment is still live

The most urgent item is not in this directory.

`script.js` line 7 (and the inline copy in `index.html`) contains a public
Google Apps Script URL. That endpoint takes the caller's email as identity and
returns or overwrites that account's data with no verification. It is
reachable by anyone who views the page source.

Two facts make this severe rather than merely untidy:

- Account passwords were stored in the `Users` sheet in plaintext and compared
  with `===`.
- Customers' **registrar credentials** — the logins for GoDaddy, Namecheap and
  so on — were stored in the `Providers` sheet in plaintext.

So the exposure is not "someone sees a list of domains". It is "someone takes
over the domains".

**Deploying this backend does not close that hole.** An Apps Script deployment
keeps serving after the site stops calling it. It must be retired explicitly:

1. In the Apps Script project: **Deploy → Manage deployments → Archive** the
   active web app. Creating a new deployment is not enough; the old URL keeps
   working.
2. Restrict or delete the backing spreadsheet.
3. Tell affected users to change their registrar passwords. This is the
   unpleasant part, and it is not optional — those credentials were readable
   by anyone for as long as the endpoint was live.
4. If any user reused their Domain Vault password elsewhere, they should change
   that too.

Consider whether a breach notification is required. If any customer is in the
EU (GDPR) or Japan (APPI) — the latter being directly relevant to the sales
plan — there are disclosure duties with deadlines.

---

## 2. What the new design changes

| Old | New |
|---|---|
| Identity = email in the request body | Identity = JWT verified by Supabase Auth |
| Any caller could read any account | RLS makes cross-account reads impossible in the database |
| Account passwords in plaintext | Delegated to Supabase Auth (bcrypt); none stored here |
| Registrar passwords in plaintext | AES-256-GCM, key never in the database, opt-in |
| Plan limits enforced in browser JS | Enforced by a database trigger |
| Unverified PayPal IPN | Verified with PayPal, receiver checked, replay-proof |
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

Deliberately not built yet — worth scoping before launch:

- **No email verification.** Registration confirms the address on creation so
  the account is usable, which means a user can sign up with an address they
  do not own. The admin-activation gate limits the damage, but a real
  confirmation link should replace it.
- **No MFA.** Supabase Auth supports TOTP; it is not wired up. For a product
  holding registrar credentials this should be considered close to mandatory.
- **No email enumeration defence on login.** Registration is deliberately
  vague about whether an address exists; login is not.
- **No admin panel.** Activating a user is a manual SQL update, so in practice
  someone holds the service role key to do routine work. That is the wrong
  shape and should be replaced.
- **No automated Edge Function tests.** The SQL layer has them
  (`supabase/tests/`); the TypeScript does not.
- **Avatars are in a public bucket.** Fine for profile pictures, but the URLs
  are guessable by user id. Move to signed URLs if that matters.

---

## 6. Verifying the security properties

```bash
./supabase/tests/run-tests.sh
```

Applies every migration to a throwaway Postgres container and asserts that
cross-account reads return nothing, plan limits hold, users cannot promote
their own plan, suspended accounts are locked out at the database level, and
the rate limiter is atomic. Run it after any change to the schema or policies.
