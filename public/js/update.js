// New versions: a bar at the top when one is ready to put in (the installed Viti downloads it by itself) or out
// (the portable Viti only links to it). Looked for when the page opens and every so often after. The work is
// done by the app (/app/update, app/main.js).
import { h, toast } from './ui.js';

const call = (method, path) => fetch(path, { method }).then((r) => r.json());
const later = new Set(); // (versions you said "later" to, this time)

export async function restartToUpdate() {
  const r = await call('POST', '/app/update/install').catch(() => ({}));
  if (!r.ok) toast('The new version is not ready yet.', true);
}

export function updateBar() {
  let bar = null;
  const look = async () => {
    let u;
    try {
      u = await call('GET', '/app/update');
    } catch {
      return;
    }
    const show = (u.state === 'ready' || u.state === 'available') && !later.has(u.version);
    if (!show) return bar?.remove(), (bar = null);
    if (bar?.dataset.v === u.version + u.state) return;
    bar?.remove();
    const text = u.state === 'ready' ? `Viti ${u.version} is ready. It is put in when Viti restarts.` : `Viti ${u.version} is out.`;
    const go = u.state === 'ready' ? h('button', { class: 'btn small', onclick: restartToUpdate }, 'Restart now') : h('button', { class: 'btn small', onclick: () => window.open(u.url) }, 'Download');
    bar = h('div', { class: 'update-bar', role: 'status', dataset: { v: u.version + u.state } }, h('span', {}, text), go, h('button', { class: 'btn small ghost', onclick: () => (later.add(u.version), bar.remove(), (bar = null)) }, 'Later'));
    document.body.append(bar);
  };
  look();
  setInterval(look, 10 * 60 * 1000);
}

// for About: how updates stand, and looking now
export async function updateRow(row, btn) {
  const text = (u) =>
    ({
      off: 'New versions are on the releases page.',
      idle: 'Viti looks for new versions by itself.',
      checking: 'Looking for a new version…',
      none: `You have the latest version.`,
      downloading: `Downloading Viti ${u.version}… ${u.percent || 0}%`,
      ready: `Viti ${u.version} is ready: it is put in when Viti restarts.`,
      available: `Viti ${u.version} is out. This is the portable Viti, which cannot update itself: download the new one.`,
      error: `Could not look for updates: ${u.error}`,
    })[u.state] || '';
  const u = await call('GET', '/app/update').catch(() => ({ state: 'off' }));
  const small = h('span', {}, text(u));
  const action = (u) =>
    u.state === 'off'
      ? btn('Releases', () => window.open('https://github.com/ionodev/viti/releases'))
      : u.state === 'ready'
        ? btn('Restart now', restartToUpdate)
        : u.state === 'available'
          ? btn('Download', () => window.open(u.url))
          : btn('Look now', async (e) => {
              const b = e.currentTarget;
              b.disabled = true;
              small.textContent = text({ state: 'checking' });
              const n = await call('POST', '/app/update/check').catch(() => ({ state: 'error', error: 'no answer' }));
              small.textContent = text(n);
              b.replaceWith(action(n));
            });
  return row('Updates', small, action(u));
}
