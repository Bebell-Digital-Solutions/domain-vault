# Wiring the frontend to the new backend

The API keeps the old action names and response shapes, so rendering, state
and translations do not move. Below is every change, with line numbers from
`script.js` as it stands today.

> **First, a housekeeping problem.** `index.html` still contains its own copy
> of the application JavaScript inline (from line 977), and `script.js` is a
> second copy that nothing loads. Whichever you keep, delete the other before
> starting — otherwise you will make these edits in the file that is not
> running and conclude the backend is broken. These instructions assume you
> keep `script.js` and remove the inline `<script>` block from `index.html`.

---

## 1. Load the client and its config

In `index.html`, before the closing `</body>`:

```html
<script>
  window.DOMAIN_VAULT_CONFIG = {
    supabaseUrl:  "https://YOUR-PROJECT-REF.supabase.co",
    functionsUrl: "https://YOUR-PROJECT-REF.supabase.co/functions/v1",
    anonKey:      "YOUR-ANON-KEY"
  };
</script>
<script src="/backend/web/api.js"></script>
<script src="/script.js"></script>
```

The anon key is meant to be public — it identifies the project, it does not
grant access. Row Level Security is what protects the data. The **service
role** key is the dangerous one and must never appear in the frontend.

---

## 2. Replace the transport — `script.js` line 7 and lines 466-483

Delete the `API_URL` constant at line 7, and replace the whole `apiCall`
function with a delegation:

```javascript
async function apiCall(action, payload = {}) {
    return window.DomainVaultAPI.call(action, payload);
}
```

Every existing call site keeps working unchanged. The `email:
currentUser.email` argument they all pass is now ignored — the server takes
identity from the signed token instead — but leaving it in place costs
nothing.

---

## 3. Stop showing a password the browser no longer has — lines 1154 and 1159

Stored registrar passwords are never sent with the rest of the data, so
`data.pass` is now always empty and these two lines would wrongly report
"Not set". Use the `hasPassword` flag the API returns:

```javascript
// line 1154 — leave the field blank; typing in it sets a new password,
// leaving it blank keeps whatever is stored.
document.getElementById('providerPass').value = '';
document.getElementById('providerPass').placeholder =
    data.hasPassword ? '•••••••• (unchanged)' : 'No password stored';

// line 1159
document.getElementById('credPass').textContent =
    data.hasPassword ? '••••••••' : 'Not set';
```

To let a user actually see a stored password, call the reveal endpoint. It is
rate limited to 10 per hour and every call is written to
`credential_access_log`:

```javascript
const res = await window.DomainVaultAPI.revealPassword(provider.id);
if (res.success) showToast(res.password);
```

If you would rather not offer reveal at all, skip it — nothing else depends
on it, and not having the feature is the safer product.

---

## 4. Keep users signed in — line 541

`handleLogout` should clear the stored session:

```javascript
function handleLogout() {
    window.DomainVaultAPI.signOut();
    currentUser = null;
    // ...the rest as it is today
}
```

And on load, restore an existing session instead of always showing the login
overlay. Add this where the app initialises:

```javascript
window.DomainVaultAPI.restore().then(function (user) {
    if (!user) return;                       // not signed in; show the overlay
    currentUser = user;
    document.getElementById('auth-overlay').style.display = 'none';
    if (matrixInterval) clearInterval(matrixInterval);
    loadDashboardData();
});
```

This is new behaviour: the old build logged you out on every refresh.

---

## 5. Route the lookups through the backend — lines 1064 and 1098

Optional, but it stops every visitor spending our upstream quota and makes the
results cacheable:

```javascript
// line 1064 — WHOIS
const res = await fetch(window.DOMAIN_VAULT_CONFIG.functionsUrl + '/lookup', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + window.DomainVaultAPI.session.access_token
    },
    body: JSON.stringify({ domain: domain, kind: 'whois' })
}).then(r => r.json());
// res.data holds the same payload networkcalc returned

// line 1098 — DNS, one request for all record types
const res = await fetch(window.DOMAIN_VAULT_CONFIG.functionsUrl + '/lookup', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + window.DomainVaultAPI.session.access_token
    },
    body: JSON.stringify({ domain: domain, kind: 'dns', types: types })
}).then(r => r.json());
// res.data is keyed by record type: res.data.A, res.data.MX, ...
```

---

## 6. Registration now requires a longer password

The API enforces a 10-character minimum. Match it in the signup field so users
find out before submitting:

```html
<input type="password" id="authPassword" class="form-control"
       minlength="10" required>
```

---

## Checklist

- [ ] One copy of the app JS, not two
- [ ] `DOMAIN_VAULT_CONFIG` set, `api.js` loaded before `script.js`
- [ ] `API_URL` deleted; `apiCall` delegates
- [ ] Provider password UI uses `hasPassword`
- [ ] Logout clears the session; load restores it
- [ ] `ALLOWED_ORIGINS` includes the real site origin
- [ ] Old Apps Script deployment retired (see SECURITY.md)
