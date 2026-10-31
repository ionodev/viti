// Mail for a project's mailboxes, with Gmail: reading one label of an account you connected, and sending from
// that account (a reply, or a new email: only when you press Send). Viti never moves or deletes anything in
// your mail. Both use an app password (Google account → Security → 2-Step Verification → App passwords):
// IMAP to read, SMTP to send.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

const FIRST = 200; // the first time a label is linked, its newest messages come in (not all its history)

// (VITI_IMAP=host:port lets a test server stand in for Gmail)
const [IMAP_HOST, IMAP_PORT] = (process.env.VITI_IMAP || 'imap.gmail.com:993').split(':');
const imap = ({ address, password }) =>
  new ImapFlow({ host: IMAP_HOST, port: Number(IMAP_PORT), secure: !process.env.VITI_IMAP, auth: { user: address, pass: password.replace(/\s+/g, '') }, logger: false, emitLogs: false, connectionTimeout: 20000, greetingTimeout: 15000 });

async function withImap(cred, fn) {
  const client = imap(cred);
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (e) {
    throw new Error(e.authenticationFailed || /auth/i.test(e.responseText || e.message) ? 'Gmail did not accept the address and app password. Check them (an app password is 16 letters, made in your Google account), and that IMAP is on in Gmail’s settings.' : `Could not reach Gmail: ${e.message}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// the labels of the account: the ones you made first, then Gmail's own (Inbox, and the [Gmail] ones)
export async function folders(cred) {
  return withImap(cred, async (client) => {
    const list = await client.list();
    return list
      .filter((f) => !f.flags?.has('\\Noselect'))
      .map((f) => ({ id: f.path, name: f.path === 'INBOX' ? 'Inbox' : f.path.replace(/^\[Gmail\]\//, ''), own: !f.specialUse && f.path !== 'INBOX' }))
      .sort((a, b) => (b.own - a.own) || a.name.localeCompare(b.name));
  });
}

// the messages in the label newer than what came in before: { state, messages }. One you sent yourself is
// marked "own" (Gmail puts your reply in the label of the conversation it belongs to), with whom it went to.
export async function fetchNew(cred, folder, state = {}) {
  const me = String(cred.address || '').toLowerCase();
  return withImap(cred, async (client) => {
    const box = await client.mailboxOpen(folder, { readOnly: true });
    const same = state.uidValidity && String(state.uidValidity) === String(box.uidValidity);
    const after = same ? state.lastUid || 0 : 0;
    const out = [];
    let lastUid = after;
    if (box.exists) {
      // first time: the newest FIRST; after that: everything with a higher UID
      const range = after ? `${after + 1}:*` : `${Math.max(1, box.exists - FIRST + 1)}:*`;
      for await (const m of client.fetch(range, { uid: true, source: true, internalDate: true }, { uid: !!after })) {
        if (m.uid <= after) continue; // (an IMAP range "n:*" always gives the last message, even an old one)
        lastUid = Math.max(lastUid, m.uid);
        // (pictures inside the email stay "cid:" links: Viti points them at its own copy)
        const p = await simpleParser(m.source, { skipImageLinks: true });
        const from = p.from?.value?.[0] || {};
        const people = (v) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.value || []);
        const to = people(p.to);
        const cc = people(p.cc);
        const own = String(from.address || '').toLowerCase() === me;
        const ref = p.messageId || `gmail:${folder}:${box.uidValidity}:${m.uid}`;
        // the conversation it belongs to: the first email of it (References), else the one it answers, else itself
        const refs = Array.isArray(p.references) ? p.references : p.references ? String(p.references).split(/\s+/) : [];
        const msg = {
          ref,
          name: from.name || '',
          email: from.address || '',
          subject: p.subject || '',
          text: (p.text || '').trim() || htmlToText(p.html || ''),
          html: typeof p.html === 'string' ? p.html : '',
          attachments: (p.attachments || []).map((a) => ({ name: a.filename || 'attachment', type: a.contentType || '', content: a.content, cid: a.contentId ? String(a.contentId).replace(/^<|>$/g, '') : '' })),
          rcpt: { to: to.map((x) => x.address).filter(Boolean), cc: cc.map((x) => x.address).filter(Boolean) },
          thread: refs[0] || p.inReplyTo || ref,
          ts: (p.date || m.internalDate || new Date()).getTime(),
        };
        out.push(own ? { ...msg, own: true, to: to.map((x) => x.address).filter(Boolean).join(', '), toName: to.length === 1 ? to[0].name || '' : '' } : unforward(msg));
      }
    }
    return { state: { uidValidity: String(box.uidValidity), lastUid }, messages: out };
  });
}

// sending: Gmail's outgoing server (SMTP), with the same app password (VITI_SMTP=host:port: a test server).
// msg: { to, cc, subject, text, inReplyTo, references, attachments: [{ name, type, content }] } -> { messageId }
const [SMTP_HOST, SMTP_PORT] = (process.env.VITI_SMTP || 'smtp.gmail.com:465').split(':');
export async function send(cred, msg) {
  const t = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: !process.env.VITI_SMTP, ignoreTLS: !!process.env.VITI_SMTP, auth: { user: cred.address, pass: cred.password.replace(/\s+/g, '') }, connectionTimeout: 20000 });
  try {
    const info = await t.sendMail({ from: cred.address, to: msg.to, cc: msg.cc || undefined, subject: msg.subject, text: msg.text, inReplyTo: msg.inReplyTo || undefined, references: msg.references || undefined, attachments: (msg.attachments || []).map((a) => ({ filename: a.name, contentType: a.type || undefined, content: a.content })) });
    return { messageId: info.messageId };
  } catch (e) {
    throw new Error(e.responseCode === 535 || /auth/i.test(e.message) ? 'Gmail did not accept the app password for sending. Connect the account again with a new one.' : `Gmail could not send it: ${e.message}`);
  }
}

// A forwarded email (a mail rule that forwards, say) comes from whoever forwarded it; the one who wrote it is
// in the forwarded header in the text. Shown as from them, with their subject, and the text without that
// header (as Gmail writes it, and other mail programs, in English and Norwegian).
const FWD = /^\s*(?:(?:fw|fwd|vs|wg|tr|rv)\s*:\s*)+/i;
const HEADER = /(?:^|\n)[ \t>*]*(?:From|Fra|Von|De)[ \t*]*:[ \t*]*([^\n]+)\n([\s\S]{0,600}?)\n[ \t>*]*(?:Subject|Emne|Betreff|Objet)[ \t*]*:[ \t*]*([^\n]*)\n/i;
const MORE = /^(?:[ \t>*]*(?:To|Til|Cc|Kopi|Date|Dato|Sent|Sendt)[ \t*]*:[^\n]*\n)+/i;
export function unforward(m) {
  if (!FWD.test(m.subject || '')) return m;
  const t = String(m.text || '').replace(/\r\n/g, '\n');
  const h = t.match(HEADER);
  if (!h) return { ...m, subject: m.subject.replace(FWD, '') };
  const who = h[1].trim();
  const at = who.match(/<([^>\s]+@[^>\s]+)>|\[mailto:([^\]\s]+)\]|([^\s<>"'()\[\]]+@[^\s<>"'()\[\]]+)/);
  const email = (at && (at[1] || at[2] || at[3])) || m.email;
  const name = who.replace(/<[^>]*>|\[mailto:[^\]]*\]/g, '').replace(/["']/g, '').trim();
  const body = t.slice(h.index + h[0].length).replace(MORE, '').trim();
  return { ...m, name: name && name !== email ? name : '', email, subject: h[3].trim() || m.subject.replace(FWD, ''), text: body || t };
}

// an HTML-only email as plain text
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
