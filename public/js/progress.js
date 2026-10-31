// Progress: a cairn that grows with the work. Every to-do row that is moved to Closed adds one stone on top of the
// pile, and every stone is a little smaller than the one under it. So the tower never ends: what looks like the
// smallest stone at the top is a stone you can zoom into, and there are more stones piled on it, and on those.
// Scroll to zoom (towards the pointer), drag to move, double-click a stone to dive into it.
//
// The picture is drawn relative to an "anchor" stone near the middle of the view, and the anchor is passed up or
// down the tower as you zoom, so there is no limit to how far in you can go.
import { api } from './api.js';
import { h, ago, stamp, toast } from './ui.js';

const R = 0.8; // each stone is this much of the width of the one below
const ASP = 0.56; // how tall a stone is compared to its width
const STEP = 0.82; // a stone sits well into the one below
const C = (STEP * ASP * (1 + R)) / 2 / (1 - R);
const yAt = (k) => C * (1 - Math.pow(R, k)); // the middle of the stone k steps above the anchor (up is positive)
const MIN_Z = 70; // zoomed all the way out: pixels across the bottom stone

function hash(s) {
  let x = 2166136261;
  for (const c of String(s)) {
    x ^= c.charCodeAt(0);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}
function rng(seed) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const look = new Map(); // what each stone looks like, decided once from its number
function stoneLook(i) {
  let l = look.get(i);
  if (!l) {
    const r = rng(`stone${i}`);
    const hue = 20 + r() * 26;
    const sat = 6 + r() * 12;
    const light = 40 + r() * 24;
    l = {
      jx: (r() - 0.5) * 0.14,
      tall: 1, // (all stones are equally tall for their width, so they can be stacked without gaps)
      noise: Array.from({ length: 12 }, () => 1 + (r() - 0.5) * 0.1),
      fill: `hsl(${hue} ${sat}% ${light}%)`,
      edge: `hsl(${hue} ${sat + 4}% ${Math.max(14, light - 24)}%)`,
      hi: `hsl(${hue} ${sat}% ${Math.min(86, light + 20)}%)`,
    };
    if (look.size > 6000) look.clear();
    look.set(i, l);
  }
  return l;
}

// the rules shown in the box in the corner of the page
const RULES = [
  'Planlegg spillet, og meld fra om planen.',
  'Tilpass spillet etter evne og forhold.',
  'Ta hensyn til tekniske varsler og prosjektfarer.',
  'Vær forberedt på bugs og kriser, selv i små prosjekter.',
  'Ta med nødvendig utstyr for å hjelpe deg selv og andre.',
  'Velg trygge tekniske veier. Gjenkjenn risikabel kode og ustabile systemer.',
  'Bruk kart og kompass. Vit alltid hvor du er i utviklingen.',
  'Vend i tide. Det er ingen skam å forkaste en dårlig idé.',
  'Spar på kreftene, og ta en pause når det trengs.',
];

export class Progress {
  constructor({ open } = {}) {
    this.open = open; // (shows a row or report: where a stone came from)
    this.tasks = [];
    this.view = { a: 0, x: 0, y: 0, s: 300 };
    this.hits = [];
    this.stones = [];
    this.hover = null;
    this.glow = 0;
    this.base = 0; // (always the real bottom: clicking a stone only re-frames the view, every stone stays drawn)
  }
  get N() {
    return this.tasks.length;
  }

  async mount(stage) {
    this.stage = stage;
    this.canvas = h('canvas', { class: 'cairn' });
    this.count = h('div', { class: 'cairn-count' });
    this.zoomLabel = h('span', {});
    this.tip = h('div', { class: 'cairn-tip', hidden: true });
    this.card = h('div', { class: 'cairn-card', hidden: true });
    this.empty = h('div', { class: 'cairn-empty', hidden: true }, 'Nothing finished yet.\nClose a to-do row or a report and the first stone appears.');
    this.empty.style.whiteSpace = 'pre-line';
    this.help = h(
      'div',
      { class: 'cairn-help' },
      h('span', {}, 'Scroll to zoom · drag to move · click a stone to see the tower from it (and the way to what it was), double-click to go straight there · '),
      this.zoomLabel,
      h('button', { class: 'cairn-reset', onclick: () => this.fit() }, 'Bottom'),
      h('button', { class: 'cairn-reset', title: 'Zoom to the newest stone on top', onclick: () => this.toTop() }, 'Top'),
    );
    // "Kjenner du spillvettreglene?": a box in the upper right corner that opens into the rules, and closes again
    const open = h('button', { class: 'rules-open', onclick: () => this.rules(true) }, 'Kjenner du spillvettreglene?');
    const body = h('div', { class: 'rules-body', hidden: true }, h('div', { class: 'rules-head' }, h('b', {}, 'Spillvettreglene'), h('button', { class: 'rules-x', title: 'Lukk', onclick: () => this.rules(false) }, '×')), h('ol', {}, RULES.map((r) => h('li', {}, r))));
    this.rulesBox = h('div', { class: 'rules' }, open, body);
    this.rulesOpen = open;
    this.rulesBody = body;
    this.root_ = h('div', { class: 'progress' }, this.canvas, this.count, this.empty, this.tip, this.card, this.help, this.rulesBox);
    stage.append(this.root_);
    this.ctx = this.canvas.getContext('2d');
    this.size();
    this.wire();
    this.ro = new ResizeObserver(() => {
      this.size();
      this.draw();
    });
    this.ro.observe(this.root_);
    await this.load(true);
  }
  rules(show) {
    this.rulesBody.hidden = !show;
    this.rulesOpen.hidden = show;
  }
  unmount() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.flight);
    this.ro?.disconnect();
    this.stage?.replaceChildren();
  }
  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(false), 400);
  }
  size() {
    const r = this.root_.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(50, r.width);
    this.H = Math.max(50, r.height);
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.dpr = dpr;
  }

  async load(first) {
    let r;
    try {
      r = await api('GET', '/api/progress');
    } catch (e) {
      return toast(e.message, true);
    }
    const before = this.N;
    this.tasks = r.tasks;
    this.count.replaceChildren(h('b', {}, String(this.N)), h('span', {}, this.N === 1 ? ' task done' : ' tasks done'));
    this.empty.hidden = this.N > 0;
    if (first) this.fit();
    else if (this.N > before) this.glow = performance.now();
    this.schedule();
  }

  // ------------------------------------------------------------------ the camera
  // view: the anchor stone (its number), and the middle of the screen in the anchor's own units (its width = 1,
  // x to the right, y up); s = pixels per anchor width.
  fit() {
    cancelAnimationFrame(this.flight);
    this.base = 0;
    const f = this.frame();
    this.view = { a: 0, x: 0, y: f.y, s: f.s };
    this.schedule();
  }
  // the default view of the tower, in units of its bottom stone: how far up the middle of the screen is, and the pixels per unit
  frame() {
    const m = Math.min(Math.max(this.N, 3), 10); // frame the first stones
    const top = yAt(m - 1) + (ASP * Math.pow(R, m - 1)) / 2;
    const bottom = -ASP / 2;
    return { y: (top + bottom) / 2, s: Math.min(this.W * 0.6, (this.H * 0.78) / (top - bottom)) };
  }
  // the newest stone, filling most of the view
  toTop() {
    cancelAnimationFrame(this.flight);
    this.base = 0;
    const i = Math.max(0, this.N - 1);
    this.view = { a: i, x: stoneLook(i).jx, y: 0, s: Math.min(this.W, this.H) * 0.6 };
    this.schedule();
  }
  // keep the anchor near the middle of the view: pass it up or down the tower as needed
  normalize() {
    const v = this.view;
    for (let guard = 0; guard < 400; guard++) {
      const upY = yAt(1);
      const downY = yAt(-1);
      if (v.y > upY / 2 && v.a < this.N) {
        // the next stone up becomes the anchor (it is R as wide, so one unit of it is R of ours)
        v.x = v.x / R; // (x is measured from the axis of the tower, which every stone is centred on)
        v.y = (v.y - upY) / R;
        v.s *= R;
        v.a += 1;
      } else if (v.y < downY / 2 && v.a > 0) {
        v.x = v.x * R;
        v.y = (v.y - downY) * R;
        v.s /= R;
        v.a -= 1;
      } else break;
    }
    // not further out than the whole tower, not below the ground, not past the top
    const minS = MIN_Z * Math.pow(R, v.a);
    if (v.s < minS) v.s = minS;
    if (v.a === 0) v.y = Math.max(v.y, -ASP / 2 + 0.05);
    // not further in than the empty spot on top, where the next stone will go
    const ghost = 2.5 * Math.max(this.W, this.H);
    const maxS = ghost / Math.pow(R, this.N - v.a);
    if (v.s > maxS) v.s = maxS;
  }
  zoomAt(px, py, factor) {
    const v = this.view;
    const wx = v.x + (px - this.W / 2) / v.s;
    const wy = v.y - (py - this.H / 2) / v.s;
    v.s *= factor;
    v.x = wx - (px - this.W / 2) / v.s;
    v.y = wy + (py - this.H / 2) / v.s;
    this.normalize();
    this.schedule();
  }

  // ------------------------------------------------------------------ drawing
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }
  blob(x, y, w, h_, noise) {
    const c = this.ctx;
    const pts = noise.map((k, i) => {
      const t = (i / noise.length) * Math.PI * 2;
      const sy = Math.sin(t);
      return [x + Math.cos(t) * (w / 2) * k, y + sy * (h_ / 2) * k * (sy > 0 ? 0.9 : 1)];
    });
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    c.beginPath();
    const start = mid(pts[pts.length - 1], pts[0]);
    c.moveTo(start[0], start[1]);
    for (let i = 0; i < pts.length; i++) {
      const m = mid(pts[i], pts[(i + 1) % pts.length]);
      c.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
    }
    c.closePath();
  }
  draw() {
    const c = this.ctx;
    const { W, H } = this;
    const { a, x: vx, y: vy, s } = this.view;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    this.hits = [];
    this.stones = [];
    const sx = (wx) => W / 2 + (wx - vx) * s;
    const sy = (wy) => H / 2 - (wy - vy) * s;
    // zoomed far out from a chosen base stone: back to the whole tower
    if (this.base > 0 && s * Math.pow(R, this.base - a) < 0.16 * W) this.base = 0;
    const kBase = this.base - a; // the base stone, relative to the anchor
    // the ground under the base stone (the real bottom of the tower, or the stone you clicked)
    if (kBase > -70) {
      const wb = Math.pow(R, kBase);
      const gy = sy(yAt(kBase) - (ASP * wb) / 2 * 0.96);
      if (gy < H + 20) {
        c.fillStyle = '#ddd5c0';
        c.fillRect(0, Math.max(0, gy), W, H);
        const g = c.createRadialGradient(sx(0), gy, 1, sx(0), gy, s * wb * 0.7);
        g.addColorStop(0, 'rgba(60,50,30,.28)');
        g.addColorStop(1, 'rgba(60,50,30,0)');
        c.fillStyle = g;
        c.fillRect(0, Math.max(0, gy - s * wb * 0.1), W, H);
      }
    }
    // the stones, bottom to top; stone number i = a + k (the one past the last finished task is the empty spot for the next)
    const kMin = Math.max(this.base - a, -70);
    const kMax = Math.min(this.N - a, Math.floor(Math.log(0.6 / s) / Math.log(R)) + 1, 90);
    for (let k = kMin; k <= kMax; k++) {
      const i = a + k;
      const w = Math.pow(R, k);
      const L = stoneLook(i);
      const wpx = w * s;
      const hpx = ASP * L.tall * wpx;
      const cx = sx(L.jx * w);
      const cy = sy(yAt(k));
      if (wpx < 0.6 || cx + wpx / 2 < 0 || cx - wpx / 2 > W || cy + hpx / 2 < 0 || cy - hpx / 2 > H) continue;
      const done = i < this.N;
      if (wpx > 10) this.stones.push({ x: cx, y: cy, sw: wpx, sh: hpx, k, i });
      if (!done) {
        // where the next stone will go
        if (wpx > 14 && wpx < 3e5) {
          this.blob(cx, cy, wpx, hpx, L.noise);
          c.setLineDash([6, 5]);
          c.strokeStyle = 'rgba(80,70,50,.45)';
          c.lineWidth = 1.5;
          c.stroke();
          c.setLineDash([]);
        }
        continue;
      }
      if (wpx > 3e5) {
        // so large that it only fills the window: no outline to draw
        c.fillStyle = L.fill;
        c.fillRect(0, 0, W, H);
      } else {
        this.blob(cx, cy, wpx, hpx, L.noise);
        c.fillStyle = L.fill;
        c.fill();
        c.lineWidth = Math.max(0.6, Math.min(2.4, wpx / 60));
        c.strokeStyle = L.edge;
        c.stroke();
        if (wpx > 8) {
          c.beginPath();
          c.ellipse(cx, cy - hpx * 0.12, wpx * 0.32, hpx * 0.2, 0, Math.PI * 1.1, Math.PI * 1.85);
          c.strokeStyle = L.hi;
          c.lineWidth = Math.max(0.6, wpx / 40);
          c.stroke();
        }
        if (this.hover === i) {
          this.blob(cx, cy, wpx, hpx, L.noise);
          c.strokeStyle = '#e3b94a';
          c.lineWidth = Math.max(2, Math.min(4, wpx / 30));
          c.stroke();
        }
        if (i === this.N - 1 && this.glow && performance.now() - this.glow < 2500) {
          c.beginPath();
          c.ellipse(cx, cy, wpx * 0.62, hpx * 0.72, 0, 0, Math.PI * 2);
          c.strokeStyle = `rgba(227,185,74,${1 - (performance.now() - this.glow) / 2500})`;
          c.lineWidth = Math.max(2, wpx / 20);
          c.stroke();
        }
      }
      if (wpx > 10) this.hits.push({ x: cx, y: cy, sw: wpx, sh: hpx, i });
    }
    // how far in: the bottom stone's width on the screen compared to the start
    const z = s / Math.pow(R, a) / 300;
    this.zoomLabel.textContent = `×${z < 1000 ? z.toFixed(z < 10 ? 1 : 0) : z.toExponential(1)}`;
    if (this.glow && performance.now() - this.glow < 2500) this.schedule();
  }

  // ------------------------------------------------------------------ the pointer
  // click: the stone under the pointer becomes the base: the view glides and zooms until that stone stands at the bottom,
  // as wide as the first one was, with the rest of the tower rising from it
  stoneAt(px, py) {
    let best = null;
    for (const st of this.stones) {
      const dx = (px - st.x) / (st.sw / 2);
      const dy = (py - st.y) / (st.sh / 2);
      if (dx * dx + dy * dy <= 1 && (!best || st.sw < best.sw)) best = st;
    }
    return best;
  }
  // go to the row or report a stone is made of
  source(i) {
    const t = this.tasks[i];
    if (t) this.open?.({ k: 'bug', bug: t.id, section: t.section });
  }
  // a card beside the clicked stone: what it was, and the way to it
  showCard(i, px, py) {
    const t = this.tasks[i];
    if (!t) return (this.card.hidden = true);
    this.card.replaceChildren(h('b', {}, t.text.length > 200 ? t.text.slice(0, 199) + '…' : t.text), h('span', {}, `Stone ${i + 1} · by ${t.name} · closed ${ago(t.ts)}`), h('button', { class: 'btn small', onclick: () => this.source(i) }, `Open in ${t.where || 'the list'} \u2192`));
    this.card.style.left = Math.max(8, Math.min(this.W - 280, px + 16)) + 'px';
    this.card.style.top = Math.max(8, Math.min(this.H - 140, py - 20)) + 'px';
    this.card.hidden = false;
  }
  dive(px, py) {
    const best = this.stoneAt(px, py);
    if (!best) return;
    if (best.i < this.N) this.showCard(best.i, px, py);
    const v = this.view;
    // the view becomes the default view, but with the clicked stone as the bottom one: the same framing and the same
    // height of tower above it, so it looks just like the start of the tower (only the stone is a smaller one)
    const wUnit = Math.pow(R, best.k); // the clicked stone's width in the anchor's units
    const f = this.frame();
    const to = { x: 0, y: yAt(best.k) + f.y * wUnit, s: f.s / wUnit };
    const from = { x: v.x, y: v.y, s: v.s };
    const t0 = performance.now();
    cancelAnimationFrame(this.flight);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 500);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      // (the anchor stays put during the flight; it is passed on when the flight is over)
      v.x = from.x + (to.x - from.x) * e;
      v.y = from.y + (to.y - from.y) * e;
      v.s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
      if (t >= 1) this.normalize();
      this.draw();
      if (t < 1) this.flight = requestAnimationFrame(step);
    };
    this.flight = requestAnimationFrame(step);
  }
  wire() {
    const cv = this.canvas;
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        cancelAnimationFrame(this.flight);
        const r = cv.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0017));
      },
      { passive: false },
    );
    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect();
      const st = this.stoneAt(e.clientX - r.left, e.clientY - r.top);
      if (st && st.i < this.N) this.source(st.i);
    });
    cv.addEventListener('pointerdown', (e) => {
      this.card.hidden = true;
      cancelAnimationFrame(this.flight);
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {}
      let last = { x: e.clientX, y: e.clientY };
      const mv = (ev) => {
        const v = this.view;
        v.x -= (ev.clientX - last.x) / v.s;
        v.y += (ev.clientY - last.y) / v.s;
        last = { x: ev.clientX, y: ev.clientY };
        this.normalize();
        this.tip.hidden = true;
        this.schedule();
      };
      const start = { x: e.clientX, y: e.clientY };
      const up = (ev) => {
        cv.removeEventListener('pointermove', mv);
        cv.removeEventListener('pointerup', up);
        // a click (not a drag) on a stone: look at the tower from that stone
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) {
          const r = cv.getBoundingClientRect();
          this.dive(ev.clientX - r.left, ev.clientY - r.top);
        }
      };
      cv.addEventListener('pointermove', mv);
      cv.addEventListener('pointerup', up);
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      let hit = null;
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const st = this.hits[i];
        const dx = (px - st.x) / (st.sw / 2);
        const dy = (py - st.y) / (st.sh / 2);
        if (dx * dx + dy * dy <= 1) {
          hit = st;
          break;
        }
      }
      const id = hit ? hit.i : null;
      if (id !== this.hover) {
        this.hover = id;
        this.schedule();
      }
      this.tip.hidden = !hit || !this.card.hidden;
      if (hit && this.card.hidden) {
        const t = this.tasks[hit.i];
        this.tip.replaceChildren(h('b', {}, t.text.length > 160 ? t.text.slice(0, 159) + '…' : t.text), h('span', {}, `Stone ${hit.i + 1} · ${t.where ? t.where + ' · ' : ''}by ${t.name} · closed ${ago(t.ts)}`), h('small', {}, stamp(t.ts)));
        this.tip.style.left = `${Math.min(this.W - 260, px + 14)}px`;
        this.tip.style.top = `${Math.max(8, py - 10)}px`;
      }
      cv.style.cursor = hit ? 'pointer' : 'grab';
    });
    cv.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.schedule();
    });
  }
}
