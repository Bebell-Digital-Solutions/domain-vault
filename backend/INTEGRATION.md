# Frontend ↔ backend

The integration is complete. This page is for whoever edits the frontend
next, so nothing breaks the contract by accident.

## Files and load order

```html
<script src="config.js"></script>   <!-- backend URL, anon key, PayPal button ids -->
<script src="api.js"></script>      <!-- DomainVaultAPI: transport + session -->
<script src="script.js"></script>   <!-- the app -->          (admin.html loads admin.js)
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
- Public actions (no session needed) are `registerUser`, `loginUser` and
  `getPrices`. If you add a public action to the server, add it to `call()`
  in `api.js` too.
- Other helpers: `DomainVaultAPI.restore()`, `.signOut()`,
  `.revealPassword(providerId)`, `.updateUser(patch)`.

## Rules the UI must keep

| Rule | Where |
|---|---|
| **Take the plan from `getUserData().plan`**, never from the login session. It changes after purchases and refunds. | `applyAccountState()` in script.js |
| Stored registrar passwords are never sent to the browser. Show `hasPassword`; a blank password field means "keep"; `removePassword: true` deletes it. | provider modal |
| The admin link is shown only when `isAdmin` is true. This is cosmetic: the server refuses admin actions to everyone else anyway. | `.admin-link` |
| Checkout goes to PayPal with `custom=<account email>`. That's how the webhook finds the account. | `paypalCheckoutUrl()` |
| Unpriced packs (`amount: null`) and packs without a button id can't be bought. | `loadPackPrices()` |
| PayPal returns to `/?payment=success`. The app polls until the plan changes. | `handlePaymentReturn()` |
| The mobile drawer is filled by copying `.sidebar-menu` at startup. New menu items only need adding once, in the sidebar. | DOMContentLoaded |
| Anything from the database that goes into `innerHTML` must be escaped (`escapeHTML` in script.js, `h()` in admin.js). | everywhere |

## Checking a change

```bash
cd backend
npm run test:e2e     # includes real-browser tests of index.html and admin.html
```
