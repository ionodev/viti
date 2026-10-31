// A mailbox: email to read here, from a folder of an email account you linked (the bar on top: mailsetup.js),
// or (the web version) from a website's contact form. On the left the messages of
// one folder (Inbox, Archive or Trash), newest first, unread ones in bold; on the right the one you opened.
// It uses the same data as the report lists (so it is live and backed up in the same way).
import { S } from './state.js';
import { api } from './api.js';
import { h, ago, stamp, toast } from './ui.js';
import { emit } from './state.js';
import { Bugs } from './bugs.js';
import { sourceBar } from './mailsetup.js';

const FOLDERS = [
  { key: 'open', title: 'Inbox', empty: 'No mail here.' },
  { key: 'closed', title: 'Archive', empty: 'Nothing archived.' },
  { key: 'trash', title: 'Trash', empty: 'The trash is empty.' },
];
const preview = (m) => m.message.split('\n').slice(m.subject && m.message.startsWith(m.subject) ? 1 : 0).join(' ').replace(/\s+/g, ' ').trim().slice(0, 110);

export class Mailbox extends Bugs {
  constructor(opts) {
    super(opts);
    this.folder = 'open';
    this.openId = null;
  }

  async mount(stage) {
    this.stage = stage;
    this.tabs = {};
    this.list_ = h('div', { class: 'mail-rows' });
    this.read = h('div', { class: 'mail-read' });
    this.top = h('div', { class: 'mail-tabs' }, FOLDERS.map((f) => (this.tabs[f.key] = h('button', { class: 'tab', onclick: () => this.setFolder(f.key) }, f.title, ' ', h('span', { class: 'n' })))));
    this.source = sourceBar(this.section);
    this.root = h('div', { class: 'mailbox' }, h('div', { class: 'mail-side' }, this.source, this.top, this.list_), this.read);
    stage.append(this.root);
    await this.load();
  }
  unmount() {
    this.stage?.replaceChildren();
  }
  paintSel() {} // (no picking of several here)

  rows(folder) {
    return [...this.all.values()].filter((m) => m.status === folder && !this.deleting.has(m.id)).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }
  counts() {
    const all = [...this.all.values()].filter((m) => !this.deleting.has(m.id));
    return { open: all.filter((m) => m.status === 'open').length, closed: all.filter((m) => m.status === 'closed').length, trash: all.filter((m) => m.status === 'trash').length, unread: all.filter((m) => m.status === 'open' && !m.seen).length };
  }
  setFolder(key) {
    this.folder = key;
    if (this.openId && this.all.get(this.openId)?.status !== key) this.openId = null;
    this.draw();
  }

  draw() {
    if (!this.root) return;
    const c = this.counts();
    for (const f of FOLDERS) {
      this.tabs[f.key].classList.toggle('on', f.key === this.folder);
      const n = f.key === 'open' ? c.unread : c[f.key];
      const span = this.tabs[f.key].querySelector('.n');
      span.textContent = n ? (f.key === 'open' ? `${n} new` : String(n)) : '';
      span.classList.toggle('new', f.key === 'open' && n > 0);
    }
    const rows = this.rows(this.folder);
    this.list_.replaceChildren(
      ...(rows.length
        ? rows.map((m) =>
            h(
              'button',
              { class: 'mail-row' + (m.seen || m.status !== 'open' ? '' : ' unread') + (m.id === this.openId ? ' on' : ''), dataset: { id: m.id }, onclick: () => this.openMail(m.id) },
              h('span', { class: 'from' }, m.name || m.email, h('time', { title: stamp(m.ts) }, ago(m.ts))),
              h('span', { class: 'subj' }, m.subject || '(no subject)'),
              h('span', { class: 'prev' }, preview(m)),
            ),
          )
        : [h('div', { class: 'col-empty' }, FOLDERS.find((f) => f.key === this.folder).empty)]),
    );
    this.drawRead();
    S.bugCounts[this.section] = c;
    emit('bugcounts');
    this.root.classList.toggle('reading', !!this.openId);
  }

  drawRead() {
    const m = this.openId && this.all.get(this.openId);
    if (!m) {
      this.openId = null;
      this.read.replaceChildren(h('div', { class: 'mail-none' }, 'Select a message to read it.'));
      return;
    }
    const body = h('div', { class: 'mail-body', 'data-quotable': '' });
    body.textContent = m.message;
    const reply = h('a', { class: 'btn small', href: `mailto:${m.email}?subject=${encodeURIComponent('Re: ' + (m.subject || ''))}&body=${encodeURIComponent('\n\n> ' + m.message.split('\n').join('\n> '))}` }, 'Reply');
    const act = (label, fn, cls = '') => h('button', { class: 'btn small ghost ' + cls, onclick: fn }, label);
    const buttons = [reply];
    if (m.status === 'open') buttons.push(act('Archive', () => this.moveMail(m.id, 'closed')), act('Mark unread', () => this.markSeen(m.id, false)), act('Trash', () => this.moveMail(m.id, 'trash')));
    else if (m.status === 'closed') buttons.push(act('Move to Inbox', () => this.moveMail(m.id, 'open')), act('Trash', () => this.moveMail(m.id, 'trash')));
    else buttons.push(act('Move to Inbox', () => this.moveMail(m.id, 'open')), act('Delete', () => this.destroy(m.id), 'danger'));
    buttons.push(act('Reference', () => this.onReference({ k: 'bug', bug: m.id, section: this.section, text: `${m.name}: ${(m.subject || m.message).replace(/\s+/g, ' ').slice(0, 120)}` })));
    this.read.replaceChildren(
      h(
        'div',
        { class: 'mail-msg', dataset: { id: m.id, section: this.section } },
        h('button', { class: 'mail-back', onclick: () => ((this.openId = null), this.draw()) }, '← Back'),
        h('h2', {}, m.subject || '(no subject)'),
        h('div', { class: 'mail-meta' }, h('b', {}, m.name || m.email), m.email ? h('span', {}, ` <${m.email}>`) : null),
        h('div', { class: 'mail-meta dim' }, `${stamp(m.ts)} · ${ago(m.ts)} · ${m.source === 'form' ? 'via the website’s contact form' : 'added here'}${m.browser ? ' · ' + m.browser : ''}`),
        h('div', { class: 'mail-actions' }, buttons),
        body,
      ),
    );
  }

  async openMail(id) {
    this.openId = id;
    const m = this.all.get(id);
    if (m && !m.seen) this.markSeen(id, true);
    this.draw();
  }
  async markSeen(id, seen) {
    const m = this.all.get(id);
    if (!m || m.seen === seen) return;
    this.all.set(id, { ...m, seen });
    this.draw();
    try {
      await api('PATCH', `/api/bugs/${id}`, { seen });
    } catch (e) {
      toast(e.message, true);
    }
  }
  async moveMail(id, status) {
    this.openId = null;
    await this.move(id, status);
  }
  destroy(id) {
    if (this.openId === id) this.openId = null;
    super.destroy(id); // (undoable for a few seconds)
  }
  movedText(status) {
    return status === 'open' ? 'Moved to the Inbox' : status === 'closed' ? 'Archived' : 'Moved to Trash';
  }
  // a chat reference to a message: show its folder and open it
  focus(id) {
    const m = this.all.get(id);
    if (!m) return toast('That message is gone.', true);
    this.folder = m.status;
    this.openMail(id);
    this.list_.querySelector(`.mail-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  }
}
