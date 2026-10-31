// A mailbox: email to read here, from a Gmail label you linked (the bar on top: mailsetup.js), or (an older
// Viti) from a website's contact form. On the left the conversations of one folder (Inbox, Archive, Sent or
// Trash), newest first, unread ones in bold; on the right the conversation you opened, every email of it in
// order, with its attachments, and formatted emails shown as they were written (cleaned, in a frame of their
// own, and with pictures from the internet only when you ask: they can tell the sender you read it).
// It uses the same data as the report lists (so it is live and backed up in the same way).
import { icon } from './icons.js';
import { S } from './state.js';
import { api } from './api.js';
import { h, ago, stamp, toast, modal, lightbox } from './ui.js';
import { emit } from './state.js';
import { Bugs } from './bugs.js';
import { sourceBar } from './mailsetup.js';
import DOMPurify from '/vendor/purify.js';

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
// the conversation an email belongs to (one without: on its own)
const convOf = (m) => m.thread || m.page || m.id;
const bare = (s) => String(s || '').replace(/^\s*((re|fw|fwd|sv|vs)\s*:\s*)+/i, '');
const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const PICTURE = /^image\/(png|jpeg|gif|webp)$/;

// a formatted email, cleaned and made into a page of its own (for the frame); pictures from the internet are
// left out unless shown on purpose -> { page, blocked }
function emailPage(html, showImages) {
  const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'] });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  let blocked = 0;
  if (!showImages) {
    for (const img of doc.querySelectorAll('img[src]')) {
      if (/^https?:/i.test(img.getAttribute('src'))) {
        img.removeAttribute('src');
        img.removeAttribute('srcset');
        blocked++;
      }
    }
    for (const el of doc.querySelectorAll('[style*="url("], [background]')) {
      el.removeAttribute('background');
      el.setAttribute('style', el.getAttribute('style')?.replace(/url\([^)]*\)/gi, 'none') || '');
      blocked++;
    }
    for (const st of doc.querySelectorAll('style')) st.textContent = st.textContent.replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none');
  }
  const base = '<meta charset="utf-8"><base target="_blank"><style>html,body{margin:0}body{padding:16px 18px;font:14px/1.55 "Segoe UI",system-ui,sans-serif;color:#1d1f24;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>';
  return { page: `<!doctype html><html><head>${base}${doc.head.innerHTML}</head><body>${doc.body.innerHTML}</body></html>`, blocked };
}

export class Mailbox extends Bugs {
  constructor(opts) {
    super(opts);
    this.folder = 'open';
    this.openId = null;
    this.showImages = new Set(); // the emails whose pictures you chose to see
    this.unfolded = new Set(); // earlier emails of a conversation you opened up
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
  // the conversations of a folder: the newest email of each, how many it has, and whether any is unread
  conversations(folder) {
    const seen = new Map();
    for (const m of this.rows(folder)) {
      const k = convOf(m);
      const c = seen.get(k);
      if (!c) seen.set(k, { m, n: 1, unread: !m.seen && !isSent(m) && m.status === 'open' });
      else (c.n++, (c.unread ||= !m.seen && !isSent(m) && m.status === 'open'));
    }
    return [...seen.values()];
  }
  // every email of a conversation (from any folder but Trash, unless it is Trash you are in), oldest first
  thread(m) {
    const k = convOf(m);
    return [...this.all.values()].filter((x) => convOf(x) === k && !this.deleting.has(x.id) && (this.folder === 'trash' || x.status !== 'trash')).sort((a, b) => a.ts - b.ts);
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
    const open = this.openId && this.all.get(this.openId);
    const openConv = open ? convOf(open) : null;
    const convs = this.conversations(this.folder);
    this.list_.replaceChildren(
      ...(convs.length
        ? convs.map(({ m, n, unread }) =>
            h(
              'button',
              { class: 'mail-row' + (unread ? ' unread' : '') + (convOf(m) === openConv ? ' on' : ''), dataset: { id: m.id }, onclick: () => this.openMail(m.id) },
              h('span', { class: 'from' }, h('span', { class: 'who' }, isSent(m) ? `To ${m.name || m.email}` : m.name || m.email, n > 1 ? h('span', { class: 'cnt' }, String(n)) : null), h('time', { title: stamp(m.ts) }, ago(m.ts))),
              h('span', { class: 'subj' }, m.files?.length ? h('span', { class: 'clip', title: 'Has attachments' }, icon('clip')) : null, bare(m.subject) || '(no subject)'),
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
      this.read.replaceChildren(h('div', { class: 'mail-none' }, 'Select a conversation to read it.'));
      return;
    }
    const conv = this.thread(m);
    const last = conv[conv.length - 1] || m;
    const lastIn = [...conv].reverse().find((x) => !isSent(x)) || null; // (the newest one that came in: what Reply answers)
    const here = conv.filter((x) => this.inFolder(x, this.folder));
    const act = (label, fn, cls = '') => h('button', { class: 'btn small ghost ' + cls, onclick: fn }, label);
    const moveAll = (status) => ((this.openId = null), this.moveMany(here.map((x) => x.id), status));
    const buttons = [];
    if (lastIn) buttons.push(h('button', { class: 'btn small', onclick: () => this.compose({ reply: lastIn }) }, 'Reply'), act('Reply all', () => this.compose({ reply: lastIn, all: true })));
    if (this.folder === 'open') buttons.push(act('Archive', () => moveAll('closed')), act('Mark unread', () => this.markSeen(lastIn?.id || last.id, false)), act('Trash', () => moveAll('trash')));
    else if (this.folder === 'closed') buttons.push(act('Move to Inbox', () => moveAll('open')), act('Trash', () => moveAll('trash')));
    else if (this.folder === 'sent') buttons.push(act('Trash', () => moveAll('trash')));
    else buttons.push(act('Restore', () => moveAll(isSent(m) ? 'open' : 'open')), act('Delete', () => ((this.openId = null), this.destroyMany(here.map((x) => x.id))), 'danger'));
    buttons.push(act('Reference', () => this.onReference({ k: 'bug', bug: last.id, section: this.section, text: `${last.name}: ${(last.subject || last.message).replace(/\s+/g, ' ').slice(0, 120)}` })));
    this.read.replaceChildren(
      h(
        'div',
        { class: 'mail-msg', dataset: { id: last.id, section: this.section } },
        h('button', { class: 'mail-back', onclick: () => ((this.openId = null), this.draw()) }, '← Back'),
        h('h2', {}, bare(conv[0]?.subject || m.subject) || '(no subject)', conv.length > 1 ? h('span', { class: 'conv-n' }, `${conv.length} emails`) : null),
        h('div', { class: 'mail-actions' }, buttons),
        h('div', { class: 'conv' }, conv.map((x, i) => this.email(x, i === conv.length - 1 || this.unfolded.has(x.id)))),
      ),
    );
  }

  // one email of a conversation: folded (who, when, the first words: click to open) or open
  email(m, open) {
    const who = isSent(m) ? sentFrom(m) || 'You' : m.name || m.email;
    const head = h(
      'div',
      { class: 'em-head', onclick: () => (open && this.thread(m).length > 1 ? (this.unfolded.delete(m.id), this.drawRead()) : !open && (this.unfolded.add(m.id), this.drawRead())) },
      h('b', {}, isSent(m) ? `${who} (you)` : who),
      !isSent(m) && m.email && m.email !== m.name ? h('span', { class: 'addr' }, `<${m.email}>`) : null,
      h('time', { title: stamp(m.ts) }, `${stamp(m.ts)} · ${ago(m.ts)}`),
    );
    if (!open) return h('div', { class: 'em folded', dataset: { id: m.id } }, head, h('div', { class: 'em-peek' }, preview(m)));
    const to = isSent(m) ? (m.rcpt?.to?.length ? m.rcpt.to : [m.email]) : m.rcpt?.to || [];
    const cc = m.rcpt?.cc || [];
    const lines = [to.length ? `To ${to.join(', ')}` : '', cc.length ? `Cc ${cc.join(', ')}` : ''].filter(Boolean);
    return h(
      'div',
      { class: 'em', dataset: { id: m.id } },
      head,
      lines.length ? h('div', { class: 'em-rcpt' }, lines.join(' · ')) : null,
      m.html ? this.htmlBody(m) : h('div', { class: 'mail-body', 'data-quotable': '' }, m.message),
      m.files?.length ? this.attachments(m) : null,
    );
  }

  // a formatted email in its frame, as tall as it is; pictures from the internet on request
  htmlBody(m) {
    const show = this.showImages.has(m.id);
    const { page, blocked } = emailPage(m.html, show);
    const frame = h('iframe', { class: 'em-frame', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', title: 'The email' });
    frame.srcdoc = page;
    const fit = () => {
      try {
        frame.style.height = Math.min(4000, frame.contentDocument.documentElement.scrollHeight + 4) + 'px';
      } catch {}
    };
    frame.addEventListener('load', () => {
      fit();
      // (pictures that load later make it taller)
      frame.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
    });
    const note = blocked && !show ? h('div', { class: 'em-images' }, 'Pictures from the internet are hidden (they can tell the sender you read this). ', h('button', { class: 'link-btn', onclick: () => (this.showImages.add(m.id), this.drawRead()) }, 'Show them')) : null;
    return h('div', { class: 'em-html' }, note, frame);
  }

  // its attachments: pictures as small pictures (click to see them large), other files to save
  attachments(m) {
    return h(
      'div',
      { class: 'em-files' },
      m.files.map((f) =>
        f.skipped
          ? h('span', { class: 'file skipped', title: 'Too large to keep in Viti: it is in your Gmail' }, h('span', { class: 'fi' }, '!'), h('span', { class: 'fn' }, f.name), h('small', {}, size(f.size)))
          : PICTURE.test(f.type)
            ? h('button', { class: 'file pic', title: `${f.name} · ${size(f.size)}`, onclick: () => lightbox(`/api/images/${f.id}`) }, h('img', { src: `/api/images/${f.id}`, alt: f.name, loading: 'lazy' }))
            : h('a', { class: 'file', href: `/api/images/${f.id}`, download: f.name, title: `Save ${f.name}` }, h('span', { class: 'fi' }, (f.name.match(/\.([a-z0-9]{1,4})$/i)?.[1] || 'file').toUpperCase()), h('span', { class: 'fn' }, f.name), h('small', {}, size(f.size))),
      ),
    );
  }

  // ---- writing: a reply (to, "Re:" and the original quoted, threaded with it), a reply to all, or a new email.
  // Sent from the account the mailbox's label is read from (with its signature), after "Send to ... from ...?"
  async compose({ reply, all } = {}) {
    let acc = null;
    try {
      const st = await fetch('/app/mail').then((r) => r.json());
      acc = st.accounts?.find((a) => a.id === st.links?.[this.section]?.account) || null;
    } catch {}
    const me = String(acc?.address || '').toLowerCase();
    const others = (list) => (list || []).filter((a) => a && a.toLowerCase() !== me && a.toLowerCase() !== String(reply?.email || '').toLowerCase());
    const ccList = reply && all ? [...new Set(others([...(reply.rcpt?.to || []), ...(reply.rcpt?.cc || [])]))] : [];
    const to = h('input', { type: 'text', class: 'cm-input', placeholder: 'name@example.com (commas between several)', value: reply ? reply.email : '' });
    const cc = h('input', { type: 'text', class: 'cm-input', placeholder: 'Copy to (optional)', value: ccList.join(', ') });
    const subject = h('input', { type: 'text', class: 'cm-input', placeholder: 'Subject', value: reply ? (/^re:/i.test(reply.subject || '') ? reply.subject : 'Re: ' + bare(reply.subject || '')) : '' });
    const sig = acc?.signature ? `\n\n-- \n${acc.signature}` : '';
    const quote = reply ? `\n\nOn ${stamp(reply.ts)}, ${reply.name || reply.email} wrote:\n> ${reply.message.split('\n').join('\n> ')}` : '';
    const text = h('textarea', { class: 'cm-text', placeholder: 'Write your email…' });
    text.value = sig + quote;
    // attachments: picked files, read in to go with the email (up to 24 MB together)
    let files = [];
    const fileList = h('div', { class: 'cm-files' });
    const drawFiles = () =>
      fileList.replaceChildren(...files.map((f, i) => h('span', { class: 'file' }, h('span', { class: 'fn' }, f.name), h('small', {}, size(f.size)), h('button', { type: 'button', title: 'Leave it out', onclick: () => ((files = files.filter((_, j) => j !== i)), drawFiles()) }, '×'))));
    const picker = h('input', { type: 'file', multiple: true, hidden: true });
    picker.addEventListener('change', () => {
      files.push(...picker.files);
      picker.value = '';
      if (files.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024) toast('Over 24 MB of attachments: Gmail takes up to 25 MB.', true);
      drawFiles();
    });
    const read64 = (f) => new Promise((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1] || '');
      r.onerror = () => bad(new Error(`${f.name} could not be read.`));
      r.readAsDataURL(f);
    });
    const send = h('button', { class: 'btn small' }, 'Send');
    const close = () => ((this.composing = false), this.draw());
    send.addEventListener('click', async () => {
      if (!text.value.trim() || text.value.trim() === (sig + quote).trim()) return toast('Write something first.', true);
      if (!acc) return toast('Link this mailbox to a Gmail label first (the bar above the mailbox).', true);
      const sure = await modal('Send this email?', h('p', {}, 'To ', h('b', {}, to.value.trim()), cc.value.trim() ? [h('br'), 'Cc ', h('b', {}, cc.value.trim())] : null, h('br'), 'From ', h('b', {}, acc.address), h('br'), 'Subject: ', subject.value.trim() || '(no subject)', files.length ? [h('br'), `${files.length} attachment${files.length === 1 ? '' : 's'}`] : null), [
        { label: 'Not yet', value: false },
        { label: 'Send', value: true, primary: true },
      ]);
      if (sure !== true) return;
      send.disabled = true;
      send.textContent = 'Sending…';
      try {
        const attachments = [];
        for (const f of files) attachments.push({ name: f.name, type: f.type, data: await read64(f) });
        const r = await fetch(`/app/mail/send/${this.section}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: to.value, cc: cc.value, toName: reply && reply.email === to.value.trim() ? reply.name : '', subject: subject.value.trim(), text: text.value, reply: reply?.id || '', attachments }) }).then((x) => x.json());
        if (!r.ok) throw new Error(r.error || 'It could not be sent.');
        toast(`Sent from ${r.from}.`);
        this.composing = false;
        if (!reply) this.folder = 'sent';
        this.openId = reply ? reply.id : r.id || null;
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
        h('h2', {}, reply ? (all ? 'Reply to all' : 'Reply') : 'New email'),
        h('label', { class: 'cm-row' }, h('span', {}, 'To'), to),
        h('label', { class: 'cm-row' }, h('span', {}, 'Cc'), cc),
        h('label', { class: 'cm-row' }, h('span', {}, 'Subject'), subject),
        text,
        fileList,
        h('div', { class: 'cm-bar' }, send, h('button', { class: 'btn small ghost', type: 'button', onclick: () => picker.click() }, icon('clip'), ' Attach files'), picker, h('span', { class: 'grow' }), h('button', { class: 'btn small ghost', onclick: close }, 'Discard')),
      ),
    );
    this.root.classList.add('reading');
    (reply ? text : to).focus();
    if (reply) text.setSelectionRange(0, 0);
  }

  // opening a conversation: every unread email of it is read now
  async openMail(id) {
    this.composing = false;
    this.openId = id;
    const m = this.all.get(id);
    if (m) for (const x of this.thread(m)) if (!x.seen && !isSent(x)) this.markSeen(x.id, true);
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
    this.folder = isSent(m) && m.status !== 'trash' ? 'sent' : m.status;
    this.openMail(id);
    this.list_.querySelector(`.mail-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  }
}
