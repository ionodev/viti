// The home screen: your projects (GitHub repositories). Sign in with GitHub once, then connect a
// repository by picking it from yours; open one, or take one off the list. (A token pasted by hand still
// works, for a repository the sign-in cannot reach.) Talks to the app's own server (/app/*, app/server.js).
import { h, ago, toast, modal, menu } from '/js/ui.js';
import { appearanceControls } from '/js/appearance.js';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
let state = { projects: [] };

async function call(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || data.message || `Something went wrong (${r.status}).`);
  return data;
}

async function load() {
  state = await call('GET', '/app/state');
  drawAccount();
  draw();
}

// top right: who you are signed in as (click for Sign out), or the button to sign in
function drawAccount() {
  const box = document.getElementById('account');
  const a = state.account;
  if (a) {
    box.replaceChildren(
      h('button', { class: 'account', title: 'Signed in with GitHub', onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.left, r.bottom + 4, [{ label: `Signed in as ${a.login}`, fn: () => window.open(`https://github.com/${a.login}`) }, { label: 'Sign out', danger: true, fn: signOut }]);
      } }, a.avatar ? h('img', { src: a.avatar, alt: '' }) : null, h('span', {}, a.name || a.login)),
    );
  } else box.replaceChildren(state.canSignIn ? h('button', { class: 'btn ghost small', onclick: () => signIn() }, 'Sign in with GitHub') : '');
}
async function signOut() {
  const r = await modal('Sign out?', h('p', {}, 'Viti forgets your GitHub sign-in on this computer. Your projects stay, but they cannot read branches or back up until you sign in again.'), [
    { label: 'Cancel', value: false },
    { label: 'Sign out', value: true, danger: true },
  ]);
  if (r !== true) return;
  await call('POST', '/app/signout');
  load();
}

function draw() {
  const list = document.getElementById('projects');
  if (!state.projects.length) {
    list.replaceChildren(
      h('div', { class: 'empty' }, h('span', { class: 'cairn-mark' }), h('h2', {}, 'Connect your first repository'), h('p', {}, 'Pick a GitHub repository you work on. Viti gives it boards, a chat, a to-do list, reports, a calendar and a progress cairn, and backs it all up to the repository.'), h('button', { class: 'btn', onclick: connect }, 'Connect a repository')),
    );
    return;
  }
  list.replaceChildren(...state.projects.map(card), h('button', { class: 'proj-add', onclick: connect }, h('span', { class: 'plus' }, '+'), 'Connect a repository'));
}

function card(p) {
  const [owner, name] = p.repo.split('/');
  const more = h('button', { class: 'proj-more', title: 'More', onclick: (e) => (e.stopPropagation(), projectMenu(e, p)) }, '⋯');
  return h(
    'div',
    { class: 'proj' + (p.open ? ' open' : ''), role: 'button', tabindex: '0', onclick: () => open(p), onkeydown: (e) => e.key === 'Enter' && open(p) },
    more,
    h('div', { class: 'proj-top' }, h('span', { class: 'proj-tile' }, name.charAt(0).toUpperCase()), h('span', { class: 'proj-name' }, h('b', {}, name), h('small', {}, owner))),
    h('div', { class: 'proj-meta' }, h('span', { class: 'tag' }, p.private ? 'Private' : 'Public'), p.open ? h('span', { class: 'tag live' }, 'Open now') : null, p.hasToken ? null : h('span', { class: 'tag warn' }, 'Not signed in')),
    h('div', { class: 'proj-foot' }, h('span', { class: 'who' }, p.user?.avatar ? h('img', { src: p.user.avatar, alt: '' }) : null, h('span', {}, p.user?.name || '')), h('span', {}, p.opened ? `Opened ${ago(p.opened)}` : 'Not opened yet')),
  );
}

function projectMenu(e, p) {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left - 140, r.bottom + 4, [
    { label: 'Open', fn: () => open(p) },
    { label: 'Open on GitHub', fn: () => window.open(`https://github.com/${p.repo}`) },
    { label: 'Use a token…', fn: () => newToken(p) },
    { label: 'Remove from Viti…', danger: true, fn: () => remove(p) },
  ]);
}

// opening a project: its first time on this computer it is fetched from its backup on GitHub
async function open(p) {
  const busy = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, h('div', { class: 'spin' }), h('b', {}, `Opening ${p.repo}`), h('span', {}, p.opened ? 'One moment…' : 'Getting what is backed up on GitHub…')));
  document.body.append(busy);
  try {
    await call('POST', `/app/open/${p.id}`);
    location.href = '/';
  } catch (err) {
    busy.remove();
    toast(err.message, true);
  }
}

function tokenHelp(repo) {
  return h(
    'details',
    { class: 'how' },
    h('summary', {}, 'How to make a token'),
    h(
      'ol',
      {},
      h('li', {}, 'On GitHub, open ', h('a', { href: TOKEN_URL, target: '_blank' }, 'Settings › Developer settings › Fine-grained tokens › Generate new token'), '.'),
      h('li', {}, 'Name it (for example "Viti"), and pick how long it should last.'),
      h('li', {}, 'Under ', h('b', {}, 'Repository access'), ', choose ', h('b', {}, 'Only select repositories'), ' and pick ', repo ? h('b', {}, repo) : 'the repository', '.'),
      h('li', {}, 'Under ', h('b', {}, 'Permissions › Repository permissions'), ', set ', h('b', {}, 'Contents'), ' to ', h('b', {}, 'Read and write'), '.'),
      h('li', {}, 'Generate it, copy it, and paste it here. It is kept encrypted on this computer only.'),
    ),
  );
}

// connecting: sign in first if need be, then pick a repository
async function connect() {
  if (state.account) return pickRepo();
  if (state.canSignIn) return signIn(pickRepo);
  return connectWithToken();
}

// "Sign in with GitHub": Viti shows a code, opens github.com/login/device, and waits while you enter it there
async function signIn(after) {
  let start;
  try {
    start = await call('POST', '/app/signin/start');
  } catch (e) {
    return toast(e.message, true);
  }
  const code = h('div', { class: 'device-code' }, start.userCode);
  const status = h('p', { class: 'device-status' }, h('span', { class: 'spin small' }), 'Waiting for you to approve Viti on GitHub…');
  const openGitHub = () => {
    navigator.clipboard?.writeText(start.userCode).catch(() => {});
    window.open(start.url);
  };
  const body = h(
    'div',
    { class: 'device' },
    h('p', {}, 'Enter this code on GitHub to let Viti work with your repositories. It reads their branches and keeps its backup in a branch of its own; your code is never changed.'),
    code,
    h('button', { class: 'btn', type: 'button', onclick: openGitHub }, 'Copy the code and open GitHub'),
    h('p', { class: 'device-note' }, 'This is not your authenticator code. If GitHub first asks you to log in, use your password and authenticator as usual; then paste this code (it is copied) and press Authorize.'),
    status,
  );
  let done = false;
  const box = modal('Sign in with GitHub', body, [{ label: 'Cancel', value: false }]);
  const overlay = document.querySelector('.overlay:last-of-type');
  openGitHub();
  // ask GitHub every few seconds until you have approved (or said no, or the code ran out)
  let wait = (start.interval || 5) * 1000;
  const poll = async () => {
    if (!overlay.isConnected) return;
    let r;
    try {
      r = await call('POST', '/app/signin/poll');
    } catch (e) {
      r = { status: 'pending' };
    }
    if (r.status === 'pending') {
      wait = (r.interval || start.interval || 5) * 1000;
      return setTimeout(poll, wait);
    }
    if (r.status === 'done') {
      done = true;
      overlay._close(true);
      await load();
      toast(`Signed in as ${r.account.login}.`);
      return after?.();
    }
    status.replaceChildren(r.status === 'denied' ? 'The sign-in was cancelled on GitHub.' : r.status === 'failed' ? r.error || 'The sign-in did not work.' : 'The code ran out. Close this and sign in again.');
    status.classList.add('bad');
  };
  setTimeout(poll, wait);
  await box;
  return done;
}

// picking one of your repositories (the ones you can write to, most recently pushed first)
async function pickRepo() {
  const search = h('input', { type: 'text', placeholder: 'Search your repositories…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'repo-list' }, h('div', { class: 'repo-empty' }, h('span', { class: 'spin small' }), 'Getting your repositories…'));
  const err = h('p', { class: 'err', hidden: true });
  let repos = [];
  const body = h(
    'div',
    {},
    search,
    list,
    err,
    h('p', { class: 'repo-other' }, 'Not on the list? ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), overlay._close(false), connectWithToken()) }, 'Connect it with a token instead'), '.'),
  );
  const box = modal('Connect a repository', body, [{ label: 'Cancel', value: false }]);
  const overlay = document.querySelector('.overlay:last-of-type');
  overlay.querySelector('.dialog').classList.add('wide');
  const pick = async (r) => {
    if (r.added) return;
    err.hidden = true;
    list.classList.add('busy-list');
    try {
      const out = await call('POST', '/app/projects', { repo: r.repo });
      overlay._close(true);
      await load();
      const p = state.projects.find((x) => x.id === out.id);
      if (p) open(p);
    } catch (x) {
      list.classList.remove('busy-list');
      err.textContent = x.message;
      err.hidden = false;
    }
  };
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = repos.filter((r) => !q || r.repo.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)).slice(0, 200);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((r) => {
            const [owner, name] = r.repo.split('/');
            return h(
              'button',
              { type: 'button', class: 'repo-row' + (r.added ? ' added' : ''), onclick: () => pick(r), title: r.added ? 'Already on your list' : `Connect ${r.repo}` },
              h('span', { class: 'proj-tile small' }, name.charAt(0).toUpperCase()),
              h('span', { class: 'repo-name' }, h('b', {}, name), h('small', {}, owner + (r.description ? ' · ' + r.description : ''))),
              h('span', { class: 'tag' }, r.added ? 'Added' : r.private ? 'Private' : 'Public'),
            );
          })
        : [h('div', { class: 'repo-empty' }, repos.length ? 'No repository matches.' : 'No repositories you can write to were found.')]),
    );
  };
  search.addEventListener('input', paint);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = list.querySelector('.repo-row:not(.added)');
    first?.click();
  });
  setTimeout(() => search.focus(), 0);
  call('GET', '/app/repos')
    .then((r) => {
      repos = r.repos || [];
      paint();
    })
    .catch((x) => {
      list.replaceChildren();
      err.textContent = x.message;
      err.hidden = false;
    });
  await box;
}

// the other way: a repository's name and a token made by hand (for one the sign-in cannot reach)
async function connectWithToken() {
  const repo = h('input', { type: 'text', placeholder: 'owner/name, or https://github.com/owner/name', autocomplete: 'off', spellcheck: 'false' });
  const token = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' });
  const err = h('p', { class: 'err', hidden: true });
  const body = h(
    'div',
    {},
    h('p', {}, 'Viti reads the repository’s branches and backs your project up to a branch of its own. Your code is never changed.'),
    h('div', { class: 'field' }, h('label', {}, 'Repository'), repo),
    h('div', { class: 'field' }, h('label', {}, 'GitHub token'), token, h('small', {}, 'A fine-grained token with Contents: Read and write on this repository.')),
    tokenHelp(),
    err,
  );
  // the dialog stays open until it works (or is cancelled): errors are shown in it
  const box = modal('Connect with a token', body, [
    { label: 'Cancel', value: false },
    { label: 'Connect', value: true, primary: true },
  ]);
  const overlay = document.querySelector('.overlay:last-of-type');
  const ok = overlay.querySelector('.actions .btn:not(.ghost)');
  ok.addEventListener(
    'click',
    async (e) => {
      e.stopImmediatePropagation();
      err.hidden = true;
      ok.disabled = true;
      ok.textContent = 'Checking…';
      try {
        const r = await call('POST', '/app/projects', { repo: repo.value, token: token.value });
        overlay._close(true);
        await load();
        const p = state.projects.find((x) => x.id === r.id);
        if (p) open(p);
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        ok.disabled = false;
        ok.textContent = 'Connect';
      }
    },
    true,
  );
  [repo, token].forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && ok.click()));
  setTimeout(() => repo.focus(), 0);
  await box;
}

async function newToken(p) {
  const token = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' });
  const err = h('p', { class: 'err', hidden: true });
  const body = h('div', {}, h('p', {}, `A new token for ${p.repo} (when the old one has expired, or was made for another repository).`), h('div', { class: 'field' }, h('label', {}, 'GitHub token'), token), tokenHelp(p.repo), err);
  const box = modal('New token', body, [
    { label: 'Cancel', value: false },
    { label: 'Save', value: true, primary: true },
  ]);
  const overlay = document.querySelector('.overlay:last-of-type');
  const ok = overlay.querySelector('.actions .btn:not(.ghost)');
  ok.addEventListener(
    'click',
    async (e) => {
      e.stopImmediatePropagation();
      ok.disabled = true;
      try {
        await call('PATCH', `/app/projects/${p.id}`, { token: token.value });
        overlay._close(true);
        toast('Saved. The token works.');
        load();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        ok.disabled = false;
      }
    },
    true,
  );
  token.addEventListener('keydown', (e) => e.key === 'Enter' && ok.click());
  await box;
}

async function remove(p) {
  const r = await modal(`Remove ${p.repo}?`, h('p', {}, 'It is taken off your list and its copy on this computer is deleted. What was backed up stays on GitHub, so connecting it again brings it all back.'), [
    { label: 'Cancel', value: false },
    { label: 'Remove', value: true, danger: true },
  ]);
  if (r !== true) return;
  try {
    await call('DELETE', `/app/projects/${p.id}`);
    toast(`${p.repo} was removed.`);
    load();
  } catch (x) {
    toast(x.message, true);
  }
}

document.getElementById('look').addEventListener('click', () => modal('Appearance', h('div', { class: 'look' }, ...appearanceControls()), [{ label: 'Done', value: true, primary: true }]));
load().catch((e) => toast(e.message, true));
