const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  getPackageManager: () => ipcRenderer.invoke('get-package-manager'),
  installDependency: (depKey) => ipcRenderer.invoke('install-dependency', depKey),
  installMultiple: (depKeys) => ipcRenderer.invoke('install-multiple', depKeys),
  isSetupComplete: () => ipcRenderer.invoke('is-setup-complete'),
  markSetupComplete: () => ipcRenderer.invoke('mark-setup-complete'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  saveSites: (sites) => ipcRenderer.invoke('save-sites', sites),
});
