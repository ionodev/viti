// Small DOM helpers, and the page's dialogs, menus, toasts and lightbox.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// h('div', { class: 'x', onclick: fn }, child, 'text', ...): an element
// on a Mac the shortcuts are written with ⌘ (Ctrl K -> ⌘K)
export const MAC = /Mac/.test(navigator.platform);
export const keys = (s) => (MAC && typeof s === 'string' ? s.replace(/Ctrl[ +]?/g, '⌘') : s);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (let [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'title') v = keys(v);
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(keys(String(kid))));
  // (a button that is only an icon is named for screen readers by its tooltip)
  if (tag === 'button' && el.title && !el.hasAttribute('aria-label') && !/\w/.test(el.textContent)) el.setAttribute('aria-label', el.title);
  return el;
}

export const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const stamp = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const dayLabel = (ts) => {
  const d = new Date(ts);
  const t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'Today';
  if (same(d, new Date(t - 86400000))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};

// a person's picture (their GitHub one), or else the first letter of their name on their colour
export const avatar = (u, big) =>
  u.avatar && /^https:\/\//.test(u.avatar)
    ? h('span', { class: 'av pic' + (big ? ' big' : ''), title: u.name }, h('img', { src: u.avatar, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.parentNode.replaceWith(avatar({ ...u, avatar: '' }, big)) }))
    : h('span', { class: 'av' + (big ? ' big' : ''), style: { background: u.color || '#888' }, title: u.name }, (u.name || '?').charAt(0).toUpperCase());

// a short message in the corner; with an action ({ label, fn }) it has a button too (Undo), and stays a little longer
export function toast(text, bad, action) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') + (action ? ' act' : '') }, h('span', {}, text));
  if (action) t.append(h('button', { onclick: () => (t.remove(), action.fn()) }, action.label));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), action ? UNDO_MS : bad ? 6000 : 3200);
  return t;
}
// how long something done can be taken back (Undo in the toast)
export const UNDO_MS = 7000;
export const undoToast = (text, undo) => toast(text, false, { label: 'Undo', fn: undo });

// a dialog; resolves with the label of the button pressed (or null for Esc / a click outside)
export function modal(title, body, buttons = [{ label: 'OK', value: true, primary: true }]) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && close(null) }, h('div', { class: 'dialog', role: 'dialog' }, h('h3', {}, title), body, h('div', { class: 'actions' }, buttons.map((b) => h('button', { class: 'btn small ' + (b.primary ? '' : b.danger ? 'danger' : 'ghost'), onclick: () => close(b.value) }, b.label)))));
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    overlay._close = close;
    const first = overlay.querySelector('input, textarea');
    if (first) setTimeout(() => (first.focus(), first.select?.()), 0);
  });
}
// wraps every match of `q` in the text of `root` in <mark> (for the search boxes)
export function highlight(root, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.toLowerCase().includes(q)) nodes.push(n);
  for (const n of nodes) {
    const text = n.nodeValue;
    const low = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let at = 0;
    for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
      frag.append(text.slice(at, i), h('mark', {}, text.slice(i, i + q.length)));
      at = i + q.length;
    }
    frag.append(text.slice(at));
    n.replaceWith(frag);
  }
}

// the Settings can turn off the question before something is deleted (read here, so this file needs nothing from settings.js)
const askBeforeDeleting = () => {
  try {
    return JSON.parse(localStorage.getItem('hub.settings') || '{}').confirmDelete !== false;
  } catch {
    return true;
  }
};
export const confirmBox = async (title, text, okLabel = 'OK', danger = false) => (danger && !askBeforeDeleting()) || (await modal(title, h('p', {}, text), [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }])) === true;
export async function promptBox(title, label, value = '', okLabel = 'Save') {
  const input = h('input', { type: 'text', value, maxlength: 60 });
  const box = h('div', {}, h('label', {}, label), input);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && box.closest('.overlay')._close(true));
  const ok = await modal(title, box, [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true }]);
  return ok === true ? input.value.trim() : null;
}

let openMenu = null;
export function menu(x, y, items) {
  openMenu?.remove();
  const el = h('div', { class: 'menu' }, items.map((i) => h('button', { class: (i.danger ? 'danger' : '') + (i.on ? ' on' : ''), onclick: () => (el.remove(), i.fn()) }, i.label)));
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  openMenu = el;
  const away = (e) => {
    if (!el.contains(e.target)) {
      el.remove();
      document.removeEventListener('mousedown', away, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
}

export function lightbox(src) {
  const box = h('div', { class: 'lightbox', onclick: () => close() }, h('img', { src, alt: '' }));
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => e.key === 'Escape' && (e.stopPropagation(), close());
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
}

// true while the keyboard is for writing (so the board's shortcuts keep out of the way)
export const typing = () => {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};

// a small (i) button that shows a few lines of help when clicked (and hides them again: a click
// anywhere else, or Esc); place = where the text opens: 'up-left', 'up-right', 'down-left' or 'down-right'
export function infoButton(text, place = 'up-left') {
  const pop = h('div', { class: 'info-pop ' + place, role: 'tooltip', hidden: true }, text);
  const btn = h('button', { class: 'info-btn', type: 'button', title: 'How this works', 'aria-label': 'How this works' }, 'i');
  const box = h('span', { class: 'info' }, btn, pop);
  const away = (e) => (e.type === 'keydown' ? e.key === 'Escape' : !box.contains(e.target)) && show(false);
  const show = (on) => {
    pop.hidden = !on;
    btn.classList.toggle('on', on);
    document[on ? 'addEventListener' : 'removeEventListener']('mousedown', away, true);
    document[on ? 'addEventListener' : 'removeEventListener']('keydown', away, true);
  };
  btn.addEventListener('click', () => show(pop.hidden));
  return box;
}
