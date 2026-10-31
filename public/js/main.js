// Viti: starts the page, draws the sidebar, moves between sections, and passes on what the server
// says is happening (a message, a moved item, a new bug report).
import { S, emit, on, user, sectionById, setBranchView } from './state.js';
import { api, Live, loadBranches, uploadPdf } from './api.js';
import { sectionLabel } from './state.js';
import { h, $, avatar, toast, menu, modal, promptBox, confirmBox, ago, typing } from './ui.js';
import { openSearch, openShortcuts } from './search.js';
import { Board, snippet, kindLabel } from './board.js';
import { Bugs } from './bugs.js';
import { Todo } from './todo.js';
import { Overview } from './overview.js';
import { Progress } from './progress.js';
import { Mailbox } from './mail.js';
import { NoteView } from './note.js';
import { PdfView } from './pdf.js';
import { Calendar } from './calendar.js';
import { settings, onSetting, announce, openSettings } from './settings.js';
import { Chat, initQuotes, glyph } from './chat.js';

const stage = $('#stage');
// a phone or a narrow window: the menu and the chat slide over the page instead of beside it
const narrow = () => matchMedia('(max-width: 900px)').matches;
let view = null; // the Board or the Bugs shown now
let chat = null;
let pending = null; // what to show once the section is open: { item, quote } | { msg } | { bug }
let queue = Promise.resolve();
let reconnecting = false;
let hiddenCount = 0;

boot();

async function boot() {
  let st;
  try {
    st = await api('GET', '/api/state');
  } catch (e) {
    return fatal(e);
  }
  applyState(st);
  chat = new Chat($('#chat'), { go: goRef, pick: (id) => chat.open(id) });
  initQuotes(chat);
  loadBranches().then(() => (fillBranchView(), drawSidebar())); // (the order of the branch pages follows the list)
  S.live = new Live();
  wire(S.live);
  S.live.connect();
  chrome();
  document.body.classList.remove('loading');
  // (on a narrow screen the chat covers the page, so it starts shut there; the remembered choice is for wide screens)
  if (narrow() || localStorage.getItem('hub.chat') === 'off') document.body.classList.add('nochat');
  if (localStorage.getItem('hub.side') === 'off') document.body.classList.add('noside');
  route();
  if (!S.me.named) welcome();
}

// the first time someone opens the hub: who are you?
async function welcome() {
  const input = h('input', { type: 'text', maxlength: '40', value: S.me.name, placeholder: 'Your name' });
  const body = h('div', {}, h('p', {}, 'This is the name shown on your chat messages, notes and cursor. You can change it later by clicking your name in the corner.'), input);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && document.querySelector('.overlay .btn:not(.ghost)')?.click());
  for (;;) {
    if ((await modal('Welcome to Viti. What is your name?', body, [{ label: 'Save', value: true, primary: true }])) !== true) continue;
    const name = input.value.trim();
    if (!name) continue;
    try {
      await api('PATCH', '/api/me', { name });
      S.me.name = name;
      S.me.named = true;
      drawSidebar();
      return;
    } catch (e) {
      toast(e.message, true);
    }
  }
}

function applyState(st) {
  S.me = st.me;
  S.users = new Map(st.users.map((u) => [u.email, u]));
  S.sections = st.sections;
  S.categories = st.categories || [];
  S.bugCounts = st.bugCounts;
  S.presence = st.presence;
  S.sync = st.sync;
}

function fatal(e) {
  const box = $('#fatal');
  const setup = e.code === 'not-configured';
  box.replaceChildren(h('div', {}, h('h2', {}, setup ? 'Not set up yet' : e.status === 401 || e.status === 403 ? 'Sign in required' : 'Something went wrong'), h('p', {}, e.message), h('p', {}, h('a', { href: '/home' }, 'Back to your projects'))));
  box.hidden = false;
  document.body.classList.remove('loading');
}

// ------------------------------------------------------------------ the sidebar and the title bar
function chrome() {
  // the project (the repository) this is, at the top of the menu: click it to go back to all of them
  fetch('/app/state')
    .then((r) => r.json())
    .then((st) => {
      const p = st.projects?.find((x) => x.id === st.current);
      if (!p) return;
      const [owner, name] = p.repo.split('/');
      $('#project-btn .pi').textContent = name.charAt(0).toUpperCase();
      $('#project-btn b').textContent = name;
      $('#project-btn small').textContent = owner;
      S.projectName = name;
      if (!/^\(/.test(document.title)) document.title = `${name} · Viti`;
    })
    .catch(() => {});
  $('#project-btn').addEventListener('click', () => (location.href = '/home'));
  // "+ New section" under Sections and under Reports: a board or a report list, in that group
  $('#add-section').addEventListener('click', () => newSectionIn({ id: '@sections', name: 'Sections' }, 'board'));
  $('#add-category').addEventListener('click', async () => {
    const name = await promptBox('New category', 'Name', '', 'Create');
    if (!name) return;
    api('POST', '/api/categories', { name }).catch((e) => toast(e.message, true));
  });
  $('#add-report').addEventListener('click', () => newSectionIn({ id: '@reports', name: 'Reports' }, 'bugs'));
  $('#settings').addEventListener('click', openSettings);
  // Ctrl+K (or the button in the menu) searches everything; ? lists the keyboard shortcuts
  const search = () => openSearch((r) => (document.body.classList.remove('menu-open'), r.k === 'section' ? (location.hash = `#/${r.section}`) : goRef(r)));
  $('#search-btn').addEventListener('click', search);
  $('#keys-btn').addEventListener('click', openShortcuts);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return e.preventDefault(), search();
    if (e.key === '?' && !typing() && !document.querySelector('.overlay, .lightbox')) return e.preventDefault(), openShortcuts();
  });
  $('#branch-view').addEventListener('change', () => {
    setBranchView($('#branch-view').value);
    followBranch();
  });
  on('branchview', fillBranchView);
  on('branchview', drawSidebar);
  const applySettings = () => document.body.classList.toggle('noanim', !settings().animate);
  applySettings();
  onSetting((k) => {
    if (k === 'animate') applySettings();
    if (k === 'titleCount') drawSidebar();
  });
  $('#me').addEventListener('click', async () => {
    const name = await promptBox('Your name', 'Shown on what you write', S.me.name);
    if (!name || name === S.me.name) return;
    try {
      await api('PATCH', '/api/me', { name });
      S.me.name = name;
      drawSidebar();
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('#sync').addEventListener('click', async () => {
    if (!S.sync?.configured) return toast('This project is not backed up: sign in with GitHub on the home screen (or give the project a token in its ⋯ menu there).');
    // an empty repository: offer to give it its first commit
    if (/repository is empty/i.test(S.sync.error || '')) {
      const go = await modal('The repository is empty', h('p', {}, 'GitHub cannot keep Viti’s backup branch in a repository with no commits. Viti can start it with a README (one small file on its main branch), and then back up as usual.'), [
        { label: 'Not now', value: false },
        { label: 'Start it with a README', value: true, primary: true },
      ]);
      if (go !== true) return;
      try {
        const r = await api('POST', '/api/admin/start-repo', {});
        S.sync = r.sync;
        drawSync();
        toast(r.sync.ok === false ? `The backup failed: ${r.sync.error}` : 'The repository has a README now, and the project is backed up.', r.sync.ok === false);
      } catch (e) {
        toast(e.message, true);
      }
      return;
    }
    try {
      toast('Backing up to GitHub…');
      const r = await api('POST', '/api/admin/sync', {});
      S.sync = r.sync;
      drawSync();
      toast(r.sync.ok === false ? `The backup failed: ${r.sync.error}` : 'Backed up to GitHub.', r.sync.ok === false);
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('#chat-btn').addEventListener('click', () => {
    const off = document.body.classList.toggle('nochat');
    if (narrow()) document.body.classList.remove('menu-open');
    else localStorage.setItem('hub.chat', off ? 'off' : 'on');
    hiddenCount = 0;
    drawChatBadge();
    if (!off) chat.markRead();
  });
  // the section menu: on a wide screen it slides shut (and the choice is remembered); on a narrow one it slides over the page
  $('#menu-btn').addEventListener('click', () => {
    if (narrow()) return document.body.classList.add('nochat'), document.body.classList.toggle('menu-open');
    const off = document.body.classList.toggle('noside');
    localStorage.setItem('hub.side', off ? 'off' : 'on');
  });
  // on a narrow screen a tap beside the menu or the chat closes it
  $('#scrim').addEventListener('click', () => (document.body.classList.remove('menu-open'), document.body.classList.add('nochat')));
  $('#chat .chat-head').append(h('button', { class: 'icon chat-close', title: 'Hide the chat', onclick: () => $('#chat-btn').click() }, '\u00d7'));
  $('#title').addEventListener('dblclick', async () => {
    const sec = sectionById(S.section);
    if (!sec || sec.core) return;
    const name = await promptBox('Rename section', 'Name', sec.name);
    if (name && name !== sec.name) api('PATCH', `/api/sections/${sec.id}`, { name }).catch((e) => toast(e.message, true));
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && chat?.markRead());
  window.addEventListener('hashchange', route);
  on('unread', drawSidebar);
  on('bugcounts', drawSidebar);
  drawSidebar();
}

// a section with a gold dot has new messages from someone else: opening it also opens the chat, at the latest one
let wantLatest = null;
// ---- the branch chosen at the top of the menu
function fillBranchView() {
  const sel = $('#branch-view');
  const names = [...S.branches.list];
  for (const c of S.sections) if (c.branch && !names.includes(c.branch)) names.push(c.branch);
  if (S.branchView && !names.includes(S.branchView)) names.push(S.branchView);
  const key = names.join('|');
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren(h('option', { value: '' }, 'All branches'), ...names.map((n) => h('option', { value: n }, n)));
  }
  sel.value = S.branchView;
}
// a branch was picked: if a board is open, go to its page for that branch (or back to the main one for "all")
function followBranch() {
  const cur = sectionById(S.section);
  if (!cur || cur.kind !== 'board') return;
  const main = cur.parent ? sectionById(cur.parent) : cur;
  if (!main) return;
  if (!S.branchView) return cur.parent ? go(main.id) : undefined;
  const sub = pageOf(main.id, S.branchView);
  if (sub) return sub.id === cur.id ? undefined : go(sub.id);
  if (cur.parent) {
    go(main.id);
    toast(`${main.name} has no page for ${S.branchView} yet (use + Branch under it).`);
  }
}
function clickSection(s, e) {
  document.body.classList.remove('menu-open');
  const own = e && s.kind === 'board' && S.section === s.id;
  const viaPage = e && s.kind === 'board' && !s.parent && S.branchView && S.sections.some((c) => c.id === S.section && c.parent === s.id && c.kind === 'board' && c.branch === S.branchView);
  // an open list of a board you are not on yet: one click folds it up (and takes you there)
  const foldOnWay = e && s.kind === 'board' && !own && !viaPage && unfolded.has(s.id);
  if (foldOnWay) unfolded.delete(s.id);
  if (own || viaPage) {
    e.preventDefault();
    const fold = viaPage ? s.id : s.id;
    if (!unfolded.delete(fold)) unfolded.add(fold);
    const subs = e.currentTarget?.nextElementSibling;
    return subs?.classList.contains('subs') ? subs.classList.toggle('open', unfolded.has(s.id)) : drawSidebar();
  }
  if (s.kind === 'board' && !foldOnWay) {
    unfolded.add(s.id); // (going to a board or a branch page opens its list)
    if (s.parent) unfolded.add(s.parent);
  }
  // with a branch chosen, a main board opens its page for that branch (when it has one)
  if (S.branchView && s.kind === 'board' && !s.parent && e) {
    const sub = pageOf(s.id, S.branchView);
    if (sub) {
      e.preventDefault();
      if (sub.unread) wantLatest = sub.id;
      return go(sub.id);
    }
  }
  if (!s.unread) return;
  if (S.section === s.id && view) return showLatest(s.id);
  wantLatest = s.id;
}
// someone wrote "@you": the chat opens (if it was hidden) on that section and the message lights up
async function showMention(msg) {
  document.body.classList.remove('nochat');
  localStorage.setItem('hub.chat', 'on');
  hiddenCount = 0;
  drawChatBadge();
  if (chat.section !== msg.section) await chat.open(msg.section);
  setTimeout(() => chat.showMessage(msg.id), 100);
}
async function showLatest(id) {
  document.body.classList.remove('nochat');
  hiddenCount = 0;
  drawChatBadge();
  if (chat.section !== id) await chat.open(id);
  const last = chat.last?.id;
  if (last) chat.showMessage(last);
  chat.markRead();
}

// the branch subsections of a main board, in the order of the repository's branches (the latest first)
function childrenOf(id) {
  // oldest branch first: main on top, then the others as they came (the repository's list is newest first, so it is read backwards)
  const rank = (s) => {
    if (s.branch === 'main') return -1;
    const i = S.branches.list.indexOf(s.branch);
    return i < 0 ? 1e6 : S.branches.list.length - i;
  };
  // (with a branch chosen: only that branch's page and its notes and PDFs; with all branches, everything)
  return S.sections.filter((s) => s.parent === id && (!S.branchView || s.branch === S.branchView)).sort((a, b) => (a.kind === 'board' ? 0 : 1) - (b.kind === 'board' ? 0 : 1) || rank(a) - rank(b) || a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name));
}
// the notes and PDFs made on one branch ('' = made before they had one)
const objectsOf = (id, branch) => S.sections.filter((c) => c.parent === id && c.kind !== 'board' && (c.branch || '') === branch).sort((a, b) => a.name.localeCompare(b.name));
const pageOf = (id, branch) => S.sections.find((c) => c.parent === id && c.kind === 'board' && c.branch === branch);
// clicking the open section again folds its list up (and down again)
// (everything starts closed: click a board to see its branches and objects, a branch page to see its objects; click the open one again to fold it up)
const unfolded = new Set();
const expanded = (s) => unfolded.has(s.id);
function subEl(c) {
  return h(
    'a',
    { class: 'sec sub' + (c.id === S.section ? ' on' : '') + (c.unread ? ' unread' : ''), dataset: { id: c.id }, href: `#/${c.id}`, onclick: (e) => clickSection(c, e), oncontextmenu: (e) => (e.preventDefault(), sectionMenu(e.clientX, e.clientY, c)) },
    h('span', { class: 'hash' }, c.kind === 'board' ? '\u2387' : glyph(c.kind)),
    h('span', { class: 'nm', title: c.name }, c.name),
    c.unread ? h('span', { class: 'golddot', title: `${c.unread} new message${c.unread === 1 ? '' : 's'}` }, c.unread > 99 ? '99+' : String(c.unread)) : null,
    h('button', { class: 'dots', title: 'Delete this subsection', onclick: (e) => (e.preventDefault(), e.stopPropagation(), sectionMenu(e.clientX, e.clientY, c)) }, '\u22ef'),
  );
}
// "+ Note" and "+ PDF": a page of markdown, or a PDF, as a subsection of a board
function addNoteEl(s, branch = '') {
  return h('button', { class: 'sec sub addsub', title: 'A page of markdown (with equations) under this board', onclick: async () => {
    const name = await promptBox('New note', 'Name', '', 'Create');
    if (!name) return;
    try {
      go((await api('POST', '/api/sections', { parent: s.id, kind: 'note', name, branch })).id);
    } catch (err) {
      toast(err.message, true);
    }
  } }, h('span', { class: 'hash' }, '+'), h('span', { class: 'nm' }, 'Note'));
}
function addPdfEl(s, branch = '') {
  return h('button', { class: 'sec sub addsub', title: 'Add a PDF under this board', onclick: () => {
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf' });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        toast('Uploading ' + f.name + '…');
        const up = await uploadPdf(f);
        go((await api('POST', '/api/sections', { parent: s.id, kind: 'pdf', name: f.name.replace(/\.pdf$/i, '').slice(0, 60) || 'PDF', file: up.id, branch })).id);
      } catch (err) {
        toast(err.message, true);
      }
    };
    input.click();
  } }, h('span', { class: 'hash' }, '+'), h('span', { class: 'nm' }, 'PDF'));
}
// "+ Branch": make a subsection for a branch of the repository that does not have one yet
function addBranchEl(s) {
  return h('button', { class: 'sec sub addsub', title: 'A board for one branch of the repository', onclick: async (e) => {
    const x = e.clientX;
    const y = e.clientY;
    const { list } = await loadBranches();
    const free = list.filter((n) => !pageOf(s.id, n) && (!S.branchView || n === S.branchView));
    if (!free.length) return toast(list.length ? 'Every branch already has one here.' : 'The list of branches is not available.', true);
    menu(x, y, free.map((n) => ({ label: n, fn: async () => {
      try {
        const r = await api('POST', '/api/sections', { parent: s.id, branch: n });
        go(r.id);
      } catch (err) {
        toast(err.message, true);
      }
    } })));
  } }, h('span', { class: 'hash' }, '+'), h('span', { class: 'nm' }, 'Branch'));
}
// a section's entry, followed by its subsections when it is the open one
function secEls(s) {
  const el = secEl(s);
  if (s.kind !== 'board' || s.parent) return [el];
  const kids = childrenOf(s.id);
  const total = (s.unread || 0) + kids.reduce((n, c) => n + (c.unread || 0), 0); // (hidden subsections still show their messages on the main section)
  const dot = el.querySelector('.golddot');
  if (total && !dot) el.insertBefore(h('span', { class: 'golddot', title: `${total} new message${total === 1 ? '' : 's'}` }, total > 99 ? '99+' : String(total)), el.querySelector('.dots'));
  else if (dot) {
    dot.textContent = total > 99 ? '99+' : String(total);
    dot.title = `${total} new message${total === 1 ? '' : 's'}`;
  }
  let inner;
  if (!S.branchView) {
    // all branches: the older notes and PDFs, then each branch's page with its own notes and PDFs under it (click the open page to fold them up)
    const pages = kids.filter((c) => c.kind === 'board');
    inner = [...objectsOf(s.id, '').map(subEl), ...pages.flatMap((p) => [subEl(p), h('div', { class: 'subs obj' + (unfolded.has(p.id) ? ' open' : '') }, h('div', { class: 'subs-in' }, ...objectsOf(s.id, p.branch).map(subEl), addNoteEl(s, p.branch), addPdfEl(s, p.branch)))]), addBranchEl(s)];
  } else {
    // one branch: only what was made on it
    const page = pageOf(s.id, S.branchView);
    const objs = [...objectsOf(s.id, S.branchView).map(subEl), ...(page ? [addNoteEl(s, S.branchView), addPdfEl(s, S.branchView)] : [])]; // (no objects on a branch before its page is made)
    // (with a page, its objects fold under it like in the all-branches list)
    inner = page ? [subEl(page), h('div', { class: 'subs obj' + (unfolded.has(page.id) ? ' open' : '') }, h('div', { class: 'subs-in' }, ...objs))] : [...objs, addBranchEl(s)];
  }
  // (always drawn, so that folding it up and down can slide)
  return [el, h('div', { class: 'subs' + (expanded(s) ? ' open' : '') }, h('div', { class: 'subs-in' }, ...inner))];
}
function secEl(s) {
  const open = s.kind === 'bugs' || s.kind === 'todo' ? S.bugCounts[s.id]?.open || 0 : s.kind === 'mail' ? S.bugCounts[s.id]?.unread || 0 : 0;
  return h(
    'a',
    { class: 'sec' + (s.id === S.section ? ' on' : '') + (s.unread ? ' unread' : ''), dataset: { id: s.id }, href: `#/${s.id}`, onclick: (e) => clickSection(s, e), oncontextmenu: (e) => !s.core && (e.preventDefault(), sectionMenu(e.clientX, e.clientY, s)) },
    h('span', { class: 'hash' }, glyph(s.kind)),
    h('span', { class: 'nm' }, s.name),
    open ? h('span', { class: 'badge quiet', title: s.kind === 'mail' ? 'Unread mail' : 'Open reports' }, open) : null,
    s.unread ? h('span', { class: 'golddot', title: `${s.unread} new message${s.unread === 1 ? '' : 's'}` }, s.unread > 99 ? '99+' : String(s.unread)) : null,
    !s.core ? h('button', { class: 'dots', title: 'Rename or delete', onclick: (e) => (e.preventDefault(), e.stopPropagation(), sectionMenu(e.clientX, e.clientY, s)) }, '⋯') : null,
  );
}
function sectionMenu(x, y, s) {
  menu(x, y, [
    ...(s.parent && s.kind === 'board' ? [] : [{ label: 'Rename', fn: async () => {
      const name = await promptBox('Rename section', 'Name', s.name);
      if (name && name !== s.name) api('PATCH', `/api/sections/${s.id}`, { name }).catch((e) => toast(e.message, true));
    } }]),
    { label: 'Delete…', danger: true, fn: async () => {
      if (!(await confirmBox(`Delete “${sectionLabel(s.id)}”?`, s.parent ? 'Its board and its chat are removed. (The backup on GitHub keeps the history.)' : s.kind === 'board' && childrenOf(s.id).length ? 'Its board, its chat and its branch subsections are removed. (The backup on GitHub keeps the history.)' : s.kind === 'bugs' ? 'Its reports and its chat are removed. (The backup on GitHub keeps the history.)' : 'Its board and its chat are removed. (The backup on GitHub keeps the history.)', 'Delete', true))) return;
      api('DELETE', `/api/sections/${s.id}`).catch((e) => toast(e.message, true));
    } },
  ]);
}
// The menu is a few groups: Sections, Reports, and any categories people made. Each person drags entries into their
// own order; dragging into another group moves the section there (for everyone). Sections and Reports only take the
// kind of section they are for; a custom category takes boards and report lists.
const isReport = (s) => s.kind === 'bugs';
// the sections that belong to the PROJECT category (the whole project at a glance, not content)
const isProject = (s) => ['todo', 'progress', 'calendar', 'overview'].includes(s.kind);
function ordered(list) {
  // the sections you have placed take their slots in your order; the others (new ones) stay where they are by default
  const order = S.me.order || [];
  const mine = list.filter((s) => order.includes(s.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  let n = 0;
  return list.map((s) => (order.includes(s.id) ? mine[n++] : s));
}
let dragId = null;
function enableDrag(nav, group) {
  const clear = () => document.querySelectorAll('#sidebar .dragging, #sidebar .drop-before, #sidebar .drop-after, #sidebar .drop-in').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-in'));
  const accepts = () => {
    const sec = sectionById(dragId);
    return !!sec && group.accept(sec);
  };
  const place = (from, before, after) => {
    const sec = sectionById(from);
    if (!sec) return;
    const ids = ordered(group.list).map((s) => s.id).filter((x) => x !== from);
    const i = before ? ids.indexOf(before) + (after ? 1 : 0) : ids.length;
    ids.splice(i < 0 ? ids.length : i, 0, from);
    S.me.order = [...ids, ...(S.me.order || []).filter((x) => !ids.includes(x))];
    const moved = (sec.category || '') !== group.category;
    if (moved) sec.category = group.category;
    drawSidebar();
    if (moved) api('PUT', `/api/sections/${from}/category`, { category: group.category }).catch((err) => toast(err.message, true));
    api('PUT', '/api/me/order', { order: S.me.order }).catch((err) => toast(err.message, true));
  };
  nav.addEventListener('dragover', (e) => {
    if (!dragId || e.target.closest('.sec') || !accepts()) return;
    e.preventDefault();
    nav.classList.add('drop-in');
  });
  nav.addEventListener('dragleave', (e) => !nav.contains(e.relatedTarget) && nav.classList.remove('drop-in'));
  nav.addEventListener('drop', (e) => {
    if (e.target.closest('.sec') || !dragId || !accepts()) return;
    e.preventDefault();
    clear();
    place(dragId, null, false);
  });
  nav.querySelectorAll('.sec:not(.sub)').forEach((a) => {
    a.draggable = true;
    a.addEventListener('dragstart', (e) => {
      dragId = a.dataset.id;
      e.dataTransfer.setData('text/plain', dragId);
      e.dataTransfer.effectAllowed = 'move';
      a.classList.add('dragging');
    });
    a.addEventListener('dragend', () => {
      dragId = null;
      clear();
    });
    a.addEventListener('dragover', (e) => {
      if (!dragId || dragId === a.dataset.id || !accepts()) return;
      e.preventDefault();
      const after = e.clientY > a.getBoundingClientRect().top + a.offsetHeight / 2;
      a.classList.toggle('drop-after', after);
      a.classList.toggle('drop-before', !after);
    });
    a.addEventListener('dragleave', () => a.classList.remove('drop-before', 'drop-after'));
    a.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = a.classList.contains('drop-after');
      clear();
      if (!dragId || dragId === a.dataset.id || !accepts()) return;
      place(dragId, a.dataset.id, after);
    });
  });
}
function categoryMenu(x, y, c) {
  menu(x, y, [
    { label: 'Rename', fn: async () => {
      const name = await promptBox('Rename category', 'Name', c.name);
      if (name && name !== c.name) api('PATCH', `/api/categories/${c.id}`, { name }).catch((e) => toast(e.message, true));
    } },
    { label: 'Delete\u2026', danger: true, fn: async () => {
      if (!(await confirmBox(`Delete the category \u201c${c.name}\u201d?`, 'Its sections are not deleted: they go back to their usual place in the menu.', 'Delete', true))) return;
      api('DELETE', `/api/categories/${c.id}`).catch((e) => toast(e.message, true));
    } },
  ]);
}
// a new section in a group of the menu (Sections, Reports, or one of your categories): a board, or a list of reports
async function newSectionIn(c, preferred = 'board') {
  const input = h('input', { type: 'text', maxlength: '60', placeholder: 'Name' });
  const kind = h('select', {}, h('option', { value: 'board' }, 'Board (notes, text, images)'), h('option', { value: 'bugs' }, 'Reports (Open, Closed, Trash)'), h('option', { value: 'mail' }, 'Mailbox (reads an email folder)'));
  kind.value = preferred;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && document.querySelector('.overlay .btn:not(.ghost)')?.click());
  const body = h('div', {}, h('label', {}, 'Name'), input, h('label', { style: { marginTop: '12px' } }, 'Kind'), kind);
  if ((await modal(`New section in ${c.name}`, body, [{ label: 'Cancel', value: false }, { label: 'Create', value: true, primary: true }])) !== true) return;
  const name = input.value.trim();
  if (!name) return;
  try {
    const r = await api('POST', '/api/sections', { name, kind: kind.value, category: c.id });
    go(r.id);
  } catch (e) {
    toast(e.message, true);
  }
}
function drawSidebar() {
  const catIds = new Set(S.categories.map((c) => c.id));
  const inCat = (s) => s.category && catIds.has(s.category);
  // Sections and Reports each take boards and report lists: one that was put in either says so ('@sections',
  // '@reports'); the others are where their kind puts them
  const content = (s) => s.kind !== 'mail' && !isProject(s) && !s.parent && !inCat(s);
  const home = (s) => (s.category === '@sections' ? 'sections' : s.category === '@reports' ? 'reports' : isReport(s) ? 'reports' : 'sections');
  const anyContent = (s) => s.kind !== 'mail' && !isProject(s);
  const groups = [
    { nav: $('#sections'), category: '@sections', accept: anyContent, list: S.sections.filter((s) => content(s) && home(s) === 'sections') },
    { nav: $('#special'), category: '@reports', accept: anyContent, list: S.sections.filter((s) => content(s) && home(s) === 'reports') },
  ];
  const custom = $('#custom');
  custom.replaceChildren();
  $('#projectcat').replaceChildren();
  for (const c of S.categories) {
    const nav = h('nav', { class: 'cat-nav' });
    (c.id === 'project' ? $('#projectcat') : custom).append(
      h('div', { class: 'cat' },
        h('div', { class: 'cat-head' }, h('p', { class: 'label' }, c.name), c.core ? null : h('button', { class: 'dots', title: 'Rename or delete this category', onclick: (e) => categoryMenu(e.clientX, e.clientY, c) }, '\u22ef')),
        nav,
        c.id === 'mail' ? h('div', { class: 'side-tools' }, h('button', { class: 'link', onclick: () => newSectionIn(c, 'mail') }, '+ New mailbox')) : c.core ? null : h('div', { class: 'side-tools' }, h('button', { class: 'link', onclick: () => newSectionIn(c) }, '+ New section'))),
    );
    groups.push({ nav, category: c.id, accept: c.id === 'project' ? isProject : c.core ? (s) => s.kind === 'mail' : (s) => s.kind !== 'mail' && !isProject(s), list: S.sections.filter((s) => s.category === c.id && !s.parent) });
  }
  for (const g of groups) {
    g.list = ordered(g.list);
    g.nav.classList.toggle('empty', !g.list.length);
    // (the lists that were closed and are open now slide open, although the menu is drawn again)
    const was = new Map([...g.nav.querySelectorAll('.subs')].map((w) => [w.previousElementSibling?.dataset.id, w.classList.contains('open')]));
    g.nav.replaceChildren(...g.list.flatMap(secEls));
    const slide = [...g.nav.querySelectorAll('.subs.open')].filter((w) => was.get(w.previousElementSibling?.dataset.id) === false);
    slide.forEach((w) => w.classList.remove('open'));
    const shut = [...g.nav.querySelectorAll('.subs:not(.open)')].filter((w) => was.get(w.previousElementSibling?.dataset.id) === true);
    shut.forEach((w) => w.classList.add('open'));
    if (slide.length || shut.length) requestAnimationFrame(() => requestAnimationFrame(() => (slide.forEach((w) => w.classList.add('open')), shut.forEach((w) => w.classList.remove('open')))));
    enableDrag(g.nav, g);
  }
  $('#me').replaceChildren(avatar(S.me), S.me.name);
  drawSync();
  const unread = S.sections.reduce((n, s) => n + (s.unread || 0), 0);
  // (the window's title: the project, and how many new messages)
  const name = S.projectName ? `${S.projectName} · Viti` : 'Viti';
  document.title = unread && settings().titleCount ? `(${unread}) ${name}` : name;
}
function drawSync() {
  const el = $('#sync');
  const s = S.sync || {};
  el.className = 'sync ' + (!s.configured ? 'off' : s.ok === false ? 'bad' : 'ok');
  el.textContent = !s.configured ? 'Not backed up' : s.ok === false && /repository is empty/i.test(s.error || '') ? 'Empty repository: click to start it' : s.ok === false ? 'Backup failed: click to retry' : s.at ? `Backed up ${ago(s.at)}${s.pending ? ' · more waiting' : ''}` : 'Backup: waiting for the first run';
  el.title = !s.configured ? 'Sign in with GitHub on the home screen to back this project up.' : s.error || 'Everything is also kept in the repository on GitHub (in a branch of its own). Click to back up now.';
}
function drawTitle() {
  const sec = sectionById(S.section);
  $('#title').textContent = sec ? sectionLabel(sec.id) : '';
  $('#kind').textContent = sec?.kind === 'note' ? 'Note' : sec?.kind === 'pdf' ? 'PDF' : ['bugs', 'todo', 'overview', 'progress', 'mail', 'calendar'].includes(sec?.kind) ? '' : 'Board';
  drawHere();
}
function drawHere() {
  $('#here').replaceChildren(...(S.presence[S.section] || []).filter((e) => e !== S.me.email).map((e) => avatar(user(e))));
}
function drawChatBadge() {
  const b = $('#chat-badge');
  b.hidden = !hiddenCount;
  b.textContent = hiddenCount;
}

// ------------------------------------------------------------------ moving between sections
const parseHash = () => {
  const m = location.hash.match(/^#\/([a-z0-9-]+)(?:\/([a-z0-9]+))?/);
  return m ? { section: m[1], item: m[2] || null } : null;
};
function route() {
  queue = queue.then(doRoute).catch((e) => toast(e.message || 'Something went wrong.', true));
}
async function doRoute() {
  const r = parseHash();
  let id = r?.section;
  if (!id || !sectionById(id)) id = (S.sections.find((s) => s.kind === 'board' && !s.parent) || S.sections[0])?.id;
  if (!id) return;
  if (!r || r.section !== id) history.replaceState(null, '', `#/${id}`);
  if (r?.item && !pending) pending = { item: r.item };
  await openSection(id);
}
async function openSection(id) {
  if (S.section === id && view) return showPending();
  view?.unmount();
  view = null;
  S.section = id;
  // (a page, note or PDF inside a board: its lists are open, so you can see where you are)
  const here = sectionById(id);
  if (here?.parent) {
    unfolded.add(here.parent);
    if (here.kind !== 'board') {
      const pg = pageOf(here.parent, here.branch || '');
      if (pg) unfolded.add(pg.id);
    }
  }
  stage.replaceChildren();
  drawSidebar();
  drawTitle();
  const chatReady = chat.open(id);
  S.live.send({ t: 'view', section: id });
  const sec = sectionById(id);
  if (sec.kind === 'mail') {
    view = new Mailbox({ section: id, onReference: (ref) => chat.addRef(ref) });
    await view.mount(stage);
  } else if (sec.kind === 'calendar') {
    view = new Calendar({ open: (ref) => goRef(ref), getRefs: () => [...chat.refs], chatSection: () => chat.section });
    await view.mount(stage);
  } else if (sec.kind === 'note') {
    view = new NoteView({ onReference: (ref) => chat.addRef(ref) });
    view.mount(stage);
    await view.open(id);
  } else if (sec.kind === 'pdf') {
    view = new PdfView({});
    view.mount(stage);
    await view.open(id);
  } else if (sec.kind === 'progress') {
    view = new Progress({ open: (ref) => goRef(ref) });
    await view.mount(stage);
  } else if (sec.kind === 'overview') {
    view = new Overview({ open: (ref) => goRef(ref) });
    await view.mount(stage);
  } else if (sec.kind === 'bugs' || sec.kind === 'todo') {
    view = new (sec.kind === 'todo' ? Todo : Bugs)({ section: id, onReference: (ref) => chat.addRef(ref) });
    await view.mount(stage);
    // the open count comes from this list now
  } else {
    view = new Board({ onReference: referenceItem, onOpen: (sid) => go(sid) });
    view.mount(stage);
    await view.open(id);
  }
  await chatReady;
  if (wantLatest === id) {
    wantLatest = null;
    showLatest(id);
  }
  showPending();
}
function showPending() {
  const p = pending;
  pending = null;
  if (!p) return;
  if (p.msg) chat.showMessage(p.msg);
  else if (p.bug && view instanceof Bugs) view.focus(p.bug);
  else if (p.item && (view instanceof Board || view instanceof NoteView)) view.focus(p.item, p.quote);
}
function go(section, item, quote) {
  if (!sectionById(section)) return toast('That section no longer exists.', true);
  pending = item ? { item, quote } : null;
  const hash = `#/${section}${item ? '/' + item : ''}`;
  if (location.hash === hash) route();
  else location.hash = hash;
}
// a reference in the chat was clicked
async function goRef(ref) {
  if (ref.k === 'bug') {
    const to = sectionById(ref.section) ? ref.section : 'bugs';
    pending = { bug: ref.bug };
    return location.hash === `#/${to}` ? route() : (location.hash = `#/${to}`);
  }
  if (ref.k === 'msg') {
    if (!sectionById(ref.section)) return toast('That section no longer exists.', true);
    // only the chat moves to that channel; the board you are looking at stays
    document.body.classList.remove('nochat'); // (the chat may be hidden: show it)
    hiddenCount = 0;
    drawChatBadge();
    if (chat.section !== ref.section) await chat.open(ref.section);
    return chat.showMessage(ref.msg);
  }
  if (ref.k === 'day') {
    // a day in a chat: open that chat at the first message of the day
    if (!sectionById(ref.section)) return toast('That chat no longer exists.', true);
    document.body.classList.remove('nochat');
    hiddenCount = 0;
    drawChatBadge();
    if (chat.section !== ref.section) await chat.open(ref.section);
    try {
      const r = await api('GET', `/api/chat/${ref.section}?from=${ref.from || Date.parse(ref.day + 'T00:00:00')}`);
      if (!r.id) return toast('Nothing was written there on or after that day.');
      return chat.showMessage(r.id);
    } catch (e) {
      return toast(e.message, true);
    }
  }
  go(ref.section, ref.item, ref.k === 'quote' ? ref.text : null);
}
function referenceItem(it) {
  chat.addRef({ k: 'item', section: S.section, item: it.id, kind: it.type, img: it.type === 'image' ? it.data.img : '', text: snippet(it), label: kindLabel(it) });
}

// ------------------------------------------------------------------ what the server tells us
async function refreshState() {
  try {
    const st = await api('GET', '/api/state');
    const old = S.sections;
    applyState(st);
    // what is open right now is read
    const cur = sectionById(chat?.section || S.section);
    if (cur) cur.unread = 0;
    void old;
    drawSidebar();
    drawTitle();
    chat?.retitle();
  } catch {}
}
let counts = 0;
function bugsChanged() {
  clearTimeout(counts);
  counts = setTimeout(refreshState, 300);
}

function wire(live) {
  live.on('open', () => {
    $('#conn').hidden = true;
    if (S.section) live.send({ t: 'view', section: S.section });
    if (!reconnecting) return;
    reconnecting = false;
    refreshState();
    if (view instanceof Board || view instanceof NoteView) view.resync();
    else if (view instanceof Bugs || view instanceof Overview || view instanceof Calendar) view.load();
    else if (view instanceof Progress) view.load(false);
    chat?.load();
  });
  live.on('close', () => {
    reconnecting = true;
    $('#conn').hidden = false;
    if (view instanceof Board || view instanceof NoteView) view.lost();
  });
  live.on('ops', (m) => (view instanceof Board || view instanceof NoteView) && m.section === S.section && view.remote(m.ops));
  live.on('cal', () => view instanceof Calendar && view.refreshSoon());
  live.on('cursor', (m) => view instanceof Board && view.cursor(m));
  live.on('presence', (m) => {
    S.presence = m.presence;
    drawHere();
  });
  live.on('users', (m) => {
    S.users = new Map(m.users.map((u) => [u.email, u]));
    const me = S.users.get(S.me.email);
    if (me) S.me = { ...S.me, ...me };
    drawSidebar();
    drawHere();
  });
  live.on('sections', (m) => {
    const old = S.sections;
    S.sections = m.sections.map((s) => ({ ...s, unread: old.find((o) => o.id === s.id)?.unread || 0 }));
    S.categories = m.categories || S.categories;
    if (view instanceof Board) setTimeout(() => view.refreshDocs(), 0);
    fillBranchView();
    drawSidebar();
    drawTitle();
    chat?.retitle();
    if (chat?.section && !sectionById(chat.section)) chat.open(S.section || m.sections[0].id);
    if (S.section && !sectionById(S.section)) {
      S.section = null;
      view?.unmount();
      view = null;
      history.replaceState(null, '', '#/');
      route();
    }
  });
  live.on('msg', (m) => {
    const msg = m.msg;
    if (view instanceof Overview) view.refreshSoon();
    // someone else wrote: a chime (and a pop-up if you are elsewhere)
    if (msg.author !== S.me.email && !msg.deleted && !m.edited) announce(msg, `${glyph(sectionById(msg.section)?.kind)} ${sectionLabel(msg.section)}`, () => go(msg.section));
    if (msg.mentions?.includes(S.me.email) && !msg.deleted && msg.author !== S.me.email) showMention(msg);
    if (msg.section === chat.section) {
      chat.add(msg);
      if (document.body.classList.contains('nochat') && msg.author !== S.me.email && !msg.deleted) {
        hiddenCount++;
        drawChatBadge();
      }
      return;
    }
    const sec = sectionById(msg.section);
    if (sec && msg.author !== S.me.email && !msg.deleted) {
      sec.unread = (sec.unread || 0) + 1;
      drawSidebar();
    }
  });
  live.on('bug', (m) => (view instanceof Calendar && view.refreshSoon(), view instanceof Progress && view.refreshSoon(), view instanceof Bugs && view.section === m.bug.section ? view.upsert(m.bug) : bugsChanged()));
  live.on('bug-del', (m) => (view instanceof Progress && view.refreshSoon(), view instanceof Bugs ? view.remove(m.id) : bugsChanged()));
  live.on('sync', (m) => {
    S.sync = m.sync;
    drawSync();
  });
  live.on('reload', () => location.reload());
}
