// Viti for Windows: starts the local server (app/server.js), gives the window its key, and opens the
// home screen. Projects, settings and GitHub tokens are kept in the user's app data folder
// (%APPDATA%\Viti); tokens are encrypted with Windows' own protection for this user (safeStorage).
import { app, BrowserWindow, session, safeStorage, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47821; // (the same address every run, so what pages remember stays; another one if it is taken)

if (!app.requestSingleInstanceLock()) app.quit();

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
  const about = { version: app.getVersion(), logFile, openPath: (p) => shell.openPath(p) };
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
  win.loadURL(srv.url + '/home');
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
// the backup is sent before the app closes
app.on('before-quit', (e) => {
  if (!srv) return;
  e.preventDefault();
  const s = srv;
  srv = null;
  s.stop().finally(() => app.quit());
});
