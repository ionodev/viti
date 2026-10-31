// The bug reports: three lists (Open, Closed, Trash). Open is oldest first, so what has waited longest is
// on top; Closed and Trash are newest first. A report can be moved to any list (buttons, or drag it).
import { S, user, imageUrl, emit, on, setBranchView } from './state.js';
import { api, uploadImage, loadBranches } from './api.js';
import { h, ago, stamp, toast, undoToast, UNDO_MS, modal, lightbox, menu, highlight } from './ui.js';
import { deadlineFor } from './settings.js';
import { renderInto } from './md.js';

const COLS = [
  { key: 'open', title: 'Open', order: 'Oldest first' },
  { key: 'closed', title: 'Closed', order: 'Newest first' },
  { key: 'trash', title: 'Trash', order: 'Newest first' },
];
const LABEL = { open: 'Open', closed: 'Closed', trash: 'Trash' };
export const PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };
const PRANK = { high: 0, medium: 1, low: 2 };
// a date (YYYY-MM-DD) as people read it
export const dueLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export class Bugs {
  constructor({ section, onReference }) {
    this.section = section;
    this.onReference = onReference;
    this.all = new Map();
    this.bodies = {};
    this.heads = {};
    this.cols = {};
    this.tcount = {};
    this.sel = new Set(); // shift+click picks several cards, to act on them together
    this.deleting = new Set(); // deleted, but still undoable for a few seconds (hidden meanwhile)
    // the order of each list: oldest or newest first (click the label in the list's heading to switch); remembered
    this.order = { open: 'oldest', closed: 'newest', trash: 'newest' };
    try {
      const saved = JSON.parse(localStorage.getItem('hub.bugorder') || '{}');
      for (const k of Object.keys(this.order)) if (saved[k] === 'oldest' || saved[k] === 'newest') this.order[k] = saved[k];
    } catch {}
    this.ordBtn = {};
  }
  flipOrder(key) {
    this.order[key] = this.order[key] === 'oldest' ? 'newest' : 'oldest';
    try {
      localStorage.setItem('hub.bugorder', JSON.stringify(this.order));
    } catch {}
    this.draw();
  }

  async mount(stage) {
    this.stage = stage;
    this.root = h('div', { class: 'bugs' });
    for (const c of COLS) {
      const n = h('span', { class: 'n' });
      const body = h('div', { class: 'col-body' });
      const col = h('section', { class: 'col', dataset: { key: c.key } }, h('div', { class: 'col-head' }, h('h3', {}, c.title), n, (this.ordBtn[c.key] = h('button', { class: 'ord', title: 'Click to switch between oldest first and newest first', onclick: () => this.flipOrder(c.key) }))), body);
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('over');
      });
      col.addEventListener('dragleave', (e) => !col.contains(e.relatedTarget) && col.classList.remove('over'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const id = e.dataTransfer.getData('text/plain');
        if (this.all.has(id)) this.moveMany(this.sel.has(id) ? [...this.sel] : [id], c.key);
      });
      this.bodies[c.key] = body;
      this.heads[c.key] = n;
      this.root.append(col);
    }
    // which lists are shown: any one, two or all three (remembered); a hidden one takes no room at all
    let shown = ['open', 'closed', 'trash'];
    try {
      const s = JSON.parse(localStorage.getItem('hub.bugcols') || 'null');
      if (Array.isArray(s) && s.some((k) => COLS.some((c) => c.key === k))) shown = s;
    } catch {}
    this.shown = new Set(shown);
    this.toggles = {};
    // how wide each list is, against the others (dragged with the dividers between them; remembered per page)
    this.widths = { open: 1, closed: 1, trash: 1 };
    try {
      const w = JSON.parse(localStorage.getItem('hub.colw.' + this.section) || '{}');
      for (const k of Object.keys(this.widths)) if (w[k] > 0.05 && w[k] < 20) this.widths[k] = w[k];
    } catch {}
    // all reports, only the internal ones (added here by the team), or only the external ones (from the website's contact form)
    this.source = 'all';
    try {
      const v = localStorage.getItem('hub.bugsSource');
      if (['all', 'internal', 'external'].includes(v)) this.source = v;
    } catch {}
    this.seg = {};
    this.filter = this.filterable
      ? h(
          'div',
          { class: 'seg', title: 'Which reports to show' },
          [['all', 'All'], ['internal', 'Internal'], ['external', 'External']].map(([k, label]) => (this.seg[k] = h('button', { onclick: () => this.setSource(k) }, label))),
        )
      : null;
    // sort by date (the usual order) or by branch tag (grouped, the latest branch first), and show one branch only
    this.sortBy = 'date';
    try {
      const v = localStorage.getItem('hub.bugsSort');
      if (v === 'branch' || v === 'priority') this.sortBy = v;
    } catch {}
    this.sortSeg = {};
    this.sortCtl = h('div', { class: 'seg', title: 'How to order the cards' }, h('span', { class: 'seg-label' }, 'Sort'), [['date', 'Date'], ['branch', 'Branch'], ['priority', 'Priority']].map(([k, label]) => (this.sortSeg[k] = h('button', { onclick: () => this.setSort(k) }, label))));
    this.branchSel = h('select', { class: 'branch-filter', title: 'Show only one branch', onchange: () => this.setBranchFilter(this.branchSel.value) });
    // search: only the cards with these words in them are shown, and the words are lit up
    this.query = '';
    this.searchBox = h('input', { type: 'search', class: 'bug-search', placeholder: 'Search…', title: 'Show only the cards with these words', oninput: () => ((this.query = this.searchBox.value.trim().toLowerCase()), this.draw()) });
    this.tools = h('div', { class: 'bugtools' }, this.searchBox, this.branchSel, this.filter, this.sortCtl);
    this.top = h('div', { class: 'bugtop' }, h('span', { class: 'label' }, 'Show'), COLS.map((c) => (this.toggles[c.key] = h('button', { class: 'tog', onclick: () => this.toggle(c.key) }, c.title, ' ', (this.tcount[c.key] = h('span', { class: 'n' }))))), this.tools);
    this.root.querySelectorAll('.col').forEach((col) => (this.cols[col.dataset.key] = col));
    this.selbar = h('div', { class: 'selbar', hidden: true });
    stage.append(this.top, this.root, this.selbar);
    // (the header can be one row or two: the lists start right under it)
    this.topSize = new ResizeObserver(() => (this.root.style.top = this.top.offsetHeight + 'px'));
    this.topSize.observe(this.top);
    // shift+click a card to add it to (or take it out of) the selection; any other click clears it
    this.root.addEventListener('mousedown', (e) => e.shiftKey && e.target.closest('.bug') && e.preventDefault()); // (no text selection)
    this.root.addEventListener('click', (e) => {
      const card = e.target.closest('.bug');
      if (e.shiftKey && card && !e.target.closest('a, button, input, img')) return this.toggleSel(card.dataset.id);
      if (!e.shiftKey && !e.target.closest('button, a, input, textarea, .col-head')) this.clearSel();
    });
    this.root.addEventListener('mouseover', (e) => (this.hover = e.target.closest('.col')?.dataset.key || null));
    this.root.addEventListener('mouseleave', () => (this.hover = null));
    this.onKey = (e) => {
      if (document.querySelector('.overlay, .lightbox')) return;
      if (e.key === 'Escape' && this.sel.size) this.clearSel();
      // Ctrl+A picks everything in the list the mouse is over
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && this.hover && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) {
        e.preventDefault();
        getSelection()?.removeAllRanges();
        this.sel = new Set(this.list(this.hover).map((b) => b.id));
        this.paintSel();
      }
    };
    document.addEventListener('keydown', this.onKey);
    this.layout();
    loadBranches().then(() => this.fillBranchSelect());
    this.offBranch = on('branchview', () => this.onBranchView());
    await this.mountAdd();
    await this.load();
  }
  toggle(key) {
    if (this.shown.has(key)) {
      if (this.shown.size === 1) return; // one list always stays
      this.shown.delete(key);
    } else this.shown.add(key);
    try {
      localStorage.setItem('hub.bugcols', JSON.stringify([...this.shown]));
    } catch {}
    this.layout();
  }
  // the branch dropdown: every branch of the repository, plus any a card carries that is no longer in the list
  fillBranchSelect() {
    const names = [...this.branchChoices()];
    for (const b of this.all.values()) if (b.branch && !names.includes(b.branch)) names.push(b.branch);
    const key = names.join('|');
    if (key !== this.optKey) {
      this.optKey = key; // (only rebuilt when the branches changed, so an open dropdown is left alone)
      this.branchSel.replaceChildren(h('option', { value: '' }, 'All branches'), ...names.map((n) => h('option', { value: n }, n)));
    }
    if (this.branchFilter && !names.includes(this.branchFilter)) {
      this.branchSel.append(h('option', { value: this.branchFilter }, this.branchFilter));
      this.optKey = null;
    }
    this.branchSel.value = this.branchFilter;
  }
  setSort(mode) {
    this.sortBy = mode;
    try {
      localStorage.setItem('hub.bugsSort', mode);
    } catch {}
    this.layout();
    this.draw();
  }
  // the branch shown is the one chosen at the top of the menu (this dropdown is the same choice)
  get branchFilter() {
    return S.branchView;
  }
  setBranchFilter(name) {
    setBranchView(name);
  }
  layout() {
    for (const [k, b] of Object.entries(this.sortSeg || {})) b.classList.toggle('on', k === this.sortBy);
    if (this.filter) for (const [k, b] of Object.entries(this.seg)) b.classList.toggle('on', k === this.source);
    const on = COLS.filter((c) => this.shown.has(c.key));
    this.root.style.setProperty('--n', on.length);
    for (const c of COLS) {
      this.cols[c.key].hidden = !this.shown.has(c.key);
      this.toggles[c.key].classList.toggle('on', this.shown.has(c.key));
    }
    // a divider between each two lists that are shown
    this.root.querySelectorAll('.col-resizer').forEach((r) => r.remove());
    on.slice(0, -1).forEach((c, i) => this.cols[c.key].after(this.resizer(c.key, on[i + 1].key)));
    this.applyWidths();
  }
  // the shown lists share the width as dragged; the dividers are the 14px between them
  applyWidths() {
    const on = COLS.filter((c) => this.shown.has(c.key));
    const cols = (min) => on.map((c) => `minmax(${min}, ${this.widths[c.key].toFixed(4)}fr)`).join(' 14px ');
    this.root.style.setProperty('--cols', cols('0'));
    this.root.style.setProperty('--cols-mid', cols('260px'));
  }
  saveWidths() {
    try {
      localStorage.setItem('hub.colw.' + this.section, JSON.stringify(this.widths));
    } catch {}
  }
  // drag to make the list on the left wider and the one on the right narrower (or the other way); double-click: even
  resizer(a, b) {
    const r = h('div', { class: 'col-resizer', title: 'Drag to resize the lists · double-click to make them even', role: 'separator', 'aria-orientation': 'vertical' });
    r.addEventListener('dblclick', () => {
      this.widths[a] = this.widths[b] = (this.widths[a] + this.widths[b]) / 2;
      this.applyWidths();
      this.saveWidths();
    });
    r.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      const A = this.cols[a].getBoundingClientRect().width;
      const B = this.cols[b].getBoundingClientRect().width;
      const fr = this.widths[a] + this.widths[b];
      const min = Math.min(200, (A + B) / 2 - 1);
      const x0 = e.clientX;
      r.classList.add('on');
      document.body.classList.add('col-resizing');
      const move = (ev) => {
        const wa = Math.max(min, Math.min(A + B - min, A + ev.clientX - x0));
        this.widths[a] = (fr * wa) / (A + B);
        this.widths[b] = fr - this.widths[a];
        this.applyWidths();
      };
      const up = () => {
        r.removeEventListener('pointermove', move);
        r.removeEventListener('pointerup', up);
        r.removeEventListener('pointercancel', up);
        r.classList.remove('on');
        document.body.classList.remove('col-resizing');
        this.saveWidths();
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up);
      r.addEventListener('pointercancel', up);
    });
    return r;
  }
  unmount() {
    this.offBranch?.();
    this.topSize?.disconnect();
    document.removeEventListener('keydown', this.onKey);
    this.stage?.replaceChildren();
  }

  async load() {
    const r = await api('GET', `/api/bugs?section=${this.section}`);
    this.all = new Map([...r.open, ...r.closed, ...r.trash].map((b) => [b.id, b]));
    this.draw();
  }
  upsert(bug) {
    if (bug.section !== this.section) return;
    this.all.set(bug.id, bug);
    this.draw();
  }
  remove(id) {
    this.all.delete(id);
    this.draw();
  }
  get filterable() {
    return true;
  }
  setSource(mode) {
    this.source = mode;
    try {
      localStorage.setItem('hub.bugsSource', mode);
    } catch {}
    this.layout();
    this.draw();
  }
  list(key) {
    const rows = [...this.all.values()].filter((b) => b.status === key && !this.deleting.has(b.id) && (!this.filterable || this.source === 'all' || (this.source === 'external') === (b.source === 'form')) && (this.branchFilter ? b.branch === this.branchFilter : !this.hiddenInAll(b)) && this.matches(b)).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const ordered = this.order[key] === 'oldest' ? rows : rows.reverse();
    if (this.sortBy === 'priority') return ordered.map((b, i) => [b, i]).sort((x, y) => (PRANK[x[0].priority] ?? 9) - (PRANK[y[0].priority] ?? 9) || x[1] - y[1]).map((x) => x[0]);
    if (this.sortBy !== 'branch') return ordered;
    // grouped by branch, the repository's latest branch first and cards with no branch last; inside a branch the usual order stays
    const rank = (b) => {
      const i = S.branches.list.indexOf(b.branch);
      return b.branch ? (i < 0 ? 1e6 : i) : 1e9;
    };
    return ordered.map((b, i) => [b, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || (x[0].branch || '').localeCompare(y[0].branch || '') || x[1] - y[1]).map((x) => x[0]);
  }
  matches(b) {
    return !this.query || [b.message, b.name, b.email, b.branch, b.priority].some((t) => String(t || '').toLowerCase().includes(this.query));
  }
  empty(key) {
    if (this.query) return 'No matches.';
    return key === 'open' ? 'Nothing open. Nice.' : key === 'closed' ? 'Nothing closed yet.' : 'The trash is empty.';
  }
  counts() {
    return Object.fromEntries(COLS.map((c) => [c.key, [...this.all.values()].filter((b) => b.status === c.key && !this.deleting.has(b.id)).length]));
  }
  // ---- picking several cards
  toggleSel(id) {
    if (!this.sel.delete(id)) this.sel.add(id);
    this.paintSel();
  }
  clearSel() {
    if (!this.sel.size) return;
    this.sel.clear();
    this.paintSel();
  }
  label(status) {
    return status === 'open' ? 'Reopen' : `Move to ${LABEL[status]}`;
  }
  paintSel() {
    for (const id of [...this.sel]) if (!this.all.has(id)) this.sel.delete(id);
    this.root.querySelectorAll('.bug').forEach((el) => el.classList.toggle('selected', this.sel.has(el.dataset.id)));
    const items = [...this.sel].map((id) => this.all.get(id));
    this.selbar.hidden = !items.length;
    if (!items.length) return;
    const btns = COLS.filter((c) => items.some((b) => b.status !== c.key)).map((c) => h('button', { onclick: () => this.moveMany([...this.sel], c.key) }, this.label(c.key)));
    if (items.every((b) => b.status === 'trash')) btns.push(h('button', { class: 'danger', onclick: () => this.destroyMany([...this.sel]) }, 'Delete'));
    this.selbar.replaceChildren(h('span', { class: 'cnt' }, `${items.length} selected`), ...btns, h('button', { class: 'ghost', onclick: () => this.clearSel() }, 'Clear'));
  }
  // what the toast says after a move (with Undo)
  movedText(status, n) {
    if (status === 'open') return n > 1 ? `${n} reopened` : 'Reopened';
    return `${n > 1 ? `${n} moved` : 'Moved'} to ${LABEL[status]}`;
  }
  async moveMany(ids, status, quiet = false) {
    const rows = ids.map((id) => this.all.get(id)).filter((b) => b && b.status !== status);
    this.sel.clear();
    if (!rows.length) return this.paintSel();
    const now = Date.now();
    for (const b of rows) this.all.set(b.id, { ...b, status, moved: now, movedBy: S.me.email });
    this.draw();
    // Undo puts each back in the list it came from
    if (!quiet) undoToast(this.movedText(status, rows.length), () => Promise.all(rows.map((b) => this.moveMany([b.id], b.status, true))));
    try {
      await Promise.all(rows.map((b) => api('PATCH', `/api/bugs/${b.id}`, { status })));
    } catch (e) {
      toast(e.message, true);
      this.load();
    }
  }
  // deleting waits a few seconds so it can be undone (no question first). If the page is closed before
  // then, the card simply stays.
  destroyMany(ids) {
    this.sel.clear();
    for (const id of ids) this.deleting.add(id);
    this.draw();
    let undone = false;
    undoToast(ids.length > 1 ? `${ids.length} deleted` : 'Deleted', () => {
      undone = true;
      for (const id of ids) this.deleting.delete(id);
      this.draw();
    });
    setTimeout(async () => {
      if (undone) return;
      try {
        await Promise.all(ids.map((id) => api('DELETE', `/api/bugs/${id}`)));
        for (const id of ids) this.all.delete(id);
      } catch (e) {
        toast(e.message, true);
      }
      for (const id of ids) this.deleting.delete(id);
      this.draw();
    }, UNDO_MS);
  }

  draw() {
    if (this.editing) return; // (a card is being edited: it is drawn again when that is done)
    // with the cards grouped, the heading of the group a card starts
    const group = (b) => (this.sortBy === 'branch' ? { key: b.branch || '', label: b.branch ? '\u2387 ' + b.branch : 'no branch', same: (r) => r.branch === b.branch } : { key: b.priority || '', label: b.priority ? PRIORITY[b.priority] + ' priority' : 'no priority', same: (r) => r.priority === b.priority });
    for (const c of COLS) {
      if (this.ordBtn[c.key]) this.ordBtn[c.key].textContent = (this.order[c.key] === 'oldest' ? 'Oldest first' : 'Newest first') + ' \u21c5';
      const rows = this.list(c.key);
      this.heads[c.key].textContent = rows.length;
      this.tcount[c.key].textContent = rows.length;
      const kids = [];
      let last;
      for (const b of rows) {
        const g = this.sortBy === 'date' ? null : group(b);
        if (g && g.key !== last) {
          kids.push(h('div', { class: 'branch-head' }, g.label, h('span', {}, String(rows.filter(g.same).length))));
          last = g.key;
        }
        kids.push(this.card(b));
      }
      this.bodies[c.key].replaceChildren(...(kids.length ? kids : [h('div', { class: 'col-empty' }, this.empty(c.key))]));
    }
    if (this.branchSel) this.fillBranchSelect();
    S.bugCounts[this.section] = this.counts();
    if (this.query) this.root.querySelectorAll('.md').forEach((el) => highlight(el, this.query));
    emit('bugcounts');
    this.paintSel();
  }

  move(id, status) {
    return this.moveMany([id], status);
  }
  destroy(id) {
    this.destroyMany([id]);
  }

  // ---- what a card can do: its edit, reference and more buttons (on hover), and the same menu on a right-click
  reference(b) {
    this.onReference({ k: 'bug', bug: b.id, section: this.section, text: `${b.name}: ${b.message.replace(/\s+/g, ' ').slice(0, 120)}` });
  }
  editCard(b) {
    const el = this.root.querySelector(`.bug[data-id="${b.id}"] .md`);
    if (el) this.startEdit(b, el, this.enterSaves);
  }
  get enterSaves() {
    return false; // (a report's text is longer: Ctrl+Enter saves it)
  }
  cardMenu(x, y, b) {
    const at = { clientX: x, clientY: y };
    const items = COLS.filter((c) => c.key !== b.status).map((c) => ({ label: this.label(c.key), fn: () => this.move(b.id, c.key) }));
    items.push({ label: 'Edit', fn: () => this.editCard(b) }, { label: 'Reference in the chat', fn: () => this.reference(b) }, { label: 'Priority…', fn: () => this.pickPriority(at, b) }, { label: b.due ? 'Change the deadline…' : 'Set a deadline…', fn: () => this.pickDue(b) });
    if (this.branchChoices().length) items.push({ label: 'Branch…', fn: () => this.pickBranch(at, b) });
    if (b.status === 'trash') items.push({ label: 'Delete', danger: true, fn: () => this.destroy(b.id) });
    menu(x, y, items);
  }
  cardTools(b) {
    const more = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      this.cardMenu(r.left, r.bottom + 4, b);
    };
    return h(
      'span',
      { class: 'card-tools' },
      h('button', { class: 'ct', title: 'Edit', onclick: () => this.editCard(b) }, '\u270e'),
      h('button', { class: 'ct', title: 'Reference in the chat', onclick: () => this.reference(b) }, '\u2197'),
      h('button', { class: 'ct more', title: 'More', onclick: more }, '\u22ef'),
    );
  }
  // a right-click on a card opens its menu (not over selected text, a link or a picture: those keep the browser's)
  onCardContext(e, b) {
    if (e.target.closest('a, img, textarea, input') || (getSelection()?.toString() && e.target.closest('.md'))) return;
    e.preventDefault();
    this.cardMenu(e.clientX, e.clientY, b);
  }

  card(b) {
    const body = h('div', { class: 'md', 'data-quotable': '' });
    renderInto(body, b.message);
    const long = b.message.length > 420 || b.message.split('\n').length > 8;
    if (long) body.classList.add('clamped');
    const more = long ? h('button', { class: 'more-btn', onclick: (e) => (body.classList.toggle('clamped'), (e.target.textContent = body.classList.contains('clamped') ? 'Show more' : 'Show less')) }, 'Show more') : null;
    // only what is set shows: an unset branch or priority appears on hover, to be set with a click
    const ext = b.source === 'form';
    const card = h(
      'div',
      { class: 'bug', dataset: { id: b.id, section: this.section }, onmousedown: (e) => (card.draggable = !e.target.closest('.md, a, button, img')), oncontextmenu: (e) => this.onCardContext(e, b) },
      h('div', { class: 'bug-head' }, h('b', {}, b.name), b.email && b.email !== b.name ? h('span', { class: 'em' }, b.email) : null, h('time', { title: stamp(b.ts) }, ago(b.ts)), this.cardTools(b)),
      h('div', { class: 'bug-meta' }, ext ? h('span', { class: 'chip form', title: 'Sent from the website' }, 'external') : null, ext && b.browser ? h('span', { class: 'chip', title: b.ua || '' }, b.browser) : null, S.branches.list.length || b.branch ? this.branchChip(b) : null, ...this.prioChips(b)),
      body,
      more,
      b.images?.length ? h('div', { class: 'shots' }, b.images.map((id) => h('img', { src: imageUrl(id), alt: 'Screenshot', loading: 'lazy', onclick: () => lightbox(imageUrl(id)) }))) : null,
      b.moved && b.status !== 'open' ? h('div', { class: 'moved' }, `${LABEL[b.status]} ${ago(b.moved)} by ${user(b.movedBy).name}`) : null,
    );
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', b.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    return card;
  }

  focus(id) {
    const el = this.root?.querySelector(`.bug[data-id="${id}"]`);
    if (!el) return toast('That report is gone.', true);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  // ---- editing the text of a card
  startEdit(b, textEl, enterSaves = false) {
    if (this.editing) return;
    this.editing = b.id;
    const ta = h('textarea', { class: 'edit-box', maxlength: '10000' });
    ta.value = b.message;
    const finish = async (save) => {
      const message = ta.value.trim();
      this.editing = null;
      if (save && message && message !== b.message) {
        this.all.set(b.id, { ...this.all.get(b.id), message });
        try {
          await api('PATCH', '/api/bugs/' + b.id, { message });
        } catch (e) {
          toast(e.message, true);
          return this.load();
        }
      }
      this.draw();
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && !e.isComposing && ((enterSaves && !e.shiftKey) || e.ctrlKey || e.metaKey)) (e.preventDefault(), finish(true));
    });
    const box = h('div', { class: 'edit' }, ta, h('div', { class: 'edit-bar' }, h('button', { class: 'btn small', onclick: () => finish(true) }, 'Save'), h('button', { class: 'btn small ghost', onclick: () => finish(false) }, 'Cancel')));
    textEl.replaceWith(box);
    const fit = () => ((ta.style.height = 'auto'), (ta.style.height = Math.min(320, ta.scrollHeight + 2) + 'px'));
    ta.addEventListener('input', fit);
    fit();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ---- priority (High, Medium, Low) and the deadline it brings
  prioChips(b) {
    const overdue = b.due && b.status === 'open' && b.due < new Date().toLocaleDateString('sv');
    return [
      h('button', { class: 'chip prio ' + (b.priority || 'none unset'), title: 'The priority: click to change', onclick: (e) => this.pickPriority(e, b) }, b.priority ? PRIORITY[b.priority] : 'no priority'),
      b.due ? h('button', { class: 'chip due' + (overdue ? ' late' : ''), title: overdue ? 'Past its deadline. Click to change' : 'The deadline: click to change', onclick: () => this.pickDue(b) }, '\u23f0 ' + dueLabel(b.due)) : null,
    ];
  }
  pickPriority(e, b) {
    menu(e.clientX, e.clientY, [...Object.entries(PRIORITY).map(([k, label]) => ({ label, on: k === b.priority, fn: () => this.setPriority(b.id, k) })), { label: 'No priority', on: !b.priority, fn: () => this.setPriority(b.id, '') }]);
  }
  async setPriority(id, priority) {
    const b = this.all.get(id);
    if (!b || b.priority === priority) return;
    const due = priority ? deadlineFor(priority) : '';
    this.all.set(id, { ...b, priority, due });
    this.draw();
    try {
      await api('PATCH', '/api/bugs/' + id, { priority, due });
    } catch (e) {
      toast(e.message, true);
      this.load();
    }
  }
  async pickDue(b) {
    const inp = h('input', { type: 'date', value: b.due || '' });
    const body = h('div', {}, h('label', {}, 'Deadline'), inp);
    const r = await modal('Deadline', body, [{ label: 'Cancel', value: false }, { label: 'No deadline', value: 'none' }, { label: 'Save', value: true, primary: true }]);
    if (r !== true && r !== 'none') return;
    const due = r === 'none' ? '' : inp.value;
    if (due === (b.due || '')) return;
    this.all.set(b.id, { ...this.all.get(b.id), due });
    this.draw();
    api('PATCH', '/api/bugs/' + b.id, { due }).catch((e) => (toast(e.message, true), this.load()));
  }

  // the branch tag of a report or to-do: click it to pick another of the repository's branches
  branchChip(b) {
    const name = b.branch || '';
    return h('button', { class: 'chip branch' + (name ? '' : ' none unset'), title: 'The branch this is about: click to change', onclick: (e) => this.pickBranch(e, b) }, '\u2387 ', name || 'no branch');
  }
  async pickBranch(e, b) {
    const x = e.clientX;
    const y = e.clientY;
    await loadBranches();
    const items = this.branchChoices().map((n) => ({ label: n, on: n === b.branch, fn: () => this.setBranch(b.id, n) }));
    if (!items.length) return toast('The list of branches is not available.', true);
    menu(x, y, items);
  }
  async setBranch(id, branch) {
    const b = this.all.get(id);
    if (!b || b.branch === branch) return;
    this.all.set(id, { ...b, branch });
    this.draw();
    try {
      await api('PATCH', `/api/bugs/${id}`, { branch });
    } catch (e) {
      toast(e.message, true);
      this.load();
    }
  }
  // the branches a card can be tagged with (the to-do list adds "viti")
  branchChoices() {
    return S.branches.list;
  }
  // for the list's filter: whether a card is hidden while "All branches" is chosen
  hiddenInAll() {
    return false;
  }
  onBranchView() {
    this.fillBranchSelect();
    this.draw();
  }
  // a <select> of the repository's branches with the latest chosen
  branchSelect() {
    const list = this.branchChoices();
    const { latest } = S.branches;
    const sel = h('select', { class: 'branch-select', title: 'The branch this is about' }, list.map((n) => h('option', { value: n }, n + (n === latest ? ' (latest)' : ''))));
    sel.value = (list.includes(S.branchView) ? S.branchView : '') || latest || list[0] || '';
    return sel;
  }

  // ---- adding: a box on top of the Open list. Write and press Enter (Shift+Enter: a new line). A report can
  // take screenshots too: paste or drop them into the box (up to 5).
  get takesShots() {
    return true;
  }
  async mountAdd() {
    this.input = h('textarea', { class: 'todo-add', rows: '1', placeholder: 'Write text and press enter', maxlength: this.takesShots ? '10000' : '2000' });
    const fit = () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(160, this.input.scrollHeight + 2)}px`;
    };
    this.fitAdd = fit;
    this.input.addEventListener('input', fit);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.addRow();
      }
    });
    this.pending = []; // screenshots waiting to go with the next report
    this.shotBox = h('div', { class: 'add-shots', hidden: true });
    if (this.takesShots) {
      const take = (files) => {
        const imgs = [...files].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
        if (!imgs.length) return false;
        this.pending.push(...imgs);
        if (this.pending.length > 5) toast('A report takes up to 5 screenshots.', true);
        this.pending = this.pending.slice(0, 5);
        this.drawShots();
        return true;
      };
      this.input.addEventListener('paste', (e) => take(e.clipboardData?.files || []) && e.preventDefault());
      this.input.addEventListener('dragover', (e) => e.preventDefault());
      this.input.addEventListener('drop', (e) => take(e.dataTransfer?.files || []) && e.preventDefault());
      this.input.title = 'Paste or drop screenshots here too';
    }
    // the branch a new one is about (the latest by default) and its priority (none by default)
    await loadBranches();
    this.addBranch = S.branches.list.length ? this.branchSelect() : null;
    this.addPrio = this.prioSlider();
    this.cols.open.insertBefore(h('div', { class: 'todo-form' }, this.input, this.shotBox, h('div', { class: 'add-opts' }, this.addPrio.el, this.addBranch)), this.bodies.open);
  }
  // the priority of a new one: a slider with four notches (none, low, medium, high). The handle glides to
  // the notch (click one, drag, or use the arrow keys) and takes the level's colour.
  prioSlider() {
    const LEVELS = ['', 'low', 'medium', 'high'];
    let at = 0;
    const thumb = h('span', { class: 'ps-thumb' });
    const fill = h('span', { class: 'ps-fill' });
    const track = h('span', { class: 'ps-track' }, h('span', { class: 'ps-line' }), fill, LEVELS.map((_, i) => h('span', { class: 'ps-notch', style: { left: `${(i / 3) * 100}%` } })), thumb);
    const name = h('span', { class: 'prio-name' });
    const el = h('div', { class: 'prio-slide', role: 'slider', tabindex: '0', 'aria-label': 'Priority', 'aria-valuemin': '0', 'aria-valuemax': '3', title: 'The priority (a deadline comes with it, as set in Settings)' }, track, name);
    const set = (i) => {
      i = Math.max(0, Math.min(3, i));
      if (i !== at) {
        // a little bump when it lands on a new notch
        thumb.classList.remove('pop');
        void thumb.offsetWidth;
        thumb.classList.add('pop');
      }
      at = i;
      const k = LEVELS[i];
      thumb.style.left = fill.style.width = `${(i / 3) * 100}%`;
      name.textContent = k ? PRIORITY[k] : 'No priority';
      el.dataset.level = k || 'none';
      el.setAttribute('aria-valuenow', String(i));
      el.setAttribute('aria-valuetext', name.textContent);
    };
    const nearest = (x) => {
      const r = track.getBoundingClientRect();
      return Math.round(((x - r.left) / r.width) * 3);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus();
      el.setPointerCapture(e.pointerId);
      set(nearest(e.clientX));
      const move = (ev) => set(nearest(ev.clientX));
      const up = () => (el.removeEventListener('pointermove', move), el.removeEventListener('pointerup', up));
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (step) (e.preventDefault(), set(at + step));
      else if (e.key === 'Home' || e.key === 'End') (e.preventDefault(), set(e.key === 'Home' ? 0 : 3));
    });
    set(0);
    return {
      el,
      get value() {
        return LEVELS[at];
      },
      set value(v) {
        set(Math.max(0, LEVELS.indexOf(v)));
      },
    };
  }
  drawShots() {
    this.shotBox.hidden = !this.pending.length;
    this.shotBox.replaceChildren(
      ...this.pending.map((f, i) => {
        const url = URL.createObjectURL(f);
        return h('span', { class: 'add-shot' }, h('img', { src: url, alt: '', onload: () => URL.revokeObjectURL(url) }), h('button', { type: 'button', title: 'Leave this one out', onclick: () => (this.pending.splice(i, 1), this.drawShots()) }, '×'));
      }),
    );
  }
  async addRow() {
    const message = this.input.value.trim();
    if (!message) return;
    const shots = this.pending;
    const priority = this.addPrio.value;
    this.input.value = '';
    this.addPrio.value = '';
    this.pending = [];
    this.drawShots();
    this.fitAdd();
    try {
      const images = [];
      for (const f of shots) images.push((await uploadImage(f)).id);
      await api('POST', '/api/bugs', { message, images, section: this.section, branch: this.addBranch?.value, priority, due: priority ? deadlineFor(priority) : '' });
    } catch (e) {
      this.input.value = message;
      this.addPrio.value = priority;
      this.pending = shots;
      this.drawShots();
      this.fitAdd();
      toast(e.message, true);
    }
    this.input.focus();
  }

}
