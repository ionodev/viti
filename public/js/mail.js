// A mailbox: email to read here, from a folder of an email account you linked (the bar on top: mailsetup.js),
// or (the web version) from a website's contact form. On the left the messages of
// one folder (Inbox, Archive or Trash), newest first, unread ones in bold; on the right the one you opened.
// It uses the same data as the report lists (so it is live and backed up in the same way).
import { S } from './state.js';
import { api } from './api.js';
import { h, ago, stamp, toast, modal } from './ui.js';
import { emit } from './state.js';
import { Bugs } from './bugs.js';
import { sourceBar } from './mailsetup.js';

const FOLDERS = [
  { key: 'open', title: 'Inbox', empty: 'No mail here.' },
  { key: 'closed', title: 'Archive', empty: 'Nothing archived.' },
  { key: 'sent', title: 'Sent', empty: 'Nothing sent from here yet.' },
  { key: 'trash', title: 'Trash', empty: 'The trash is empty.' },
];
// a sent email (in Sent): to whom is its name and email, from whom its ua ("from:address")
const isSent = (m) => m.source === 'sent';
const sentFrom = (m) => String(m.ua || '').replace(/^from:/, '');
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
    this.source = sourceBar(this.section, { compose: () => this.compose({}) });
    this.root = h('div', { class: 'mailbox' }, h('div', { class: 'mail-side' }, this.source, this.top, this.list_), this.read);
    stage.append(this.root);
    await this.load();
  }
  unmount() {
    this.stage?.replaceChildren();
  }
  paintSel() {} // (no picking of several here)

  // Inbox and Archive hold what came in; Sent what was sent from here; Trash either
  inFolder(m, folder) {
    if (folder === 'sent') return isSent(m) && m.status !== 'trash';
    return m.status === folder && (folder === 'trash' || !isSent(m));
  }
  rows(folder) {
    return [...this.all.values()].filter((m) => this.inFolder(m, folder) && !this.deleting.has(m.id)).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }
  counts() {
    const all = [...this.all.values()].filter((m) => !this.deleting.has(m.id));
    const n = (f) => all.filter((m) => this.inFolder(m, f)).length;
    return { open: n('open'), closed: n('closed'), sent: n('sent'), trash: n('trash'), unread: all.filter((m) => this.inFolder(m, 'open') && !m.seen).length };
  }
  setFolder(key) {
    this.folder = key;
    this.composing = false;
    if (this.openId && !this.inFolder(this.all.get(this.openId) || {}, key)) this.openId = null;
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
              h('span', { class: 'from' }, isSent(m) ? `To ${m.name || m.email}` : m.name || m.email, h('time', { title: stamp(m.ts) }, ago(m.ts))),
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
    if (this.composing) return; // (an email is being written: it stays until sent or dropped)
    const m = this.openId && this.all.get(this.openId);
    if (!m) {
      this.openId = null;
      this.read.replaceChildren(h('div', { class: 'mail-none' }, 'Select a message to read it.'));
      return;
    }
    const body = h('div', { class: 'mail-body', 'data-quotable': '' });
    body.textContent = m.message;
    const act = (label, fn, cls = '') => h('button', { class: 'btn small ghost ' + cls, onclick: fn }, label);
    const buttons = isSent(m) ? [] : [h('button', { class: 'btn small', onclick: () => this.compose({ reply: m }) }, 'Reply')];
    if (isSent(m)) buttons.push(m.status === 'trash' ? act('Delete', () => this.destroy(m.id), 'danger') : act('Trash', () => this.moveMail(m.id, 'trash')));
    else if (m.status === 'open') buttons.push(act('Archive', () => this.moveMail(m.id, 'closed')), act('Mark unread', () => this.markSeen(m.id, false)), act('Trash', () => this.moveMail(m.id, 'trash')));
    else if (m.status === 'closed') buttons.push(act('Move to Inbox', () => this.moveMail(m.id, 'open')), act('Trash', () => this.moveMail(m.id, 'trash')));
    else buttons.push(act('Move to Inbox', () => this.moveMail(m.id, 'open')), act('Delete', () => this.destroy(m.id), 'danger'));
    buttons.push(act('Reference', () => this.onReference({ k: 'bug', bug: m.id, section: this.section, text: `${m.name}: ${(m.subject || m.message).replace(/\s+/g, ' ').slice(0, 120)}` })));
    this.read.replaceChildren(
      h(
        'div',
        { class: 'mail-msg', dataset: { id: m.id, section: this.section } },
        h('button', { class: 'mail-back', onclick: () => ((this.openId = null), this.draw()) }, '← Back'),
        h('h2', {}, m.subject || '(no subject)'),
        h('div', { class: 'mail-meta' }, isSent(m) ? 'To ' : null, h('b', {}, m.name || m.email), m.email && m.email !== m.name ? h('span', {}, ` <${m.email}>`) : null),
        h('div', { class: 'mail-meta dim' }, `${stamp(m.ts)} · ${ago(m.ts)} · ${isSent(m) ? 'sent from ' + sentFrom(m) : m.source === 'form' ? 'via the website’s contact form' : m.source === 'mail' ? 'from your linked email' : 'added here'}${m.browser ? ' · ' + m.browser : ''}`),
        h('div', { class: 'mail-actions' }, buttons),
        body,
      ),
    );
  }

  // ---- writing: a reply (to, "Re:" and the original quoted, threaded with it) or a new email. Sent from the
  // account the mailbox's folder is read from, after a last "Send to ... from ...?"
  compose({ reply } = {}) {
    const to = h('input', { type: 'text', class: 'cm-input', placeholder: 'name@example.com (commas between several)', value: reply ? reply.email : '' });
    const subject = h('input', { type: 'text', class: 'cm-input', placeholder: 'Subject', value: reply ? (/^re:/i.test(reply.subject || '') ? reply.subject : 'Re: ' + (reply.subject || '')) : '' });
    const quote = reply ? `\n\nOn ${stamp(reply.ts)}, ${reply.name || reply.email} wrote:\n> ${reply.message.split('\n').join('\n> ')}` : '';
    const text = h('textarea', { class: 'cm-text', placeholder: 'Write your email…' });
    text.value = quote;
    const send = h('button', { class: 'btn small' }, 'Send');
    const close = () => ((this.composing = false), this.draw());
    send.addEventListener('click', async () => {
      if (!text.value.trim() || text.value.trim() === quote.trim()) return toast('Write something first.', true);
      let from = '';
      try {
        const st = await fetch('/app/mail').then((r) => r.json());
        const link = st.links?.[this.section];
        from = st.accounts?.find((a) => a.id === link?.account)?.address || '';
      } catch {}
      if (!from) return toast('Link this mailbox to an email account first (the bar above the mailbox).', true);
      const sure = await modal('Send this email?', h('p', {}, 'To ', h('b', {}, to.value.trim()), h('br'), 'From ', h('b', {}, from), h('br'), 'Subject: ', subject.value.trim() || '(no subject)'), [
        { label: 'Not yet', value: false },
        { label: 'Send', value: true, primary: true },
      ]);
      if (sure !== true) return;
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        const r = await fetch(`/app/mail/send/${this.section}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: to.value, toName: reply && reply.email === to.value.trim() ? reply.name : '', subject: subject.value.trim(), text: text.value, reply: reply?.id || '' }) }).then((x) => x.json());
        if (!r.ok) throw new Error(r.error || 'It could not be sent.');
        toast(`Sent from ${r.from}.`);
        this.composing = false;
        this.folder = 'sent';
        this.openId = r.id || null;
        this.draw();
      } catch (e) {
        toast(e.message, true);
        send.disabled = false;
        send.textContent = 'Send';
      }
    });
    this.composing = true;
    this.read.replaceChildren(
      h(
        'div',
        { class: 'mail-compose' },
        h('h2', {}, reply ? 'Reply' : 'New email'),
        h('label', { class: 'cm-row' }, h('span', {}, 'To'), to),
        h('label', { class: 'cm-row' }, h('span', {}, 'Subject'), subject),
        text,
        h('div', { class: 'cm-bar' }, send, h('button', { class: 'btn small ghost', onclick: close }, 'Discard')),
      ),
    );
    this.root.classList.add('reading');
    (reply ? text : to).focus();
    if (reply) text.setSelectionRange(0, 0);
  }

  async openMail(id) {
    this.composing = false;
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
