// The Overview: a network of everything that is connected by references. Every chat message that points at
// something is a node, and so is each thing it points at (a note, a text, an image, a report, a to-do row, another
// message). Lines run from the message to what it points at; dashed ones are quotes. Click a node to go there,
// drag a node to move it, drag the background to pan, scroll to zoom, hover to see what is connected.
import { S, imageUrl, sectionById, sectionLabel } from './state.js';
import { api } from './api.js';
import { h, toast, infoButton } from './ui.js';
import { wheelZoomer } from './wheelzoom.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids.filter(Boolean));
  return e;
};
const PALETTE = ['#c99a24', '#6f9fc4', '#7aa874', '#c46f6f', '#9b7fc4', '#c48f5a', '#5fa8a0', '#b07aa0', '#8fa83c', '#8a8a8a'];
const KIND = { msg: 'Message', note: 'Post-it', text: 'Text', image: 'Image', bug: 'Report', todo: 'To do' };
const LEN = 110; // how long every line is (the distance between connected nodes)
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export class Overview {
  constructor({ open }) {
    this.open = open;
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.pos = new Map(); // where nodes were last, so a refresh does not scramble the picture
    this.view = { x: 0, y: 0, k: 1 };
    this.hidden = new Set(); // sections switched off in the legend
  }

  async mount(stage) {
    this.stage = stage;
    this.svg = el('svg', { class: 'graph' });
    this.world = el('g');
    this.edgeLayer = el('g');
    this.nodeLayer = el('g');
    this.world.append(this.edgeLayer, this.nodeLayer);
    this.svg.append(el('defs', {}, el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, el('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#6b6552' }))), this.world);
    this.legend = h('div', { class: 'graph-legend' });
    this.note = h('div', { class: 'graph-empty', hidden: true }, 'Nothing is connected yet.\nIn the chat, quote some text or reference an item, report or message and it shows up here.');
    this.note.style.whiteSpace = 'pre-line';
    this.root = h('div', { class: 'overview' }, this.svg, this.legend, this.note, h('div', { class: 'graph-help' }, infoButton('Everything that is quoted or referenced in a chat, and what it points at. Click a node to open it, drag a node to move it, scroll to zoom, drag the background to pan.', 'up-right')));
    stage.append(this.root);
    this.wire();
    await this.load(true);
  }
  unmount() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.stage?.replaceChildren();
  }
  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(false), 500);
  }
  resize() {
    const r = this.svg.getBoundingClientRect();
    this.w = r.width || 800;
    this.hgt = r.height || 600;
  }

  // ------------------------------------------------------------------ data and layout
  async load(first) {
    let g;
    try {
      g = await api('GET', '/api/graph');
    } catch (e) {
      return toast(e.message, true);
    }
    for (const n of this.nodes) this.pos.set(n.id, { x: n.x, y: n.y });
    this.byId = new Map();
    this.nodes = g.nodes.map((n, i) => {
      const old = this.pos.get(n.id);
      const a = (i * 2.399963) % (Math.PI * 2);
      return { ...n, deg: 0, x: old ? old.x : Math.cos(a) * (60 + i * 6), y: old ? old.y : Math.sin(a) * (60 + i * 6), vx: 0, vy: 0, fresh: !old };
    });
    for (const n of this.nodes) this.byId.set(n.id, n);
    this.edges = g.edges.map((e) => ({ ...e, a: this.byId.get(e.from), b: this.byId.get(e.to) })).filter((e) => e.a && e.b);
    for (const e of this.edges) (e.a.deg++, e.b.deg++);
    // every line is LEN long, except around a node with very many neighbours: its lines are as long as it takes
    // for those neighbours to stand LEN apart from each other in a ring around it
    for (const e of this.edges) e.len = Math.max(LEN, (Math.max(e.a.deg, e.b.deg) * LEN) / (Math.PI * 2));
    // a new node starts next to what it is connected to
    for (const e of this.edges) {
      if (e.a.fresh && !e.b.fresh) (e.a.x = e.b.x + 30, e.a.y = e.b.y + 30);
      else if (e.b.fresh && !e.a.fresh) (e.b.x = e.a.x + 30, e.b.y = e.a.y + 30);
    }
    this.sim(first ? 320 : 120);
    this.relax(this.nodes.length < 150 ? (first ? 500 : 250) : first ? 150 : 60);
    this.draw();
    if (first) this.fit();
  }
  // a plain force layout: everything pushes apart, lines pull their ends together, a little gravity keeps it in one piece
  sim(steps) {
    const ns = this.nodes;
    for (let s = 0; s < steps; s++) {
      const cool = 1 - s / steps;
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          let dx = ns[j].x - ns[i].x;
          let dy = ns[j].y - ns[i].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) (dx = Math.random() - 0.5, dy = Math.random() - 0.5, d2 = 1);
          if (d2 > 90000) continue;
          const f = 2600 / d2;
          const d = Math.sqrt(d2);
          dx = (dx / d) * f;
          dy = (dy / d) * f;
          ns[i].vx -= dx; ns[i].vy -= dy; ns[j].vx += dx; ns[j].vy += dy;
        }
      }
      for (const e of this.edges) {
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - e.len) * 0.05;
        e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f; e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
      }
      for (const n of ns) {
        n.vx -= n.x * 0.004; n.vy -= n.y * 0.004;
        if (n.pinned) (n.vx = 0, n.vy = 0);
        n.x += Math.max(-30, Math.min(30, n.vx)) * cool; n.y += Math.max(-30, Math.min(30, n.vy)) * cool;
        n.vx *= 0.6; n.vy *= 0.6;
      }
    }
  }
  // then even it out: every line the same length, and no two nodes closer than a little under that
  relax(iters) {
    const ns = this.nodes;
    const near = new Set();
    for (const e of this.edges) {
      near.add(e.a.id + '|' + e.b.id);
      near.add(e.b.id + '|' + e.a.id);
    }
    const min = LEN * 0.86;
    for (let it = 0; it < iters; it++) {
      for (const e of this.edges) {
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const k = ((d - e.len) / d) * 0.5;
        if (!e.a.pinned) (e.a.x += dx * k, e.a.y += dy * k);
        if (!e.b.pinned) (e.b.x -= dx * k, e.b.y -= dy * k);
      }
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          if (near.has(ns[i].id + '|' + ns[j].id)) continue;
          const dx = ns[j].x - ns[i].x;
          const dy = ns[j].y - ns[i].y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const k = ((d - min) / d) * 0.5;
          if (!ns[i].pinned) (ns[i].x += dx * k, ns[i].y += dy * k);
          if (!ns[j].pinned) (ns[j].x -= dx * k, ns[j].y -= dy * k);
        }
      }
    }
  }
  radius(n) {
    return 9 + Math.min(14, Math.sqrt(n.deg) * 3.2);
  }
  color(n) {
    const i = Math.max(0, S.sections.findIndex((s) => s.id === n.section));
    return PALETTE[i % PALETTE.length];
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    this.resize();
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    for (const e of this.edges) {
      const line = el('line', { class: 'gedge' + (e.t === 'quote' ? ' quote' : ''), 'marker-end': 'url(#arrow)' });
      const hit = el('line', { class: 'gedge-hit' }, el('title', {}, e.t === 'quote' ? `“${e.text}”` : 'Reference'));
      hit.addEventListener('click', () => (e.t === 'quote' ? this.open({ k: 'quote', section: e.b.section, item: e.b.item, text: e.text }) : this.open(this.refOf(e.b))));
      e.line = line;
      e.hit = hit;
      this.edgeLayer.append(line, hit);
    }
    this.nodes.forEach((n, i) => {
      const r = this.radius(n);
      const g = el('g', { class: `gnode ${n.k}` });
      const fill = this.color(n);
      let shape;
      if (n.k === 'image' && n.img) {
        const id = `gclip${i}`;
        g.append(el('clipPath', { id }, el('circle', { r })));
        shape = el('g', {}, el('circle', { r: r + 2, fill }), el('image', { href: imageUrl(n.img), x: -r, y: -r, width: r * 2, height: r * 2, 'clip-path': `url(#${id})`, preserveAspectRatio: 'xMidYMid slice' }));
      } else if (n.k === 'msg') shape = el('circle', { r, fill });
      else if (n.k === 'bug' || n.k === 'todo') shape = el('rect', { x: -r, y: -r, width: r * 2, height: r * 2, fill, transform: 'rotate(45)', rx: 2 });
      else shape = el('rect', { x: -r, y: -r, width: r * 2, height: r * 2, rx: 4, fill });
      shape.setAttribute('class', 'gshape');
      const glyph = { msg: '“', note: '▤', text: 'T', bug: '!', todo: '★', image: '' }[n.k];
      g.append(shape, glyph ? el('text', { class: 'gglyph', 'text-anchor': 'middle', dy: '.35em', 'font-size': Math.max(10, r) }, glyph) : null, el('text', { class: 'glabel', 'text-anchor': 'middle', y: r + 13 }, cut(n.label, 26)));
      g.append(el('title', {}, `${KIND[n.k] || n.k} · ${sectionLabel(n.section)}${n.who ? ' · ' + n.who : ''}\n${n.label}`));
      g.addEventListener('pointerdown', (ev) => this.startDrag(ev, n));
      g.addEventListener('pointerenter', () => this.hover(n));
      g.addEventListener('pointerleave', () => this.hover(null));
      n.el = g;
      this.nodeLayer.append(g);
    });
    this.drawLegend();
    this.place();
    this.note.hidden = this.nodes.length > 0;
  }
  drawLegend() {
    const used = [...new Set(this.nodes.map((n) => n.section))];
    this.legend.replaceChildren(
      ...used.map((id) => {
        const s = sectionById(id);
        const i = Math.max(0, S.sections.findIndex((x) => x.id === id));
        return h('button', { class: 'lg' + (this.hidden.has(id) ? ' off' : ''), title: 'Show or hide this section', onclick: () => (this.hidden.has(id) ? this.hidden.delete(id) : this.hidden.add(id), this.drawLegend(), this.place()) }, h('i', { style: { background: PALETTE[i % PALETTE.length] } }), s?.name || id);
      }),
    );
  }
  place() {
    const { x, y, k } = this.view;
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
    const off = (n) => this.hidden.has(n.section);
    for (const n of this.nodes) {
      n.el.setAttribute('transform', `translate(${n.x} ${n.y})`);
      n.el.style.display = off(n) ? 'none' : '';
    }
    for (const e of this.edges) {
      const hid = off(e.a) || off(e.b);
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rb = this.radius(e.b) + 3;
      const pts = { x1: e.a.x, y1: e.a.y, x2: e.b.x - (dx / d) * rb, y2: e.b.y - (dy / d) * rb };
      for (const l of [e.line, e.hit]) {
        for (const [a, v] of Object.entries(pts)) l.setAttribute(a, v);
        l.style.display = hid ? 'none' : '';
      }
    }
  }
  fit() {
    this.resize();
    const vis = this.nodes.filter((n) => !this.hidden.has(n.section));
    if (!vis.length) return;
    const x0 = Math.min(...vis.map((n) => n.x)) - 60;
    const x1 = Math.max(...vis.map((n) => n.x)) + 60;
    const y0 = Math.min(...vis.map((n) => n.y)) - 60;
    const y1 = Math.max(...vis.map((n) => n.y)) + 60;
    const k = Math.min(1.6, Math.max(0.2, Math.min(this.w / (x1 - x0), this.hgt / (y1 - y0))));
    this.view = { k, x: this.w / 2 - ((x0 + x1) / 2) * k, y: this.hgt / 2 - ((y0 + y1) / 2) * k };
    this.place();
  }
  hover(n) {
    this.svg.classList.toggle('focus', !!n);
    const near = new Set();
    if (n) {
      near.add(n.id);
      for (const e of this.edges) {
        if (e.a === n) near.add(e.b.id);
        if (e.b === n) near.add(e.a.id);
      }
    }
    for (const m of this.nodes) m.el.classList.toggle('hot', near.has(m.id));
    for (const e of this.edges) e.line.classList.toggle('hot', !!n && (e.a === n || e.b === n));
  }
  refOf(n) {
    if (n.k === 'msg') return { k: 'msg', section: n.section, msg: n.msg };
    if (n.k === 'bug' || n.k === 'todo') return { k: 'bug', section: n.section, bug: n.bug };
    return { k: 'item', section: n.section, item: n.item };
  }

  // ------------------------------------------------------------------ the pointer
  toWorld(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }
  wire() {
    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = this.svg.getBoundingClientRect();
        this.wheelZoom ??= wheelZoomer((px, py, f) => {
          const k = Math.min(4, Math.max(0.1, this.view.k * f));
          this.view = { k, x: px - ((px - this.view.x) / this.view.k) * k, y: py - ((py - this.view.y) / this.view.k) * k };
          this.place();
        }, 0.0015);
        this.wheelZoom(e, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    this.svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.gnode') || e.target.closest('.gedge-hit')) return;
      const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.setPointerCapture(e.pointerId);
      const mv = (ev) => {
        this.view.x = start.vx + ev.clientX - start.x;
        this.view.y = start.vy + ev.clientY - start.y;
        this.place();
      };
      const up = () => {
        this.svg.removeEventListener('pointermove', mv);
        this.svg.removeEventListener('pointerup', up);
      };
      this.svg.addEventListener('pointermove', mv);
      this.svg.addEventListener('pointerup', up);
    });
    this.svg.addEventListener('dblclick', (e) => !e.target.closest('.gnode') && this.fit());
  }
  startDrag(e, n) {
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    n.pinned = true;
    this.svg.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      const p = this.toWorld(ev.clientX, ev.clientY);
      n.x = p.x;
      n.y = p.y;
      this.place();
    };
    const up = () => {
      this.svg.removeEventListener('pointermove', mv);
      this.svg.removeEventListener('pointerup', up);
      if (!moved) {
        n.pinned = false;
        return this.open(this.refOf(n));
      }
      // let the others settle around where it was put, with every line the same length again
      this.relax(60);
      n.pinned = false;
      for (const m of this.nodes) this.pos.set(m.id, { x: m.x, y: m.y });
      this.place();
    };
    this.svg.addEventListener('pointermove', mv);
    this.svg.addEventListener('pointerup', up);
  }
}
