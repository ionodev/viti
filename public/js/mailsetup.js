// Where a mailbox's email comes from: one folder (a Gmail label, an Outlook folder) of an email account you
// connected. The bar above the mailbox says which (or offers to link one), fetches now on request, and the
// dialogs connect Gmail (an app password) or Outlook (Sign in with Microsoft) and pick the folder.
// What is linked, and the accounts, are kept by the app on this computer (/app/mail/*, app/mail.js).
import { h, ago, toast, modal } from './ui.js';

const PROVIDER = { gmail: 'Gmail', outlook: 'Outlook' };
const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';

async function call(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || data.message || `Something went wrong (${r.status}).`);
  return data;
}
// a dialog whose main button does the work and only closes when it worked (errors are shown in it)
function working(title, body, label, work) {
  const err = h('p', { class: 'mail-err', hidden: true });
  body.append(err);
  const done = modal(title, body, [
    { label: 'Cancel', value: false },
    { label, value: true, primary: true },
  ]);
  const overlay = document.querySelector('.overlay:last-of-type');
  const ok = overlay.querySelector('.actions .btn:not(.ghost)');
  ok.addEventListener(
    'click',
    async (e) => {
      e.stopImmediatePropagation();
      err.hidden = true;
      ok.disabled = true;
      const was = ok.textContent;
      ok.textContent = 'One moment…';
      try {
        const v = await work();
        overlay._close(v ?? true);
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        ok.disabled = false;
        ok.textContent = was;
      }
    },
    true,
  );
  body.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && ok.click()));
  return { done, overlay };
}

// the bar above a mailbox
export function sourceBar(section) {
  const bar = h('div', { class: 'mail-source' });
  const draw = async () => {
    let st;
    try {
      st = await call('GET', '/app/mail');
    } catch {
      return bar.replaceChildren();
    }
    const link = st.links[section];
    const acc = link && st.accounts.find((a) => a.id === link.account);
    if (!link || !acc) {
      bar.replaceChildren(h('span', { class: 'ms-text' }, h('b', {}, 'No email folder linked'), h('small', {}, st.private ? 'Link a Gmail label or Outlook folder, and its mail comes in here.' : 'This repository is public, so Viti does not put email in it.')), st.private ? h('button', { class: 'btn small', onclick: () => link_(section, st).then(draw) }, 'Link a folder') : null);
      return;
    }
    const when = link.fetched ? `checked ${ago(link.fetched)}` : 'not checked yet';
    const fetchNow = h('button', { class: 'ms-btn', title: 'Look for new mail now', onclick: async () => {
      fetchNow.disabled = true;
      fetchNow.classList.add('spinning');
      try {
        const r = await call('POST', `/app/mail/fetch/${section}`);
        toast(r.error ? r.error : r.added ? `${r.added} new email${r.added === 1 ? '' : 's'}.` : 'No new mail.', !!r.error);
      } catch (x) {
        toast(x.message, true);
      }
      draw();
    } }, '↻');
    bar.replaceChildren(
      h('span', { class: 'ms-icon ' + acc.provider }, PROVIDER[acc.provider].charAt(0)),
      h('span', { class: 'ms-text' }, h('b', {}, link.folderName), h('small', { title: link.error || '' }, `${PROVIDER[acc.provider]} · ${acc.address} · `, link.error ? h('span', { class: 'ms-bad' }, 'could not check') : when)),
      fetchNow,
      h('button', { class: 'ms-btn', title: 'Link another folder, or unlink', onclick: () => link_(section, st).then(draw) }, '⚙'),
    );
  };
  draw();
  bar.refresh = draw;
  return bar;
}

// link a folder to this mailbox: pick (or connect) an account, then one of its folders
async function link_(section, st) {
  const current = st.links[section];
  const list = h('div', { class: 'ms-accounts' });
  let chosen = current?.account || st.accounts[0]?.id || null;
  const paint = () =>
    list.replaceChildren(
      ...(st.accounts.length
        ? st.accounts.map((a) =>
            h('label', { class: 'ms-acc' + (a.id === chosen ? ' on' : '') }, h('input', { type: 'radio', name: 'acc', checked: a.id === chosen, onchange: () => ((chosen = a.id), paint()) }), h('span', { class: 'ms-icon ' + a.provider }, PROVIDER[a.provider].charAt(0)), h('span', {}, h('b', {}, a.address), h('small', {}, PROVIDER[a.provider]))),
          )
        : [h('p', { class: 'ms-none' }, 'No email account connected yet.')]),
    );
  paint();
  const add = async (fn) => {
    const acc = await fn();
    if (!acc) return;
    if (!st.accounts.some((a) => a.id === acc.id)) st.accounts.push(acc);
    chosen = acc.id;
    paint();
  };
  const body = h(
    'div',
    { class: 'ms-dialog' },
    h('p', {}, 'Viti reads one folder of your email (a Gmail label or an Outlook folder) into this mailbox, every couple of minutes while Viti is open. It never sends, moves or deletes your mail. What comes in is backed up to the repository with the rest of the project.'),
    h('label', {}, 'Account'),
    list,
    h('div', { class: 'ms-connect' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () => add(connectGmail) }, '+ Connect Gmail'), st.outlook ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => add(connectOutlook) }, '+ Connect Outlook') : h('span', { class: 'ms-soon', title: 'Outlook needs Viti registered with Microsoft first' }, 'Outlook: coming soon')),
    current ? h('p', { class: 'ms-unlink' }, h('a', { href: '#', onclick: async (e) => (e.preventDefault(), await call('DELETE', `/app/mail/links/${section}`), document.querySelector('.overlay:last-of-type')?._close(true)) }, 'Unlink this mailbox'), ' (the mail already here stays).') : null,
  );
  const { done } = working('Link an email folder', body, 'Next: pick a folder', async () => {
    if (!chosen) throw new Error('Connect an email account first.');
    return chosen;
  });
  const account = await done;
  if (!account || account === true) return;
  return pickFolder(section, st.accounts.find((a) => a.id === account));
}

async function pickFolder(section, acc) {
  const search = h('input', { type: 'text', placeholder: 'Search folders…' });
  const list = h('div', { class: 'ms-folders' }, h('p', { class: 'ms-none' }, 'Getting the folders…'));
  let folders = [];
  let chosen = null;
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = folders.filter((f) => !q || f.name.toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map((f) => h('button', { type: 'button', class: 'ms-folder' + (chosen?.id === f.id ? ' on' : ''), onclick: () => ((chosen = f), paint()) }, f.name)) : [h('p', { class: 'ms-none' }, folders.length ? 'No folder matches.' : 'No folders found.')]));
  };
  search.addEventListener('input', paint);
  const body = h('div', { class: 'ms-dialog' }, h('p', {}, acc.provider === 'gmail' ? 'Pick the label to read. Tip: make one called "Viti" in Gmail, and a filter that puts the right mail in it.' : 'Pick the folder to read. Tip: make one called "Viti" in Outlook, and a rule that moves the right mail to it.'), search, list);
  call('GET', `/app/mail/accounts/${acc.id}/folders`)
    .then((r) => ((folders = r.folders), (chosen = folders.find((f) => /^viti$/i.test(f.name)) || null), paint()))
    .catch((x) => list.replaceChildren(h('p', { class: 'mail-err' }, x.message)));
  const { done } = working(`Pick a folder · ${acc.address}`, body, 'Link and fetch', async () => {
    if (!chosen) throw new Error('Pick a folder.');
    const r = await call('PUT', `/app/mail/links/${section}`, { account: acc.id, folder: chosen.id, folderName: chosen.name });
    toast(r.error ? r.error : r.added ? `Linked. ${r.added} email${r.added === 1 ? '' : 's'} came in.` : 'Linked. The folder is empty for now.', !!r.error);
  });
  return done;
}

// Gmail: the address and an app password
async function connectGmail() {
  const address = h('input', { type: 'text', placeholder: 'you@gmail.com', autocomplete: 'off' });
  const password = h('input', { type: 'password', placeholder: 'abcd efgh ijkl mnop', autocomplete: 'off' });
  const body = h(
    'div',
    { class: 'ms-dialog' },
    h('label', {}, 'Gmail address'),
    address,
    h('label', {}, 'App password'),
    password,
    h(
      'details',
      { class: 'ms-how' },
      h('summary', {}, 'How to get an app password'),
      h(
        'ol',
        {},
        h('li', {}, 'Your Google account needs 2-Step Verification turned on (Google account › Security).'),
        h('li', {}, 'Open ', h('a', { href: APP_PASSWORDS, target: '_blank' }, 'App passwords'), ', type "Viti" as the name, and press Create.'),
        h('li', {}, 'Copy the 16 letters Google shows and paste them here. Viti keeps them encrypted on this computer, and uses them only to read the folder you pick.'),
      ),
    ),
  );
  setTimeout(() => address.focus(), 0);
  const { done } = working('Connect Gmail', body, 'Connect', async () => (await call('POST', '/app/mail/gmail', { address: address.value, password: password.value })).account);
  const acc = await done;
  return acc && acc !== true ? acc : null;
}

// Outlook: "Sign in with Microsoft" (a code to enter at microsoft.com/devicelogin)
async function connectOutlook() {
  let start;
  try {
    start = await call('POST', '/app/mail/outlook/start');
  } catch (x) {
    return toast(x.message, true), null;
  }
  const status = h('p', { class: 'ms-status' }, 'Waiting for you to approve Viti at Microsoft…');
  const open = () => (navigator.clipboard?.writeText(start.userCode).catch(() => {}), window.open(start.url));
  const body = h('div', { class: 'ms-dialog ms-device' }, h('p', {}, 'Enter this code at Microsoft and sign in with your Outlook account, then approve Viti (it reads the folder you pick).'), h('div', { class: 'ms-code' }, start.userCode), h('button', { class: 'btn', type: 'button', onclick: open }, 'Copy the code and open Microsoft'), status);
  let account = null;
  const done = modal('Connect Outlook', body, [{ label: 'Cancel', value: false }]);
  const overlay = document.querySelector('.overlay:last-of-type');
  open();
  const poll = async () => {
    if (!overlay.isConnected) return;
    const r = await call('POST', '/app/mail/outlook/poll').catch(() => ({ status: 'pending' }));
    if (r.status === 'pending') return setTimeout(poll, (r.interval || start.interval || 5) * 1000);
    if (r.status === 'done') return (account = r.account), overlay._close(true);
    status.textContent = r.status === 'denied' ? 'The sign-in was cancelled at Microsoft.' : r.error || 'The code ran out. Close this and try again.';
    status.classList.add('bad');
  };
  setTimeout(poll, (start.interval || 5) * 1000);
  await done;
  return account;
}
