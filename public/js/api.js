// Talking to the server: plain calls, image uploads (shrunk first), and the live connection.
import { S } from "./state.js";
export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.message || `Something went wrong (${res.status}).`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

// ---------- images ----------
const ACCEPT = /^image\/(png|jpeg|webp|gif)$/;
const MAX_SIDE = 2400;

// Big pictures are shrunk before they are sent (a screenshot of a big screen is some 5 MB as PNG).
// GIFs are sent as they are, so they keep moving.
export async function prepareImage(file) {
  if (!ACCEPT.test(file.type)) throw new Error('Only PNG, JPEG, WebP and GIF images.');
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('That image could not be read.');
  }
  let blob = file;
  let { width: w, height: h } = bmp;
  if (file.type !== 'image/gif' && (file.size > 1500000 || Math.max(w, h) > MAX_SIDE)) {
    for (const side of [MAX_SIDE, 1800, 1200]) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      w = Math.round(bmp.width * k);
      h = Math.round(bmp.height * k);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      let out = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.9));
      if (!out || out.type !== 'image/webp') out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
      blob = out;
      if (blob.size <= 8 * 1024 * 1024) break;
    }
  }
  bmp.close?.();
  if (blob.size > 10 * 1024 * 1024) throw new Error('That image is too big (10 MB at most).');
  return { blob, w, h, name: file.name || 'image' };
}

// the game's branches; the answer is kept on the server for a few minutes, so asking often is cheap
export async function loadBranches() {
  try {
    const r = await api('GET', '/api/branches');
    S.branches = { list: r.list || [], latest: r.latest || '' };
  } catch {}
  return S.branches;
}

export async function uploadImage(file) {
  const p = await prepareImage(file);
  const res = await fetch(`/api/images?name=${encodeURIComponent(p.name)}&w=${p.w}&h=${p.h}`, { method: 'POST', body: p.blob });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.message || 'The upload failed.');
  return { id: data.id, w: p.w, h: p.h, name: p.name };
}

// a PDF (as it is: it is not shrunk)
export async function uploadPdf(file) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name || '')) throw new Error('Only PDF files.');
  if (file.size > 10 * 1024 * 1024) throw new Error('That PDF is too big (10 MB at most).');
  const res = await fetch('/api/files?name=' + encodeURIComponent(file.name || 'document.pdf'), { method: 'POST', body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.message || 'The upload failed.');
  return { id: data.id, name: file.name || 'document.pdf' };
}

// ---------- the live connection ----------
export class Live {
  constructor() {
    this.handlers = new Map();
    this.open = false;
    this.wait = 500;
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  emit(type, data) {
    for (const fn of this.handlers.get(type) || []) fn(data);
  }
  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    ws.onopen = () => {
      this.open = true;
      this.wait = 500;
      this.timer = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
      this.emit('open');
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const m = JSON.parse(e.data);
        this.emit(m.t, m);
      } catch {}
    };
    ws.onclose = () => {
      clearInterval(this.timer);
      const was = this.open;
      this.open = false;
      if (was) this.emit('close');
      setTimeout(() => this.connect(), (this.wait = Math.min(this.wait * 2, 10000)));
    };
    this.ws = ws;
  }
  send(o) {
    if (this.open) this.ws.send(JSON.stringify(o));
  }
}
