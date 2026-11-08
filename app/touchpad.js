// Pinch to zoom on Linux under X11. Chromium never sees a touchpad pinch there (on Windows, on a Mac and under
// Wayland it turns one into Ctrl+scroll by itself, which the board, the progress tower and the overview zoom on).
// Viti reads the pinch itself and hands every small change in it to the window under the fingers as the same
// fine Ctrl+scroll that Chromium makes from a pinch elsewhere.
//
// Where the pinch comes from:
// - the X server (X Input 2.4, X.Org 21.1 and later: app/x11gestures.js), on Viti's own windows. The scale is
//   libinput's own: it follows the fingers both ways for as long as they stay on the touchpad, so a pinch can
//   stop, go on, and turn back.
// - else Touchégg, the gesture service many Linux desktops run. It gives less: how far a pinch has come in one
//   direction, chosen at its start, and no further than twice as far apart. It speaks D-Bus over a socket of
//   its own (no bus in between); only the few messages needed here are read.
import net from 'node:net';
import os from 'node:os';
import { app, BrowserWindow, screen } from 'electron';
import { connectX11Gestures } from './x11gestures.js';

const SOCKET = '\0touchegg'; // unix:abstract=touchegg
const PINCH = 2;
const IN = 5;
const OUT = 6;
// how much the view zooms for a pinch: the fingers' scale to this power (1 is Chromium's own), so that zooming far
// in or out takes fewer pinches
const GAIN = 1.5;

export async function startPinchZoom() {
  if (process.platform !== 'linux' || process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) return;
  if (await fromX11()) return;
  fromTouchegg();
}

// ------------------------------------------------------------------ from the X server
async function fromX11() {
  const windows = new Map(); // X window -> BrowserWindow
  let refused = false;
  let x;
  try {
    x = await connectX11Gestures({
      onPinch(phase, xwin, scale, rootX, rootY) {
        const win = windows.get(xwin);
        if (phase === 'begin' || last === null) last = 1;
        if (phase === 'end') return (last = null);
        const ratio = scale / last;
        last = scale;
        if (!win || win.isDestroyed() || Math.abs(Math.log(ratio)) < 1e-4) return;
        const f = screen.getDisplayNearestPoint(win.getContentBounds()).scaleFactor || 1; // (X speaks pixels)
        zoomBy(win, ratio, rootX / f, rootY / f);
      },
      // another program already takes the pinches on this window: Touchégg instead, for all of them
      onError() {
        if (refused) return;
        refused = true;
        x.close();
        fromTouchegg();
      },
    });
  } catch {
    return false;
  }
  const add = (win) => {
    const id = win.getNativeWindowHandle().readUInt32LE(0);
    windows.set(id, win);
    win.once('closed', () => windows.delete(id));
    x.select(id);
  };
  BrowserWindow.getAllWindows().forEach(add);
  app.on('browser-window-created', (_, win) => add(win));
  return true;
}

// ------------------------------------------------------------------ from Touchégg
function fromTouchegg() {
  let retry = 2000;
  const connect = () => {
    const sock = net.createConnection({ path: SOCKET });
    let buf = Buffer.alloc(0);
    let authed = false;
    sock.on('connect', () => {
      retry = 2000;
      const uid = Buffer.from(String(os.userInfo().uid)).toString('hex');
      sock.write(`\0AUTH EXTERNAL ${uid}\r\n`);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!authed) {
        const end = buf.indexOf('\r\n');
        if (end < 0) return;
        const line = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 2);
        if (!line.startsWith('OK')) return sock.destroy();
        authed = true;
        sock.write('BEGIN\r\n');
      }
      for (;;) {
        const msg = nextMessage(buf);
        if (!msg) break;
        buf = buf.subarray(msg.length);
        if (msg.member) gesture(msg);
      }
    });
    sock.on('error', () => {});
    // touchégg not running (yet), or restarted: try again, less and less often
    sock.on('close', () => {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60000);
    });
  };
  connect();
}

// ------------------------------------------------------------------ the pinch, from Touchégg
let last = null; // the scale the previous update of this pinch stood at (either source)

function gesture({ member, type, direction, percentage }) {
  if (type !== PINCH || (direction !== IN && direction !== OUT)) return (last = null);
  // touchégg gives how far the pinch has come in percent: in, 100 at the fingers together; out, 100 at twice
  // as far apart. Back to libinput's scale (1 where the pinch began):
  const scale = direction === OUT ? 1 + percentage / 100 : Math.max(0.05, 1 - percentage / 100);
  if (member === 'OnGestureEnd') return (last = null);
  // a pinch starts at scale 1: what the fingers moved before touchégg's first word counts too
  if (member === 'OnGestureBegin' || last === null) last = 1;
  const ratio = scale / last;
  last = scale;
  if (Math.abs(Math.log(ratio)) < 1e-4) return;
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  zoomBy(win, ratio, p.x, p.y);
}

// zoom the page in win by ratio around the screen point (sx, sy)
function zoomBy(win, ratio, sx, sy) {
  const b = win.getContentBounds();
  const x = Math.round(sx - b.x);
  const y = Math.round(sy - b.y);
  if (x < 0 || y < 0 || x >= b.width || y >= b.height) return;
  // Chromium's own pinch: Ctrl+scroll with deltaY = -100·ln(scale) (here the sign is the other way round:
  // a positive deltaY sent in is a scroll up, which a page sees as a negative deltaY)
  // (in steps under 30, so a page never takes it for a whole notch of a mouse wheel: see public/js/wheelzoom.js)
  const d = 100 * GAIN * Math.log(ratio);
  const n = Math.ceil(Math.abs(d) / 30);
  for (let i = 0; i < n; i++) win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: d / n, modifiers: ['control'], hasPreciseScrollingDeltas: true, canScroll: true });
}

// ------------------------------------------------------------------ D-Bus messages, just enough to read signals
// a message: 16 bytes of fixed header, then the header fields (an array of (code, variant)), padded to 8, then the
// body. Returns null while the message is not all here yet.
function nextMessage(b) {
  if (b.length < 16) return null;
  const le = b[0] === 0x6c; // 'l'
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const bodyLen = u32(4);
  const fieldsLen = u32(12);
  const bodyStart = align(16 + fieldsLen, 8);
  const length = bodyStart + bodyLen;
  if (b.length < length) return null;
  const msg = { length };
  if (b[1] !== 4) return msg; // only signals
  // header fields: code (byte), signature of the variant, the value
  let o = 16;
  let sig = '';
  while (o < 16 + fieldsLen) {
    o = align(o, 8);
    const code = b[o];
    const sl = b[o + 1];
    const vt = b.toString('latin1', o + 2, o + 2 + sl);
    o += 3 + sl;
    if (vt === 's' || vt === 'o') {
      o = align(o, 4);
      const n = u32(o);
      const s = b.toString('utf8', o + 4, o + 4 + n);
      if (code === 3) msg.member = s;
      o += 5 + n;
    } else if (vt === 'g') {
      const n = b[o];
      if (code === 8) sig = b.toString('latin1', o + 1, o + 1 + n);
      o += 2 + n;
    } else if (vt === 'u') {
      o = align(o, 4) + 4;
    } else return msg; // a field this reader does not know: skip the message
  }
  if (sig !== 'uudiut' || bodyLen < 32) return { length };
  const o0 = bodyStart;
  msg.type = u32(o0);
  msg.direction = u32(o0 + 4);
  msg.percentage = le ? b.readDoubleLE(o0 + 8) : b.readDoubleBE(o0 + 8);
  return msg;
}

const align = (n, k) => Math.ceil(n / k) * k;
