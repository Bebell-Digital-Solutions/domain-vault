'use strict';
/* The only bridge between the web app and the desktop shell.

   Deliberately tiny and one-directional: the page can report its renewal
   dates and reminder settings, and ask for the version. It cannot read files,
   spawn processes or reach any other Electron API. */

const { contextBridge, ipcRenderer } = require('electron');

/** The user's reminder settings, reduced to a boolean and a list of numbers.
    null when the page sent none; the shell then uses the defaults. */
function reminderPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return null;
  return {
    enabled: prefs.enabled !== false,
    leadDays: Array.isArray(prefs.leadDays)
      ? prefs.leadDays.map((n) => parseInt(n, 10)).filter(Number.isInteger)
      : [],
  };
}

contextBridge.exposeInMainWorld('domainVaultDesktop', {
  /** Send the domain list, and optionally the user's reminder settings
      ({ enabled, leadDays }), so the shell can raise native reminders. */
  reportRenewals(domains, prefs) {
    if (!Array.isArray(domains)) return;
    // Pass on only what a reminder needs — never providers or credentials.
    ipcRenderer.send('renewals:report', domains.map((d) => ({
      name: String(d && d.name || ''),
      renewalDate: String(d && d.renewalDate || ''),
    })), reminderPrefs(prefs));
  },
  info: () => ipcRenderer.invoke('app:info'),
});
