// Mail for a project's mailboxes: reading one folder (a Gmail label, an Outlook folder) of an email account you
// connected, and sending from that account (a reply, or a new email: only when you press Send). Viti never
// moves or deletes anything in your mail.
//   Gmail:   IMAP with an app password (Google account → Security → 2-Step Verification → App passwords)
//   Outlook: Microsoft Graph, after "Sign in with Microsoft" (the device flow, like the GitHub sign-in)
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { MICROSOFT_CLIENT_ID, MICROSOFT_SCOPE } from './microsoft-app.js';

const FIRST = 200; // the first time a folder is linked, its newest messages come in (not all its history)
const MS_LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// ------------------------------------------------------------------ Gmail (IMAP)
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

export async function gmailFolders(cred) {
  return withImap(cred, async (client) => {
    const list = await client.list();
    // labels you made first, then Gmail's own (Inbox, and the [Gmail] ones)
    return list
      .filter((f) => !f.flags?.has('\\Noselect'))
      .map((f) => ({ id: f.path, name: f.path === 'INBOX' ? 'Inbox' : f.path.replace(/^\[Gmail\]\//, ''), own: !f.specialUse && f.path !== 'INBOX' }))
      .sort((a, b) => (b.own - a.own) || a.name.localeCompare(b.name));
  });
}

// the messages in the folder newer than what came in before: { state, messages }
async function gmailFetch(cred, folder, state = {}) {
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
        const p = await simpleParser(m.source);
        const from = p.from?.value?.[0] || {};
        out.push(unforward({ ref: p.messageId || `gmail:${folder}:${box.uidValidity}:${m.uid}`, name: from.name || '', email: from.address || '', subject: p.subject || '', text: (p.text || '').trim() || htmlToText(p.html || ''), ts: (p.date || m.internalDate || new Date()).getTime() }));
      }
    }
    return { state: { uidValidity: String(box.uidValidity), lastUid }, messages: out };
  });
}

// sending with Gmail: its outgoing server (SMTP), with the same app password (VITI_SMTP=host:port: a test server)
const [SMTP_HOST, SMTP_PORT] = (process.env.VITI_SMTP || 'smtp.gmail.com:465').split(':');
async function gmailSend(cred, msg) {
  const t = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: !process.env.VITI_SMTP, ignoreTLS: !!process.env.VITI_SMTP, auth: { user: cred.address, pass: cred.password.replace(/\s+/g, '') }, connectionTimeout: 20000 });
  try {
    const info = await t.sendMail({ from: cred.address, to: msg.to, cc: msg.cc || undefined, subject: msg.subject, text: msg.text, inReplyTo: msg.inReplyTo || undefined, references: msg.references || undefined });
    return { messageId: info.messageId };
  } catch (e) {
    throw new Error(e.responseCode === 535 || /auth/i.test(e.message) ? 'Gmail did not accept the app password for sending. Connect the account again with a new one.' : `Gmail could not send it: ${e.message}`);
  }
}

// ------------------------------------------------------------------ Outlook (Microsoft Graph)
async function msPost(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params) });
  return r.json().catch(() => ({}));
}
export const outlookReady = () => !!MICROSOFT_CLIENT_ID;
export async function outlookStart() {
  const r = await msPost(`${MS_LOGIN}/devicecode`, { client_id: MICROSOFT_CLIENT_ID, scope: MICROSOFT_SCOPE });
  if (!r.device_code) throw new Error(`Microsoft did not start the sign-in${r.error_description ? ': ' + r.error_description.split('\r\n')[0] : '.'}`);
  return r;
}
// one look: { status: 'pending' | 'done' | 'denied' | 'expired', refresh, address }
export async function outlookPoll(deviceCode) {
  const r = await msPost(`${MS_LOGIN}/token`, { client_id: MICROSOFT_CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  if (r.access_token) {
    const me = await fetch(`${GRAPH}/me`, { headers: { authorization: `Bearer ${r.access_token}` } }).then((x) => x.json());
    return { status: 'done', refresh: r.refresh_token, address: me.mail || me.userPrincipalName || '' };
  }
  if (r.error === 'authorization_pending' || r.error === 'slow_down') return { status: 'pending', slow: r.error === 'slow_down' };
  return { status: r.error === 'authorization_declined' ? 'denied' : 'expired' };
}
// a fresh access token (Microsoft hands out a new refresh token too: it is kept)
async function outlookToken(cred, keep) {
  const r = await msPost(`${MS_LOGIN}/token`, { client_id: MICROSOFT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: cred.refresh, scope: MICROSOFT_SCOPE });
  if (!r.access_token) throw new Error('Microsoft wants you to sign in again (remove this account in Mail settings and connect it again).');
  if (r.refresh_token && r.refresh_token !== cred.refresh) keep({ ...cred, refresh: r.refresh_token });
  return r.access_token;
}
async function graph(token, path) {
  const r = await fetch(path.startsWith('http') ? path : GRAPH + path, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.body-content-type="text"' } });
  if (!r.ok) throw new Error(`Outlook answered ${r.status}`);
  return r.json();
}
async function graphPost(token, path, body) {
  const r = await fetch(GRAPH + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Outlook could not send it (${r.status}).`);
}
// sending with Outlook: a reply to the original when it is in the mailbox (so it threads), or else a new email
async function outlookSend(cred, msg, keep) {
  const token = await outlookToken(cred, keep);
  const people = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
  const message = { subject: msg.subject, body: { contentType: 'Text', content: msg.text }, toRecipients: people(msg.to), ccRecipients: people(msg.cc) };
  if (msg.inReplyTo) {
    const found = await graph(token, `/me/messages?$filter=internetMessageId eq '${msg.inReplyTo.replace(/'/g, "''")}'&$select=id&$top=1`).catch(() => null);
    const id = found?.value?.[0]?.id;
    if (id) return graphPost(token, `/me/messages/${id}/reply`, { message }).then(() => ({ messageId: '' }));
  }
  await graphPost(token, '/me/sendMail', { message, saveToSentItems: true });
  return { messageId: '' };
}

export async function outlookFolders(cred, keep) {
  const token = await outlookToken(cred, keep);
  const out = [];
  const walk = async (path, prefix, depth) => {
    for (let url = path; url; ) {
      const page = await graph(token, url);
      for (const f of page.value || []) {
        out.push({ id: f.id, name: prefix + f.displayName, own: !f.wellKnownName });
        if (f.childFolderCount && depth < 2) await walk(`/me/mailFolders/${f.id}/childFolders?$top=100`, `${prefix}${f.displayName}/`, depth + 1);
      }
      url = page['@odata.nextLink'];
    }
  };
  await walk('/me/mailFolders?$top=100', '', 0);
  return out.sort((a, b) => (b.own - a.own) || a.name.localeCompare(b.name));
}
async function outlookFetch(cred, folder, state = {}, keep) {
  const token = await outlookToken(cred, keep);
  const sel = '$select=id,internetMessageId,subject,from,receivedDateTime,body';
  let rows = [];
  if (!state.since) {
    const page = await graph(token, `/me/mailFolders/${folder}/messages?$top=${FIRST}&$orderby=receivedDateTime desc&${sel}`);
    rows = (page.value || []).reverse();
  } else {
    for (let url = `/me/mailFolders/${folder}/messages?$top=100&$orderby=receivedDateTime asc&$filter=receivedDateTime gt ${state.since}&${sel}`; url; ) {
      const page = await graph(token, url);
      rows.push(...(page.value || []));
      url = page['@odata.nextLink'];
    }
  }
  const messages = rows.map((m) => unforward({ ref: m.internetMessageId || `outlook:${m.id}`, name: m.from?.emailAddress?.name || '', email: m.from?.emailAddress?.address || '', subject: m.subject || '', text: (m.body?.content || '').trim(), ts: Date.parse(m.receivedDateTime) || Date.now() }));
  const since = rows.length ? rows[rows.length - 1].receivedDateTime : state.since || new Date().toISOString();
  return { state: { since }, messages };
}

// ------------------------------------------------------------------ either
export const folders = (account, cred, keep) => (account.provider === 'gmail' ? gmailFolders(cred) : outlookFolders(cred, keep));
export const fetchNew = (account, cred, folder, state, keep) => (account.provider === 'gmail' ? gmailFetch(cred, folder, state) : outlookFetch(cred, folder, state, keep));
// msg: { to, cc, subject, text, inReplyTo, references } -> { messageId }
export const send = (account, cred, msg, keep) => (account.provider === 'gmail' ? gmailSend(cred, msg) : outlookSend(cred, msg, keep));

// A forwarded email (an Outlook rule that forwards, say) comes from whoever forwarded it; the one who
// wrote it is in the forwarded header in the text. Shown as from them, with their subject, and the text
// without that header. Outlook (English, Norwegian) and Gmail write that header.
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
