const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

function getSetupFlagPath() {
  return path.join(app.getPath('userData'), 'setup-complete.json');
}

function isSetupComplete() {
  return fs.existsSync(getSetupFlagPath());
}

function markSetupComplete() {
  const data = { completedAt: new Date().toISOString() };
  fs.writeFileSync(getSetupFlagPath(), JSON.stringify(data, null, 2));
}

// ── Sites persistence ──
function getSitesPath() {
  return path.join(app.getPath('userData'), 'sites.json');
}

function loadSites() {
  try {
    const data = fs.readFileSync(getSitesPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveSites(sites) {
  fs.writeFileSync(getSitesPath(), JSON.stringify(sites, null, 2));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');
}

function checkCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        resolve({ installed: false, version: null });
      } else {
        const output = (stdout || stderr || '').trim();
        resolve({ installed: true, version: output });
      }
    });
  });
}

function detectPackageManager() {
  const managers = [
    { name: 'dnf', check: 'which dnf' },
    { name: 'apt', check: 'which apt' },
    { name: 'pacman', check: 'which pacman' },
    { name: 'zypper', check: 'which zypper' },
    { name: 'brew', check: 'which brew' },
  ];

  return new Promise((resolve) => {
    let found = false;
    let pending = managers.length;

    for (const mgr of managers) {
      exec(mgr.check, (error) => {
        if (!error && !found) {
          found = true;
          resolve(mgr.name);
        }
        pending--;
        if (pending === 0 && !found) {
          resolve(null);
        }
      });
    }
  });
}

function getInstallCommand(pkgManager, depKey) {
  const packages = {
    dnf: { php: 'php-cli', node: 'nodejs', mysql: 'community-mysql', nginx: 'nginx' },
    apt: { php: 'php-cli', node: 'nodejs', mysql: 'mysql-client', nginx: 'nginx' },
    pacman: { php: 'php', node: 'nodejs', mysql: 'mysql', nginx: 'nginx' },
    zypper: { php: 'php8', node: 'nodejs', mysql: 'mysql-client', nginx: 'nginx' },
    brew: { php: 'php', node: 'node', mysql: 'mysql', nginx: 'nginx' },
  };

  const pkgMap = packages[pkgManager];
  if (!pkgMap || !pkgMap[depKey]) return null;

  const pkg = pkgMap[depKey];

  switch (pkgManager) {
    case 'dnf': return `sudo dnf install -y ${pkg}`;
    case 'apt': return `sudo apt install -y ${pkg}`;
    case 'pacman': return `sudo pacman -S --noconfirm ${pkg}`;
    case 'zypper': return `sudo zypper install -y ${pkg}`;
    case 'brew': return `brew install ${pkg}`;
    default: return null;
  }
}

function runInstall(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { stdio: 'pipe' });
    let output = '';

    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      resolve({ success: code === 0, output });
    });
  });
}

ipcMain.handle('check-dependencies', async () => {
  const deps = [
    { name: 'PHP', command: 'php --version', icon: 'php' },
    { name: 'Node.js', command: 'node --version', icon: 'node' },
    { name: 'MySQL', command: 'mysql --version', icon: 'mysql' },
    { name: 'Nginx', command: 'nginx -v 2>&1', icon: 'nginx' },
  ];

  const results = [];
  for (const dep of deps) {
    await new Promise((r) => setTimeout(r, 800));
    const result = await checkCommand(dep.command);
    results.push({
      name: dep.name,
      icon: dep.icon,
      installed: result.installed,
      version: result.version,
    });
  }

  return results;
});

ipcMain.handle('get-package-manager', async () => {
  return await detectPackageManager();
});

ipcMain.handle('is-setup-complete', () => {
  return isSetupComplete();
});

ipcMain.handle('mark-setup-complete', () => {
  markSetupComplete();
  return true;
});

ipcMain.handle('install-dependency', async (_event, depKey) => {
  const pkgManager = await detectPackageManager();
  if (!pkgManager) {
    return { success: false, output: 'No supported package manager found' };
  }

  const command = getInstallCommand(pkgManager, depKey);
  if (!command) {
    return { success: false, output: `Unknown package: ${depKey}` };
  }

  return await runInstall(command);
});

ipcMain.handle('install-multiple', async (_event, depKeys) => {
  const pkgManager = await detectPackageManager();
  if (!pkgManager) {
    return { success: false, output: 'No supported package manager found' };
  }

  const results = [];
  for (const depKey of depKeys) {
    const command = getInstallCommand(pkgManager, depKey);
    if (!command) {
      results.push({ depKey, success: false, output: `Unknown package: ${depKey}` });
      continue;
    }
    const result = await runInstall(command);
    results.push({ depKey, ...result });
  }

  return results;
});

// ── Sites IPC ──
ipcMain.handle('get-sites', () => {
  return loadSites();
});

ipcMain.handle('save-sites', (_event, sites) => {
  saveSites(sites);
  return true;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
