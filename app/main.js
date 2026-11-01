// Viti for Windows: starts the local server (app/server.js), gives the window its key, and opens the
// home screen. Projects, settings and GitHub tokens are kept in the user's app data folder
// (%APPDATA%\Viti); tokens are encrypted with Windows' own protection for this user (safeStorage).
import { app, BrowserWindow, session, safeStorage, shell, Menu, nativeTheme, Notification, Tray, nativeImage, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import updater from 'electron-updater';

const { autoUpdater } = updater;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47821; // (the same address every run, so what pages remember stays; another one if it is taken)

if (!app.requestSingleInstanceLock()) app.quit();
// (Windows shows notifications under the app's id)
if (process.platform === 'win32') app.setAppUserModelId('io.github.ionodev.viti');

const seal = (t) => (safeStorage.isEncryptionAvailable() ? 'v1:' + safeStorage.encryptString(t).toString('base64') : 'v0:' + Buffer.from(t).toString('base64'));
const unseal = (s) => {
  try {
    if (s.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(s.slice(3), 'base64'));
    if (s.startsWith('v0:')) return Buffer.from(s.slice(3), 'base64').toString();
  } catch {}
  return '';
};

let win = null;
let srv = null;
let tray = null;
let quitting = false;
// the program itself (the portable version runs from a copy unpacked elsewhere: its own .exe is the one to start)
const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
// "--open=<project id>" (the jump list, the tray) and "--hidden" (started with Windows, into the tray)
const openArg = (argv) => (argv.find((a) => a.startsWith('--open=')) || '').slice(7);
const startHidden = process.argv.includes('--hidden');

// ---- updates: new versions are GitHub Releases of ionodev/viti. The installed Viti downloads one by itself and
// puts it in when it restarts (or at once, when you choose); the portable one cannot change itself, so it only
// says that there is one, and where to get it.
const REPO = 'ionodev/viti';
const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
const upd = { state: 'idle', version: '', percent: 0, error: '', checked: 0, portable, url: `https://github.com/${REPO}/releases/latest` };
let onUpdate = () => {};
const setUpd = (x) => (Object.assign(upd, x), onUpdate(upd));
const newer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function checkUpdates() {
  if (!app.isPackaged) return setUpd({ state: 'off' });
  if (upd.state === 'ready' || upd.state === 'downloading') return;
  setUpd({ state: 'checking', error: '', checked: Date.now() });
  try {
    if (!portable) return void (await autoUpdater.checkForUpdates());
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'viti' } });
    if (r.status === 404) return setUpd({ state: 'none' });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
    const j = await r.json();
    const v = String(j.tag_name || '').replace(/^v/, '');
    const exe = (j.assets || []).find((a) => /portable\.exe$/i.test(a.name));
    setUpd(newer(v, app.getVersion()) ? { state: 'available', version: v, url: exe?.browser_download_url || j.html_url } : { state: 'none' });
  } catch (e) {
    // (no release yet is not a problem worth showing)
    setUpd(/404|latest version|no published versions/i.test(e.message) ? { state: 'none' } : { state: 'error', error: String(e.message).split('\n')[0].slice(0, 200) });
  }
}
function setupUpdates(notify) {
  if (!app.isPackaged) return setUpd({ state: 'off' });
  if (!portable) {
    // (VITI_UPDATE_URL: a folder with latest.yml and the installer, to try an update without a release)
    if (process.env.VITI_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.VITI_UPDATE_URL });
    autoUpdater.autoDownload = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m) => console.log('update:', m), warn: (m) => console.log('update:', m), error: (m) => console.error('update:', m), debug: () => {} };
    autoUpdater.on('update-available', (i) => setUpd({ state: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => setUpd({ percent: Math.round(p.percent) }));
    autoUpdater.on('update-not-available', () => setUpd({ state: 'none' }));
    autoUpdater.on('update-downloaded', (i) => {
      setUpd({ state: 'ready', version: i.version, percent: 100 });
      notify(`Viti ${i.version} is ready`, 'It is put in when Viti restarts. Or restart now from the bar at the top.');
    });
    autoUpdater.on('error', (e) => upd.state !== 'checking' && setUpd({ state: 'error', error: String(e?.message || e).split('\n')[0].slice(0, 200) }));
  }
  setTimeout(checkUpdates, 15000);
  setInterval(checkUpdates, 4 * 60 * 60 * 1000);
}

// a log of what happens (and goes wrong), for the About page's "Open the log": %APPDATA%\Viti\logs\viti.log,
// started afresh when it grows past 1 MB
const logFile = path.join(app.getPath('userData'), 'logs', 'viti.log');
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
} catch {}
for (const level of ['log', 'warn', 'error']) {
  const was = console[level].bind(console);
  console[level] = (...a) => {
    was(...a);
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
    } catch {}
  };
}
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));
console.log(`Viti ${app.getVersion()} starting`);

async function start() {
  const dataDir = app.getPath('userData');
  const notify = (title, body) => {
    if (!Notification.isSupported() || (win && win.isFocused())) return;
    const n = new Notification({ title, body, icon: path.join(root, 'build', 'icon.png'), silent: false });
    n.on('click', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    n.show();
  };
  // what the app's server needs from Windows: start with it, the tray and the jump list, and two dialogs
  const desktop = {
    setStartup: (on) => app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: ['--hidden'] }),
    changed: ({ recent, prefs }) => {
      jumpList(recent);
      trayIcon(prefs.tray, recent);
    },
    pickFolder: async (from) => (await dialog.showOpenDialog(win, { title: 'Where should Viti keep your projects?', defaultPath: from, properties: ['openDirectory', 'createDirectory'] })).filePaths?.[0] || '',
    saveFile: async (name) => (await dialog.showSaveDialog(win, { title: 'Export the project', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Zip', extensions: ['zip'] }] })).filePath || '',
    reveal: (p) => shell.showItemInFolder(p),
    // updates: how they stand, look now, and restart into the new version
    update: {
      get: () => ({ ...upd, current: app.getVersion() }),
      check: async () => (await checkUpdates(), { ...upd, current: app.getVersion() }),
      install: () => {
        if (upd.state !== 'ready') return false;
        quitting = true;
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
        return true;
      },
    },
  };
  const about = { version: app.getVersion(), logFile, openPath: (p) => shell.openPath(p), notify, desktop };
  try {
    srv = await startServer({ root, dataDir, seal, unseal, port: PORT, ...about });
  } catch {
    srv = await startServer({ root, dataDir, seal, unseal, port: 0, ...about });
  }
  await session.defaultSession.cookies.set({ url: srv.url, name: 'viti', value: srv.key, httpOnly: true, sameSite: 'strict' });
  Menu.setApplicationMenu(null);
  // the background while the page loads matches the theme (no white flash in the dark one)
  let dark = nativeTheme.shouldUseDarkColors;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dataDir, 'viti.json'), 'utf8')).prefs?.theme;
    if (t === 'dark' || t === 'light') dark = t === 'dark';
  } catch {}
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    title: 'Viti',
    backgroundColor: dark ? '#0f1013' : '#f6f7f9',
    icon: path.join(root, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  // links out of the app (GitHub, a link in a note) open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(srv.url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(srv.url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
  });
  // F5 reloads, F12 the developer tools, Ctrl+= / Ctrl+- zoom the whole app
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') win.webContents.reload();
    else if (input.key === 'F12') win.webContents.toggleDevTools();
    else if (input.control && (input.key === '=' || input.key === '+')) win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
    else if (input.control && input.key === '-') win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
    else if (input.control && input.key === '0') win.webContents.setZoomLevel(0);
    else return;
    e.preventDefault();
  });
  // closing the window: into the tray when that is chosen (mail keeps coming in), else Viti quits
  win.on('close', (e) => {
    if (quitting || !srv?.prefs().tray) return;
    e.preventDefault();
    win.hide();
  });
  desktop.changed({ recent: srv.recent(), prefs: srv.prefs() });
  setupUpdates(notify);
  // started from the jump list or the tray with a project: straight into it
  const id = openArg(process.argv);
  if (id) await openInWindow(id);
  else win.loadURL(srv.url + '/home');
  if (startHidden && srv.prefs().tray) win.hide();
}

// a project, opened and shown (from the jump list or the tray)
async function openInWindow(id) {
  try {
    await srv.openProject(id);
    await win.loadURL(srv.url + '/');
  } catch {
    await win.loadURL(srv.url + '/home');
  }
  showWindow();
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// the taskbar's jump list (right-click Viti): the projects most recently opened
function jumpList(recent) {
  if (process.platform !== 'win32') return;
  try {
    app.setJumpList([
      { type: 'custom', name: 'Recent projects', items: recent.map((p) => ({ type: 'task', title: p.repo.split('/')[1], description: p.repo, program: exe, args: `--open=${p.id}`, iconPath: exe, iconIndex: 0 })) },
      { type: 'tasks', items: [{ type: 'task', title: 'All projects', description: 'The home screen', program: exe, args: '', iconPath: exe, iconIndex: 0 }] },
    ]);
  } catch (e) {
    console.error('jump list:', e.message);
  }
}

// the tray icon (when Viti is to stay there): open it, a recent project, or quit
function trayIcon(on, recent) {
  if (!on) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(root, 'public', 'img', 'icon-64.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('Viti');
    tray.on('click', showWindow);
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Viti', click: showWindow },
      { type: 'separator' },
      ...recent.slice(0, 6).map((p) => ({ label: p.repo.split('/')[1], click: () => openInWindow(p.id) })),
      ...(recent.length ? [{ type: 'separator' }] : []),
      { label: 'Quit Viti', click: () => ((quitting = true), app.quit()) },
    ]),
  );
}

// Viti started again (the jump list, a shortcut) while it runs: this window, with that project if one was asked for
app.on('second-instance', (e, argv) => {
  if (!win || !srv) return;
  const id = openArg(argv);
  if (id) openInWindow(id);
  else showWindow();
});
app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
// the backup is sent before the app closes
app.on('before-quit', (e) => {
  quitting = true;
  if (!srv) return;
  e.preventDefault();
  const s = srv;
  srv = null;
  s.stop().finally(() => app.quit());
});
