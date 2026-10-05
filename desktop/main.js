'use strict';
/* ==========================================================================
   Domain Vault — desktop client

   A thin, hardened shell around the web app, plus the three things a browser
   tab cannot do: native renewal reminders, a tray icon, and launch-at-login.

   Security posture: the renderer has no node access, is sandboxed and
   context-isolated, and can only navigate within allowed origins. The page
   talks to the shell through a single narrow bridge (preload.js).
   ========================================================================== */

const {
  app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, powerMonitor, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  ALLOWED_ORIGINS, dueReminders, isAllowedUrl, normalizeDomains, normalizePrefs, pruneNotified,
} = require('./lib');

const APP_URL = process.env.DOMAIN_VAULT_URL || 'https://domain-vault.elnegocio.digital/app/';
const NOTIFIED_FILE = () => path.join(app.getPath('userData'), 'notified.json');
const RENEWALS_FILE = () => path.join(app.getPath('userData'), 'renewals.json');
const CHECK_EVERY_MS = 60 * 60 * 1000;   // hourly; a day boundary is caught within the hour

let mainWindow = null;
let tray = null;
let quitting = false;
let renewals = null;   // { domains, prefs } last reported by the page; loaded lazily
// Shown notifications, held until dismissed: one that is garbage collected
// early loses its click handler on some platforms.
const liveNotifications = new Set();

/* ----------------------------------------------------------- persistence */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, what) {
  try {
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (err) {
    console.error(`could not persist ${what}`, err);
  }
}

// A corrupt or hand-edited file must never break reminders: anything that is
// not a list of strings is treated as empty. Keys from older versions simply
// fail to match and are pruned.
function readNotified() {
  const keys = readJson(NOTIFIED_FILE(), []);
  return Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [];
}

function writeNotified(keys) {
  writeJson(NOTIFIED_FILE(), keys, 'notification state');
}

// The last domain list and reminder settings, kept on disk so that a
// launch-at-login start with the window hidden can remind before the page
// has loaded.
function readRenewals() {
  const saved = readJson(RENEWALS_FILE(), null) || {};
  return { domains: normalizeDomains(saved.domains), prefs: normalizePrefs(saved.prefs) };
}

function writeRenewals(value) {
  writeJson(RENEWALS_FILE(), value, 'renewal list');
}

/* --------------------------------------------------------------- window */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(APP_URL);

  // Keep the window on our own app; send everything else to the real browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Never let the renderer ask for camera, microphone and the like.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'notifications');
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return; // aborted, usually a redirect
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Cannot reach Domain Vault',
      message: `Could not load ${url}`,
      detail: `${description}\n\nCheck your internet connection and try again.`,
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
    }).then(({ response }) => (response === 0 ? mainWindow.loadURL(APP_URL) : app.quit()));
  });

  // Closing hides to the tray; quitting is explicit.
  mainWindow.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ----------------------------------------------------------------- tray */

function buildTray() {
  const iconPath = path.join(__dirname, 'build', 'tray.png');
  try {
    tray = new Tray(iconPath);
  } catch (err) {
    // Some Linux desktops have no system tray; the app still works without it.
    console.warn('tray unavailable:', err.message);
    return;
  }

  const refresh = () => {
    const launchAtLogin = app.getLoginItemSettings().openAtLogin;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Domain Vault', click: showWindow },
      { type: 'separator' },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: launchAtLogin,
        click: () => {
          app.setLoginItemSettings({ openAtLogin: !launchAtLogin, openAsHidden: true });
          refresh();
        },
      },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };

  tray.setToolTip('Domain Vault');
  tray.on('click', showWindow);
  refresh();
}

/* -------------------------------------------------- renewal notifications */

/**
 * Raise whatever reminders are due for the last reported domain list. Runs at
 * startup, hourly, after the system wakes and whenever the page reports, so
 * it does not depend on the page being open or reloaded.
 */
function checkRenewals() {
  try {
    if (!renewals) renewals = readRenewals();
    const { domains, prefs } = renewals;
    const notified = readNotified();

    if (prefs.enabled && Notification.isSupported()) {
      const due = dueReminders(domains, { leadDays: prefs.leadDays, alreadyNotified: notified });

      for (const item of due.slice(0, 5)) {   // never spam; the rest follow on later checks
        const notification = new Notification({
          title: item.title,
          body: item.body,
          icon: path.join(__dirname, 'build', 'icon.png'),
        });
        const release = () => liveNotifications.delete(notification);
        notification.on('click', () => { release(); showWindow(); });
        notification.on('close', release);
        liveNotifications.add(notification);
        notification.show();
        notified.push(item.key);
      }
    }

    writeNotified(pruneNotified(notified, domains));
  } catch (err) {
    // Runs unattended on a timer: a failed check must never take the app down.
    console.error('renewal check failed', err);
  }
}

/**
 * The renderer reports its domain list (it already has it) and the user's
 * reminder settings. The shell decides what deserves a notification, so no
 * credentials or tokens ever reach the main process.
 */
ipcMain.on('renewals:report', (event, domains, prefs) => {
  // The preload runs on every page the window shows, PayPal's included; only
  // the app itself may report renewals.
  if (!isAppFrame(event.senderFrame)) return;
  renewals = { domains: normalizeDomains(domains), prefs: normalizePrefs(prefs) };
  writeRenewals(renewals);
  checkRenewals();
});

function isAppFrame(frame) {
  try {
    const origin = new URL(frame.url).origin;
    return origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

/* ----------------------------------------------------------- app lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    createWindow();
    buildTray();

    // Reminders must not wait for the page: check the saved list now, then
    // keep checking while the app sits in the tray. A laptop that slept
    // through a day boundary catches up as soon as it wakes.
    checkRenewals();
    setInterval(checkRenewals, CHECK_EVERY_MS);
    powerMonitor.on('resume', checkRenewals);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // With a tray icon the app keeps running in the background, which is the
  // point: reminders still arrive. Without one, closing the window quits.
  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { quitting = true; });

  // Refuse to attach a debugger to the renderer in packaged builds.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('devtools-opened', () => { if (app.isPackaged) contents.closeDevTools(); });
  });
}

module.exports = { ALLOWED_ORIGINS };
