'use strict';
/* The only bridge between the web app and the desktop shell.

   Deliberately tiny and one-directional: the page can report which domains
   are due and ask for the version. It cannot read files, spawn processes or
   reach any other Electron API. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('domainVaultDesktop', {
  /** Send the domain list so the shell can raise native reminders. */
  reportRenewals(domains) {
    if (!Array.isArray(domains)) return;
    // Pass on only what a reminder needs — never providers or credentials.
    ipcRenderer.send('renewals:report', domains.map((d) => ({
      name: String(d && d.name || ''),
      renewalDate: String(d && d.renewalDate || ''),
    })));
  },
  info: () => ipcRenderer.invoke('app:info'),
});
