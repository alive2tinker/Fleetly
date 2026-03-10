const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
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

  mainWindow.loadFile('index.html');
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

  // Composer: install via system package manager
  if (depKey === 'composer') {
    switch (pkgManager) {
      case 'dnf': return 'pkexec dnf install -y composer';
      case 'apt': return 'pkexec apt install -y composer';
      case 'pacman': return 'pkexec pacman -S --noconfirm composer';
      case 'zypper': return 'pkexec zypper install -y php-composer';
      case 'brew': return 'brew install composer';
      default: return null;
    }
  }

  // Laravel Installer: install via Composer global
  if (depKey === 'laravel') {
    return 'composer global require laravel/installer';
  }

  // Valet Linux: install prerequisites, then install via Composer global
  // Writes a temp script and runs via pkexec since valet install needs root internally
  if (depKey === 'valet') {
    return '__VALET_INSTALL__';
  }

  const pkgMap = packages[pkgManager];
  if (!pkgMap || !pkgMap[depKey]) return null;

  const pkg = pkgMap[depKey];

  switch (pkgManager) {
    case 'dnf': return `pkexec dnf install -y ${pkg}`;
    case 'apt': return `pkexec apt install -y ${pkg}`;
    case 'pacman': return `pkexec pacman -S --noconfirm ${pkg}`;
    case 'zypper': return `pkexec zypper install -y ${pkg}`;
    case 'brew': return `brew install ${pkg}`;
    default: return null;
  }
}

function runInstall(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { stdio: 'pipe', env: { ...process.env } });
    let output = '';

    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      resolve({ success: code === 0, output });
    });
  });
}

function runValetInstall(pkgManager) {
  const prereqs = {
    dnf: 'dnf install -y nss-tools jq xsel inotify-tools dnsmasq php-fpm',
    apt: 'apt install -y libnss3-tools jq xsel inotify-tools dnsmasq php-fpm',
    pacman: 'pacman -S --noconfirm nss jq xsel inotify-tools dnsmasq php-fpm',
    zypper: 'zypper install -y mozilla-nss-tools jq xsel inotify-tools dnsmasq php-fpm',
    brew: 'brew install nss jq xsel inotify-tools dnsmasq php',
  };

  const prereqCmd = prereqs[pkgManager];
  if (!prereqCmd) return Promise.resolve({ success: false, output: 'Unsupported package manager for Valet' });

  const user = process.env.USER || os.userInfo().username;
  const home = process.env.HOME || os.homedir();

  const script = `#!/bin/bash

# Grant temporary passwordless sudo for valet install
SUDOERS_TMP="/etc/sudoers.d/fleetly-valet-tmp"
cleanup() { rm -f "\$SUDOERS_TMP"; }
trap cleanup EXIT

echo "${user} ALL=(ALL) NOPASSWD: ALL" > "\$SUDOERS_TMP"
chmod 440 "\$SUDOERS_TMP"

set -e

# Install system prerequisites
${prereqCmd}

# Install valet-linux via Composer as the current user
su - ${user} -c "composer global require cpriego/valet-linux"

# Resolve Composer global bin path and run valet install
COMPOSER_BIN=$(su - ${user} -c "composer global config bin-dir --absolute 2>/dev/null")
su - ${user} -c "export PATH=\$COMPOSER_BIN:\\$PATH && valet install --ignore-selinux"

# Move upstream DNS into SELinux-allowed path and fix dnsmasq config
cat > /etc/dnsmasq.d/upstream-dns << 'DNS'
nameserver 8.8.8.8
nameserver 1.1.1.1
DNS

cat > /etc/dnsmasq.d/options << 'OPTS'
resolv-file=/etc/dnsmasq.d/upstream-dns
listen-address=127.0.0.1
bind-interfaces
cache-size=0
proxy-dnssec
OPTS

cat > /opt/valet-linux/resolv.conf << 'RESOLV'
nameserver 127.0.0.1
nameserver 8.8.8.8
nameserver 1.1.1.1
RESOLV

ln -sf /opt/valet-linux/resolv.conf /etc/resolv.conf
systemctl restart dnsmasq
`;

  const scriptPath = path.join(os.tmpdir(), 'fleetly-valet-install.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    const child = spawn('pkexec', ['bash', scriptPath], { stdio: 'pipe' });
    let output = '';

    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      try { fs.unlinkSync(scriptPath); } catch {}
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
    { name: 'Composer', command: 'composer --version', icon: 'composer' },
    { name: 'Valet', command: 'valet --version', icon: 'valet' },
    { name: 'Laravel Installer', command: 'laravel --version', icon: 'laravel' },
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

  if (command === '__VALET_INSTALL__') {
    return await runValetInstall(pkgManager);
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
    const result = command === '__VALET_INSTALL__'
      ? await runValetInstall(pkgManager)
      : await runInstall(command);
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

// ── DNS Fix ──
function buildDnsFixScript() {
  return `#!/bin/bash

# Move upstream DNS into SELinux-allowed path
cat > /etc/dnsmasq.d/upstream-dns << 'DNS'
nameserver 8.8.8.8
nameserver 1.1.1.1
DNS

# Update dnsmasq options to use the SELinux-allowed path
cat > /etc/dnsmasq.d/options << 'OPTS'
resolv-file=/etc/dnsmasq.d/upstream-dns
listen-address=127.0.0.1
bind-interfaces
cache-size=0
proxy-dnssec
OPTS

# Ensure resolv.conf has local + upstream fallback
cat > /opt/valet-linux/resolv.conf << 'RESOLV'
nameserver 127.0.0.1
nameserver 8.8.8.8
nameserver 1.1.1.1
RESOLV

ln -sf /opt/valet-linux/resolv.conf /etc/resolv.conf

# Restart all valet services
systemctl restart dnsmasq || true
systemctl restart nginx || true
systemctl restart php-fpm || true

exit 0
`;
}

function buildValetStartScript() {
  return `#!/bin/bash
systemctl start nginx || true
systemctl start php-fpm || true
systemctl start dnsmasq || true
exit 0
`;
}

function buildValetStopScript() {
  return `#!/bin/bash
systemctl stop nginx || true
systemctl stop php-fpm || true
systemctl stop dnsmasq || true
exit 0
`;
}

function runPkexecScript(script) {
  const scriptPath = path.join(os.tmpdir(), `fleetly-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    const child = spawn('pkexec', ['bash', scriptPath], { stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    // Timeout after 30s to prevent hanging
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ success: false, output: 'Operation timed out' });
    }, 30000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      try { fs.unlinkSync(scriptPath); } catch {}
      resolve({ success: code === 0, output: output.trim() });
    });
  });
}

ipcMain.handle('fix-dns', async () => {
  return runPkexecScript(buildDnsFixScript());
});

ipcMain.handle('valet-start', async () => {
  return runPkexecScript(buildValetStartScript());
});

ipcMain.handle('valet-stop', async () => {
  return runPkexecScript(buildValetStopScript());
});

ipcMain.handle('valet-status', async () => {
  return new Promise((resolve) => {
    exec('systemctl is-active nginx php-fpm dnsmasq', (error, stdout) => {
      const lines = (stdout || '').trim().split('\n');
      resolve({
        nginx: lines[0] === 'active',
        phpFpm: lines[1] === 'active',
        dnsmasq: lines[2] === 'active',
      });
    });
  });
});

// ── Parked Directories ──
function getParkedDirsPath() {
  return path.join(app.getPath('userData'), 'parked-dirs.json');
}

function loadParkedDirs() {
  try {
    const data = fs.readFileSync(getParkedDirsPath(), 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveParkedDirs(dirs) {
  fs.writeFileSync(getParkedDirsPath(), JSON.stringify(dirs, null, 2));
}

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select directory to park with Valet',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-parked-dirs', () => {
  return loadParkedDirs();
});

ipcMain.handle('save-parked-dirs', (_event, dirs) => {
  saveParkedDirs(dirs);
  return true;
});

ipcMain.handle('park-directory', async (_event, dirPath) => {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', `cd "${dirPath}" && valet park`], {
      stdio: 'pipe',
      env: { ...process.env },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => {
      resolve({ success: code === 0, output: output.trim() });
    });
  });
});

ipcMain.handle('unpark-directory', async (_event, dirPath) => {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', `cd "${dirPath}" && valet forget`], {
      stdio: 'pipe',
      env: { ...process.env },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => {
      resolve({ success: code === 0, output: output.trim() });
    });
  });
});

// ── Site Actions ──
ipcMain.handle('open-in-browser', async (_event, domain) => {
  const url = domain.startsWith('http') ? domain : `http://${domain}`;
  await shell.openExternal(url);
});

ipcMain.handle('open-in-editor', (_event, sitePath) => {
  if (!sitePath) return;
  spawn('bash', ['-lc', `code "${sitePath}" || xdg-open "${sitePath}"`], { detached: true, stdio: 'ignore' }).unref();
});

ipcMain.handle('open-in-terminal', (_event, sitePath) => {
  if (!sitePath) return;
  // Try common Linux terminals, then fall back
  const terminals = [
    `gnome-terminal --working-directory="${sitePath}"`,
    `konsole --workdir "${sitePath}"`,
    `xfce4-terminal --working-directory="${sitePath}"`,
    `xterm -e "cd '${sitePath}' && bash"`,
  ];
  spawn('bash', ['-lc', terminals.join(' || ')], { detached: true, stdio: 'ignore' }).unref();
});

// ── Project Creation ──

function getProjectsDir() {
  const dir = path.join(os.homedir(), 'Sites');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sendOutput(event, text) {
  event.sender.send('creation-output', text);
}

function runCommandWithOutput(command, cwd, event) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env },
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      sendOutput(event, text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      sendOutput(event, text);
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, code });
    });
  });
}

ipcMain.handle('create-laravel-project', async (event, options) => {
  const projectsDir = getProjectsDir();
  const projectPath = path.join(projectsDir, options.name);

  // Build the laravel new command with all options
  let cmd = `laravel new ${options.name}`;

  // Starter kit
  if (options.starterKit === 'breeze') {
    cmd += ' --breeze';
  } else if (options.starterKit === 'jetstream') {
    cmd += ' --jet';
  }

  // Stack (for breeze or jetstream)
  if (options.stack && options.starterKit !== 'none') {
    cmd += ` --stack=${options.stack}`;
  }

  // Dark mode
  if (options.dark) {
    cmd += ' --dark';
  }

  // Teams (jetstream)
  if (options.teams) {
    cmd += ' --teams';
  }

  // SSR
  if (options.ssr) {
    cmd += ' --ssr';
  }

  // TypeScript (breeze with react/vue)
  if (options.typescript) {
    cmd += ' --typescript';
  }

  // Database
  if (options.database) {
    cmd += ` --database=${options.database}`;
  }

  // Testing framework
  if (options.testing === 'pest') {
    cmd += ' --pest';
  } else if (options.testing === 'phpunit') {
    cmd += ' --phpunit';
  }

  // Git
  if (!options.git) {
    cmd += ' --no-interaction';
  }

  sendOutput(event, `$ ${cmd}\n`);

  const result = await runCommandWithOutput(cmd, projectsDir, event);

  if (result.success) {
    sendOutput(event, '\nProject created successfully!');
    return { success: true, path: projectPath };
  } else {
    sendOutput(event, `\nCommand exited with code ${result.code}`);
    return { success: false, path: projectPath };
  }
});

ipcMain.handle('clone-git-project', async (event, options) => {
  const projectsDir = getProjectsDir();
  const projectPath = path.join(projectsDir, options.name);

  // Step 1: Clone
  sendOutput(event, `$ git clone ${options.url} ${options.name}\n`);
  const cloneResult = await runCommandWithOutput(
    `git clone ${options.url} ${options.name}`,
    projectsDir,
    event
  );

  if (!cloneResult.success) {
    sendOutput(event, '\nGit clone failed.');
    return { success: false, path: projectPath };
  }

  // Step 2: Run setup commands if it's a Laravel project
  const composerJsonPath = path.join(projectPath, 'composer.json');
  if (fs.existsSync(composerJsonPath)) {
    const steps = [
      { cmd: 'composer install', label: 'Installing Composer dependencies' },
      { cmd: 'cp .env.example .env', label: 'Copying environment file' },
      { cmd: 'php artisan key:generate', label: 'Generating application key' },
    ];

    // Check for package.json (npm deps)
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      steps.push({ cmd: 'npm install', label: 'Installing NPM dependencies' });
      steps.push({ cmd: 'npm run build', label: 'Building frontend assets' });
    }

    for (const step of steps) {
      sendOutput(event, `\n--- ${step.label} ---\n$ ${step.cmd}\n`);
      const stepResult = await runCommandWithOutput(step.cmd, projectPath, event);
      if (!stepResult.success) {
        sendOutput(event, `\nWarning: "${step.cmd}" exited with code ${stepResult.code}`);
      }
    }
  }

  sendOutput(event, '\nProject setup complete!');
  return { success: true, path: projectPath };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
