// The canvas of one section: notes, markdown text and images you can place, move, resize and edit, with
// pan and zoom, undo, and everything kept in step live with the others looking at the same board.
import { S, user, imageUrl, sectionById } from './state.js';
import { api, uploadImage, uploadPdf } from './api.js';
import { h, toast, typing, menu, lightbox, promptBox } from './ui.js';
import { renderInto, highlight } from './md.js';
import { settings } from './settings.js';

export const NOTE = { yellow: '#f6d66b', white: '#fbf8f0', red: '#f19a92', orange: '#f5a85a', green: '#a9d6a0', blue: '#9cc7e6', purple: '#c9aee3' };
const LEGACY = { pink: 'red', cream: 'white', gold: 'orange' }; // names notes were saved with before
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const round = (n) => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// a short line of what an item says (for the chat)
export function snippet(it) {
  if (it.type === 'image') return it.data.name || 'Image';
  if (it.type === 'doc') return sectionById(it.data.section)?.name || it.data.name || 'Note';
  if (it.type === 'group') return it.data.title || 'Group';
  if (it.type === 'draw') return 'Drawing';
  return String(it.data.text || '').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}
export const kindLabel = (it) => (it.type === 'doc' ? (it.data.kind === 'pdf' ? 'PDF' : 'Note') : ({ note: 'Post-it', text: 'Text', image: 'Image', group: 'Group', draw: 'Drawing' })[it.type] || 'Item');
const SVG = 'http://www.w3.org/2000/svg';
const BRUSH = { S: 2, M: 5, L: 10 }; // the sizes of the Draw tool
const PAD = 18; // the space a group keeps around what is in it

export class Board {
  constructor({ onReference, onOpen }) {
    this.onReference = onReference;
    this.onOpen = onOpen; // (go to a Note or PDF)
    this.markColor = 'yellow';
    this.brush = 'M';
    this.items = new Map();
    this.els = new Map();
    this.sel = new Set();
    this.busy = new Set(); // items this person is moving or editing: others' changes to them wait
    this.view = { x: 0, y: 0, z: 1 };
    this.tool = 'select';
    this.undo = [];
    this.redo = [];
    this.outbox = [];
    this.cursors = new Map();
    this.editing = null;
    this.spaceDown = false;
    this.off = [];
    this.lastColor = 'yellow';
  }

  // ------------------------------------------------------------------ building the page
  mount(stage) {
    this.stage = stage;
    this.vp = h('div', { class: 'viewport', tabindex: '0' });
    this.world = h('div', { class: 'world' });
    this.marquee = h('div', { class: 'marquee', hidden: true });
    this.vp.append(this.world, this.marquee);
    this.hint = h('div', { class: 'empty-hint', hidden: true }, 'An empty board.\nDouble-click to write, press P for a post-it, I for an image.');
    this.hint.style.whiteSpace = 'pre-line';
    this.offline = h('div', { class: 'status-line', hidden: true }, 'Offline: reconnecting. Your changes are kept and sent when it is back.');
    this.zoomLabel = h('span', {}, '100%');
    this.toolButtons = {};
    const tool = (id, label, key, alt) => (this.toolButtons[id] = h('button', { class: 'tool', title: `${label} (${key} or ${alt})`, onclick: () => this.setTool(id) }, label, h('b', {}, `${key}·${alt}`)));
    this.toolbar = h('div', { class: 'toolbar' }, tool('select', 'Select', 'S', '1'), tool('hand', 'Hand', 'H', '2'), tool('note', 'Post-it', 'P', '3'), tool('text', 'Text', 'T', '4'), h('button', { class: 'tool', title: 'Add images (I or 5)', onclick: () => this.pickImages() }, 'Image', h('b', {}, 'I·5')), tool('draw', 'Draw', 'D', '6'), tool('marker', 'Marker', 'M', '7'), h('button', { class: 'tool', title: 'A new Note: a page of markdown, a subsection of this board (N or 8)', onclick: () => this.newNote(this.center()) }, 'Note', h('b', {}, 'N·8')), h('button', { class: 'tool', title: 'Add a PDF as a subsection of this board', onclick: () => this.pdfPicker.click() }, 'PDF', h('b', {}, '9')));
    this.subbar = h('div', { class: 'subbar', hidden: true });
    this.zoombar = h('div', { class: 'zoombar' }, h('button', { title: 'Zoom out (-)', onclick: () => this.zoomBy(1 / 1.25) }, '−'), this.zoomLabel, h('button', { title: 'Zoom in (+)', onclick: () => this.zoomBy(1.25) }, '+'), h('button', { title: 'Fit everything (Shift+1)', onclick: () => this.fit() }, 'Fit'));
    this.itembar = h('div', { class: 'itembar', hidden: true });
    this.pdfPicker = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    this.pdfPicker.addEventListener('change', () => {
      const f = this.pdfPicker.files[0];
      this.pdfPicker.value = '';
      if (f) this.addPdf(f, this.center());
    });
    this.picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
    this.picker.addEventListener('change', () => {
      this.addImages([...this.picker.files], this.center());
      this.picker.value = '';
    });
    stage.append(this.vp, this.hint, this.offline, this.toolbar, this.subbar, this.zoombar, this.itembar, this.picker, this.pdfPicker);

    const on = (t, ev, fn, opt) => {
      t.addEventListener(ev, fn, opt);
      this.off.push(() => t.removeEventListener(ev, fn, opt));
    };
    on(this.vp, 'pointerdown', (e) => this.onDown(e));
    on(this.vp, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(this.vp, 'dblclick', (e) => this.onDouble(e));
    on(this.vp, 'contextmenu', (e) => this.onContext(e));
    on(this.vp, 'pointermove', (e) => this.onHover(e));
    on(this.vp, 'dragover', (e) => e.preventDefault());
    on(this.vp, 'drop', (e) => {
      e.preventDefault();
      const dropped = [...(e.dataTransfer?.files || [])];
      const files = dropped.filter((f) => f.type.startsWith('image/'));
      if (files.length) this.addImages(files, this.toWorld(e.clientX, e.clientY));
      else if (dropped[0]?.type === 'application/pdf') this.addPdf(dropped[0], this.toWorld(e.clientX, e.clientY));
    });
    on(document, 'keydown', (e) => this.onKey(e));
    on(document, 'keyup', (e) => {
      if (e.key === ' ' && this.spaceDown) {
        this.spaceDown = false;
        this.vp.classList.remove('hand');
      }
    });
    on(document, 'mouseup', () => this.tool === 'marker' && setTimeout(() => this.applyMarker(), 0));
    on(document, 'paste', (e) => this.onPaste(e));
    on(document, 'copy', (e) => this.onCopy(e, false));
    on(document, 'cut', (e) => this.onCopy(e, true));
    on(window, 'resize', () => this.placeBar());
    this.setTool('select');
  }

  unmount() {
    this.finishEdit();
    this.off.forEach((f) => f());
    this.off = [];
    this.saveView();
    this.stage?.replaceChildren();
    this.items.clear();
    this.els.clear();
    this.sel.clear();
    this.cursors.clear();
  }

  // ------------------------------------------------------------------ loading
  async open(section) {
    this.section = section;
    const { items } = await api('GET', `/api/sections/${section}/items`);
    this.world.replaceChildren();
    this.items.clear();
    this.els.clear();
    this.sel.clear();
    this.cursors.clear();
    for (const it of items) this.setItem(it);
    this.undo = [];
    this.redo = [];
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem('hub.view.' + section));
    } catch {}
    if (settings().autoFit && items.length) this.fit(false); // (Settings: always open fitted to the screen)
    else if (saved && Number.isFinite(saved.x)) {
      this.view = saved;
      // the remembered view shows none of the items (they were added far from it, for example by an import): frame them all
      const z = saved.z || 1;
      const x0 = -saved.x / z;
      const y0 = -saved.y / z;
      const x1 = x0 + (this.vp.clientWidth || innerWidth) / z;
      const y1 = y0 + (this.vp.clientHeight || innerHeight) / z;
      if (items.length && !items.some((it) => it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0)) this.fit(false);
    } else if (items.length) this.fit(false);
    else this.view = { x: this.vp.clientWidth / 2, y: this.vp.clientHeight / 2, z: 1 };
    this.applyView();
    this.refreshHint();
    this.vp.focus({ preventScroll: true });
  }
  saveView() {
    if (this.section) {
      try {
        localStorage.setItem('hub.view.' + this.section, JSON.stringify(this.view));
      } catch {}
    }
  }
  refreshHint() {
    this.hint.hidden = this.items.size > 0;
  }

  // after the connection came back: send what was written offline, then see what the others did
  async resync() {
    this.offline.hidden = true;
    const out = this.outbox.splice(0);
    if (out.length) S.live.send({ t: 'ops', section: this.section, ops: out });
    const keep = this.view;
    const sel = [...this.sel];
    await this.open(this.section);
    this.view = keep;
    this.applyView();
    this.select(sel.filter((id) => this.items.has(id)));
  }
  lost() {
    this.offline.hidden = false;
  }

  // ------------------------------------------------------------------ view: pan, zoom
  toWorld(cx, cy) {
    const r = this.vp.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.z, y: (cy - r.top - this.view.y) / this.view.z };
  }
  center() {
    const r = this.vp.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  applyView() {
    const { x, y, z } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    this.world.style.setProperty('--inv', String(1 / z));
    this.vp.style.backgroundSize = `${24 * z}px ${24 * z}px`;
    this.vp.style.backgroundPosition = `${x}px ${y}px`;
    this.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    this.placeBar();
  }
  zoomAt(cx, cy, f) {
    const r = this.vp.getBoundingClientRect();
    const z2 = clamp(this.view.z * f, 0.1, 4);
    const wx = (cx - r.left - this.view.x) / this.view.z;
    const wy = (cy - r.top - this.view.y) / this.view.z;
    this.view = { z: z2, x: cx - r.left - wx * z2, y: cy - r.top - wy * z2 };
    this.applyView();
  }
  zoomBy(f) {
    const r = this.vp.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
  }
  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)));
    else {
      const k = e.deltaMode ? 16 : 1;
      this.view.x -= e.deltaX * k;
      this.view.y -= e.deltaY * k;
      this.applyView();
    }
  }
  bounds(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids || this.items.keys()) {
      const it = this.items.get(id);
      if (!it) continue;
      const hh = this.els.get(id)?.offsetHeight || it.h;
      x0 = Math.min(x0, it.x);
      y0 = Math.min(y0, it.y);
      x1 = Math.max(x1, it.x + it.w);
      y1 = Math.max(y1, it.y + hh);
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }
  fit(glide = true) {
    const b = this.bounds();
    if (!b) return;
    this.frame(b, 70, 1, glide);
  }
  frame(b, pad, maxZ, glide) {
    const w = this.vp.clientWidth;
    const hh = this.vp.clientHeight;
    const z = clamp(Math.min((w - pad * 2) / Math.max(1, b.x1 - b.x0), (hh - pad * 2) / Math.max(1, b.y1 - b.y0)), 0.1, maxZ);
    this.view = { z, x: w / 2 - ((b.x0 + b.x1) / 2) * z, y: hh / 2 - ((b.y0 + b.y1) / 2) * z };
    if (glide) {
      this.world.classList.add('glide');
      setTimeout(() => this.world.classList.remove('glide'), 320);
    }
    this.applyView();
  }
  // from a reference in the chat: show the item, and light up the quoted words
  focus(id, quote) {
    const it = this.items.get(id);
    const el = this.els.get(id);
    if (!it || !el) {
      toast('That item is no longer on the board.', true);
      return false;
    }
    this.frame({ x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + (el.offsetHeight || it.h) }, 140, 1.2, true);
    this.select([id]);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    if (quote) setTimeout(() => !highlight(el.querySelector('.md') || el, quote) && toast('The quoted words have changed since.'), 340);
    return true;
  }

  // ------------------------------------------------------------------ tools
  setTool(t) {
    this.tool = t;
    this.vp.classList.remove('hand', 'place-note', 'place-text', 'tool-draw', 'tool-marker');
    if (t === 'hand') this.vp.classList.add('hand');
    if (t === 'note' || t === 'text') this.vp.classList.add('place-' + t);
    if (t === 'draw' || t === 'marker') this.vp.classList.add('tool-' + t);
    for (const [k, b] of Object.entries(this.toolButtons)) b.classList.toggle('on', k === t);
    this.drawSubbar();
  }
  // under the toolbar: the brush sizes of the Draw tool, the colours of the Marker
  drawSubbar() {
    const bar = this.subbar;
    bar.replaceChildren();
    bar.hidden = this.tool !== 'draw' && this.tool !== 'marker';
    if (this.tool === 'draw') {
      bar.append(h('span', { class: 'label' }, 'Brush'));
      for (const k of Object.keys(BRUSH)) bar.append(h('button', { class: 'brush' + (this.brush === k ? ' on' : ''), title: { S: 'Small', M: 'Medium', L: 'Large' }[k] + ' (' + k + ')', onclick: () => this.setBrush(k) }, h('i', { style: { width: BRUSH[k] + 3 + 'px', height: BRUSH[k] + 3 + 'px' } }), k));
    } else if (this.tool === 'marker') {
      bar.append(h('span', { class: 'label' }, 'Marker'));
      for (const [name, hex] of Object.entries(NOTE)) bar.append(h('button', { class: 'sw' + (this.markColor === name ? ' on' : ''), style: { '--c': hex }, title: name, onclick: () => ((this.markColor = name), this.drawSubbar()) }));
      bar.append(h('small', {}, 'Select words in a post-it or text. Click a marked word to remove it.'));
    }
  }
  setBrush(k) {
    this.brush = k;
    this.drawSubbar();
  }
  pickImages() {
    this.picker.click();
  }

  // ------------------------------------------------------------------ items: drawing them
  setItem(it) {
    this.items.set(it.id, it);
    this.paint(it);
    this.refreshHint();
  }
  removeItem(id) {
    this.els.get(id)?.remove();
    this.els.delete(id);
    this.items.delete(id);
    this.busy.delete(id);
    if (this.sel.delete(id)) this.selectionChanged();
    this.refreshHint();
  }
  paint(it) {
    let el = this.els.get(it.id);
    if (!el) {
      el = this.makeEl(it);
      this.els.set(it.id, el);
      this.world.append(el);
    }
    el.style.left = `${it.x}px`;
    el.style.top = `${it.y}px`;
    el.style.width = `${it.w}px`;
    el.style.height = it.type === 'text' ? 'auto' : `${it.h}px`;
    el.style.zIndex = String(it.type === 'group' ? it.z - 100000 : it.z); // (a group stays behind what is in it)
    const sig = JSON.stringify(it.data) + '|' + it.author;
    if (el._sig !== sig) {
      el._sig = sig;
      this.fill(el, it);
    }
  }
  makeEl(it) {
    const el = h('div', { class: `item ${it.type}`, dataset: { id: it.id } });
    if (it.type === 'note') el.append(h('div', { class: 'grip' }, h('span', { class: 'by' }), h('span', {}, '⠇')), h('div', { class: 'md', 'data-quotable': '' }));
    else if (it.type === 'text') el.append(h('div', { class: 'grip' }), h('div', { class: 'md', 'data-quotable': '' }));
    else if (it.type === 'group') el.append(h('span', { class: 'gtitle' }));
    else if (it.type === 'draw') {
      const svg = document.createElementNS(SVG, 'svg');
      svg.append(document.createElementNS(SVG, 'path'));
      el.append(svg);
    } else if (it.type === 'doc') el.append(h('span', { class: 'dicon' }), h('span', { class: 'dbody' }, h('b', {}), h('small', {})));
    else el.append(h('img', { alt: '', draggable: 'false' }));
    return el;
  }
  fill(el, it) {
    const who = it.author ? user(it.author).name : '';
    if (it.type === 'group') {
      el.style.setProperty('--note', NOTE[it.data.color] || NOTE.blue);
      el.querySelector('.gtitle').textContent = it.data.title || '';
      return;
    }
    if (it.type === 'draw') {
      const svg = el.querySelector('svg');
      svg.setAttribute('viewBox', '0 0 ' + it.w + ' ' + it.h);
      const pts = it.data.pts || [];
      const path = svg.querySelector('path');
      path.setAttribute('d', pts.length === 1 ? 'M' + pts[0][0] + ' ' + pts[0][1] + 'l0.01 0' : 'M' + pts.map((p) => p[0] + ' ' + p[1]).join('L'));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', it.data.color || '#000');
      path.setAttribute('stroke-width', String(it.data.size || 5));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      return;
    }
    if (it.type === 'doc') {
      const sec = sectionById(it.data.section);
      const pdf = (sec?.kind || it.data.kind) === 'pdf';
      el.classList.toggle('gone', !sec);
      el.classList.toggle('pdf', pdf);
      el.querySelector('.dicon').textContent = pdf ? 'PDF' : '\u270e';
      el.querySelector('b').textContent = sec?.name || it.data.name || (pdf ? 'PDF' : 'Note');
      el.querySelector('small').textContent = sec ? (pdf ? 'PDF · double-click to open' : 'Note · double-click to write') : 'Removed';
      el.title = pdf ? 'A PDF: double-click to open it' : 'A note: double-click to open the editor';
      return;
    }
    if (it.type === 'image') {
      const img = el.querySelector('img');
      img.src = imageUrl(it.data.img);
      img.alt = it.data.name || '';
      el.title = it.data.name || '';
      return;
    }
    if (it.type === 'note') {
      el.style.setProperty('--note', NOTE[LEGACY[it.data.color] || it.data.color] || NOTE.yellow);
      el.querySelector('.by').textContent = who;
    } else el.querySelector('.grip').textContent = who;
    renderInto(el.querySelector('.md'), it.data.text, (next) => this.patchData(it.id, { text: next }));
  }
  refreshDocs() {
    for (const it of this.items.values()) if (it.type === 'doc') this.fill(this.els.get(it.id), it);
  }
  wire(it) {
    const el = this.els.get(it.id);
    return { id: it.id, type: it.type, x: round(it.x), y: round(it.y), w: round(it.w), h: round(it.type === 'text' && el ? el.offsetHeight : it.h), z: it.z, data: it.data };
  }
  topZ() {
    let z = 0;
    for (const it of this.items.values()) z = Math.max(z, it.z);
    return z;
  }
  bottomZ() {
    let z = 0;
    for (const it of this.items.values()) z = Math.min(z, it.z);
    return z;
  }

  // ------------------------------------------------------------------ items: changing them
  send(ops, live) {
    if (S.live?.open) S.live.send({ t: 'ops', section: this.section, ops, live: !!live });
    else if (!live) {
      this.outbox.push(...ops);
      this.lost();
    }
  }
  // changes: [{ before, after }] (a whole item, or null for "not there")
  commit(changes, record = true) {
    changes = changes.concat(this.groupChanges(changes));
    this.send(changes.map((c) => (c.after ? { op: 'put', item: this.wire(c.after), restore: !c.before } : { op: 'del', id: c.before.id })));
    if (record) {
      this.undo.push(changes);
      if (this.undo.length > 100) this.undo.shift();
      this.redo = [];
    }
  }
  // ---- groups: a frame that always fits around its members
  // the frame around some items: { x, y, w, h }, or null if none of them is on the board
  frameFor(ids, title) {
    const b = this.bounds(ids.filter((i) => this.items.has(i)));
    if (!b) return null;
    const top = PAD + (title ? 16 : 0);
    return { x: round(b.x0 - PAD), y: round(b.y0 - top), w: round(b.x1 - b.x0 + PAD * 2), h: round(b.y1 - b.y0 + top + PAD) };
  }
  // the groups that have to change because some of their members did: the new frame (or none, when nothing is left)
  groupChanges(changes) {
    const touched = new Set();
    const direct = new Set();
    for (const c of changes) {
      for (const it of [c.before, c.after]) {
        if (!it) continue;
        (it.type === 'group' ? direct : touched).add(it.id);
      }
    }
    const out = [];
    for (const g of [...this.items.values()]) {
      if (g.type !== 'group' || direct.has(g.id) || !g.data.members.some((m) => touched.has(m))) continue;
      const members = g.data.members.filter((m) => this.items.has(m));
      if (!members.length) {
        this.removeItem(g.id);
        out.push({ before: this.copyOf(g), after: null });
        continue;
      }
      const f = this.frameFor(members, g.data.title);
      const after = { ...g, ...f, data: { ...g.data, members } };
      if (after.x === g.x && after.y === g.y && after.w === g.w && after.h === g.h && members.length === g.data.members.length) continue;
      this.setItem(after);
      out.push({ before: this.copyOf(g), after: this.copyOf(after) });
    }
    return out;
  }
  // while something is being moved or resized: the groups around it follow at once (the new frames are returned, to send)
  liveGroups(ids) {
    const moving = new Set(ids);
    const out = [];
    for (const g of this.items.values()) {
      if (g.type !== 'group' || moving.has(g.id) || !g.data.members.some((m) => moving.has(m))) continue;
      const f = this.frameFor(g.data.members, g.data.title);
      if (!f) continue;
      Object.assign(g, f);
      this.paint(g);
      out.push(g.id);
    }
    return out;
  }
  groupSelected() {
    const members = [...this.sel].filter((id) => this.items.get(id) && this.items.get(id).type !== 'group');
    if (!members.length) return toast('Select some items first.');
    const f = this.frameFor(members, '');
    const g = { id: newId(), type: 'group', ...f, z: this.topZ() + 1, data: { members, title: '', color: 'blue' }, author: S.me.email };
    this.setItem(g);
    this.commit([{ before: null, after: this.copyOf(g) }]);
    this.select([g.id]);
  }
  setGroup(id, patch) {
    const g = this.items.get(id);
    if (!g) return;
    const before = this.copyOf(g);
    const data = { ...g.data, ...patch };
    const after = { ...g, data, ...(patch.title !== undefined ? this.frameFor(data.members, data.title) : {}) };
    this.setItem(after);
    this.commit([{ before, after: this.copyOf(after) }]);
    this.renderBar();
  }
  async renameGroup(id) {
    const g = this.items.get(id);
    if (!g) return;
    const title = await promptBox('Name the group', 'Name (empty for none)', g.data.title || '');
    if (title !== null) this.setGroup(id, { title });
  }
  copyOf(it) {
    return { ...it, data: { ...it.data } };
  }
  patchData(id, patch) {
    const it = this.items.get(id);
    if (!it) return;
    const before = this.copyOf(it);
    const after = { ...it, data: { ...it.data, ...patch } };
    this.setItem(after);
    this.commit([{ before, after: this.copyOf(after) }]);
  }
  step(dir) {
    const from = dir < 0 ? this.undo : this.redo;
    const to = dir < 0 ? this.redo : this.undo;
    const ch = from.pop();
    if (!ch) return;
    to.push(ch);
    const ops = [];
    for (const c of dir < 0 ? [...ch].reverse() : ch) {
      const target = dir < 0 ? c.before : c.after;
      const other = dir < 0 ? c.after : c.before;
      if (target) {
        this.setItem(this.copyOf(target));
        ops.push({ op: 'put', item: this.wire(target), restore: true });
      } else if (other) {
        this.removeItem(other.id);
        ops.push({ op: 'del', id: other.id });
      }
    }
    this.send(ops);
    this.selectionChanged();
  }
  deleteSelected() {
    const ch = [...this.sel].map((id) => this.items.get(id)).filter(Boolean).map((it) => ({ before: this.copyOf(it), after: null }));
    if (!ch.length) return;
    ch.forEach((c) => this.removeItem(c.before.id));
    this.commit(ch);
  }
  duplicateSelected() {
    const ch = [];
    const ids = [];
    let z = this.topZ();
    const map = new Map();
    const copies = [];
    for (const id of this.sel) {
      const it = this.items.get(id);
      if (!it) continue;
      const copy = { ...this.copyOf(it), id: newId(), x: it.x + 28, y: it.y + 28, z: ++z, author: S.me.email };
      map.set(id, copy.id);
      copies.push(copy);
    }
    for (const c of this.settleCopies(copies, map)) {
      ids.push(c.id);
      ch.push({ before: null, after: this.copyOf(c) });
    }
    if (ch.length) {
      this.commit(ch);
      this.select(ids);
    }
  }
  // puts copies on the board: a copied group is about the copies of its members (and is dropped if none were copied)
  settleCopies(copies, map) {
    const keep = copies.filter((c) => c.type !== 'group' || c.data.members.some((m) => map.has(m)));
    for (const c of keep) if (c.type !== 'group') this.setItem(c);
    for (const c of keep) {
      if (c.type !== 'group') continue;
      c.data = { ...c.data, members: c.data.members.map((m) => map.get(m)).filter(Boolean) };
      Object.assign(c, this.frameFor(c.data.members, c.data.title));
      this.setItem(c);
    }
    return keep;
  }
  reorder(front) {
    const ch = [];
    let z = front ? this.topZ() : this.bottomZ();
    for (const id of [...this.sel].sort((a, b) => this.items.get(a).z - this.items.get(b).z)) {
      const it = this.items.get(id);
      const before = this.copyOf(it);
      z += front ? 1 : -1;
      const after = { ...it, z };
      this.setItem(after);
      ch.push({ before, after: this.copyOf(after) });
    }
    if (ch.length) this.commit(ch);
  }
  setColor(color) {
    this.lastColor = color;
    const ch = [];
    for (const id of this.sel) {
      const it = this.items.get(id);
      if (it?.type !== 'note' || it.data.color === color) continue;
      const before = this.copyOf(it);
      const after = { ...it, data: { ...it.data, color } };
      this.setItem(after);
      ch.push({ before, after: this.copyOf(after) });
    }
    if (ch.length) {
      this.commit(ch);
      this.renderBar();
    }
  }
  nudge(dx, dy) {
    const ch = [];
    for (const id of this.sel) {
      const it = this.items.get(id);
      if (!it) continue;
      const before = this.copyOf(it);
      const after = { ...it, x: it.x + dx, y: it.y + dy };
      this.setItem(after);
      ch.push({ before, after: this.copyOf(after) });
    }
    if (ch.length) {
      this.commit(ch);
      this.placeBar();
    }
  }

  // ------------------------------------------------------------------ adding things
  place(type, p) {
    const note = type === 'note';
    const it = { id: newId(), type, x: round(p.x - (note ? 110 : 0)), y: round(p.y - (note ? 14 : 0)), w: note ? 220 : 320, h: note ? 180 : 40, z: this.topZ() + 1, data: note ? { text: '', color: this.lastColor } : { text: '' }, author: S.me.email };
    this.setItem(it);
    this.setTool('select');
    this.select([it.id]);
    // the mouse press that placed it would otherwise move focus off the new editor and close it again
    window.addEventListener('mousedown', (ev) => ev.preventDefault(), { once: true, capture: true });
    this.startEdit(it.id, true);
  }
  // the board whose subsection a new Note or PDF becomes (a branch page's own board is its main one)
  mainBoard() {
    const s = sectionById(this.section);
    return s?.parent || this.section;
  }
  // the branch a new note or PDF belongs to: this page's, else the one chosen at the top of the menu
  madeOn() {
    return sectionById(this.section)?.branch || S.branchView || '';
  }
  // a card for a Note or PDF subsection, put on the board
  putDoc(section, kind, name, at) {
    const it = { id: newId(), type: 'doc', x: round(at.x - 100), y: round(at.y - 30), w: 200, h: 64, z: this.topZ() + 1, data: { section, kind, name }, author: S.me.email };
    this.setItem(it);
    this.commit([{ before: null, after: this.copyOf(it) }]);
    this.select([it.id]);
  }
  // a note or PDF on a branch needs that branch's page under this section first
  branchReady() {
    const br = this.madeOn();
    if (br && !S.sections.some((c) => c.parent === this.mainBoard() && c.kind === 'board' && c.branch === br)) {
      toast('Make the page for ' + br + ' under this section first (+ Branch in the menu).', true);
      return false;
    }
    return true;
  }
  async newNote(at) {
    if (!this.branchReady()) return;
    const name = await promptBox('New note', 'Name', '', 'Create');
    if (!name) return;
    try {
      const r = await api('POST', '/api/sections', { parent: this.mainBoard(), kind: 'note', name, branch: this.madeOn() });
      this.putDoc(r.id, 'note', name, at);
      toast('The note is a subsection of this board now. Double-click its card to write in it.');
    } catch (e) {
      toast(e.message, true);
    }
  }
  async addPdf(file, at) {
    if (!this.branchReady()) return;
    try {
      toast('Uploading ' + (file.name || 'the PDF') + '…');
      const up = await uploadPdf(file);
      const name = (up.name || 'PDF').replace(/\.pdf$/i, '').slice(0, 60) || 'PDF';
      const r = await api('POST', '/api/sections', { parent: this.mainBoard(), kind: 'pdf', name, file: up.id, branch: this.madeOn() });
      this.putDoc(r.id, 'pdf', name, at);
    } catch (e) {
      toast(e.message, true);
    }
  }
  // Draw: press and drag to draw a line in black; one item per line
  startDraw(e) {
    e.preventDefault();
    const size = BRUSH[this.brush];
    const min = 1.5 / Math.max(this.view.z, 0.5);
    const pts = [this.toWorld(e.clientX, e.clientY)];
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'draw-live');
    svg.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none';
    const path = document.createElementNS(SVG, 'path');
    for (const [k, v] of Object.entries({ fill: 'none', stroke: '#000', 'stroke-width': size, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, String(v));
    svg.append(path);
    this.world.append(svg);
    const paint = () => path.setAttribute('d', pts.length === 1 ? 'M' + pts[0].x + ' ' + pts[0].y + 'l0.01 0' : 'M' + pts.map((p) => p.x + ' ' + p.y).join('L'));
    paint();
    this.drag(
      e,
      (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        const last = pts[pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < min || pts.length >= 3000) return;
        pts.push(p);
        paint();
      },
      () => {
        svg.remove();
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const pad = size / 2 + 2;
        const x = Math.min(...xs) - pad;
        const y = Math.min(...ys) - pad;
        const w = Math.max(24, Math.max(...xs) + pad - x);
        const hh = Math.max(16, Math.max(...ys) + pad - y);
        const it = { id: newId(), type: 'draw', x: round(x), y: round(y), w: round(w), h: round(hh), z: this.topZ() + 1, data: { pts: pts.map((p) => [round(p.x - x), round(p.y - y)]), size, color: '#000000' }, author: S.me.email };
        this.setItem(it);
        this.commit([{ before: null, after: this.copyOf(it) }]);
      },
    );
  }
  // Marker: words selected in a post-it or text get a coloured highlight (<mark class="hl-colour"> in its markdown)
  applyMarker() {
    if (this.tool !== 'marker' || !this.vp?.isConnected) return;
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const md = (node.nodeType === 1 ? node : node.parentElement)?.closest('.item .md');
    const itemEl = md?.closest('.item');
    const it = itemEl && this.items.get(itemEl.dataset.id);
    if (!it || (it.type !== 'note' && it.type !== 'text')) return;
    const src = it.data.text || '';
    // clicked (no selection) on a marked word: take the mark off, or give it the colour now chosen
    if (sel.isCollapsed) {
      const mk = (node.nodeType === 1 ? node : node.parentElement)?.closest('mark');
      if (!mk || !md.contains(mk)) return;
      const n = [...md.querySelectorAll('mark')].indexOf(mk);
      let i = -1;
      const next = src.replace(/<mark class="hl-[a-z]+">([\s\S]*?)<\/mark>/g, (m, inner) => (++i === n ? (mk.className === 'hl-' + this.markColor ? inner : '<mark class="hl-' + this.markColor + '">' + inner + '</mark>') : m));
      if (next !== src) this.patchData(it.id, { text: next });
      return;
    }
    const text = sel.toString().trim();
    if (!text) return;
    if (/\n/.test(text)) return toast('Mark words in one line at a time.');
    // which of the places this text occurs in the rendered words it is: the same one in the markdown
    const pre = document.createRange();
    pre.selectNodeContents(md);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString().length;
    const shown = md.textContent;
    let k = 0;
    for (let i = shown.indexOf(text); i >= 0 && i < before; i = shown.indexOf(text, i + 1)) k++;
    let at = -1;
    for (let i = 0, found = src.indexOf(text); found >= 0; found = src.indexOf(text, found + 1), i++) {
      if (i === k) {
        at = found;
        break;
      }
    }
    sel.removeAllRanges();
    if (at < 0) return toast('Select plain words (the formatting characters get in the way).');
    this.patchData(it.id, { text: src.slice(0, at) + '<mark class="hl-' + this.markColor + '">' + text + '</mark>' + src.slice(at + text.length) });
  }
  async addImages(files, at) {
    for (const f of files) {
      try {
        toast(`Uploading ${f.name || 'image'}…`);
        const up = await uploadImage(f);
        const k = Math.min(1, 480 / up.w);
        const it = { id: newId(), type: 'image', x: round(at.x), y: round(at.y), w: Math.round(up.w * k), h: Math.round(up.h * k), z: this.topZ() + 1, data: { img: up.id, name: up.name }, author: S.me.email };
        this.setItem(it);
        this.commit([{ before: null, after: this.copyOf(it) }]);
        this.select([it.id]);
        at = { x: at.x + 32, y: at.y + 32 };
      } catch (e) {
        toast(e.message, true);
      }
    }
  }
  // Ctrl+C / Ctrl+X: the selected items go on the clipboard (as JSON for pasting here or in another section or tab,
  // and as plain text for anywhere else). Cut also deletes them. Words you have highlighted are copied as usual.
  onCopy(e, cut) {
    if (typing() || !this.vp?.isConnected || document.querySelector('.overlay, .lightbox') || !this.sel.size) return;
    if (!getSelection()?.isCollapsed) return;
    const items = [...this.sel].map((id) => this.items.get(id)).filter(Boolean).sort((a, b) => a.z - b.z);
    if (!items.length) return;
    e.preventDefault();
    e.clipboardData.setData('application/x-viti-items', JSON.stringify({ v: 1, items: items.map((it) => this.copyOf(it)) }));
    e.clipboardData.setData('text/plain', items.map((it) => (it.type === 'image' ? it.data.name || 'image' : it.data.text || '')).join('\n\n'));
    if (cut) this.deleteSelected();
    else toast(items.length === 1 ? 'Copied.' : `Copied ${items.length} items.`);
  }
  pasteItems(raw) {
    let list;
    try {
      list = JSON.parse(raw).items;
    } catch {
      return false;
    }
    if (!Array.isArray(list) || !list.length) return false;
    const x0 = Math.min(...list.map((i) => i.x));
    const y0 = Math.min(...list.map((i) => i.y));
    const x1 = Math.max(...list.map((i) => i.x + i.w));
    const y1 = Math.max(...list.map((i) => i.y + i.h));
    const to = this.pointer && this.vp.matches(':hover') ? this.pointer : this.center(); // where the mouse is, else the middle of the view
    let z = this.topZ();
    const ch = [];
    const ids = [];
    const map = new Map();
    const copies = [];
    for (const it of list) {
      const copy = { id: newId(), type: it.type, x: round(it.x - x0 + to.x - (x1 - x0) / 2), y: round(it.y - y0 + to.y - (y1 - y0) / 2), w: it.w, h: it.h, z: ++z, data: { ...it.data }, author: S.me.email };
      map.set(it.id, copy.id);
      copies.push(copy);
    }
    for (const c of this.settleCopies(copies, map)) {
      ids.push(c.id);
      ch.push({ before: null, after: this.copyOf(c) });
    }
    this.commit(ch);
    this.select(ids);
    return true;
  }
  onPaste(e) {
    if (typing() || !this.vp.isConnected || document.querySelector('.overlay')) return;
    const mine = e.clipboardData?.getData('application/x-viti-items');
    if (mine && this.pasteItems(mine)) return e.preventDefault();
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      this.addImages(files, this.center());
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text?.trim()) {
      e.preventDefault();
      const c = this.center();
      const it = { id: newId(), type: 'text', x: round(c.x - 160), y: round(c.y - 40), w: 320, h: 40, z: this.topZ() + 1, data: { text: text.slice(0, 20000) }, author: S.me.email };
      this.setItem(it);
      this.commit([{ before: null, after: this.copyOf(it) }]);
      this.select([it.id]);
    }
  }

  // ------------------------------------------------------------------ editing text
  startEdit(id, isNew = false) {
    const it = this.items.get(id);
    if (!it || (it.type !== 'note' && it.type !== 'text')) return;
    this.finishEdit();
    const el = this.els.get(id);
    const md = el.querySelector('.md');
    const ta = h('textarea', { class: 'editor', placeholder: 'Write markdown…', spellcheck: 'false' });
    ta.value = it.data.text || '';
    const fit = () => {
      if (it.type !== 'text') return;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(60, ta.scrollHeight + 2)}px`;
    };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        this.finishEdit();
        this.vp.focus({ preventScroll: true });
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => this.editing?.ta === ta && this.finishEdit(), 0));
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    md.hidden = true;
    el.append(ta);
    this.editing = { id, ta, isNew, before: this.copyOf(it) };
    this.busy.add(id);
    this.renderBar();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    fit();
  }
  finishEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const it = this.items.get(ed.id);
    const el = this.els.get(ed.id);
    const text = ed.ta.value;
    ed.ta.remove();
    this.busy.delete(ed.id);
    if (el) el.querySelector('.md').hidden = false;
    if (!it) return;
    if (ed.isNew && !text.trim()) {
      this.removeItem(ed.id);
      return;
    }
    if (ed.isNew || text !== (ed.before.data.text || '')) {
      const after = { ...it, data: { ...it.data, text } };
      this.setItem(after);
      this.commit([{ before: ed.isNew ? null : ed.before, after: this.copyOf(after) }]);
    }
    this.renderBar();
  }

  // ------------------------------------------------------------------ selecting
  select(ids) {
    this.sel = new Set(ids);
    this.selectionChanged();
  }
  selectionChanged() {
    for (const [id, el] of this.els) {
      const on = this.sel.has(id);
      el.classList.toggle('selected', on);
      el.querySelectorAll('.handle').forEach((x) => x.remove());
      if (on && this.sel.size === 1) {
        const it = this.items.get(id);
        const dirs = it.type === 'group' || it.type === 'draw' || it.type === 'doc' ? [] : it.type === 'text' ? ['w', 'e'] : it.type === 'image' ? ['nw', 'ne', 'sw', 'se'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        for (const d of dirs) el.append(h('div', { class: `handle ${d}`, dataset: { d } }));
      }
    }
    this.renderBar();
  }
  toggleSel(id) {
    const s = new Set(this.sel);
    if (!s.delete(id)) s.add(id);
    this.select([...s]);
  }

  // ------------------------------------------------------------------ the bar over a selection
  renderBar() {
    const bar = this.itembar;
    bar.replaceChildren();
    const items = [...this.sel].map((id) => this.items.get(id)).filter(Boolean);
    if (!items.length || this.editing) {
      bar.hidden = true;
      return;
    }
    const btn = (label, fn, cls = '', title = '') => h('button', { class: cls, title, onclick: fn }, label);
    if (items.every((i) => i.type === 'note')) {
      const cur = items.length === 1 ? LEGACY[items[0].data.color] || items[0].data.color : null;
      for (const [name, hex] of Object.entries(NOTE)) bar.append(h('button', { class: 'sw' + (cur === name ? ' on' : ''), style: { '--c': hex }, title: name, onclick: () => this.setColor(name) }));
      bar.append(h('span', { class: 'sep' }));
    }
    if (items.length === 1 && items[0].type === 'group') {
      const g = items[0];
      for (const [name, hex] of Object.entries(NOTE)) bar.append(h('button', { class: 'sw' + (g.data.color === name ? ' on' : ''), style: { '--c': hex }, title: name, onclick: () => this.setGroup(g.id, { color: name }) }));
      bar.append(h('span', { class: 'sep' }), btn('Name', () => this.renameGroup(g.id), '', 'Give the group a name'));
    } else if (items.every((i) => i.type !== 'group') && items.length > 0) bar.append(btn('Group', () => this.groupSelected(), '', 'A frame around these that always fits them (Ctrl+G)'));
    if (items.length === 1) {
      const it = items[0];
      if (it.type !== 'draw' && it.type !== 'group') bar.append(btn('Reference', () => this.onReference(it), '', 'Point at this in the chat'));
      if (it.type === 'image') bar.append(btn('Open', () => lightbox(imageUrl(it.data.img))));
      else if (it.type === 'doc') bar.append(btn('Open', () => this.onOpen?.(it.data.section)));
      else if (it.type === 'note' || it.type === 'text') bar.append(btn('Edit', () => this.startEdit(it.id)));
    }
    if (items.length !== 1 || items[0].type !== 'group') bar.append(btn('Duplicate', () => this.duplicateSelected()), btn('Front', () => this.reorder(true)), btn('Back', () => this.reorder(false)));
    bar.append(btn(items.length === 1 && items[0].type === 'group' ? 'Ungroup' : 'Delete', () => this.deleteSelected(), 'danger'));
    bar.hidden = false;
    this.placeBar();
  }
  placeBar() {
    const bar = this.itembar;
    if (bar.hidden) return;
    const b = this.bounds([...this.sel]);
    if (!b) return;
    const { x, y, z } = this.view;
    const left = x + b.x0 * z;
    // a text item's name tag hangs 22px above it (a post-it's is inside), so the bar goes above the tag
    const tagTop = Math.min(...[...this.sel].map((id) => this.items.get(id)).filter(Boolean).map((it) => it.y - (it.type === 'text' ? 22 : 0)));
    const top = y + Math.min(b.y0, tagTop) * z;
    const bottom = y + b.y1 * z;
    const w = bar.offsetWidth;
    bar.style.left = `${clamp(left + ((b.x1 - b.x0) * z) / 2 - w / 2, 8, this.vp.clientWidth - w - 8)}px`;
    bar.style.top = `${top - 46 < 6 ? Math.min(bottom + 10, this.vp.clientHeight - 44) : top - 46}px`;
  }

  // ------------------------------------------------------------------ the pointer
  onDown(e) {
    if (this.editing && !e.target.closest('.editor')) this.finishEdit();
    const t = e.target;
    if (e.button === 1 || this.spaceDown || this.tool === 'hand' || (e.shiftKey && e.button === 0)) return this.startPan(e);
    if (e.button !== 0) return;
    if (this.tool === 'draw' && !t.closest('.handle, .itembar')) return this.startDraw(e);
    if (this.tool === 'marker' && t.closest('.item .md')) return; // (the words are selected the usual way; applyMarker does the rest)
    const handle = t.closest('.handle');
    if (handle) return this.startResize(e, handle.dataset.d);
    const itemEl = t.closest('.item');
    if (itemEl && !t.closest('.editor')) {
      if (t.closest('a, input')) return;
      const id = itemEl.dataset.id;
      const was = this.sel.has(id);
      if (e.shiftKey) return this.toggleSel(id);
      if (!was) this.select([id]);
      // an item that is already picked lets you select its words (to quote them); its edge and top move it
      if (was && this.sel.size === 1 && t.closest('.md') && !t.closest('.grip')) return;
      return this.startMove(e);
    }
    if (t.closest('.editor')) return;
    if (this.tool === 'note' || this.tool === 'text') return this.place(this.tool, this.toWorld(e.clientX, e.clientY));
    if (!e.shiftKey) this.select([]);
    this.startMarquee(e);
  }
  drag(e, move, up) {
    const mv = (ev) => move(ev);
    const end = (ev) => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      up?.(ev);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  startPan(e) {
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
    this.vp.classList.add('panning');
    this.drag(
      e,
      (ev) => {
        this.view.x = from.vx + ev.clientX - from.x;
        this.view.y = from.vy + ev.clientY - from.y;
        this.applyView();
      },
      () => this.vp.classList.remove('panning'),
    );
  }
  startMove(e) {
    // (a group takes its members with it)
    const ids = [...new Set([...this.sel].flatMap((id) => [id, ...(this.items.get(id)?.type === 'group' ? this.items.get(id).data.members.filter((m) => this.items.has(m)) : [])]))];
    const start = this.toWorld(e.clientX, e.clientY);
    const orig = new Map(ids.map((id) => [id, this.copyOf(this.items.get(id))]));
    let moved = false;
    let last = 0;
    ids.forEach((id) => this.busy.add(id));
    this.drag(
      e,
      (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        if (!moved && Math.hypot(dx, dy) * this.view.z < 3) return;
        if (!moved) ids.forEach((id) => this.els.get(id)?.classList.add('dragging'));
        moved = true;
        for (const id of ids) {
          const o = orig.get(id);
          const it = this.items.get(id);
          if (!it) continue;
          it.x = o.x + dx;
          it.y = o.y + dy;
          this.paint(it);
        }
        const gs = this.liveGroups(ids);
        this.placeBar();
        if (performance.now() - last > 60) {
          last = performance.now();
          this.send([...ids, ...gs].filter((id) => this.items.has(id)).map((id) => ({ op: 'put', item: this.wire(this.items.get(id)) })), true);
        }
      },
      () => {
        ids.forEach((id) => {
          this.busy.delete(id);
          this.els.get(id)?.classList.remove('dragging');
        });
        if (!moved) return;
        const ch = ids.filter((id) => this.items.has(id)).map((id) => ({ before: orig.get(id), after: this.copyOf(this.items.get(id)) }));
        this.commit(ch);
      },
    );
  }
  startResize(e, dir) {
    const id = [...this.sel][0];
    const it = this.items.get(id);
    const el = this.els.get(id);
    if (!it) return;
    const o = this.copyOf(it);
    if (it.type === 'text') o.h = el.offsetHeight;
    const start = this.toWorld(e.clientX, e.clientY);
    let last = 0;
    let moved = false;
    this.busy.add(id);
    e.preventDefault();
    this.drag(
      e,
      (ev) => {
        const p = this.toWorld(ev.clientX, ev.clientY);
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        let { x, y, w, h: hh } = o;
        if (dir.includes('e')) w = o.w + dx;
        if (dir.includes('w')) w = o.w - dx;
        if (dir.includes('s')) hh = o.h + dy;
        if (dir.includes('n')) hh = o.h - dy;
        w = Math.max(it.type === 'text' ? 80 : 60, w);
        hh = Math.max(it.type === 'note' ? 70 : 30, hh);
        if (it.type === 'image' && !ev.altKey) {
          const s = Math.abs(w / o.w - 1) > Math.abs(hh / o.h - 1) ? w / o.w : hh / o.h;
          w = Math.max(40, o.w * s);
          hh = Math.max(30, o.h * s);
        }
        if (dir.includes('w')) x = o.x + o.w - w;
        if (dir.includes('n')) y = o.y + o.h - hh;
        Object.assign(it, { x, y, w, h: it.type === 'text' ? o.h : hh });
        moved = true;
        this.paint(it);
        const gs = this.liveGroups([id]);
        this.placeBar();
        if (performance.now() - last > 60) {
          last = performance.now();
          this.send([id, ...gs].map((x) => ({ op: 'put', item: this.wire(this.items.get(x)) })), true);
        }
      },
      () => {
        this.busy.delete(id);
        if (moved) this.commit([{ before: o, after: this.copyOf(it) }]);
      },
    );
  }
  startMarquee(e) {
    const r = this.vp.getBoundingClientRect();
    const x0 = e.clientX - r.left;
    const y0 = e.clientY - r.top;
    const base = e.shiftKey ? new Set(this.sel) : new Set();
    this.drag(e, (ev) => {
      const x1 = ev.clientX - r.left;
      const y1 = ev.clientY - r.top;
      const l = Math.min(x0, x1);
      const t = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const hh = Math.abs(y1 - y0);
      if (w < 4 && hh < 4) return;
      Object.assign(this.marquee.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${hh}px` });
      this.marquee.hidden = false;
      const a = { x: (l - this.view.x) / this.view.z, y: (t - this.view.y) / this.view.z, x2: (l + w - this.view.x) / this.view.z, y2: (t + hh - this.view.y) / this.view.z };
      const hit = new Set(base);
      for (const [id, it] of this.items) {
        const ih = this.els.get(id)?.offsetHeight || it.h;
        if (it.x < a.x2 && it.x + it.w > a.x && it.y < a.y2 && it.y + ih > a.y) hit.add(id);
      }
      this.select([...hit]);
    }, () => (this.marquee.hidden = true));
  }
  onDouble(e) {
    const itemEl = e.target.closest('.item');
    if (itemEl) {
      const it = this.items.get(itemEl.dataset.id);
      if (it?.type === 'image') lightbox(imageUrl(it.data.img));
      else if (it?.type === 'doc') this.onOpen?.(it.data.section);
      else if (it?.type === 'group') this.renameGroup(it.id);
      else if (it && !e.target.closest('input, a')) this.startEdit(it.id);
      return;
    }
    if (e.target.closest('.viewport')) this.place('text', this.toWorld(e.clientX, e.clientY));
  }
  onContext(e) {
    e.preventDefault();
    const itemEl = e.target.closest('.item');
    const p = this.toWorld(e.clientX, e.clientY);
    if (itemEl) {
      if (!this.sel.has(itemEl.dataset.id)) this.select([itemEl.dataset.id]);
      const it = this.items.get(itemEl.dataset.id);
      menu(e.clientX, e.clientY, [
        ...(it.type === 'image' ? [{ label: 'Open', fn: () => lightbox(imageUrl(it.data.img)) }] : it.type === 'doc' ? [{ label: 'Open', fn: () => this.onOpen?.(it.data.section) }] : it.type === 'group' ? [{ label: 'Name the group', fn: () => this.renameGroup(it.id) }] : it.type === 'draw' ? [] : [{ label: 'Edit', fn: () => setTimeout(() => this.startEdit(it.id), 0) }]),
        ...(this.sel.size && [...this.sel].every((id) => this.items.get(id)?.type !== 'group') ? [{ label: 'Group the selected', fn: () => this.groupSelected() }] : []),
        ...(it.type === 'draw' || it.type === 'group' ? [] : [{ label: 'Reference in chat', fn: () => this.onReference(it) }]),
        ...(it.type === 'group' ? [] : [{ label: 'Duplicate', fn: () => this.duplicateSelected() }, { label: 'Bring to front', fn: () => this.reorder(true) }, { label: 'Send to back', fn: () => this.reorder(false) }]),
        { label: it.type === 'group' ? 'Ungroup' : 'Delete', fn: () => this.deleteSelected(), danger: true },
      ]);
    } else {
      menu(e.clientX, e.clientY, [
        { label: 'New post-it here', fn: () => this.place('note', p) },
        { label: 'New text here', fn: () => this.place('text', p) },
        { label: 'Add image…', fn: () => this.pickImages() },
        { label: 'New note here…', fn: () => this.newNote(p) },
        { label: 'Add a PDF…', fn: () => this.pdfPicker.click() },
        { label: 'Fit everything', fn: () => this.fit() },
      ]);
    }
  }
  onHover(e) {
    const now = performance.now();
    if (now - (this.lastCursor || 0) < 80) return;
    this.lastCursor = now;
    const p = this.toWorld(e.clientX, e.clientY);
    this.pointer = p;
    S.live?.send({ t: 'cursor', section: this.section, x: round(p.x), y: round(p.y) });
  }

  // ------------------------------------------------------------------ the keyboard
  onKey(e) {
    if (typing() || !this.vp?.isConnected || document.querySelector('.overlay, .lightbox')) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.vp.classList.add('hand');
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod) {
      if (k === 'z') {
        e.preventDefault();
        this.step(e.shiftKey ? 1 : -1);
      } else if (k === 'y') {
        e.preventDefault();
        this.step(1);
      } else if (k === 'd') {
        e.preventDefault();
        this.duplicateSelected();
      } else if (k === 'a') {
        e.preventDefault();
        this.select([...this.items.keys()]);
      } else if (k === 'g') {
        e.preventDefault();
        this.groupSelected();
      }
      return;
    }
    const big = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return this.deleteSelected();
      case 'Escape':
        this.setTool('select');
        return this.select([]);
      case 'Enter':
        if (this.sel.size === 1) {
          e.preventDefault();
          this.startEdit([...this.sel][0]);
        }
        return;
      case 'ArrowLeft': return this.sel.size && (e.preventDefault(), this.nudge(-big, 0));
      case 'ArrowRight': return this.sel.size && (e.preventDefault(), this.nudge(big, 0));
      case 'ArrowUp': return this.sel.size && (e.preventDefault(), this.nudge(0, -big));
      case 'ArrowDown': return this.sel.size && (e.preventDefault(), this.nudge(0, big));
      case '+':
      case '=':
        return this.zoomBy(1.25);
      case '-':
        return this.zoomBy(1 / 1.25);
      case '0':
        return this.zoomAt(this.vp.getBoundingClientRect().left + this.vp.clientWidth / 2, this.vp.getBoundingClientRect().top + this.vp.clientHeight / 2, 1 / this.view.z);
      case '!': // Shift+1 (plain 1 is the Select tool)
        return this.fit();
    }
    // (with the Draw tool, S, M and L are the brush sizes: Esc or 1 goes back to Select)
    if (this.tool === 'draw' && ['s', 'm', 'l'].includes(k)) return this.setBrush(k.toUpperCase());
    if (k === 's' || k === '1') this.setTool('select');
    else if (k === 'd' || k === '6') this.setTool('draw');
    else if (k === 'm' || k === '7') this.setTool('marker');
    else if (k === 'n' || k === '8') this.newNote(this.pointer && this.vp.matches(':hover') ? this.pointer : this.center());
    else if (k === '9') this.pdfPicker.click();
    else if (k === 'h' || k === '2') this.setTool('hand');
    else if (k === 'p' || k === '3') this.setTool('note');
    else if (k === 't' || k === '4') this.setTool('text');
    else if (k === 'i' || k === '5') this.pickImages();
  }

  // ------------------------------------------------------------------ the others
  remote(ops) {
    for (const op of ops) {
      if (op.op === 'del') {
        this.removeItem(op.id);
        continue;
      }
      const it = op.item;
      if (this.busy.has(it.id)) continue;
      const cur = this.items.get(it.id);
      if (op.live && !cur) continue;
      this.setItem({ ...(cur || {}), ...it });
      if (this.sel.has(it.id)) this.placeBar();
    }
    this.refreshHint();
  }
  cursor(m) {
    if (m.section !== this.section || !settings().cursors) return;
    let c = this.cursors.get(m.id);
    if (!c) {
      const u = user(m.email);
      c = { el: h('div', { class: 'cursor', style: { '--c': u.color } }, h('span', {}, u.name)), timer: 0 };
      this.cursors.set(m.id, c);
      this.world.append(c.el);
    }
    c.el.style.left = `${m.x}px`;
    c.el.style.top = `${m.y}px`;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      c.el.remove();
      this.cursors.delete(m.id);
    }, 7000);
  }
}
