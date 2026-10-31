// The chat of the open section: markdown messages that can point at things (a quoted passage, an image or
// note on a board, another message, a bug report), and the "Quote in chat" button that appears when you
// select words anywhere.
import { S, user, sectionById, sectionLabel, imageUrl, emit } from './state.js';
import { api } from './api.js';
import { h, $, avatar, clock, dayLabel, stamp, toast, lightbox, menu } from './ui.js';
import { renderInto } from './md.js';
import { emojiPicker } from './emoji.js';

// what goes before a section's name: # a board, ! a list of reports, a star for the to-do list
export const glyph = (kind) => (kind === 'bugs' ? '!' : kind === 'todo' ? '\u2605' : kind === 'overview' ? '\u25ce' : kind === 'progress' ? '\u25b3' : kind === 'mail' ? '\u2709' : kind === 'calendar' ? '\u25a6' : kind === 'note' ? '\u270e' : kind === 'pdf' ? '\u25a4' : '#');
const KIND = { note: 'Post-it', text: 'Text', image: 'Image', group: 'Group', draw: 'Drawing', doc: 'Note' };

// a card for one reference: in a message, or (with onRemove) among the chips above the box
export function refCard(ref, { onClick, onRemove } = {}) {
  const where = sectionLabel(ref.section);
  let label = '';
  let text = '';
  let thumb = null;
  if (ref.k === 'quote') {
    label = `${ref.label || 'Quote'}${where ? ` · ${where}` : ''}`;
    text = ref.text;
  } else if (ref.k === 'item') {
    label = `${KIND[ref.kind] || ref.label || 'Item'}${where ? ` · ${where}` : ''}`;
    text = ref.text;
    if (ref.img) thumb = h('img', { src: imageUrl(ref.img), alt: '', loading: 'lazy' });
  } else if (ref.k === 'msg') {
    label = `Message · ${ref.who || 'chat'}${where ? ` · ${where}` : ''}`;
    text = ref.text;
  } else if (ref.k === 'bug') {
    label = (sectionById(ref.section)?.kind === 'todo' ? 'To do' : 'Report') + (where ? ` \u00b7 ${where}` : '');
    text = ref.text;
  } else if (ref.k === 'day') {
    label = `Chat day${where ? ` \u00b7 ${where}` : ''}`;
    text = ref.text || ref.day;
  }
  const card = h('div', { class: 'ref ' + (ref.k === 'quote' || ref.k === 'msg' ? 'q' : ''), role: 'button', tabindex: '0', title: 'Show this', onclick: (e) => !e.target.closest('.x') && onClick?.(ref), onkeydown: (e) => e.key === 'Enter' && onClick?.(ref) }, thumb, h('span', { class: 'rb' }, h('span', { class: 'rl' }, label), h('span', { class: 'rt' }, text || '')));
  if (onRemove) card.append(h('button', { class: 'x', title: 'Remove', onclick: () => onRemove(ref) }, '×'));
  return card;
}

// "@name" in a message: the name of someone on the team is lit up (gold for you)
function mentionize(el) {
  const names = [...new Set([...S.users.values()].flatMap((u) => [u.name, String(u.name || '').split(/\s+/)[0]]).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!names.length) return;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^\\w])@(' + names.map(esc).join('|') + ')(?![\\w])', 'gi');
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('code, pre, a') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes('@')) nodes.push(n);
  for (const n of nodes) {
    const text = n.nodeValue;
    const frag = document.createDocumentFragment();
    let at = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index + m[1].length;
      const who = [...S.users.values()].find((u) => u.name.toLowerCase() === m[2].toLowerCase() || String(u.name).split(/\s+/)[0].toLowerCase() === m[2].toLowerCase());
      frag.append(text.slice(at, start), h('span', { class: 'mention' + (who?.email === S.me.email ? ' me' : '') }, '@' + m[2]));
      at = start + 1 + m[2].length;
    }
    frag.append(text.slice(at));
    n.replaceWith(frag);
  }
}

export class Chat {
  constructor(root, { go, pick }) {
    this.root = root;
    this.go = go;
    this.pick = pick;
    this.section = null;
    this.refs = [];
    this.drafts = new Map();
    this.last = null; // the newest message shown
    this.more = false;
    this.title = h('button', { class: 'chat-title', title: 'Switch section', onclick: (e) => this.switcher(e) });
    this.msgs = h('div', { class: 'msgs' });
    this.chips = h('div', { class: 'chips' });
    this.input = h('textarea', { rows: '1', placeholder: 'Write a message… (markdown works)', maxlength: '8000' });
    this.send = h('button', { class: 'btn small', onclick: () => this.submit() }, 'Send');
    this.emojiBtn = h('button', { class: 'icon emoji-btn', type: 'button', title: 'Emoji', onclick: () => emojiPicker(this.emojiBtn, (e) => this.insert(e)) }, '\u{1F642}');
    this.mentionBox = h('div', { class: 'menu mention-pop', hidden: true });
    this.root.append(h('div', { class: 'chat-head' }, h('p', { class: 'label' }, 'Chat'), this.title), this.msgs, h('div', { class: 'composer' }, this.chips, this.mentionBox, h('div', { class: 'row' }, this.input, this.emojiBtn, this.send)));
    this.input.addEventListener('keydown', (e) => {
      // the list of names after an @: arrows to choose, Tab or Enter to take it, Esc to leave it
      if (!this.mentionBox.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.mentionAt = (this.mentionAt + (e.key === 'ArrowDown' ? 1 : -1) + this.mentionList.length) % this.mentionList.length;
          return this.drawMentions();
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
          e.preventDefault();
          return this.takeMention(this.mentionList[this.mentionAt]);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          return (this.mentionBox.hidden = true);
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => (this.grow(), this.checkMention()));
    this.input.addEventListener('blur', () => setTimeout(() => (this.mentionBox.hidden = true), 150));
    this.msgs.addEventListener('scroll', () => this.atBottom() && this.markRead());
  }

  // put text (an emoji, a name) in the box where the cursor is
  insert(text) {
    const i = this.input;
    const a = i.selectionStart ?? i.value.length;
    const b = i.selectionEnd ?? a;
    i.value = i.value.slice(0, a) + text + i.value.slice(b);
    i.setSelectionRange(a + text.length, a + text.length);
    i.focus();
    this.grow();
  }
  // typing "@" and the start of a name offers the people it could be
  checkMention() {
    const i = this.input;
    const before = i.value.slice(0, i.selectionStart ?? 0);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return (this.mentionBox.hidden = true);
    const q = m[2].toLowerCase();
    this.mentionList = [...S.users.values()].filter((u) => u.email !== S.me.email && (u.name || '').toLowerCase().startsWith(q)).slice(0, 8);
    this.mentionAt = 0;
    this.mentionBox.hidden = !this.mentionList.length;
    if (this.mentionList.length) this.drawMentions();
  }
  drawMentions() {
    this.mentionBox.replaceChildren(...this.mentionList.map((u, n) => h('button', { type: 'button', class: n === this.mentionAt ? 'on' : '', onmousedown: (e) => (e.preventDefault(), this.takeMention(u)) }, '@' + u.name)));
  }
  takeMention(u) {
    if (!u) return;
    const i = this.input;
    const pos = i.selectionStart ?? i.value.length;
    const before = i.value.slice(0, pos).replace(/@[^\s@]*$/, '');
    i.value = before + '@' + u.name + ' ' + i.value.slice(pos);
    const at = (before + '@' + u.name + ' ').length;
    i.setSelectionRange(at, at);
    this.mentionBox.hidden = true;
    this.grow();
    i.focus();
  }
  grow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(160, this.input.scrollHeight + 2)}px`;
  }
  atBottom() {
    return this.msgs.scrollHeight - this.msgs.scrollTop - this.msgs.clientHeight < 60;
  }
  toBottom() {
    this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  // ------------------------------------------------------------------ opening a section's chat
  async open(section) {
    if (this.section) this.drafts.set(this.section, { text: this.input.value, refs: this.refs });
    this.section = section;
    const d = this.drafts.get(section) || { text: '', refs: [] };
    this.input.value = d.text;
    this.refs = d.refs;
    this.grow();
    this.drawChips();
    this.retitle();
    this.msgs.replaceChildren();
    this.last = null;
    await this.load();
  }
  // the title is a menu: change section without leaving the chat. A section's branch pages show up only once you have
  // clicked the section (and only the chosen branch's, when one is chosen at the top of the menu)
  switcher(e) {
    if (this.sw) return this.sw.remove(), (this.sw = null);
    const r = e.currentTarget.getBoundingClientRect();
    let expanded = '';
    const el = h('div', { class: 'menu switcher' });
    const close = () => {
      el.remove();
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', onKey, true);
      this.sw = null;
    };
    const away = (ev) => !el.contains(ev.target) && !this.title.contains(ev.target) && close();
    const onKey = (ev) => ev.key === 'Escape' && close();
    const kids = (id) => S.sections.filter((s) => s.parent === id && (!S.branchView || s.branch === S.branchView));
    const item = (s, sub) => h('button', { class: (s.id === this.section ? 'on' : '') + (sub ? ' sub' : ''), onclick: () => choose(s) }, `${sub && s.kind === 'board' ? '\u2387' : glyph(s.kind)} ${s.name}${s.unread ? ` (${s.unread})` : ''}`, !sub && kids(s.id).length ? h('span', { class: 'more' }, expanded === s.id ? '\u25be' : '\u25b8') : null);
    const choose = (s) => {
      const has = !s.parent && kids(s.id).length;
      if (s.id !== this.section) this.pick?.(s.id);
      if (!has) return close();
      expanded = expanded === s.id && s.id === this.section ? '' : s.id;
      draw();
    };
    const draw = () => el.replaceChildren(...S.sections.filter((s) => !s.parent).flatMap((s) => [item(s, false), ...(expanded === s.id ? kids(s.id).map((c) => item(c, true)) : [])]));
    draw();
    document.body.append(el);
    const w = el.getBoundingClientRect().width;
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    el.style.top = r.bottom + 4 + 'px';
    el.style.maxHeight = Math.max(120, innerHeight - r.bottom - 16) + 'px';
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', onKey, true);
    this.sw = el;
  }
  retitle() {
    if (this.section) {
      const s = sectionById(this.section);
      this.title.textContent = `${glyph(s?.kind)} ${sectionLabel(this.section)} \u25be`;
    }
  }
  async load() {
    const sec = this.section;
    try {
      const r = await api('GET', `/api/chat/${sec}?limit=50`);
      if (sec !== this.section) return;
      this.msgs.replaceChildren();
      this.more = r.more;
      this.last = null;
      this.draw(r.messages);
      if (!r.messages.length) this.msgs.append(h('div', { class: 'chat-empty' }, 'Nothing here yet. Say something, or select text on the board and quote it.'));
      this.toBottom();
      this.markRead();
    } catch (e) {
      toast(e.message, true);
    }
  }
  async loadEarlier() {
    const first = this.msgs.querySelector('.msg')?.dataset.id;
    if (!first) return;
    const r = await api('GET', `/api/chat/${this.section}?limit=50&before=${first}`);
    const before = this.msgs.scrollHeight;
    this.more = r.more;
    const keep = this.msgs.querySelectorAll('.msg, .day, .more');
    const frag = document.createDocumentFragment();
    let prev = null;
    for (const m of r.messages) {
      this.dayMark(frag, m, prev);
      frag.append(this.msgEl(m, prev));
      prev = m;
    }
    this.msgs.querySelector('.more')?.remove();
    this.msgs.prepend(frag);
    if (this.more) this.msgs.prepend(this.moreBtn());
    this.msgs.scrollTop += this.msgs.scrollHeight - before;
    void keep;
  }
  moreBtn() {
    return h('button', { class: 'btn small ghost more', onclick: () => this.loadEarlier() }, 'Earlier messages');
  }
  draw(list) {
    if (this.more) this.msgs.append(this.moreBtn());
    let prev = null;
    for (const m of list) {
      this.dayMark(this.msgs, m, prev);
      this.msgs.append(this.msgEl(m, prev));
      prev = m;
    }
    this.last = list.at(-1) || null;
  }
  dayMark(parent, m, prev) {
    if (prev && dayLabel(prev.ts) === dayLabel(m.ts)) return;
    // (the heading of a day can be pointed at: from the Calendar, or in a message)
    const d = new Date(m.ts);
    const day = d.toLocaleDateString('sv');
    parent.append(h('div', { class: 'day' }, dayLabel(m.ts), h('button', { class: 'dayref', title: 'Reference this day', onclick: () => this.addRef({ k: 'day', section: this.section, day, from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), text: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) }) }, '\u2197')));
  }

  // ------------------------------------------------------------------ messages
  msgEl(m, prev) {
    const u = S.users.has(m.author) ? user(m.author) : { email: m.author || '', name: m.name || user(m.author).name, color: '#8a8470' }; // (imported messages carry only a name)
    const same = prev && prev.author === m.author && m.ts - prev.ts < 5 * 60000 && dayLabel(prev.ts) === dayLabel(m.ts) && !prev.deleted;
    const body = h('div', { class: 'md', 'data-quotable': '' });
    if (m.deleted) body.textContent = 'This message was deleted.';
    else (renderInto(body, m.body), mentionize(body));
    const el = h(
      'div',
      { class: 'msg' + (same ? ' same' : '') + (m.deleted ? ' gone' : ''), dataset: { id: m.id, section: m.section, who: m.name || u.name } },
      avatar(u),
      h('div', { class: 'mb' }, h('div', { class: 'who' }, u.name, h('time', { title: stamp(m.ts) }, clock(m.ts))), (m.refs || []).map((r) => refCard(r, { onClick: (ref) => this.go(ref) })), m.body || m.deleted ? body : null),
    );
    if (m.author === S.me.email && !m.deleted) el.append(h('button', { class: 'del', title: 'Delete your message', onclick: () => api('DELETE', `/api/messages/${m.id}`).catch((e) => toast(e.message, true)) }, '×'));
    return el;
  }
  add(m) {
    if (m.section !== this.section) return;
    const old = this.msgs.querySelector(`.msg[data-id="${m.id}"]`);
    if (old) {
      old.replaceWith(this.msgEl(m, null));
      return;
    }
    this.msgs.querySelector('.chat-empty')?.remove();
    const stick = this.atBottom() || m.author === S.me.email;
    this.dayMark(this.msgs, m, this.last);
    this.msgs.append(this.msgEl(m, this.last));
    this.last = m;
    if (stick) {
      this.toBottom();
      this.markRead();
    }
  }
  // scrolls to a message and lights it up (loading earlier ones if need be)
  async showMessage(id) {
    for (let i = 0; i < 6; i++) {
      const el = this.msgs.querySelector(`.msg[data-id="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        return;
      }
      if (!this.more) break;
      await this.loadEarlier();
    }
    toast('That message is too far back, or deleted.');
  }

  markRead() {
    const id = this.last?.id;
    const sec = sectionById(this.section);
    if (!id || !sec || document.visibilityState !== 'visible') return;
    if (sec.unread) {
      sec.unread = 0;
      emit('unread');
    }
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => api('POST', `/api/chat/${this.section}/read`, { id }).catch(() => {}), 400);
  }

  // ------------------------------------------------------------------ writing
  addRef(ref) {
    const key = JSON.stringify([ref.k, ref.item, ref.msg, ref.bug, ref.day, ref.text]);
    if (!this.refs.some((r) => JSON.stringify([r.k, r.item, r.msg, r.bug, r.day, r.text]) === key)) this.refs.push(ref);
    this.drawChips();
    document.body.classList.remove('nochat');
    this.input.focus();
  }
  drawChips() {
    this.chips.replaceChildren(
      ...this.refs.map((r) =>
        refCard(r, {
          onClick: (ref) => this.go(ref),
          onRemove: () => {
            this.refs = this.refs.filter((x) => x !== r);
            this.drawChips();
          },
        }),
      ),
    );
  }
  async submit() {
    const body = this.input.value.trim();
    if (!body && !this.refs.length) return;
    this.send.disabled = true;
    try {
      await api('POST', `/api/chat/${this.section}`, { body, refs: this.refs });
      this.input.value = '';
      this.refs = [];
      this.drawChips();
      this.grow();
    } catch (e) {
      toast(e.message, true);
    }
    this.send.disabled = false;
    this.input.focus();
  }
}

// ---------- select words anywhere (a board, the chat, a bug report), then "Quote in chat" ----------
export function initQuotes(chat) {
  const pop = $('#quote-pop');
  const btn = $('#quote-btn');
  let current = null;
  const hide = () => {
    pop.hidden = true;
    current = null;
  };
  const check = () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
    let range = sel.getRangeAt(0);
    const hostOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest('[data-quotable]');
    let host = hostOf(range.commonAncestorContainer);
    if (!host) {
      // a triple-click or a drag that ends past the text: use the part that is inside the text it started (or ended) in
      host = hostOf(range.startContainer) || hostOf(range.endContainer);
      if (!host) return hide();
      range = range.cloneRange();
      if (!host.contains(range.startContainer)) range.setStart(host, 0);
      if (!host.contains(range.endContainer)) range.setEnd(host, host.childNodes.length);
    }
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return hide();
    let ref = null;
    const item = host.closest('.item');
    const noteDoc = host.closest('.notedoc[data-id]');
    const msg = host.closest('.msg');
    const bug = host.closest('.bug, .mail-msg');
    if (noteDoc) ref = { k: 'quote', section: S.section, item: noteDoc.dataset.id, label: 'Note' };
    else if (item) ref = { k: 'quote', section: S.section, item: item.dataset.id, label: item.classList.contains('note') ? 'Post-it' : 'Text' };
    else if (msg) ref = { k: 'msg', section: msg.dataset.section, msg: Number(msg.dataset.id), who: msg.dataset.who };
    else if (bug) ref = { k: 'bug', bug: bug.dataset.id, section: bug.dataset.section };
    if (!ref) return hide();
    ref.text = text.slice(0, 600);
    current = ref;
    const r = range.getBoundingClientRect();
    pop.style.left = `${Math.min(innerWidth - 70, Math.max(70, r.left + r.width / 2))}px`;
    pop.style.top = `${Math.max(46, r.top - 8)}px`;
    pop.hidden = false;
  };
  let t = 0;
  document.addEventListener('selectionchange', () => {
    clearTimeout(t);
    t = setTimeout(check, 80);
  });
  document.addEventListener('scroll', () => current && check(), true);
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (current) chat.addRef(current);
    getSelection()?.removeAllRanges();
    hide();
  });
}
