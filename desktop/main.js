'use strict';
/* ==========================================================================
   Domain Vault — desktop client

   A thin, hardened shell around the web app, plus the three things a browser
   tab cannot do: native renewal reminders, a tray icon, and launch-at-login.

   Security posture: the renderer has no node access, is sandboxed and
   context-isolated, and can only navigate within allowed origins. The page
   talks to the shell through a single narrow bridge (preload.js).
   ========================================================================== */

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ALLOWED_ORIGINS, dueReminders, isAllowedUrl, pruneNotified } = require('./lib');

const APP_URL = process.env.DOMAIN_VAULT_URL || 'https://domain-vault.elnegocio.digital';
const NOTIFIED_FILE = () => path.join(app.getPath('userData'), 'notified.json');

let mainWindow = null;
let tray = null;
let quitting = false;

/* ----------------------------------------------------------- persistence */

function readNotified() {
  try {
    return JSON.parse(fs.readFileSync(NOTIFIED_FILE(), 'utf8'));
  } catch {
    return [];
  }
}

function writeNotified(keys) {
  try {
    fs.writeFileSync(NOTIFIED_FILE(), JSON.stringify(keys));
  } catch (err) {
    console.error('could not persist notification state', err);
  }
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
 * The renderer reports its domain list (it already has it). The shell decides
 * what deserves a notification, so no credentials or tokens ever reach the
 * main process.
 */
ipcMain.on('renewals:report', (_event, domains) => {
  if (!Notification.isSupported()) return;

  const notified = readNotified();
  const due = dueReminders(domains, { alreadyNotified: notified });

  for (const item of due.slice(0, 5)) {   // never spam on first launch
    new Notification({
      title: item.title,
      body: item.body,
      icon: path.join(__dirname, 'build', 'icon.png'),
    }).on('click', showWindow).show();
    notified.push(item.key);
  }

  writeNotified(pruneNotified(notified, domains));
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

/* ----------------------------------------------------------- app lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    createWindow();
    buildTray();

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
