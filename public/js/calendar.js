// The Calendar: a month at a time. Label a date (and point the label at anything you can reference in the chat: a post-it,
// a to-do, a report, a message, a day in a chat) and see the deadlines of the open tasks. Each person's own Settings decide
// how long a priority gives (see settings.js); here the dates are only shown.
import { S, sectionLabel } from './state.js';
import { api } from './api.js';
import { h, toast, modal, confirmBox, promptBox, menu } from './ui.js';
import { refCard, glyph } from './chat.js';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => new Date(s + 'T12:00:00');
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class Calendar {
  // open(ref): show what a label points at. getRefs(): what is waiting in the chat box (to point a label at).
  constructor({ open, getRefs, chatSection }) {
    this.open = open;
    this.getRefs = getRefs;
    this.chatSection = chatSection;
    const now = new Date();
    this.month = new Date(now.getFullYear(), now.getMonth(), 1);
    this.entries = [];
    this.tasks = [];
  }

  async mount(stage) {
    this.stage = stage;
    this.title = h('h2', { class: 'cal-title' });
    this.grid = h('div', { class: 'cal-grid' });
    this.root = h(
      'div',
      { class: 'calendar' },
      h('div', { class: 'cal-head' }, h('button', { class: 'btn small ghost', title: 'Last month', onclick: () => this.shift(-1) }, '‹'), this.title, h('button', { class: 'btn small ghost', title: 'Next month', onclick: () => this.shift(1) }, '›'), h('button', { class: 'btn small ghost', onclick: () => this.today() }, 'Today'), h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => this.add(iso(new Date())) }, '+ Label a date')),
      h('div', { class: 'cal-week' }, WEEK.map((d) => h('span', {}, d))),
      this.grid,
      h('p', { class: 'cal-hint' }, 'Click a day to label it. To point a label at something, press Reference on it first (a post-it, a to-do, a report, or a day in the chat) and pick it in the dialog. Open tasks with a deadline show here too.'),
    );
    stage.append(this.root);
    await this.load();
  }
  unmount() {
    clearTimeout(this.timer);
    this.stage?.replaceChildren();
  }
  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), 300);
  }
  shift(n) {
    this.month = new Date(this.month.getFullYear(), this.month.getMonth() + n, 1);
    this.load();
  }
  today() {
    const now = new Date();
    this.month = new Date(now.getFullYear(), now.getMonth(), 1);
    this.load();
  }

  // the days shown: whole weeks (Monday first) from the one with the 1st to the one with the last day
  days() {
    const first = new Date(this.month);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    const last = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 0);
    const out = [];
    for (let d = new Date(start); d <= last || out.length % 7; d.setDate(d.getDate() + 1)) out.push(new Date(d));
    return out;
  }

  async load() {
    const days = this.days();
    try {
      const r = await api('GET', `/api/calendar?from=${iso(days[0])}&to=${iso(days.at(-1))}`);
      this.entries = r.entries;
      this.tasks = r.tasks;
    } catch (e) {
      return toast(e.message, true);
    }
    this.draw(days);
  }

  draw(days = this.days()) {
    this.title.textContent = this.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const todayIso = iso(new Date());
    this.grid.replaceChildren(
      ...days.map((d) => {
        const key = iso(d);
        const cell = h('div', { class: 'cal-day' + (d.getMonth() !== this.month.getMonth() ? ' other' : '') + (key === todayIso ? ' today' : ''), dataset: { date: key } });
        const head = h('div', { class: 'cal-num' }, h('span', {}, String(d.getDate())), h('button', { class: 'cal-add', title: 'Label this day', onclick: () => this.add(key) }, '+'));
        cell.append(head);
        for (const t of this.tasks.filter((x) => x.due === key)) {
          cell.append(h('button', { class: 'cal-chip task ' + (t.priority || 'none'), title: `${t.where}${t.branch ? ' · ' + t.branch : ''}${t.priority ? ' · ' + t.priority + ' priority' : ''}: ${t.text}`, onclick: () => this.open({ k: 'bug', bug: t.id, section: t.section }) }, '⏰ ' + t.text.replace(/\s+/g, ' ').slice(0, 60)));
        }
        for (const e of this.entries.filter((x) => x.date === key)) cell.append(this.entryEl(e));
        return cell;
      }),
    );
  }

  entryEl(e) {
    const text = e.title || e.ref?.text || 'Label';
    const el = h(
      'div',
      { class: 'cal-chip entry' + (e.ref ? ' linked' : '') },
      h('button', { class: 'cal-text', title: e.ref ? 'Open what this points at' : text, onclick: () => (e.ref ? this.open(e.ref) : this.edit(e)) }, (e.ref ? '🔗 ' : '') + text.slice(0, 80)),
      h('button', { class: 'cal-more', title: 'Change or remove', onclick: (ev) => this.entryMenu(ev, e) }, '⋯'),
    );
    return el;
  }
  entryMenu(ev, e) {
    menu(ev.clientX, ev.clientY, [
      { label: 'Change the label', fn: () => this.edit(e) },
      { label: 'Move to another day…', fn: () => this.moveDay(e) },
      { label: 'Delete', danger: true, fn: async () => (await confirmBox('Delete this label?', e.title || 'It is removed from the calendar.', 'Delete', true)) && api('DELETE', `/api/calendar/${e.id}`).catch((er) => toast(er.message, true)) },
    ]);
  }
  async edit(e) {
    const title = await promptBox('Label', 'Text', e.title);
    if (title === null || title === e.title) return;
    if (!title && !e.ref) return toast('A label needs some text.', true);
    api('PATCH', `/api/calendar/${e.id}`, { title }).catch((er) => toast(er.message, true));
  }
  async moveDay(e) {
    const inp = h('input', { type: 'date', value: e.date });
    if ((await modal('Move to', h('div', {}, h('label', {}, 'Date'), inp), [{ label: 'Cancel', value: false }, { label: 'Move', value: true, primary: true }])) !== true || !inp.value) return;
    api('PATCH', `/api/calendar/${e.id}`, { date: inp.value }).catch((er) => toast(er.message, true));
  }

  // ---- a new label: for a date, with a pointer at something (or at a day in a chat)
  async add(date) {
    const dateInp = h('input', { type: 'date', value: date });
    const text = h('input', { type: 'text', maxlength: '200', placeholder: 'For example: playtest with the team' });
    const waiting = this.getRefs();
    const link = h('select', {}, h('option', { value: '' }, 'Nothing'), waiting.map((r, i) => h('option', { value: String(i) }, this.describe(r))), h('option', { value: 'day' }, 'A day in a chat…'));
    const chatSel = h('select', {}, S.sections.map((s) => h('option', { value: s.id }, `${glyph(s.kind)} ${sectionLabel(s.id)}`)));
    chatSel.value = this.chatSection() || chatSel.value;
    const dayInp = h('input', { type: 'date', value: date });
    const dayBox = h('div', { hidden: true }, h('label', { style: { marginTop: '12px' } }, 'Which chat'), chatSel, h('label', { style: { marginTop: '12px' } }, 'Which day in it'), dayInp);
    link.addEventListener('change', () => (dayBox.hidden = link.value !== 'day'));
    text.addEventListener('keydown', (e) => e.key === 'Enter' && document.querySelector('.overlay .btn:not(.ghost)')?.click());
    const body = h('div', {}, h('label', {}, 'Date'), dateInp, h('label', { style: { marginTop: '12px' } }, 'Label'), text, h('label', { style: { marginTop: '12px' } }, 'Points at'), link, waiting.length ? null : h('small', { class: 'hint' }, 'Nothing is waiting in the chat box. Press Reference on a post-it, a to-do or a report, or on a day heading in the chat, and it is offered here.'), dayBox);
    if ((await modal('Label a date', body, [{ label: 'Cancel', value: false }, { label: 'Add', value: true, primary: true }])) !== true) return;
    let ref = null;
    if (link.value === 'day') {
      const d = fromIso(dayInp.value || dateInp.value);
      ref = { k: 'day', section: chatSel.value, day: iso(d), from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), text: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) };
    } else if (link.value !== '') ref = waiting[Number(link.value)];
    try {
      await api('POST', '/api/calendar', { date: dateInp.value, title: text.value, ref });
    } catch (e) {
      toast(e.message, true);
    }
  }
  describe(r) {
    const card = refCard(r, {});
    return `${card.querySelector('.rl').textContent}: ${(card.querySelector('.rt').textContent || '').slice(0, 50)}`;
  }
}

