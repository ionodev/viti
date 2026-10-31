// The home screen: your projects (GitHub repositories). Open one, connect a new one, give one a new
// token, or take one off the list. Talks to the app's own server (/app/*, app/server.js).
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
  draw();
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
    h('div', { class: 'proj-meta' }, h('span', { class: 'tag' }, p.private ? 'Private' : 'Public'), p.open ? h('span', { class: 'tag live' }, 'Open now') : null, p.hasToken ? null : h('span', { class: 'tag warn' }, 'Needs a token')),
    h('div', { class: 'proj-foot' }, h('span', { class: 'who' }, p.user?.avatar ? h('img', { src: p.user.avatar, alt: '' }) : null, h('span', {}, p.user?.name || '')), h('span', {}, p.opened ? `Opened ${ago(p.opened)}` : 'Not opened yet')),
  );
}

function projectMenu(e, p) {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left - 140, r.bottom + 4, [
    { label: 'Open', fn: () => open(p) },
    { label: 'Open on GitHub', fn: () => window.open(`https://github.com/${p.repo}`) },
    { label: 'New token…', fn: () => newToken(p) },
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

async function connect() {
  const repo = h('input', { type: 'text', placeholder: 'owner/name, or https://github.com/owner/name', autocomplete: 'off', spellcheck: 'false' });
  const token = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' });
  const err = h('p', { class: 'err', hidden: true });
  const body = h(
    'div',
    {},
    h('p', {}, 'Viti reads the repository’s branches and backs your project up to a branch of its own (', h('code', {}, 'viti-data'), '). Your code is never changed.'),
    h('div', { class: 'field' }, h('label', {}, 'Repository'), repo),
    h('div', { class: 'field' }, h('label', {}, 'GitHub token'), token, h('small', {}, 'A fine-grained token with Contents: Read and write on this repository.')),
    tokenHelp(),
    err,
  );
  // the dialog stays open until it works (or is cancelled): errors are shown in it
  const box = modal('Connect a repository', body, [
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
  const r = await modal(`Remove ${p.repo}?`, h('p', {}, 'It is taken off your list and its copy on this computer is deleted. What was backed up stays on GitHub (the viti-data branch), so connecting it again brings it all back.'), [
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
