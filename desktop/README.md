# Domain Vault — desktop client

An Electron shell around the web app, plus the three things a browser tab
can't do:

- **Native renewal reminders** at 30, 7 and 1 day, even when the window is
  closed.
- **Tray / menu-bar icon**, so the app keeps running in the background.
- **Launch at login**, toggled from the tray menu.

It is not an offline app. The data lives in Supabase, so it needs the
internet, exactly like the website.

---

## How it fits together

```
desktop/
├── main.js        window, tray, notifications, navigation rules
├── preload.js     the only bridge to the page (2 methods)
├── lib.js         pure logic — URL allow-list, renewal maths
├── build/         icons + macOS entitlements
├── test/
│   ├── lib.test.mjs     unit tests, no display needed  (npm test)
│   └── app-smoke.mjs    drives a built app over DevTools (./verify-build.sh)
└── verify-build.sh      runs a built AppImage in a container and checks it
```

The renderer is sandboxed, context-isolated and has no node access. The page
reaches the shell through exactly two methods:

```js
window.domainVaultDesktop.reportRenewals([{ name, renewalDate }]);  // for reminders
await window.domainVaultDesktop.info();                             // { version, platform }
```

`script.js` calls `reportRenewals` after loading the dashboard and does
nothing when the bridge is absent, so the same code runs in a browser.

Only domain names and renewal dates cross that bridge — never providers,
credentials or tokens. Navigation is restricted to the app's own origin and
PayPal; every other link opens in the user's real browser.

---

## Developing

```bash
cd desktop
npm install
npm run dev     # loads http://127.0.0.1:5500 (serve the repo root there)
npm start       # loads the production site
npm test        # unit tests, no display required
```

`DOMAIN_VAULT_URL` overrides the URL the shell loads.

## Building

```bash
npm run build:linux   # .AppImage + .deb   (works on Linux)
npm run build:win     # .exe installer     (needs Windows, or Wine + NSIS)
npm run build:mac     # .dmg               (needs macOS — no way around this)
npm run build         # whatever the current OS can produce
```

Output lands in `desktop/dist/`.

**Release builds go through CI**, not a laptop:
`.github/workflows/desktop-release.yml` builds all three on their own runners.

```bash
git tag desktop-v1.0.0 && git push origin desktop-v1.0.0
```

That produces a **draft** release with every installer attached. Publish it,
then put the asset URLs into `downloads` in `config.js` so the download page
stops saying "Coming soon".

## Verifying a Linux build

```bash
npm run build:linux
./verify-build.sh
```

Runs the built AppImage in a container on a virtual display and checks, over
the DevTools protocol, that the window loads the app, the preload bridge is
exposed with exactly two methods, node has not leaked into the page, and IPC
works.

---

## Code signing

Without certificates the apps still build and run, but users see warnings —
"unidentified developer" on macOS, SmartScreen on Windows. For a product that
stores registrar passwords, that is worth avoiding.

| | Cost | Repository secrets |
|---|---|---|
| macOS | Apple Developer Program, ~$99/year | `APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | Code-signing certificate, ~$100–400/year | `WINDOWS_CERT_PFX`, `WINDOWS_CERT_PASSWORD` |
| Linux | free | none — AppImage and .deb are not signed |

The workflow signs and notarises automatically once those secrets exist, and
skips it when they don't.

## Known limits

- **No auto-update.** Each new version is a fresh download. `electron-updater`
  plus a published release feed would fix it; not built yet.
- **Tray icons are unreliable on some Linux desktops** (notably stock GNOME
  without an extension). The app detects a missing tray and falls back to
  quitting when the window closes.
- **Notifications need a desktop notification service.** Present on normal
  desktops, absent in containers.
- **~100 MB per install**, the price of bundling Chromium. Tauri would be
  ~10 MB but needs a per-platform Rust toolchain.
