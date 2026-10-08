# Frontend ↔ backend

The integration is complete. This page is for whoever edits the frontend
next, so nothing breaks the contract by accident.

## Files and load order

```html
<!-- app/index.html; paths are relative because the app lives at /app/ -->
<script src="../config.js"></script>   <!-- backend URL, anon key, PayPal button ids -->
<script src="../api.js"></script>      <!-- DomainVaultAPI: transport + session -->
<script src="../script.js"></script>   <!-- the app -->     (app/admin.html loads admin.js)
```

`config.js` picks the local backend when the page is served from `localhost`
or `127.0.0.1`, and the hosted project otherwise. Everything in it is public;
never add a secret to it.

## Calling the backend

```js
const res = await apiCall('saveDomains', { domains });   // script.js
// → window.DomainVaultAPI.call(action, payload)
```

- Identity comes from the stored session token. The `email` field that older
  call sites still pass is ignored by the server.
- `api.js` refreshes expired tokens, retries once on 401, and keeps the
  session across reloads (`localStorage` key `dv.session`).
- Public actions (no session needed) are `registerUser`, `loginUser`,
  `getPrices`, `getCatalog` and `requestPasswordReset`. If you add a public action to the
  server, add it to `call()` in `api.js` too.
- A response with `expired: true` means the session is gone for good; the app
  logs out with the message.
- Other helpers: `DomainVaultAPI.restore()`, `.signOut()`,
  `.revealPassword(providerId)`, `.updateUser(patch)`,
  `.lookup(domain, 'whois'|'dns', types?)`, `.calendarFeedUrl(token)`,
  `.recoveryFromUrl()`, `.setPasswordWithRecovery(token, password)`.

## Rules the UI must keep

| Rule | Where |
|---|---|
| **Take the plan from `getUserData().plan`**, never from the login session. It changes after purchases and refunds. | `applyAccountState()` in script.js |
| Stored registrar passwords are never sent to the browser. Show `hasPassword`; a blank password field means "keep"; `removePassword: true` deletes it. | provider modal |
| The admin link is shown only when `isAdmin` is true. This is cosmetic: the server refuses admin actions to everyone else anyway. | `.admin-link` |
| **Saves go through `persist()`**. On a refusal it shows the server's message and reloads the server's copy, so the screen never shows unsaved data. | script.js |
| WHOIS and DNS go through the `lookup` function, never to third parties from the browser. | `fetchWhoisData()`, `fetchDnsRecords()` |
| Checkout goes to PayPal with `custom=<account email>`. That's how the webhook finds the account. | `paypalCheckoutUrl()` |
| Unpriced packs (`amount: null`) and packs without a button id can't be bought. | `loadPackPrices()` |
| PayPal returns to `/app/?payment=success`. The app polls until the plan changes. The landing page forwards a bare `/?payment=success` (and stray reset links) to `/app/`. | `handlePaymentReturn()` |
| A reset link's token is taken out of the address bar before anything else runs. | DOMContentLoaded |
| The desktop shell gets domain names, renewal dates and reminder settings — nothing else — and an empty list on logout. | `reportRenewalsToDesktop()`, `handleLogout()` |
| The mobile drawer is filled by copying `.sidebar-menu` at startup. New menu items only need adding once, in the sidebar. | DOMContentLoaded |
| Anything from the database that goes into `innerHTML` must be escaped (`escapeHTML` in script.js, `h()` in admin.js). | everywhere |

## Checking a change

```bash
cd backend
npm run test:e2e     # includes real-browser tests of the app and the admin panel
```
