// The to-do list: a list of rows you add one at a time. Each row has a checkbox (done: it moves to Closed)
// and an X (not needed: it moves to Trash). Closed rows have a Trash button, Trash rows a Delete button.
// It is the same machinery as the report lists (three lists, live, with a chat), just a different face.
import { S, user, setBranchView } from './state.js';
import { api, loadBranches } from './api.js';
import { h, ago, stamp, toast } from './ui.js';
import { renderInto } from './md.js';
import { Bugs } from './bugs.js';

export const VITI = 'viti'; // (the web version's tag for to-dos about Viti itself; the desktop app offers none)

export class Todo extends Bugs {
  // the branches a row can carry: the repository's
  branchChoices() {
    return S.branches.list;
  }
  // "All branches" does not include the viti rows: pick viti to see those
  hiddenInAll(b) {
    return b.branch === VITI;
  }
  // viti is picked here only (not in the menu's Branch field), so it is kept on this page
  get branchFilter() {
    return this.vitiOnly ? VITI : S.branchView;
  }
  setBranchFilter(name) {
    if (name === VITI) {
      this.vitiOnly = true;
      this.fillBranchSelect();
      this.draw();
    } else {
      this.vitiOnly = false;
      setBranchView(name);
    }
  }
  onBranchView() {
    this.vitiOnly = false; // (the menu's Branch field was changed)
    super.onBranchView();
  }
  // the viti rows are not counted in the number by the menu entry
  counts() {
    return Object.fromEntries(['open', 'closed', 'trash'].map((k) => [k, [...this.all.values()].filter((b) => b.status === k && b.branch !== VITI).length]));
  }
  fillBranchSelect() {
    super.fillBranchSelect();
    if (this.addBranch && this.vitiOnly && this.addBranch.value !== VITI) this.addBranch.value = VITI; // (the row to add follows the page)
  }
  get filterable() {
    return false; // (a to-do list has no external rows)
  }

  async mount(stage) {
    await super.mount(stage);
    this.add.remove(); // (no "+ New report": rows are added in the box on top of the Open list)
    this.input = h('textarea', { class: 'todo-add', rows: '1', placeholder: 'Add a row…', maxlength: '2000' });
    const fit = () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(160, this.input.scrollHeight + 2)}px`;
    };
    this.input.addEventListener('input', fit);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.addRow().then(fit);
      }
    });
    // the branch a new row is about: the latest by default
    await loadBranches();
    this.addBranch = S.branches.list.length ? this.branchSelect() : null;
    // viti picked for the new row: the page shows the viti rows too
    this.addBranch?.addEventListener('change', () => (this.addBranch.value === VITI ? this.setBranchFilter(VITI) : this.vitiOnly && this.setBranchFilter(S.branchView)));
    this.cols.open.insertBefore(h('div', { class: 'todo-form' }, this.input, this.addBranch, h('button', { class: 'btn small', onclick: () => this.addRow() }, 'Add')), this.bodies.open);
  }

  async addRow() {
    const message = this.input.value.trim();
    if (!message) return;
    this.input.value = '';
    try {
      await api('POST', '/api/bugs', { message, section: this.section, branch: this.addBranch?.value });
    } catch (e) {
      this.input.value = message;
      toast(e.message, true);
    }
    this.input.focus();
  }

  label(status) {
    return status === 'open' ? 'Reopen' : status === 'closed' ? 'Mark as done' : 'Move to Trash';
  }
  movedText(status, n) {
    if (status === 'closed') return n > 1 ? `${n} marked as done` : 'Marked as done';
    return super.movedText(status, n);
  }
  get enterSaves() {
    return true; // (a row is short: Enter saves it, Shift+Enter is a new line)
  }
  reference(b) {
    this.onReference({ k: 'bug', bug: b.id, section: this.section, text: b.message.replace(/\s+/g, ' ').slice(0, 140) });
  }

  empty(key) {
    return key === 'open' ? 'Nothing to do. Add a row above.' : key === 'closed' ? 'Nothing done yet.' : 'The trash is empty.';
  }

  card(b) {
    const text = h('div', { class: 'md todo-text', 'data-quotable': '' });
    renderInto(text, b.message);
    const row = h('div', { class: `bug todo ${b.status}`, dataset: { id: b.id, section: this.section }, oncontextmenu: (e) => this.onCardContext(e, b) });
    const meta = h('span', { class: 'todo-meta', title: stamp(b.ts) }, `${b.name} · ${ago(b.ts)}`);
    const chip = S.branches.list.length || b.branch ? this.branchChip(b) : null;
    const body = h('div', { class: 'todo-body' }, text, h('div', { class: 'todo-foot' }, meta, chip, ...this.prioChips(b)));
    // open: tick it done, or X (not needed); closed: untick to reopen; trash: Restore. The rest is in the more menu (or a right-click).
    if (b.status === 'open') row.append(h('button', { class: 'tbox', title: 'Done', onclick: () => this.move(b.id, 'closed') }), body, this.cardTools(b), h('button', { class: 'tx', title: 'Not needed: move to Trash', onclick: () => this.move(b.id, 'trash') }, '✕'));
    else if (b.status === 'closed') row.append(h('button', { class: 'tbox on', title: 'Not done after all: reopen', onclick: () => this.move(b.id, 'open') }, '✓'), body, this.cardTools(b));
    else row.append(body, this.cardTools(b), h('button', { class: 'todo-btn', onclick: () => this.move(b.id, 'open') }, 'Restore'));
    return row;
  }
}
