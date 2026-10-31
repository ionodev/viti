// The quick search (Ctrl+K): type a few letters to jump to a section, or to a to-do, report, mail,
// board item, note or chat message with those words. Arrow keys pick, Enter opens, Esc closes.
// Also the shortcut sheet (?): every keyboard shortcut in one place.
import { S, sectionLabel } from './state.js';
import { api } from './api.js';
import { h, highlight } from './ui.js';

const KIND = { todo: 'To do', report: 'Report', mail: 'Mail', chat: 'Chat', note: 'Post-it', text: 'Text', image: 'Image', doc: 'Note', group: 'Group' };

let open = null; // the search window, while it is up

// onOpen(result) is given { k: 'section', section } or a chat reference ({ k: 'bug' | 'item' | 'msg', ... })
export function openSearch(onOpen) {
  if (open) return open.input.focus();
  const input = h('input', { type: 'search', class: 'qs-input', placeholder: 'Search sections, to-dos, reports, boards and the chat…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'qs-list', role: 'listbox' });
  const box = h('div', { class: 'qs', role: 'dialog' }, input, list);
  const overlay = h('div', { class: 'overlay qs-overlay', onmousedown: (e) => e.target === overlay && close() }, box);
  let rows = [];
  let at = 0;
  let timer = 0;
  let asked = '';

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    open = null;
  };
  const pick = (r) => {
    close();
    onOpen(r);
  };
  const paint = () => {
    list.querySelectorAll('.qs-row').forEach((el, i) => el.classList.toggle('on', i === at));
    list.querySelector('.qs-row.on')?.scrollIntoView({ block: 'nearest' });
  };
  const draw = (q, found) => {
    rows = [...sectionsMatching(q), ...found];
    at = 0;
    const kids = rows.map((r, i) => {
      const where = r.k === 'section' ? '' : sectionLabel(r.section);
      const el = h(
        'button',
        { class: 'qs-row', role: 'option', onmousemove: () => at !== i && ((at = i), paint()), onclick: () => pick(r) },
        h('span', { class: 'qs-kind' }, r.k === 'section' ? kindOfSection(r.section) : KIND[r.kind] || r.kind),
        h('span', { class: 'qs-text' }, r.k === 'section' ? sectionLabel(r.section) : r.text || '(empty)'),
        where || r.who ? h('span', { class: 'qs-where' }, [where, r.who].filter(Boolean).join(' · ')) : null,
      );
      if (q) highlight(el.querySelector('.qs-text'), q);
      return el;
    });
    list.replaceChildren(...(kids.length ? kids : [h('div', { class: 'qs-empty' }, q.length < 2 ? 'Type to search.' : 'Nothing found.')]));
    paint();
  };
  const ask = () => {
    const q = input.value.trim();
    clearTimeout(timer);
    draw(q, []);
    if (q.length < 2) return;
    // (the server's results come a moment later; a newer question replaces an older answer)
    timer = setTimeout(async () => {
      asked = q;
      const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)).catch(() => ({ results: [] }));
      if (asked === q && input.value.trim() === q) draw(q, r.results || []);
    }, 160);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') return e.stopPropagation(), close();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      paint();
    } else if (e.key === 'Enter' && rows[at]) {
      e.preventDefault();
      pick(rows[at]);
    }
  };
  input.addEventListener('input', ask);
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  open = { input };
  draw('', []);
  input.focus();
}

// the sections whose name has these letters (all of them while nothing is typed, the most used first)
function sectionsMatching(q) {
  const low = q.toLowerCase();
  // (names that start with the letters first, then main sections before their branch pages)
  const rank = (s) => (sectionLabel(s.id).toLowerCase().startsWith(low) ? 0 : 2) + (s.parent ? 1 : 0);
  return S.sections
    .filter((s) => !low || sectionLabel(s.id).toLowerCase().includes(low))
    .map((s, i) => [s, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([s]) => s)
    .slice(0, low ? 8 : 12)
    .map((s) => ({ k: 'section', section: s.id }));
}
function kindOfSection(id) {
  const s = S.sections.find((x) => x.id === id);
  if (!s) return 'Section';
  return { todo: 'To do', bugs: 'Reports', mail: 'Mailbox', note: 'Note', pdf: 'PDF', progress: 'Progress', calendar: 'Calendar', overview: 'Overview' }[s.kind] || 'Section';
}

// ---- the shortcut sheet
const SHEET = [
  ['Everywhere', [['Ctrl K', 'Search and jump anywhere'], ['?', 'This list'], ['Esc', 'Close a window or menu']]],
  ['Boards', [['S · 1', 'Select'], ['H · 2', 'Hand (pan); also Space or Shift+drag'], ['P · 3', 'Post-it'], ['T · 4', 'Text'], ['I · 5', 'Image'], ['D · 6', 'Draw (S, M, L: brush size)'], ['M · 7', 'Marker'], ['N · 8', 'Note'], ['9', 'PDF'], ['Shift 1', 'Fit everything in view'], ['+ / − / 0', 'Zoom in, out, 100%'], ['Enter', 'Edit the selected item'], ['Arrows', 'Nudge (Shift: further)'], ['Delete', 'Delete the selection'], ['Ctrl Z / Ctrl Y', 'Undo / redo'], ['Ctrl C · X · V', 'Copy, cut, paste items'], ['Ctrl D', 'Duplicate'], ['Ctrl G', 'Group'], ['Ctrl A', 'Select everything']]],
  ['To do and reports', [['Enter', 'Add a row (Shift+Enter: new line)'], ['Shift+click', 'Pick several cards'], ['Ctrl A', 'Pick every card in the list under the mouse'], ['Right-click', 'Everything a card can do'], ['Enter / Ctrl+Enter', 'Save an edited row / report'], ['Esc', 'Cancel an edit']]],
  ['Notes', [['Ctrl B · Ctrl I', 'Bold, italic'], ['Ctrl E', 'Preview']]],
  ['Chat', [['Enter', 'Send (Shift+Enter: new line)'], ['@name', 'Tell someone'], ['Tab', 'Pick the @name suggested']]],
];
export function openShortcuts() {
  if (document.querySelector('.overlay')) return;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => (e.key === 'Escape' || e.key === '?') && (e.preventDefault(), e.stopPropagation(), close());
  const overlay = h(
    'div',
    { class: 'overlay', onmousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'dialog keys', role: 'dialog' },
      h('h3', {}, 'Keyboard shortcuts'),
      h('div', { class: 'keys-cols' }, SHEET.map(([title, keys]) => h('section', {}, h('p', { class: 'label' }, title), h('dl', {}, keys.flatMap(([k, what]) => [h('dt', {}, k.split(' / ').flatMap((part, i) => [i ? ' / ' : '', h('kbd', {}, part)])), h('dd', {}, what)]))))),
      h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: close }, 'Close')),
    ),
  );
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
}
