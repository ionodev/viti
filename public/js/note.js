// A Note: a page of markdown to write in (a subsection of a board). It takes the room of the canvas: a plain editor with
// a few formatting buttons, and a button on the top bar that shows how it will look (with equations written in LaTeX:
// $x^2$ in a line, $$ ... $$ as a block). Saved as you type, and live for everyone who has the note open.
import { icon } from './icons.js';
import { S } from './state.js';
import { api } from './api.js';
import { h, toast } from './ui.js';
import { renderInto, highlight } from './md.js';

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const LIMIT = 20000;

export class NoteView {
  constructor({ onReference }) {
    this.onReference = onReference;
    this.itemId = null; // the one text item that holds the note's markdown
    this.pending = false; // something typed here that is not saved yet
    this.mode = 'write';
  }

  mount(stage) {
    this.stage = stage;
    this.ta = h('textarea', { class: 'note-editor', spellcheck: 'false', maxlength: String(LIMIT), placeholder: 'Write markdown here…\n\n# A heading\n- a list\n**bold**, *italic*, `code`\nEquations: $E = mc^2$ or a block:\n$$\\int_0^1 x^2\\,dx = \\tfrac13$$' });
    this.preview = h('div', { class: 'note-preview' });
    this.doc = h('div', { class: 'notedoc md', 'data-quotable': '' });
    this.preview.append(this.doc);
    this.status = h('span', { class: 'note-status' }, '');
    this.seg = {
      write: h('button', { class: 'on', onclick: () => this.setMode('write') }, 'Write'),
      view: h('button', { title: 'See how it will look (Ctrl+E)', onclick: () => this.setMode('view') }, 'Preview'),
    };
    const fmt = (label, title, fn, cls = '') => h('button', { class: 'fmt ' + cls, title, onmousedown: (e) => e.preventDefault(), onclick: () => (this.mode === 'write' ? fn() : this.setMode('write'), this.ta.focus()) }, label);
    this.bar = h(
      'div',
      { class: 'notebar' },
      h('div', { class: 'seg' }, this.seg.write, this.seg.view),
      h('span', { class: 'sep' }),
      fmt('B', 'Bold (Ctrl+B)', () => this.wrap('**', '**'), 'b'),
      fmt('I', 'Italic (Ctrl+I)', () => this.wrap('*', '*'), 'i'),
      fmt('H', 'Heading', () => this.prefix('# ')),
      fmt('•', 'Bullet list', () => this.prefix('- ')),
      fmt('1.', 'Numbered list', () => this.prefix('1. ')),
      fmt('☐', 'Task list', () => this.prefix('- [ ] ')),
      fmt('</>', 'Code', () => this.wrap('`', '`')),
      fmt('“', 'Quote', () => this.prefix('> ')),
      fmt(icon('link'), 'Link', () => this.wrap('[', '](https://)')),
      fmt('∑', 'Equation in the line: $...$', () => this.wrap('$', '$')),
      fmt('∫', 'Equation as a block: $$...$$', () => this.wrap('\n$$\n', '\n$$\n')),
      h('span', { class: 'grow' }),
      this.status,
      h('button', { class: 'fmt wide', title: 'Point at this note in the chat', onclick: () => this.reference() }, 'Reference'),
    );
    this.root = h('div', { class: 'noteview' }, this.bar, this.ta, this.preview);
    stage.append(this.root);
    this.preview.hidden = true;
    this.ta.addEventListener('input', () => this.changed());
    this.ta.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'b') (e.preventDefault(), this.wrap('**', '**'));
      else if (mod && e.key.toLowerCase() === 'i') (e.preventDefault(), this.wrap('*', '*'));
      else if (mod && e.key.toLowerCase() === 'e') (e.preventDefault(), this.setMode('view'));
      else if (e.key === 'Tab') (e.preventDefault(), this.insert('  '));
    });
    this.keys = (e) => {
      if (this.mode === 'view' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && !document.querySelector('.overlay')) (e.preventDefault(), this.setMode('write'));
    };
    document.addEventListener('keydown', this.keys);
  }

  async open(section) {
    this.section = section;
    const { items } = await api('GET', `/api/sections/${section}/items`);
    const it = items.find((i) => i.type === 'text');
    this.itemId = it?.id || null;
    this.last = it?.data.text || '';
    this.ta.value = this.last;
    this.updateStatus();
    this.ta.focus();
  }
  unmount() {
    this.flush();
    clearTimeout(this.timer);
    document.removeEventListener('keydown', this.keys);
    this.stage?.replaceChildren();
  }

  setMode(mode) {
    this.mode = mode;
    for (const [k, b] of Object.entries(this.seg)) b.classList.toggle('on', k === mode);
    this.ta.hidden = mode !== 'write';
    this.preview.hidden = mode !== 'view';
    this.bar.classList.toggle('previewing', mode === 'view');
    if (mode === 'view') this.draw();
    else this.ta.focus();
  }
  draw() {
    if (this.itemId) this.doc.dataset.id = this.itemId;
    renderInto(this.doc, this.ta.value || '_Nothing written yet._', (next) => {
      this.ta.value = next;
      this.changed();
      this.draw();
    });
  }

  // ---- the little helpers around the text
  insert(text) {
    const a = this.ta.selectionStart;
    this.ta.setRangeText(text, a, this.ta.selectionEnd, 'end');
    this.changed();
  }
  wrap(before, after) {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    const chosen = value.slice(a, b);
    this.ta.setRangeText(before + chosen + after, a, b, 'end');
    if (!chosen) this.ta.setSelectionRange(a + before.length, a + before.length);
    else this.ta.setSelectionRange(a + before.length, a + before.length + chosen.length);
    this.changed();
  }
  // the lines the selection touches begin with `mark` (or lose it, if they already do)
  prefix(mark) {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    const from = value.lastIndexOf('\n', a - 1) + 1;
    let to = value.indexOf('\n', b);
    if (to < 0) to = value.length;
    const lines = value.slice(from, to).split('\n');
    const all = lines.every((l) => l.startsWith(mark));
    const next = lines.map((l) => (all ? l.slice(mark.length) : mark + l)).join('\n');
    this.ta.setRangeText(next, from, to, 'select');
    this.changed();
  }

  // ---- saving: as you type, and live for the others
  changed() {
    this.pending = true;
    this.updateStatus();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 700);
  }
  flush() {
    if (!this.pending || !this.section) return;
    const text = this.ta.value;
    if (!this.itemId) this.itemId = newId();
    const item = { id: this.itemId, type: 'text', x: 0, y: 0, w: 600, h: 40, z: 1, data: { text } };
    if (S.live?.open) {
      S.live.send({ t: 'ops', section: this.section, ops: [{ op: 'put', item, restore: true }] });
      this.pending = false;
      this.last = text;
    }
    this.updateStatus();
  }
  updateStatus() {
    const n = this.ta.value.length;
    this.status.textContent = (this.pending ? (S.live?.open ? 'Saving…' : 'Offline: saved when it is back') : 'Saved') + ` · ${n} / ${LIMIT}`;
  }

  // ---- the others, and the connection
  remote(ops) {
    for (const op of ops) {
      if (op.op !== 'put' || op.item.type !== 'text' || op.live) continue;
      if (this.itemId && op.item.id !== this.itemId) continue;
      if (this.pending) continue; // (what is being typed here goes first)
      this.itemId = op.item.id;
      const text = op.item.data.text || '';
      if (text === this.ta.value) continue;
      const at = Math.min(this.ta.selectionStart, text.length);
      this.ta.value = text;
      this.last = text;
      this.ta.setSelectionRange(at, at);
      if (this.mode === 'view') this.draw();
      this.updateStatus();
    }
  }
  async resync() {
    this.flush();
    if (!this.pending) await this.open(this.section);
  }
  lost() {
    this.updateStatus();
  }

  // ---- pointing at it from the chat
  reference() {
    if (!this.itemId || !this.ta.value.trim()) return toast('Write something first.');
    this.flush();
    this.onReference({ k: 'item', section: this.section, item: this.itemId, kind: 'text', text: this.ta.value.replace(/[#*_`>[\]$]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140), label: 'Note' });
  }
  // from a reference or quote in the chat: show the note, and light up the quoted words
  focus(id, quote) {
    if (id && this.itemId && id !== this.itemId) return false;
    this.setMode('view');
    if (quote) setTimeout(() => !highlight(this.doc, quote) && toast('The quoted words have changed since.'), 150);
    return true;
  }
}
