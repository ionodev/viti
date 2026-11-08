// Touchpad pinches straight from the X server (Linux, X11). Since X Input 2.4 (X.Org 21.1 with the libinput
// driver) the server hands a pinch to the window under the fingers, with the scale libinput measures: 1 where the
// fingers started, more as they spread, less as they close, free to go back and forth until they lift. Chromium
// does not ask for these, so Viti does, on its own windows, over a second connection to the X server.
//
// Just enough of the X protocol for that: connect (with the MIT-MAGIC-COOKIE from ~/.Xauthority), find the
// XInputExtension, say we speak X Input 2.4, and select the three pinch events on a window.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const XI_GesturePinchBegin = 27;
const XI_GesturePinchUpdate = 28;
const XI_GesturePinchEnd = 29;
const GENERIC_EVENT = 35;
const XIAllMasterDevices = 1;

const pad4 = (n) => (4 - (n % 4)) % 4;

// connect: resolves to { root, select(windowId), close() } or rejects when there is no X server, no X Input 2.4, ...
// onPinch(phase, window, scale, rootX, rootY) for every pinch event; phase is 'begin', 'update' or 'end'.
// onError(window) when the server refuses a window (another program already takes its pinches).
export function connectX11Gestures({ onPinch, onError }) {
  return new Promise((resolve, reject) => {
    const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY || '');
    if (!m) return reject(new Error('no local X display'));
    const display = m[1];
    const sock = net.createConnection({ path: `/tmp/.X11-unix/X${display}` });
    let buf = Buffer.alloc(0);
    let state = 'setup';
    let seq = 0;
    let xi = 0; // the X Input extension's major opcode
    let root = 0;
    const waiting = new Map(); // sequence number -> (reply) => ...
    const selected = new Map(); // sequence number of an XISelectEvents -> window

    const request = (bytes, onReply) => {
      seq = (seq + 1) & 0xffff;
      if (onReply) waiting.set(seq, onReply);
      sock.write(bytes);
      return seq;
    };
    const fail = (err) => {
      sock.destroy();
      reject(err);
    };

    sock.on('error', fail);
    sock.on('connect', () => {
      const { name, data } = cookie(display);
      const head = Buffer.alloc(12);
      head.write('l', 0, 'latin1');
      head.writeUInt16LE(11, 2);
      head.writeUInt16LE(0, 4);
      head.writeUInt16LE(name.length, 6);
      head.writeUInt16LE(data.length, 8);
      sock.write(Buffer.concat([head, name, Buffer.alloc(pad4(name.length)), data, Buffer.alloc(pad4(data.length))]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === 'setup') {
        if (buf.length < 8) return;
        const total = 8 + buf.readUInt16LE(6) * 4;
        if (buf.length < total) return;
        const ok = buf[0] === 1;
        if (ok) {
          const vendor = buf.readUInt16LE(24);
          root = buf.readUInt32LE(40 + vendor + pad4(vendor) + 8 * buf[29]); // the first screen's root window
        }
        buf = buf.subarray(total);
        if (!ok) return fail(new Error('X server refused the connection'));
        state = 'ready';
        queryExtension();
      }
      while (buf.length >= 32) {
        const kind = buf[0] & 0x7f;
        const length = kind === 1 || kind === GENERIC_EVENT ? 32 + buf.readUInt32LE(4) * 4 : 32;
        if (buf.length < length) return;
        const p = buf.subarray(0, length);
        buf = buf.subarray(length);
        if (kind === 1) {
          const s = p.readUInt16LE(2);
          const cb = waiting.get(s);
          waiting.delete(s);
          cb?.(p);
        } else if (kind === 0) {
          const s = p.readUInt16LE(2);
          if (selected.has(s)) onError?.(selected.get(s));
          else if (waiting.has(s)) {
            waiting.delete(s);
            fail(new Error('X error ' + p[1]));
          }
        } else if (kind === GENERIC_EVENT && p[1] === xi) {
          const type = p.readUInt16LE(8);
          if (type < XI_GesturePinchBegin || type > XI_GesturePinchEnd) continue;
          const fp = (o) => p.readInt32LE(o) / 65536;
          const phase = type === XI_GesturePinchBegin ? 'begin' : type === XI_GesturePinchUpdate ? 'update' : 'end';
          onPinch(phase, p.readUInt32LE(24), fp(64), fp(32), fp(36));
        }
      }
    });

    function queryExtension() {
      const name = Buffer.from('XInputExtension', 'latin1');
      const r = Buffer.alloc(8 + name.length + pad4(name.length));
      r[0] = 98; // QueryExtension
      r.writeUInt16LE(r.length / 4, 2);
      r.writeUInt16LE(name.length, 4);
      name.copy(r, 8);
      request(r, (rep) => {
        if (!rep[8]) return fail(new Error('no X Input extension'));
        xi = rep[9];
        // XIQueryVersion 2.4: needed before the server sends gesture events at all
        const v = Buffer.alloc(8);
        v[0] = xi;
        v[1] = 47;
        v.writeUInt16LE(2, 2);
        v.writeUInt16LE(2, 4);
        v.writeUInt16LE(4, 6);
        request(v, (vr) => {
          const major = vr.readUInt16LE(8);
          const minor = vr.readUInt16LE(10);
          if (major < 2 || (major === 2 && minor < 4)) return fail(new Error(`X Input ${major}.${minor}, no gestures`));
          resolve({ root, select, close: () => sock.destroy() });
        });
      });
    }

    function select(window) {
      const r = Buffer.alloc(20);
      r[0] = xi;
      r[1] = 46; // XISelectEvents
      r.writeUInt16LE(5, 2);
      r.writeUInt32LE(window, 4);
      r.writeUInt16LE(1, 8); // one mask
      r.writeUInt16LE(XIAllMasterDevices, 12);
      r.writeUInt16LE(1, 14); // mask length, in 4-byte units
      r.writeUInt32LE((1 << XI_GesturePinchBegin) | (1 << XI_GesturePinchUpdate) | (1 << XI_GesturePinchEnd), 16);
      selected.set(request(r), window);
    }
  });
}

// the MIT-MAGIC-COOKIE-1 for this display from the X authority file (none: connect without, which a server that
// trusts local users accepts)
function cookie(display) {
  const none = { name: Buffer.alloc(0), data: Buffer.alloc(0) };
  let b;
  try {
    b = fs.readFileSync(process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority'));
  } catch {
    return none;
  }
  const host = os.hostname();
  let o = 0;
  let fallback = null;
  const field = () => {
    const n = b.readUInt16BE(o);
    const v = b.subarray(o + 2, o + 2 + n);
    o += 2 + n;
    return v;
  };
  while (o + 2 <= b.length) {
    const family = b.readUInt16BE(o);
    o += 2;
    const address = field().toString('latin1');
    const number = field().toString('latin1');
    const name = field();
    const data = field();
    if (name.toString('latin1') !== 'MIT-MAGIC-COOKIE-1' || (number && number !== display)) continue;
    if (family === 65535 || (family === 256 && address === host)) return { name, data };
    fallback ??= { name, data };
  }
  return fallback || none;
}
