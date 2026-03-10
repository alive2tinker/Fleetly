const { contextBridge, ipcRenderer } = require('electron');

let creationOutputHandler = null;

contextBridge.exposeInMainWorld('api', {
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  getPackageManager: () => ipcRenderer.invoke('get-package-manager'),
  installDependency: (depKey) => ipcRenderer.invoke('install-dependency', depKey),
  installMultiple: (depKeys) => ipcRenderer.invoke('install-multiple', depKeys),
  isSetupComplete: () => ipcRenderer.invoke('is-setup-complete'),
  markSetupComplete: () => ipcRenderer.invoke('mark-setup-complete'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  saveSites: (sites) => ipcRenderer.invoke('save-sites', sites),
  fixDns: () => ipcRenderer.invoke('fix-dns'),
  valetStart: () => ipcRenderer.invoke('valet-start'),
  valetStop: () => ipcRenderer.invoke('valet-stop'),
  valetStatus: () => ipcRenderer.invoke('valet-status'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getParkedDirs: () => ipcRenderer.invoke('get-parked-dirs'),
  saveParkedDirs: (dirs) => ipcRenderer.invoke('save-parked-dirs', dirs),
  parkDirectory: (dirPath) => ipcRenderer.invoke('park-directory', dirPath),
  unparkDirectory: (dirPath) => ipcRenderer.invoke('unpark-directory', dirPath),
  openInBrowser: (domain) => ipcRenderer.invoke('open-in-browser', domain),
  openInEditor: (sitePath) => ipcRenderer.invoke('open-in-editor', sitePath),
  openInTerminal: (sitePath) => ipcRenderer.invoke('open-in-terminal', sitePath),
  createLaravelProject: (options) => ipcRenderer.invoke('create-laravel-project', options),
  cloneGitProject: (options) => ipcRenderer.invoke('clone-git-project', options),
  onCreationOutput: (callback) => {
    creationOutputHandler = (_event, data) => callback(data);
    ipcRenderer.on('creation-output', creationOutputHandler);
  },
  offCreationOutput: () => {
    if (creationOutputHandler) {
      ipcRenderer.removeListener('creation-output', creationOutputHandler);
      creationOutputHandler = null;
    }
  },
});
