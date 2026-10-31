// Small shared helpers.
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const fail = (status, error, message) => json({ ok: false, error, message: message || error }, status);

// random ids: lower-case letters and digits
export const rid = (n = 10) => {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return [...a].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
};

export const sha256hex = async (data) => {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// compare two secrets without leaking where they differ
export const safeEqual = (a, b) => {
  a = String(a || '');
  b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
};

export const clip = (s, n) => String(s ?? '').slice(0, n);
export const num = (v, lo, hi, dflt = 0) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

export const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'section';

export const b64decode = (s) => Uint8Array.from(atob(String(s).replace(/\s/g, '')), (c) => c.charCodeAt(0));
export const b64encode = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// a PDF, from its first bytes ("%PDF-")
export const sniffPdf = (b) => (b.length > 8 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d ? ['application/pdf', 'pdf'] : null);

// The kind of image, from its first bytes (never from what the sender says it is)
export const sniffImage = (b) => {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ['image/png', 'png'];
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return ['image/gif', 'gif'];
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return ['image/webp', 'webp'];
  return null;
};

const COLORS = ['#c99a24', '#7aa874', '#6f9fc4', '#c46f6f', '#9b7fc4', '#c48f5a', '#5fa8a0', '#b07aa0'];
// a colour no one else has yet: the palette first, then evenly spaced hues
export const nextColor = (used) => {
  const taken = new Set(used.map((c) => String(c).toLowerCase()));
  const free = COLORS.find((c) => !taken.has(c));
  if (free) return free;
  for (let i = 0; i < 4000; i++) {
    const hue = (i * 137.508) % 360;
    const c = hsl(hue, 45 + (Math.floor(i / 360) % 3) * 10, 48 + (Math.floor(i / 360) % 5) * 5);
    if (!taken.has(c)) return c;
  }
  return COLORS[0];
};
const hsl = (h, s, l) => {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return '#' + f(0) + f(8) + f(4);
};
export const colorFor = (s) => {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
