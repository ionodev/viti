// The Hub: one Durable Object that holds everything (sections, boards, chat, bug reports, images) in
// its SQLite database, serves the API, and keeps every open page in sync over WebSockets.
//
//   section   a board (a canvas of items) with its own chat; or the bug reports (kind 'bugs')
//   item      a note, a text block (both markdown) or an image, on a board
//   message   a chat message in a section, with references to items, quoted text, messages or bugs
//   bug       a bug report: open | closed | trash
//
// Everything that changes is also marked "dirty" for the GitHub mirror (src/mirror.js).
// (on the desktop the Durable Object's runtime comes from do-shim.js, not from Cloudflare)
import { DurableObject, WebSocketRequestResponsePair } from './do-shim.js';
import { json, fail, rid, sha256hex, safeEqual, clip, num, slugify, b64decode, sniffImage, sniffPdf, colorFor, nextColor } from './util.js';
import { parseUA } from './ua.js';
import { Mirror } from './mirror.js';
import { repoBranches } from './github.js';

const parse = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
export const LIMITS = { name: 60, msg: 8000, itemText: 20000, bug: 10000, image: 10 * 1024 * 1024, sections: 150, categories: 30, items: 3000, chunk: 1000000 };
const NOTE_COLORS = ['yellow', 'white', 'red', 'orange', 'green', 'blue', 'purple'];
const LEGACY_COLORS = { pink: 'red', cream: 'white', gold: 'orange' };
const DEFAULT_SECTIONS = ['General', 'Ideas']; // boards, in this order, below the to-do list (pos -1)
// (the web version has a MAIL category for a website's contact form; the desktop app has none)
const MAIL_SECTIONS = [];
const REPORT_SECTIONS = [['bugs', 'Bug reports']]; // three lists each: Open, Closed, Trash (more can be added)
const BUG_STATUS = ['open', 'closed', 'trash'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created INTEGER, seen INTEGER)',
  "CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'board', pos INTEGER NOT NULL, created INTEGER)",
  'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, section TEXT NOT NULL, type TEXT NOT NULL, x REAL, y REAL, w REAL, h REAL, z INTEGER, data TEXT, rev INTEGER DEFAULT 1, author TEXT, created INTEGER, updated INTEGER)',
  'CREATE INDEX IF NOT EXISTS items_section ON items(section)',
  'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, section TEXT NOT NULL, author TEXT, name TEXT, ts INTEGER, body TEXT, refs TEXT, deleted INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS messages_section ON messages(section, id)',
  'CREATE TABLE IF NOT EXISTS reads (email TEXT, section TEXT, last_id INTEGER, PRIMARY KEY (email, section))',
  "CREATE TABLE IF NOT EXISTS bugs (id TEXT PRIMARY KEY, name TEXT, email TEXT, ts INTEGER, browser TEXT, ua TEXT, page TEXT, message TEXT, status TEXT NOT NULL DEFAULT 'open', moved INTEGER, moved_by TEXT, images TEXT, source TEXT)",
  'CREATE INDEX IF NOT EXISTS bugs_status ON bugs(status, ts)',
  'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, name TEXT, mime TEXT, ext TEXT, size INTEGER, w INTEGER, h INTEGER, ts INTEGER, by TEXT)',
  'CREATE TABLE IF NOT EXISTS image_chunks (id TEXT, seq INTEGER, data BLOB, PRIMARY KEY (id, seq))',
  'CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, pos INTEGER NOT NULL, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS calendar (id TEXT PRIMARY KEY, date TEXT NOT NULL, title TEXT, ref TEXT, author TEXT, ts INTEGER)',
  'CREATE INDEX IF NOT EXISTS calendar_date ON calendar(date)',
  'CREATE TABLE IF NOT EXISTS dirty (key TEXT PRIMARY KEY, seq INTEGER)',
  'CREATE TABLE IF NOT EXISTS mirror (path TEXT PRIMARY KEY, hash TEXT)',
  // the files on GitHub as of the last sync: git's sha for each, and the content of the ones merged (the "before" of the next merge)
  'CREATE TABLE IF NOT EXISTS remote (path TEXT PRIMARY KEY, sha TEXT, body BLOB)',
];

const WELCOME = [
  {
    type: 'text', x: -330, y: -170, w: 470, h: 330,
    text: "# Welcome to Viti\n\nThis is the **General** board. Every section is a canvas with a chat of its own on the right.\n\n- **Double-click** the canvas to write text. It is all **markdown**\n- **P** adds a post-it, **I** an image (you can also drop or paste one)\n- Drag to move, drag the corners to resize\n- **Select some text** and press *Quote in chat* to point at it\n- Select an item and press *Reference* to point at that instead\n- **Ctrl+K** searches everything, **?** lists the shortcuts\n\nEverything is backed up to a branch of the repository you connected.",
  },
  { type: 'note', x: 190, y: -150, w: 230, h: 190, color: 'yellow', text: "**Post-its** are markdown too.\n\n- [ ] tick me\n- [x] done\n- `code` and *emphasis* work" },
];

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.tomb = new Map(); // ids just deleted: a late move of one must not bring it back
    this.mirror = new Mirror(this);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => this.init());
  }

  // ------------------------------------------------------------------ storage helpers
  q(sql, ...a) {
    return [...this.sql.exec(sql, ...a)];
  }
  run(sql, ...a) {
    this.sql.exec(sql, ...a);
  }
  one(sql, ...a) {
    return this.q(sql, ...a)[0];
  }
  getMeta(k) {
    return this.one('SELECT v FROM meta WHERE k=?', k)?.v;
  }
  setMeta(k, v) {
    this.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));
  }

  init() {
    for (const s of SCHEMA) this.run(s);
    try {
      this.run('ALTER TABLE users ADD COLUMN named INTEGER DEFAULT 0');
    } catch {} // (already there)
    try {
      this.run("ALTER TABLE bugs ADD COLUMN section TEXT DEFAULT 'bugs'");
    } catch {}
    try {
      this.run('ALTER TABLE sections ADD COLUMN core INTEGER DEFAULT 0');
    } catch {}
    try {
      this.run("ALTER TABLE sections ADD COLUMN category TEXT DEFAULT ''");
    } catch {}
    for (const alter of ["ALTER TABLE sections ADD COLUMN parent TEXT DEFAULT ''", "ALTER TABLE sections ADD COLUMN branch TEXT DEFAULT ''", "ALTER TABLE sections ADD COLUMN file TEXT DEFAULT ''",'ALTER TABLE categories ADD COLUMN core INTEGER DEFAULT 0', "ALTER TABLE bugs ADD COLUMN subject TEXT DEFAULT ''", "ALTER TABLE bugs ADD COLUMN branch TEXT DEFAULT ''", 'ALTER TABLE bugs ADD COLUMN seen INTEGER DEFAULT 0', "ALTER TABLE bugs ADD COLUMN priority TEXT DEFAULT ''", "ALTER TABLE bugs ADD COLUMN due TEXT DEFAULT ''"]) {
      try {
        this.run(alter);
      } catch {}
    }
    this.ensureMail();
    try {
      this.run("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); // (a person's picture: their GitHub one)
    } catch {}
    for (const alter of ["ALTER TABLE bugs ADD COLUMN html TEXT DEFAULT ''", "ALTER TABLE bugs ADD COLUMN files TEXT DEFAULT ''", "ALTER TABLE bugs ADD COLUMN rcpt TEXT DEFAULT ''", "ALTER TABLE bugs ADD COLUMN thread TEXT DEFAULT ''"]) {
      try {
        this.run(alter);
      } catch {} // (already there)
    }
    // (to-dos and reports tagged with Viti's backup branch, before it was left out of the branches: no tag)
    this.run("UPDATE bugs SET branch='' WHERE lower(COALESCE(branch, '')) IN ('viti-data', 'hub-data')");
    if (this.getMeta('seeded')) {
      // the Status section was dropped
      if (!this.getMeta('layout6')) {
        if (this.section('status')) {
          this.ctx.storage.transactionSync(() => {
            for (const t of ['items', 'messages', 'reads']) this.run(`DELETE FROM ${t} WHERE section='status'`);
            this.run("DELETE FROM sections WHERE id='status'");
          });
          this.markDirty('section-del:status');
        }
        this.setMeta('layout6', 1);
        this.markDirty('meta');
      }
      // an older database: Playtesting and Design issues become report lists, and the sections get their new order
      if (!this.getMeta('layout4')) {
        DEFAULT_SECTIONS.forEach((name, i) => this.run("UPDATE sections SET pos=?, kind='board' WHERE id=?", i, slugify(name)));
        this.run("UPDATE sections SET kind='todo', name='To do', pos=-1 WHERE id='planned'"); // Planned became the to-do list
        REPORT_SECTIONS.forEach(([id], i) => this.run("UPDATE sections SET pos=?, kind='bugs' WHERE id=?", 1000 + i, id));
        this.setMeta('layout4', 1);
        this.markDirty('meta');
      }
      // the Overview (a graph of everything that is connected by references) sits right under the to-do list
      if (!this.getMeta('layout5')) {
        this.run("UPDATE sections SET pos=-2 WHERE kind='todo'");
        this.run("INSERT OR IGNORE INTO sections (id, name, kind, pos, created) VALUES ('overview', 'Overview', 'overview', -1, ?)", Date.now());
        this.setMeta('layout5', 1);
        this.markDirty('meta');
      }
      // Progress (the cairn that grows with every finished to-do) goes under the Overview
      if (!this.getMeta('layout7')) {
        this.run("UPDATE sections SET pos=-3 WHERE kind='todo'");
        this.run("UPDATE sections SET pos=-2 WHERE kind='overview'");
        this.run("INSERT OR IGNORE INTO sections (id, name, kind, pos, created) VALUES ('progress', 'Progress', 'progress', -1, ?)", Date.now());
        this.setMeta('layout7', 1);
        this.markDirty('meta');
      }
      // Progress goes right under the to-do list, above the Overview
      if (!this.getMeta('layout8')) {
        this.run("UPDATE sections SET pos=-3 WHERE kind='todo'");
        this.run("UPDATE sections SET pos=-2 WHERE kind='progress'");
        this.run("UPDATE sections SET pos=-1 WHERE kind='overview'");
        this.setMeta('layout8', 1);
        this.markDirty('meta');
      }
      // the Calendar goes between Progress and the Overview
      if (!this.getMeta('layout9')) {
        this.run("UPDATE sections SET pos=-4 WHERE kind='todo'");
        this.run("UPDATE sections SET pos=-3 WHERE kind='progress'");
        this.run("INSERT OR IGNORE INTO sections (id, name, kind, pos, created) VALUES ('calendar', 'Calendar', 'calendar', -2, ?)", Date.now());
        this.setMeta('layout9', 1);
        this.markDirty('meta');
      }
      this.markCore();
      return;
    }
    const now = Date.now();
    DEFAULT_SECTIONS.forEach((name, i) => this.run('INSERT INTO sections (id, name, kind, pos, created) VALUES (?, ?, ?, ?, ?)', slugify(name), name, 'board', i, now));
    this.run('INSERT INTO sections (id, name, kind, pos, created) VALUES (?, ?, ?, ?, ?)', 'todo', 'To do', 'todo', -4, now);
    this.run('INSERT INTO sections (id, name, kind, pos, created) VALUES (?, ?, ?, ?, ?)', 'overview', 'Overview', 'overview', -1, now);
    this.run('INSERT INTO sections (id, name, kind, pos, created) VALUES (?, ?, ?, ?, ?)', 'progress', 'Progress', 'progress', -3, now);
    this.run('INSERT INTO sections (id, name, kind, pos, created) VALUES (?, ?, ?, ?, ?)', 'calendar', 'Calendar', 'calendar', -2, now);
    this.setMeta('layout9', 1);
    this.setMeta('layout7', 1);
    this.setMeta('layout8', 1);
    this.setMeta('layout5', 1);
    REPORT_SECTIONS.forEach(([id, name], i) => this.run('INSERT INTO sections (id, name, kind, pos, created) VALUES (?, ?, ?, ?, ?)', id, name, 'bugs', 1000 + i, now));
    this.setMeta('layout4', 1);
    this.setMeta('layout6', 1);
    this.markCore();
    WELCOME.forEach((w, i) =>
      this.run(
        'INSERT INTO items (id, section, type, x, y, w, h, z, data, rev, author, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)',
        rid(10), 'general', w.type, w.x, w.y, w.w, w.h, i + 1, JSON.stringify(w.type === 'note' ? { text: w.text, color: w.color } : { text: w.text }), now, now,
      ),
    );
    this.setMeta('seeded', now);
  }

  // the MAIL category and its two mailboxes (made again if missing, and never renamed, moved or deleted)
  ensureMail() {
    if (!MAIL_SECTIONS.length) return;
    const now = Date.now();
    this.run("INSERT OR IGNORE INTO categories (id, name, pos, created, core) VALUES ('mail', 'MAIL', -1, ?, 1)", now);
    this.run("UPDATE categories SET core=1 WHERE id='mail'");
    MAIL_SECTIONS.forEach(([id, name], i) => {
      this.run("INSERT OR IGNORE INTO sections (id, name, kind, pos, created, category, core) VALUES (?, ?, 'mail', ?, ?, 'mail', 1)", id, name, 2000 + i, now);
    });
  }

  // the sections every hub starts with: they cannot be renamed or deleted (the ones people add can)
  // the PROJECT category (To do, Progress, Calendar, Overview): always there, and they stay in it
  ensureProject() {
    this.run("INSERT OR IGNORE INTO categories (id, name, pos, created, core) VALUES ('project', 'PROJECT', -2, ?, 1)", Date.now());
    this.run("UPDATE categories SET core=1 WHERE id='project'");
    this.run("UPDATE sections SET category='project' WHERE kind IN ('todo', 'progress', 'calendar', 'overview') AND COALESCE(category, '') != 'project'");
  }
  markCore() {
    this.ensureProject();
    const ids = [...DEFAULT_SECTIONS.map((n) => slugify(n)), 'todo', 'planned', 'overview', 'progress', 'calendar', ...REPORT_SECTIONS.map(([id]) => id), ...MAIL_SECTIONS.map(([id]) => id)];
    for (const id of ids) this.run('UPDATE sections SET core=1 WHERE id=?', id);
  }

  // ------------------------------------------------------------------ people
  ensureUser(email) {
    let u = this.one('SELECT * FROM users WHERE email=?', email);
    const now = Date.now();
    if (!u) {
      const first = email.split('@')[0].split(/[._+-]/)[0] || 'Someone';
      const name = first.charAt(0).toUpperCase() + first.slice(1);
      this.run('INSERT INTO users (email, name, color, created, seen) VALUES (?, ?, ?, ?, ?)', email, name, nextColor(this.q('SELECT color FROM users').map((r) => r.color)), now, now);
      // what is already in the chats is not "unread" for someone who has just arrived
      for (const s of this.q('SELECT id FROM sections')) {
        const last = this.one('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE section=?', s.id).m;
        this.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, ?)', email, s.id, last);
      }
      this.markDirty('meta');
      u = this.one('SELECT * FROM users WHERE email=?', email);
      this.bcAll({ t: 'users', users: this.users() });
    } else if (now - (u.seen || 0) > 60000) this.run('UPDATE users SET seen=? WHERE email=?', now, email);
    return u;
  }
  users() {
    return this.q("SELECT email, name, color, COALESCE(avatar, '') AS avatar FROM users ORDER BY created");
  }

  // ------------------------------------------------------------------ the mirror's list of what changed
  markDirty(...keys) {
    const seq = (this.one('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM dirty')?.n) || 1;
    for (const key of keys) this.run('INSERT INTO dirty (key, seq) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET seq=excluded.seq', key, seq);
    this.mirror.schedule();
  }

  // ------------------------------------------------------------------ live connections
  sockets() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, att: ws.deserializeAttachment() || {} }));
  }
  bc(payload, filter = () => true) {
    const msg = JSON.stringify(payload);
    for (const { ws, att } of this.sockets()) {
      if (!filter(att)) continue;
      try {
        ws.send(msg);
      } catch {}
    }
  }
  bcAll(payload) {
    this.bc(payload);
  }
  presence() {
    const by = {};
    for (const { att } of this.sockets()) {
      if (!att.section || !att.email) continue;
      (by[att.section] ||= new Set()).add(att.email);
    }
    return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, [...v]]));
  }

  upgrade(request, email) {
    if (request.headers.get('upgrade') !== 'websocket') return fail(426, 'websocket', 'Expected a WebSocket.');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: rid(6), email, section: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const email = att.email;
    switch (m.t) {
      case 'view': {
        if (!this.section(m.section)) return;
        att.section = m.section;
        ws.serializeAttachment(att);
        this.bcAll({ t: 'presence', presence: this.presence() });
        break;
      }
      case 'ops': {
        const sec = this.section(m.section);
        if (!sec || (sec.kind !== 'board' && sec.kind !== 'note')) return;
        const out = this.applyOps(m.section, m.ops, email, !!m.live);
        if (out.length) this.bc({ t: 'ops', section: m.section, ops: out, by: att.id }, (a) => a.section === m.section && a.id !== att.id);
        break;
      }
      case 'cursor': {
        if (!att.section || att.section !== m.section) return;
        this.bc({ t: 'cursor', id: att.id, email, section: m.section, x: num(m.x, -1e6, 1e6), y: num(m.y, -1e6, 1e6) }, (a) => a.section === m.section && a.id !== att.id);
        break;
      }
    }
  }
  webSocketClose(ws) {
    try {
      ws.close(1000, 'bye');
    } catch {}
    this.bcAll({ t: 'presence', presence: this.presence() });
  }
  webSocketError() {
    this.bcAll({ t: 'presence', presence: this.presence() });
  }

  // ------------------------------------------------------------------ sections and boards
  section(id) {
    return this.one('SELECT * FROM sections WHERE id=?', String(id));
  }
  sections() {
    return this.q('SELECT id, name, kind, pos, core, category, parent, branch, file FROM sections ORDER BY pos, created').map((s) => ({ ...s, core: !!s.core, category: s.category || '', parent: s.parent || '', branch: s.branch || '', file: s.file || '' }));
  }
  categories() {
    return this.q('SELECT id, name, pos, core FROM categories ORDER BY pos, created').map((c) => ({ ...c, core: !!c.core }));
  }
  bcSections() {
    this.bcAll({ t: 'sections', sections: this.sections(), categories: this.categories() });
  }
  // The import. bundle = { id, boards: [{ to: 'ideas' | { name } | { parent, branch }, items: [{ type, x, y, w, h, data }] }],
  //   reports: [{ to: sectionId, rows: [{ message, branch, images }] }], todos: [{ message, branch }] }
  // It adds to what is there (imported boards are placed beside what a board already holds) and runs once per bundle id.
  importBundle(b, email) {
    const id = String(b.id || '').slice(0, 60);
    if (!id) throw new Error('The bundle has no id.');
    if (this.getMeta('import:' + id)) throw new Error('This bundle has already been imported.');
    const made = { sections: 0, items: 0, reports: 0, todos: 0, messages: 0 };
    const now = Date.now();
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    this.ctx.storage.transactionSync(() => {
      // a section to put things in: an existing one by id, a new board by name, or a branch subsection of a main board
      const target = (to) => {
        if (typeof to === 'string') {
          if (!this.section(to)) throw new Error('No section called ' + to);
          return to;
        }
        if (to.parent) {
          const par = this.section(String(to.parent));
          const br = this.cleanBranch(to.branch);
          if (!par || par.kind !== 'board' || par.parent || !br || br.toLowerCase() === 'viti') throw new Error('A branch subsection needs a main board and a branch of the game.');
          const have = this.one("SELECT id FROM sections WHERE parent=? AND branch=? AND kind='board'", par.id, br);
          if (have) return have.id;
          const sid = this.uniqueSectionId(par.id + '-' + br);
          this.run("INSERT INTO sections (id, name, kind, pos, created, category, parent, branch) VALUES (?, ?, 'board', 0, ?, '', ?, ?)", sid, br, now, par.id, br);
          for (const u of this.q('SELECT email FROM users')) this.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, 0)', u.email, sid);
          made.sections++;
          return sid;
        }
        const name = clip(to.name, LIMITS.name).trim();
        if (!name) throw new Error('A new board needs a name.');
        const sid = this.uniqueSectionId(name);
        const pos = (this.one("SELECT COALESCE(MAX(pos), -1) + 1 AS n FROM sections WHERE kind='board'").n) || 0;
        this.run("INSERT INTO sections (id, name, kind, pos, created, category) VALUES (?, ?, 'board', ?, ?, '')", sid, name, pos, now);
        for (const u of this.q('SELECT email FROM users')) this.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, 0)', u.email, sid);
        made.sections++;
        return sid;
      };
      for (const board of Array.isArray(b.boards) ? b.boards : []) {
        const sid = target(board.to);
        const items = (Array.isArray(board.items) ? board.items : []).slice(0, LIMITS.items);
        if (!items.length) continue;
        // beside what is already on the board
        const ex = this.one('SELECT MIN(x) AS x0, MAX(x + w) AS x1, MIN(y) AS y0 FROM items WHERE section=?', sid);
        const left = Math.min(...items.map((i) => num(i.x)));
        const top = Math.min(...items.map((i) => num(i.y)));
        const dx = (ex?.x1 != null ? ex.x1 + 200 : 0) - left;
        const dy = (ex?.y0 != null ? ex.y0 : 0) - top;
        let z = this.one('SELECT COALESCE(MAX(z), 0) AS z FROM items WHERE section=?', sid).z;
        for (const it of items) {
          const type = ['note', 'text', 'image'].includes(it.type) ? it.type : 'text';
          const d = it.data || {};
          const data = type === 'note' ? { text: clip(d.text, LIMITS.itemText), color: ['yellow', 'white', 'red', 'orange', 'green', 'blue', 'purple'].includes(d.color) ? d.color : 'yellow' } : type === 'text' ? { text: clip(d.text, LIMITS.itemText) } : { img: /^[a-f0-9]{24}$/.test(String(d.img)) && this.one('SELECT id FROM images WHERE id=?', d.img) ? d.img : '', name: clip(d.name, 120) };
          if (type === 'image' && !data.img) continue;
          this.run('INSERT INTO items (id, section, type, x, y, w, h, z, data, rev, author, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)', rid(10), sid, type, Math.round(num(it.x) + dx), Math.round(num(it.y) + dy), Math.max(20, num(it.w, 220)), Math.max(20, num(it.h, 180)), ++z, JSON.stringify(data), email, now, now);
          made.items++;
        }
        this.markDirty('board:' + sid);
      }
      let tick = 0;
      const addRow = (sid, row, name) => {
        const images = (Array.isArray(row.images) ? row.images : []).filter((i) => /^[a-f0-9]{24}$/.test(String(i)) && this.one('SELECT id FROM images WHERE id=?', i)).slice(0, 5);
        const message = clip(row.message, LIMITS.bug).trim();
        if (!message) return false;
        const rowOut = this.insertBug({ name, email: '', ua: '', page: '', message, images, source: 'manual', ts: now - 3600000 + tick++ * 1000, section: sid, branch: row.branch });
        if (row.status === 'closed') this.run("UPDATE bugs SET status='closed', moved=?, moved_by=? WHERE id=?", rowOut.ts, email, rowOut.id);
        return rowOut;
      };
      for (const rep of Array.isArray(b.reports) ? b.reports : []) {
        const sid = target(rep.to);
        for (const row of rep.rows || []) if (addRow(sid, row, clip(rep.name || 'Figma notes', 80))) made.reports++;
      }
      const todo = this.q("SELECT id FROM sections WHERE kind='todo' ORDER BY pos LIMIT 1")[0];
      if (todo) for (const row of Array.isArray(b.todos) ? b.todos : []) if (addRow(todo.id, row, 'Figma notes')) made.todos++;
      // chat messages, in the order given (comments from the Figma notes). The writer's name is matched to a person here when it
      // is exactly one; the messages count as already read.
      const byName = new Map();
      for (const u of this.q('SELECT email, name FROM users')) byName.set(u.name.toLowerCase(), byName.has(u.name.toLowerCase()) ? null : u.email);
      const chatTarget = (to) => {
        if (typeof to === 'string') return this.section(to) ? to : 'general';
        if (to && to.parent) return target(to);
        const found = to?.name ? this.one('SELECT id FROM sections WHERE name=? AND kind=?', String(to.name), 'board') : null;
        return found?.id || 'general';
      };
      for (const chat of Array.isArray(b.chats) ? b.chats : []) {
        const sid = chatTarget(chat.to);
        for (const m of chat.messages || []) {
          const body = clip(m.body, LIMITS.msg).trim();
          if (!body) continue;
          const ts = Math.round(num(m.ts, now));
          this.run('INSERT INTO messages (id, section, author, name, ts, body, refs, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)', this.msgId(), sid, byName.get(String(m.name || '').toLowerCase()) || null, clip(m.name, 80), ts, body, '[]');
          this.markDirty(`chat:${sid}:${new Date(ts).toISOString().slice(0, 10)}`);
          made.messages = (made.messages || 0) + 1;
        }
        const last = this.one('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE section=?', sid).m;
        for (const u of this.q('SELECT email FROM users')) this.run('INSERT INTO reads (email, section, last_id) VALUES (?, ?, ?) ON CONFLICT(email, section) DO UPDATE SET last_id=excluded.last_id', u.email, sid, last);
      }
      this.markDirty('meta');
      this.setMeta('import:' + id, now);
    });
    this.bcSections();
    this.bcAll({ t: 'reload' });
    return made;
  }
  uniqueSectionId(name) {
    const base = slugify(name);
    let id = base;
    for (let i = 2; this.section(id) || id === 'bugs'; i++) id = `${base}-${i}`;
    return id;
  }

  cleanItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = ['note', 'text', 'image', 'group', 'draw', 'doc'].includes(raw.type) ? raw.type : null;
    if (!type || !/^[a-z0-9]{6,24}$/.test(String(raw.id))) return null;
    const it = { id: raw.id, type, x: num(raw.x, -1e6, 1e6), y: num(raw.y, -1e6, 1e6), w: num(raw.w, 20, 5000, 220), h: num(raw.h, 14, 5000, 140), z: Math.round(num(raw.z, -1e6, 1e6)) };
    const d = raw.data && typeof raw.data === 'object' ? raw.data : {};
    if (type === 'note') it.data = { text: clip(d.text, LIMITS.itemText), color: NOTE_COLORS.includes(LEGACY_COLORS[d.color] || d.color) ? LEGACY_COLORS[d.color] || d.color : 'yellow' };
    else if (type === 'text') it.data = { text: clip(d.text, LIMITS.itemText) };
    else if (type === 'group') {
      // a coloured frame around other items (the page keeps it the size of what is inside)
      const members = (Array.isArray(d.members) ? d.members : []).filter((m) => /^[a-z0-9]{6,24}$/.test(String(m))).slice(0, 300);
      if (!members.length) return null;
      it.data = { members, title: clip(d.title, 60), color: NOTE_COLORS.includes(d.color) ? d.color : 'blue' };
    } else if (type === 'draw') {
      // a free-hand line: points relative to the item's corner
      const pts = (Array.isArray(d.pts) ? d.pts : []).slice(0, 4000).map((p) => [Math.round(num(p?.[0], -1e5, 1e5) * 10) / 10, Math.round(num(p?.[1], -1e5, 1e5) * 10) / 10]);
      if (!pts.length) return null;
      it.data = { pts, size: Math.round(num(d.size, 1, 40, 5)), color: /^#[0-9a-f]{6}$/i.test(String(d.color)) ? d.color : '#000000' };
    } else if (type === 'doc') {
      // a card on the board for a Note or PDF subsection of it
      if (!/^[a-z0-9-]{1,60}$/.test(String(d.section))) return null;
      it.data = { section: d.section, kind: d.kind === 'pdf' ? 'pdf' : 'note', name: clip(d.name, 80) };
    } else {
      if (!/^[a-f0-9]{24}$/.test(String(d.img))) return null;
      it.data = { img: d.img, name: clip(d.name, 120) };
    }
    return it;
  }
  itemOut(r) {
    return { id: r.id, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, z: r.z, data: JSON.parse(r.data || '{}'), rev: r.rev, author: r.author, created: r.created, updated: r.updated };
  }

  // ops: [{ op: 'put', item, restore? } | { op: 'del', id }]. live = a move in progress: passed on, not kept.
  applyOps(section, ops, email, live) {
    const out = [];
    const now = Date.now();
    let count = this.one('SELECT COUNT(*) AS c FROM items WHERE section=?', section).c;
    for (const op of Array.isArray(ops) ? ops.slice(0, 200) : []) {
      if (op?.op === 'del' && typeof op.id === 'string') {
        const cur = this.one('SELECT section FROM items WHERE id=?', op.id);
        if (!cur || cur.section !== section) continue;
        this.run('DELETE FROM items WHERE id=?', op.id);
        this.tomb.set(op.id, now);
        count--;
        out.push({ op: 'del', id: op.id });
      } else if (op?.op === 'put') {
        const it = this.cleanItem(op.item);
        if (!it) continue;
        if (op.restore) this.tomb.delete(it.id);
        else if (this.tomb.has(it.id)) continue;
        if (live) {
          out.push({ op: 'put', item: it, live: true });
          continue;
        }
        const cur = this.one('SELECT section, rev, author, created FROM items WHERE id=?', it.id);
        if (cur && cur.section !== section) continue;
        if (!cur && count >= LIMITS.items) continue;
        const rev = (cur?.rev || 0) + 1;
        this.run(
          'INSERT INTO items (id, section, type, x, y, w, h, z, data, rev, author, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, z=excluded.z, data=excluded.data, rev=excluded.rev, updated=excluded.updated',
          it.id, section, it.type, it.x, it.y, it.w, it.h, it.z, JSON.stringify(it.data), rev, cur?.author || email, cur?.created || now, now,
        );
        if (!cur) count++;
        out.push({ op: 'put', item: { ...it, rev, author: cur?.author || email, created: cur?.created || now, updated: now } });
      }
    }
    for (const [id, t] of this.tomb) if (now - t > 120000) this.tomb.delete(id);
    if (!live && out.length) this.markDirty('board:' + section);
    return out;
  }

  // ------------------------------------------------------------------ chat
  cleanRefs(raw) {
    const out = [];
    for (const r of Array.isArray(raw) ? raw.slice(0, 6) : []) {
      if (!r || typeof r !== 'object') continue;
      if (r.k === 'quote') out.push({ k: 'quote', section: clip(r.section, 60), item: clip(r.item, 24), text: clip(r.text, 600), label: clip(r.label, 60) });
      else if (r.k === 'item') out.push({ k: 'item', section: clip(r.section, 60), item: clip(r.item, 24), kind: clip(r.kind, 10), img: /^[a-f0-9]{24}$/.test(String(r.img)) ? r.img : '', text: clip(r.text, 300), label: clip(r.label, 60) });
      else if (r.k === 'msg') out.push({ k: 'msg', section: clip(r.section, 60), msg: Math.round(num(r.msg, 0, 9e15)), text: clip(r.text, 600), who: clip(r.who, 60) });
      else if (r.k === 'bug') out.push({ k: 'bug', bug: clip(r.bug, 24), section: clip(r.section, 60), text: clip(r.text, 200) });
      else if (r.k === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.day))) out.push({ k: 'day', section: clip(r.section, 60), day: r.day, from: Math.round(num(r.from, 0, 1e13, 0)), text: clip(r.text, 200) });
    }
    return out;
  }
  // the Overview: every message that points at something, and everything it points at, as nodes and edges
  // the quick search (Ctrl+K): the words in to-dos, reports, mail, board items, notes and the chat
  search(q) {
    q = String(q).trim().slice(0, 100);
    if (q.length < 2) return [];
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const low = q.toLowerCase();
    // the text around the first match
    const around = (s) => {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      const from = Math.max(0, s.toLowerCase().indexOf(low) - 40);
      return (from ? '…' : '') + s.slice(from, from + 140) + (from + 140 < s.length ? '…' : '');
    };
    const out = [];
    for (const r of this.q("SELECT id, section, message, status, name FROM bugs WHERE message LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT 25", like, like)) {
      const sec = r.section || 'bugs';
      const kind = this.section(sec)?.kind;
      out.push({ k: 'bug', kind: kind === 'todo' ? 'todo' : kind === 'mail' ? 'mail' : 'report', section: sec, bug: r.id, status: r.status, text: around(r.message), who: r.name });
    }
    for (const r of this.q("SELECT id, section, type, data FROM items WHERE data LIKE ? ESCAPE '\\' ORDER BY updated DESC LIMIT 40", like)) {
      let d = {};
      try {
        d = JSON.parse(r.data || '{}');
      } catch {}
      const t = String(d.text || d.name || '');
      if (t.toLowerCase().includes(low)) out.push({ k: 'item', kind: r.type, section: r.section, item: r.id, text: around(t) });
    }
    for (const r of this.q("SELECT id, section, name, ts, body FROM messages WHERE deleted=0 AND body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 20", like)) out.push({ k: 'msg', kind: 'chat', section: r.section, msg: r.id, text: around(r.body), who: r.name, ts: r.ts });
    return out;
  }

  graph() {
    const nodes = new Map();
    const edges = [];
    const text = (s, n) => String(s || '').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
    const msgNode = (m) => {
      if (!nodes.has('m:' + m.id)) nodes.set('m:' + m.id, { id: 'm:' + m.id, k: 'msg', section: m.section, label: text(m.body, 80) || 'Message', who: m.name, ts: m.ts, msg: m.id });
    };
    const itemNode = (id) => {
      if (nodes.has('i:' + id)) return true;
      const r = this.one('SELECT id, section, type, data FROM items WHERE id=?', id);
      if (!r) return false;
      const d = JSON.parse(r.data || '{}');
      nodes.set('i:' + id, { id: 'i:' + id, k: r.type, section: r.section, label: r.type === 'image' ? d.name || 'Image' : text(d.text, 80) || r.type, img: r.type === 'image' ? d.img : undefined, item: id });
      return true;
    };
    const bugNode = (id) => {
      if (nodes.has('b:' + id)) return true;
      const r = this.one('SELECT id, section, message, status, name FROM bugs WHERE id=?', id);
      if (!r) return false;
      const sec = r.section || 'bugs';
      nodes.set('b:' + id, { id: 'b:' + id, k: this.section(sec)?.kind === 'todo' ? 'todo' : 'bug', section: sec, label: text(r.message, 80), status: r.status, who: r.name, bug: id });
      return true;
    };
    const rows = this.q("SELECT id, section, name, ts, body, refs FROM messages WHERE deleted=0 AND refs IS NOT NULL AND refs != '[]' ORDER BY id DESC LIMIT 1500");
    for (const m of rows) {
      let refs = [];
      try {
        refs = JSON.parse(m.refs || '[]');
      } catch {}
      for (const r of refs) {
        let to = null;
        if ((r.k === 'item' || r.k === 'quote') && itemNode(r.item)) to = 'i:' + r.item;
        else if (r.k === 'bug' && bugNode(r.bug)) to = 'b:' + r.bug;
        else if (r.k === 'msg') {
          const t = this.one('SELECT id, section, name, ts, body FROM messages WHERE id=? AND deleted=0', r.msg);
          if (t) {
            msgNode(t);
            to = 'm:' + t.id;
          }
        }
        if (!to || to === 'm:' + m.id) continue;
        msgNode(m);
        edges.push({ from: 'm:' + m.id, to, t: r.k === 'quote' ? 'quote' : 'ref', text: r.k === 'quote' ? text(r.text, 160) : '' });
      }
    }
    return { nodes: [...nodes.values()], edges };
  }
  calOut(r) {
    let ref = null;
    try {
      ref = JSON.parse(r.ref || 'null');
    } catch {}
    return { id: r.id, date: r.date, title: r.title || '', ref, author: r.author, ts: r.ts };
  }
  msgOut(r) {
    return { id: r.id, section: r.section, author: r.author, name: r.name, ts: r.ts, body: r.deleted ? '' : r.body, refs: r.deleted ? [] : JSON.parse(r.refs || '[]'), deleted: !!r.deleted };
  }
  // the people a message "@"-s: @ and their name (or the first word of it), in any case; never the writer
  mentionsIn(body, from) {
    const text = String(body || '').toLowerCase();
    const out = [];
    for (const u of this.users()) {
      if (u.email === from) continue;
      const names = [String(u.name || '').toLowerCase().trim(), String(u.name || '').toLowerCase().trim().split(/\s+/)[0]].filter(Boolean);
      if (names.some((n) => new RegExp('(^|[^\\w])@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])').test(text))) out.push(u.email);
    }
    return out;
  }
  // a new message's id: from the time, with a random end (teammates each write on their own computer, and their
  // messages meet in the backup: the ids must not clash, and still follow the order they were written in)
  msgId() {
    return Math.max(Date.now() * 1000 + Math.floor(Math.random() * 1000), this.one('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM messages').n);
  }
  postMessage(section, email, body, refs) {
    body = clip(body, LIMITS.msg).trim();
    refs = this.cleanRefs(refs);
    if (!body && !refs.length) return null;
    const u = this.ensureUser(email);
    const ts = Date.now();
    const id = this.msgId();
    this.run('INSERT INTO messages (id, section, author, name, ts, body, refs, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)', id, section, email, u.name, ts, body, JSON.stringify(refs));
    this.run('INSERT INTO reads (email, section, last_id) VALUES (?, ?, ?) ON CONFLICT(email, section) DO UPDATE SET last_id=MAX(last_id, excluded.last_id)', email, section, id);
    this.markDirty(`chat:${section}:${new Date(ts).toISOString().slice(0, 10)}`);
    return this.msgOut(this.one('SELECT * FROM messages WHERE id=?', id));
  }

  // ------------------------------------------------------------------ the repository's branches (for the branch tags)
  // 'viti' is the tag for to-dos about Viti itself: not a branch of the repository, so it is never in the branch lists, and only
  // to-do rows can carry it
  cleanBranch(b) {
    const s = String(b ?? '').trim();
    return /^[\w.\-/]{1,100}$/.test(s) ? s : '';
  }
  // { list: [names, the most recently committed first], latest, source }: from GitHub (kept for 10 minutes), else the
  // BRANCHES setting (names separated by commas, the first being the latest), else nothing
  // branches that are not about the project: Viti's own backup branch (and the older one's), and the old "viti" tag
  hiddenBranch(name) {
    const n = String(name || '').toLowerCase();
    return n === 'viti' || n === 'viti-data' || n === 'hub-data' || n === String(this.env.GITHUB_BRANCH || '').toLowerCase();
  }
  async branches() {
    let c = null;
    try {
      c = JSON.parse(this.getMeta('branches') || 'null');
    } catch {}
    if (!c || Date.now() - c.at > 10 * 60 * 1000) {
      try {
        const g = await repoBranches(this.env);
        if (g) {
          const names = g.branches.map((b) => b.name).filter((n) => !this.hiddenBranch(n));
          // the latest is the most recently committed branch, not counting the main one (that one always has the newest commits)
          const latest = g.branches.find((b) => b.name !== g.def && !this.hiddenBranch(b.name))?.name || g.def || names[0] || '';
          c = { at: Date.now(), list: names, latest, source: 'github', error: '' };
          this.setMeta('branches', JSON.stringify(c));
        }
      } catch (e) {
        console.error('branches failed', e?.message);
        c = c ? { ...c, at: Date.now() - 9 * 60 * 1000, error: String(e?.message || e) } : { at: Date.now() - 9 * 60 * 1000, list: [], latest: '', source: 'github', error: String(e?.message || e) };
        this.setMeta('branches', JSON.stringify(c));
      }
    }
    if (!c || (!c.list.length && !c.error)) {
      const fixed = String(this.env.BRANCHES || '').split(',').map((x) => this.cleanBranch(x)).filter((x) => x && x.toLowerCase() !== 'viti');
      return { list: fixed, latest: fixed[0] || '', source: fixed.length ? 'setting' : 'none', error: '' };
    }
    if (!c.list.length) {
      const fixed = String(this.env.BRANCHES || '').split(',').map((x) => this.cleanBranch(x)).filter((x) => x && x.toLowerCase() !== 'viti');
      if (fixed.length) return { list: fixed, latest: fixed[0], source: 'setting', error: c.error };
    }
    // (a list kept from before may still hold the backup branch)
    const list = c.list.filter((n) => !this.hiddenBranch(n));
    const latest = this.hiddenBranch(c.latest) ? list.find((n) => !['main', 'master'].includes(n)) || list[0] || '' : c.latest;
    return { list, latest, source: c.source, error: c.error || '' };
  }

  // ------------------------------------------------------------------ bug reports
  bugOut(r) {
    return { id: r.id, name: r.name, email: r.email, ts: r.ts, browser: r.browser, ua: r.ua, page: r.page, message: r.message, status: r.status, moved: r.moved, movedBy: r.moved_by, images: JSON.parse(r.images || '[]'), source: r.source, section: r.section || 'bugs', subject: r.subject || '', seen: !!r.seen, branch: r.branch || '', priority: r.priority || '', due: r.due || '', html: r.html || '', files: parse(r.files, []), rcpt: parse(r.rcpt, null), thread: r.thread || '' };
  }
  // open: oldest first. closed and trash: newest first. (By the time it was sent.)
  bugLists(section = 'bugs') {
    const rows = this.q("SELECT * FROM bugs WHERE COALESCE(section, 'bugs')=? ORDER BY ts, id", section).map((r) => this.bugOut(r));
    return { open: rows.filter((b) => b.status === 'open'), closed: rows.filter((b) => b.status === 'closed').reverse(), trash: rows.filter((b) => b.status === 'trash').reverse() };
  }
  insertBug({ name, email, ua, page, message, images, source, ts, section, subject, branch }) {
    if (this.one("SELECT id FROM sections WHERE id=? AND kind IN ('bugs', 'todo', 'mail')", section || '') === undefined) section = 'bugs';
    const id = rid(12);
    const label = clip(name, 80) || clip(email, 200).split('@')[0] || 'Anonymous';
    this.run('INSERT INTO bugs (id, name, email, ts, browser, ua, page, message, status, moved, moved_by, images, source, section, subject, seen, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, label, clip(email, 200), ts || Date.now(), parseUA(ua), clip(ua, 400), clip(page, 300), clip(message, LIMITS.bug), 'open', null, null, JSON.stringify(images || []), source, section || 'bugs', clip(subject, 200), 0, this.cleanBranch(branch));
    this.markDirty('bug:' + id, 'bugs-index');
    return this.one('SELECT * FROM bugs WHERE id=?', id);
  }

  // an email read from a linked folder (app/mail.js) into a mailbox; each one comes in once (its Message-ID
  // is kept in "page"). -> true if it was new
  async importMail(section, m) {
    if (this.section(section)?.kind !== 'mail') return false;
    const page = clip('mail:' + m.ref, 300);
    if (this.one('SELECT id FROM bugs WHERE page=? AND section=?', page, section)) return false;
    const { files, html } = await this.mailFiles(m);
    const row = this.insertBug({ name: m.name || m.email, email: m.email, ua: '', page, message: m.text || '(no text)', images: [], source: 'mail', ts: m.ts, section, subject: m.subject });
    this.mailExtras(row.id, { html, files, rcpt: m.rcpt, thread: m.thread });
    this.bcAll({ t: 'bug', bug: this.bugOut(this.one('SELECT * FROM bugs WHERE id=?', row.id)) });
    return true;
  }
  // an email's attachments into the file store: -> { files: [{ id, name, type, size }], html } (pictures shown in
  // the email itself, "cid:", point at their stored copy and are not listed again). Too large: listed, not kept.
  async mailFiles(m) {
    let html = m.html || '';
    const files = [];
    for (const a of m.attachments || []) {
      if (!a.content?.length) continue;
      if (a.content.length > LIMITS.image) {
        files.push({ name: clip(a.name, 120), type: a.type || '', size: a.content.length, skipped: true });
        continue;
      }
      const id = await this.saveFile(new Uint8Array(a.content), a.name, a.type, 'mail');
      if (a.cid && html.includes('cid:' + a.cid)) html = html.split('cid:' + a.cid).join('/api/images/' + id);
      else files.push({ id, name: clip(a.name || 'attachment', 120), type: a.type || '', size: a.content.length });
    }
    return { files, html };
  }
  mailExtras(id, { html = '', files = [], rcpt = null, thread = '' }) {
    this.run('UPDATE bugs SET html=?, files=?, rcpt=?, thread=? WHERE id=?', clip(html, 400000), JSON.stringify(files || []), rcpt ? JSON.stringify(rcpt) : '', clip(thread, 300), id);
    this.markDirty('bug:' + id);
  }

  // an email sent from a mailbox (app/server.js): kept in its Sent (to whom in name and email, from whom in ua)
  recordSent(section, m) {
    if (this.section(section)?.kind !== 'mail') return null;
    const row = this.insertBug({ name: m.toName || m.to, email: m.to, ua: 'from:' + m.from, page: clip('sent:' + (m.messageId || rid(12)), 300), message: m.text, images: [], source: 'sent', ts: m.ts || Date.now(), section, subject: m.subject });
    this.run('UPDATE bugs SET seen=1 WHERE id=?', row.id);
    this.mailExtras(row.id, { html: m.html || '', files: m.files || [], rcpt: { to: String(m.to || '').split(/,\s*/).filter(Boolean), cc: String(m.cc || '').split(/,\s*/).filter(Boolean) }, thread: m.thread || m.messageId || '' });
    const bug = this.bugOut(this.one('SELECT * FROM bugs WHERE id=?', row.id));
    this.bcAll({ t: 'bug', bug });
    return bug;
  }

  // an email you sent yourself, found in the linked label (Gmail labels your replies with the conversation's
  // label): into Sent, unless it is already there (sent from Viti: the same Message-ID, or the same subject to
  // the same person within ten minutes). -> true if it was new
  async importSent(section, m) {
    if (this.section(section)?.kind !== 'mail') return false;
    const page = clip('sent:' + m.ref, 300);
    if (this.one('SELECT id FROM bugs WHERE page=? AND section=?', page, section)) return false;
    if (this.one("SELECT id FROM bugs WHERE section=? AND source='sent' AND subject=? AND lower(email)=lower(?) AND abs(ts-?) < 600000", section, clip(m.subject, 200), m.to || '', m.ts || 0)) return false;
    // (one that came in before as received mail is moved over instead)
    const was = this.one('SELECT id FROM bugs WHERE page=? AND section=?', clip('mail:' + m.ref, 300), section);
    if (was) this.dropBug(was.id);
    const { files, html } = await this.mailFiles(m);
    this.recordSent(section, { to: m.to || '', toName: m.toName, cc: (m.rcpt?.cc || []).join(', '), from: m.from, subject: m.subject, text: m.text, html, files, messageId: m.ref, thread: m.thread, ts: m.ts });
    return true;
  }
  // emails from your own address that came into the Inbox before Viti knew better: the ones Viti also has in
  // Sent are dropped, the others become Sent (to whom is not known for those)
  ownToSent(section, address) {
    const rows = this.q("SELECT * FROM bugs WHERE section=? AND source='mail' AND lower(email)=lower(?)", section, address || '');
    for (const r of rows) {
      const twin = this.one("SELECT id FROM bugs WHERE section=? AND source='sent' AND subject=? AND abs(ts-?) < 600000", section, r.subject || '', r.ts);
      if (twin) {
        this.dropBug(r.id);
        continue;
      }
      this.run("UPDATE bugs SET source='sent', name='', email='', ua=?, page=?, seen=1 WHERE id=?", 'from:' + address, clip('sent:' + String(r.page || '').replace(/^mail:/, ''), 300), r.id);
      this.markDirty('bug:' + r.id, 'bugs-index');
      this.bcAll({ t: 'bug', bug: this.bugOut(this.one('SELECT * FROM bugs WHERE id=?', r.id)) });
    }
  }
  dropBug(id) {
    this.run('DELETE FROM bugs WHERE id=?', id);
    this.markDirty('bug-del:' + id, 'bugs-index');
    this.bcAll({ t: 'bug-del', id });
  }

  // ------------------------------------------------------------------ images (in chunks: a row holds at most 2 MB)
  async saveImage(bytes, { name = '', w = 0, h = 0 }, by, pdf = false) {
    if (!bytes.length || bytes.length > LIMITS.image) throw new Error('size');
    const kind = pdf ? sniffPdf(bytes) : sniffImage(bytes);
    if (!kind) throw new Error('type');
    const id = (await sha256hex(bytes)).slice(0, 24);
    if (!this.one('SELECT id FROM images WHERE id=?', id)) {
      this.ctx.storage.transactionSync(() => {
        this.run('INSERT INTO images (id, name, mime, ext, size, w, h, ts, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, clip(name, 120), kind[0], kind[1], bytes.length, Math.round(num(w, 0, 100000)), Math.round(num(h, 0, 100000)), Date.now(), by);
        for (let i = 0, n = 0; i < bytes.length; i += LIMITS.chunk, n++) this.run('INSERT INTO image_chunks (id, seq, data) VALUES (?, ?, ?)', id, n, bytes.slice(i, i + LIMITS.chunk).buffer);
      });
      this.markDirty('image:' + id, 'images-index');
    }
    return { id, mime: kind[0] };
  }
  async saveFile(bytes, name, type, by) {
    if (!bytes.length || bytes.length > LIMITS.image) throw new Error('size');
    const kind = sniffImage(bytes) || sniffPdf(bytes);
    const id = (await sha256hex(bytes)).slice(0, 24);
    if (!this.one('SELECT id FROM images WHERE id=?', id)) {
      const ext = kind ? kind[1] : (String(name || '').match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'bin').toLowerCase();
      this.ctx.storage.transactionSync(() => {
        this.run('INSERT INTO images (id, name, mime, ext, size, w, h, ts, by) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)', id, clip(name || 'file', 120), kind ? kind[0] : clip(type || 'application/octet-stream', 100), ext, bytes.length, Date.now(), by);
        for (let i = 0, n = 0; i < bytes.length; i += LIMITS.chunk, n++) this.run('INSERT INTO image_chunks (id, seq, data) VALUES (?, ?, ?)', id, n, bytes.slice(i, i + LIMITS.chunk).buffer);
      });
      this.markDirty('image:' + id, 'images-index');
    }
    return id;
  }
  imageResponse(id, request) {
    const row = this.one('SELECT mime, size, name FROM images WHERE id=?', id);
    if (!row) return fail(404, 'no-image');
    // pictures and PDFs are shown; anything else is only ever saved (never opened as a page)
    const shown = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(row.mime);
    const headers = { 'cache-control': 'private, max-age=31536000, immutable', etag: `"${id}"`, 'x-content-type-options': 'nosniff', 'content-type': shown ? row.mime : 'application/octet-stream', ...(shown ? {} : { 'content-disposition': `attachment; filename="${String(row.name || 'file').replace(/["\\\r\n]/g, '_')}"` }) };
    if (request.headers.get('if-none-match') === `"${id}"`) return new Response(null, { status: 304, headers });
    const out = new Uint8Array(row.size);
    let at = 0;
    for (const c of this.q('SELECT data FROM image_chunks WHERE id=? ORDER BY seq', id)) {
      out.set(new Uint8Array(c.data), at);
      at += c.data.byteLength;
    }
    return new Response(out, { headers });
  }

  // ------------------------------------------------------------------ the API
  state(email) {
    const me = this.ensureUser(email);
    const sections = this.sections().map((s) => {
      const last = this.one('SELECT last_id FROM reads WHERE email=? AND section=?', email, s.id)?.last_id || 0;
      const unread = this.one('SELECT COUNT(*) AS c FROM messages WHERE section=? AND id>? AND deleted=0 AND author IS NOT ?', s.id, last, email).c;
      return { ...s, unread };
    });
    return {
      ok: true,
      me: { email, name: me.name, color: me.color, avatar: me.avatar || '', named: !!me.named, order: JSON.parse(this.getMeta('order:' + email) || '[]') },
      users: this.users(),
      sections,
      categories: this.categories(),
      bugCounts: Object.fromEntries(this.q("SELECT id FROM sections WHERE kind IN ('bugs', 'todo', 'mail')").map((sec) => [sec.id, { unread: this.one("SELECT COUNT(*) AS c FROM bugs WHERE status='open' AND COALESCE(seen, 0)=0 AND COALESCE(section, 'bugs')=?", sec.id).c, ...Object.fromEntries(BUG_STATUS.map((s) => [s, this.one("SELECT COUNT(*) AS c FROM bugs WHERE status=? AND COALESCE(section, 'bugs')=?", s, sec.id).c]))}])),
      presence: this.presence(),
      sync: this.mirror.status(),
      dev: this.env.DEV_MODE === '1',
    };
  }

  async readBody(request, max = 200000) {
    const text = await request.text();
    if (text.length > max) throw new Error('too big');
    return text ? JSON.parse(text) : {};
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    try {
      if (p === '/api/intake/bug' && method === 'POST') return await this.intake(request);
      if (p === '/api/intake/mail' && method === 'POST') return await this.intakeMail(request);
      const email = request.headers.get('x-hub-user');
      if (!email) return fail(401, 'no-user');
      if (p === '/api/ws') {
        this.ensureUser(email);
        return this.upgrade(request, email);
      }
      let m;
      if (p === '/api/state' && method === 'GET') return json(this.state(email));
      if (p === '/api/branches' && method === 'GET') return json({ ok: true, ...(await this.branches()) });
      if (p === '/api/progress' && method === 'GET') {
        // every to-do row and every report that is Closed is a stone, in the order they were finished 
        const rows = this.q("SELECT b.id, b.name, b.message, b.ts, b.moved, s.id AS sid, s.name AS sname, s.kind AS skind FROM bugs b JOIN sections s ON s.id = COALESCE(b.section, 'bugs') WHERE s.kind IN ('todo', 'bugs') AND b.status='closed' ORDER BY COALESCE(b.moved, b.ts), b.id");
        return json({ ok: true, tasks: rows.map((r) => ({ id: r.id, text: r.message, name: r.name, ts: r.moved || r.ts, where: r.sname, kind: r.skind, section: r.sid })) });
      }
      // the Calendar: dates people have labelled (and pointed at something), and the open tasks that have a deadline
      if (p === '/api/calendar' && method === 'GET') {
        const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
        const from = ok(url.searchParams.get('from')) ? url.searchParams.get('from') : '0000-01-01';
        const to = ok(url.searchParams.get('to')) ? url.searchParams.get('to') : '9999-12-31';
        const entries = this.q('SELECT * FROM calendar WHERE date>=? AND date<=? ORDER BY date, ts', from, to).map((r) => this.calOut(r));
        const tasks = this.q("SELECT b.id, b.message, b.due, b.priority, b.branch, b.status, COALESCE(b.section, 'bugs') AS sid, s.name AS sname, s.kind AS skind FROM bugs b JOIN sections s ON s.id = COALESCE(b.section, 'bugs') WHERE b.due != '' AND b.due>=? AND b.due<=? AND b.status='open' ORDER BY b.due, b.ts", from, to).map((r) => ({ id: r.id, text: clip(r.message, 200), due: r.due, priority: r.priority || '', branch: r.branch || '', section: r.sid, where: r.sname, kind: r.skind }));
        return json({ ok: true, entries, tasks });
      }
      if (p === '/api/calendar' && method === 'POST') {
        const b = await this.readBody(request);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) return fail(400, 'date');
        const ref = this.cleanRefs(b.ref ? [b.ref] : [])[0] || null;
        const title = clip(b.title, 200).trim();
        if (!title && !ref) return fail(400, 'title', 'Write a label, or point at something.');
        const id = rid(12);
        this.run('INSERT INTO calendar (id, date, title, ref, author, ts) VALUES (?, ?, ?, ?, ?, ?)', id, b.date, title, JSON.stringify(ref), email, Date.now());
        this.markDirty('calendar');
        this.bcAll({ t: 'cal' });
        return json({ ok: true, id });
      }
      if ((m = p.match(/^\/api\/calendar\/([a-z0-9]+)$/))) {
        const row = this.one('SELECT * FROM calendar WHERE id=?', m[1]);
        if (!row) return fail(404, 'no-entry');
        if (method === 'PATCH') {
          const b = await this.readBody(request);
          if (b.date !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) return fail(400, 'date');
            this.run('UPDATE calendar SET date=? WHERE id=?', b.date, row.id);
          }
          if (b.title !== undefined) this.run('UPDATE calendar SET title=? WHERE id=?', clip(b.title, 200).trim(), row.id);
          this.markDirty('calendar');
          this.bcAll({ t: 'cal' });
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          this.run('DELETE FROM calendar WHERE id=?', row.id);
          this.markDirty('calendar');
          this.bcAll({ t: 'cal' });
          return json({ ok: true });
        }
      }
      if (p === '/api/graph' && method === 'GET') return json({ ok: true, ...this.graph() });
      if (p === '/api/search' && method === 'GET') return json({ ok: true, results: this.search(url.searchParams.get('q') || '') });

      if (p === '/api/me/order' && method === 'PUT') {
        // each person's own order of the sections in their menu (a list of section ids)
        const b = await this.readBody(request);
        const ids = (Array.isArray(b.order) ? b.order : []).map((x) => String(x).slice(0, 80)).filter((x, i, all) => this.section(x) && all.indexOf(x) === i).slice(0, LIMITS.sections);
        this.setMeta('order:' + email, JSON.stringify(ids));
        return json({ ok: true, order: ids });
      }
      if (p === '/api/me' && method === 'PATCH') {
        const b = await this.readBody(request);
        const name = clip(b.name, 40).trim();
        if (!name) return fail(400, 'name');
        this.ensureUser(email);
        this.run('UPDATE users SET name=?, named=1 WHERE email=?', name, email);
        this.markDirty('meta');
        this.bcAll({ t: 'users', users: this.users() });
        return json({ ok: true });
      }

      if (p === '/api/sections' && method === 'POST') {
        const b = await this.readBody(request);
        const name = clip(b.name || (b.parent ? b.branch : ''), LIMITS.name).trim();
        if (!name) return fail(400, 'name');
        if (this.q('SELECT id FROM sections').length >= LIMITS.sections) return fail(400, 'limit', 'Too many sections.');
        // a Note (markdown) or a PDF under a main board: shown as a subsection, and as a card on the board
        if (b.parent && (b.kind === 'note' || b.kind === 'pdf')) {
          const par = this.section(String(b.parent));
          if (!par || par.kind !== 'board' || par.parent) return fail(400, 'parent', 'A note or PDF belongs under a main board.');
          let file = '';
          if (b.kind === 'pdf') {
            file = String(b.file || '');
            if (this.one('SELECT id FROM images WHERE id=? AND mime=?', file, 'application/pdf') === undefined) return fail(400, 'file', 'Upload the PDF first.');
          }
          const obr = this.cleanBranch(b.branch);
          if (obr.toLowerCase() === 'viti') return fail(400, 'branch', 'viti is not a branch of the repository.');
          if (obr && !this.one("SELECT id FROM sections WHERE parent=? AND branch=? AND kind='board'", par.id, obr)) return fail(400, 'branch', 'Make the page for that branch under this section first (+ Branch).');
          const sid = this.uniqueSectionId(par.id + '-' + name);
          const pos = (this.one('SELECT COALESCE(MAX(pos), 0) + 1 AS n FROM sections WHERE parent=?', par.id).n) || 1;
          this.run("INSERT INTO sections (id, name, kind, pos, created, category, parent, branch, file) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)", sid, name, b.kind, pos, Date.now(), par.id, obr, file);
          for (const u of this.q('SELECT email FROM users')) this.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, 0)', u.email, sid);
          this.markDirty('meta', 'board:' + sid);
          this.bcSections();
          return json({ ok: true, id: sid });
        }
        // a branch subsection: a board of its own under a main board, one per branch of the repository
        if (b.parent) {
          const par = this.section(String(b.parent));
          const br = this.cleanBranch(b.branch);
          if (!par || par.kind !== 'board' || par.parent) return fail(400, 'parent', 'Only a main board can have branch subsections.');
          if (!br) return fail(400, 'branch', 'Pick a branch.');
          if (br.toLowerCase() === 'viti') return fail(400, 'branch', 'viti is not a branch of the repository.');
          if (this.one("SELECT id FROM sections WHERE parent=? AND branch=? AND kind='board'", par.id, br)) return fail(409, 'exists', 'That branch already has a subsection here.');
          const sid = this.uniqueSectionId(par.id + '-' + br);
          this.run("INSERT INTO sections (id, name, kind, pos, created, category, parent, branch) VALUES (?, ?, 'board', 0, ?, '', ?, ?)", sid, br, Date.now(), par.id, br);
          for (const u of this.q('SELECT email FROM users')) this.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, 0)', u.email, sid);
          this.markDirty('meta', 'board:' + sid);
          this.bcSections();
          return json({ ok: true, id: sid });
        }
        const id = this.uniqueSectionId(name);
        const kind = b.kind === 'bugs' ? 'bugs' : b.kind === 'mail' ? 'mail' : 'board'; // a report section has Open, Closed and Trash lists; a mailbox gets email
        // a mailbox always goes in the MAIL category (made the first time)
        if (kind === 'mail') {
          this.run("INSERT OR IGNORE INTO categories (id, name, pos, created, core) VALUES ('mail', 'MAIL', -1, ?, 1)", Date.now());
          b.category = 'mail';
        }
        const pos = (this.one('SELECT COALESCE(MAX(pos), ?) + 1 AS n FROM sections WHERE kind=?', kind === 'bugs' ? 999 : -1, kind).n) || 0;
        // (a section can be created straight into Sections, Reports, or one of your own categories)
        const category = kind === 'mail' ? 'mail' : ['@sections', '@reports'].includes(b.category) ? b.category : this.one('SELECT id FROM categories WHERE id=? AND COALESCE(core, 0)=0', String(b.category || ''))?.id || '';
        this.run('INSERT INTO sections (id, name, kind, pos, created, category) VALUES (?, ?, ?, ?, ?, ?)', id, name, kind, pos, Date.now(), category);
        for (const u of this.q('SELECT email FROM users')) this.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, 0)', u.email, id);
        this.markDirty('meta', kind === 'board' ? 'board:' + id : 'bugs-index');
        if (kind === 'mail') this.markDirty('meta');
        this.bcSections();
        return json({ ok: true, id });
      }
      // categories: your own headings in the menu, holding sections
      if (p === '/api/categories' && method === 'POST') {
        const b = await this.readBody(request);
        const name = clip(b.name, LIMITS.name).trim();
        if (!name) return fail(400, 'name');
        if (this.q('SELECT id FROM categories').length >= LIMITS.categories) return fail(400, 'limit', 'Too many categories.');
        let id = slugify(name) || 'category';
        for (let i = 2; this.one('SELECT id FROM categories WHERE id=?', id); i++) id = `${slugify(name) || 'category'}-${i}`;
        const pos = this.one('SELECT COALESCE(MAX(pos), -1) + 1 AS n FROM categories').n;
        this.run('INSERT INTO categories (id, name, pos, created) VALUES (?, ?, ?, ?)', id, name, pos, Date.now());
        this.markDirty('meta');
        this.bcSections();
        return json({ ok: true, id });
      }
      if ((m = p.match(/^\/api\/categories\/([a-z0-9-]+)$/))) {
        const cat = this.one('SELECT * FROM categories WHERE id=?', m[1]);
        if (!cat) return fail(404, 'no-category');
        if (cat.core) return fail(400, 'protected', 'The MAIL and PROJECT categories cannot be renamed or deleted.');
        if (method === 'PATCH') {
          const b = await this.readBody(request);
          const name = clip(b.name, LIMITS.name).trim();
          if (!name) return fail(400, 'name');
          this.run('UPDATE categories SET name=? WHERE id=?', name, cat.id);
          this.markDirty('meta');
          this.bcSections();
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          // its sections go back to their usual place in the menu
          this.ctx.storage.transactionSync(() => {
            this.run("UPDATE sections SET category='' WHERE category=?", cat.id);
            this.run('DELETE FROM categories WHERE id=?', cat.id);
          });
          this.markDirty('meta');
          this.bcSections();
          return json({ ok: true });
        }
      }
      if ((m = p.match(/^\/api\/sections\/([a-z0-9-]+)\/category$/)) && method === 'PUT') {
        const sec = this.section(m[1]);
        if (!sec) return fail(404, 'no-section');
        const b = await this.readBody(request);
        if (sec.kind === 'mail') return fail(400, 'protected', 'The mailboxes stay in MAIL.');
        if (['todo', 'progress', 'calendar', 'overview'].includes(sec.kind)) return fail(400, 'protected', 'This section stays in PROJECT.');
        if (sec.parent) return fail(400, 'protected', 'A branch subsection stays under its main board.');
        // '@sections' and '@reports': put in the Sections or the Reports group of the menu (either takes either kind)
        const group = ['@sections', '@reports'].includes(b.category) ? b.category : '';
        const cat = b.category && !group ? this.one('SELECT id FROM categories WHERE id=? AND COALESCE(core, 0)=0', String(b.category)) : null;
        if (b.category && !group && !cat) return fail(404, 'no-category');
        this.run('UPDATE sections SET category=? WHERE id=?', group || cat?.id || '', sec.id);
        this.markDirty('meta');
        this.bcSections();
        return json({ ok: true });
      }
      if ((m = p.match(/^\/api\/sections\/([a-z0-9-]+)$/))) {
        const sec = this.section(m[1]);
        if (!sec) return fail(404, 'no-section');
        if (method === 'PATCH') {
          const b = await this.readBody(request);
          const name = clip(b.name, LIMITS.name).trim();
          if (!name) return fail(400, 'name');
          if (sec.core) return fail(400, 'protected', 'The default sections cannot be renamed.');
          if (sec.parent && sec.kind === 'board') return fail(400, 'protected', 'A branch subsection is named after its branch.');
          this.run('UPDATE sections SET name=? WHERE id=?', name, sec.id);
          this.markDirty('meta', 'board:' + sec.id);
          this.bcSections();
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          if (sec.core) return fail(400, 'protected', 'The default sections cannot be deleted.');
          const gone = [sec.id, ...this.q('SELECT id FROM sections WHERE parent=?', sec.id).map((r) => r.id)]; // (a main board takes its branch subsections with it)
          this.ctx.storage.transactionSync(() => {
            for (const id of gone) {
              this.run('DELETE FROM items WHERE section=?', id);
              this.run('DELETE FROM bugs WHERE section=?', id);
              this.run('DELETE FROM messages WHERE section=?', id);
              this.run('DELETE FROM reads WHERE section=?', id);
              this.run('DELETE FROM sections WHERE id=?', id);
            }
          });
          this.markDirty('meta', ...gone.map((id) => 'section-del:' + id));
          this.bcSections();
          return json({ ok: true });
        }
      }
      if ((m = p.match(/^\/api\/sections\/([a-z0-9-]+)\/items$/)) && method === 'GET') {
        if (!this.section(m[1])) return fail(404, 'no-section');
        return json({ ok: true, items: this.q('SELECT * FROM items WHERE section=? ORDER BY z, id', m[1]).map((r) => this.itemOut(r)) });
      }

      if ((m = p.match(/^\/api\/chat\/([a-z0-9-]+)$/))) {
        if (!this.section(m[1])) return fail(404, 'no-section');
        if (method === 'GET' && url.searchParams.has('from')) {
          const row = this.one('SELECT id FROM messages WHERE section=? AND ts>=? AND deleted=0 ORDER BY id LIMIT 1', m[1], Math.round(num(url.searchParams.get('from'), 0, 1e13, 0)));
          return json({ ok: true, id: row?.id || 0 });
        }
        if (method === 'GET') {
          const before = Math.round(num(url.searchParams.get('before'), 0, 9e15, 0)) || 9e15; // (ids are time-based since 0.6.0: up to ~2e15)
          const limit = Math.round(num(url.searchParams.get('limit'), 1, 100, 50));
          const rows = this.q('SELECT * FROM messages WHERE section=? AND id<? ORDER BY id DESC LIMIT ?', m[1], before, limit).reverse();
          return json({ ok: true, messages: rows.map((r) => this.msgOut(r)), more: rows.length === limit });
        }
        if (method === 'POST') {
          const b = await this.readBody(request, 60000);
          const msg = this.postMessage(m[1], email, b.body, b.refs);
          if (!msg) return fail(400, 'empty');
          this.bcAll({ t: 'msg', msg: { ...msg, mentions: this.mentionsIn(msg.body, email) } });
          return json({ ok: true, id: msg.id });
        }
      }
      if ((m = p.match(/^\/api\/chat\/([a-z0-9-]+)\/read$/)) && method === 'POST') {
        const b = await this.readBody(request);
        const id = Math.round(num(b.id, 0, 9e15));
        this.run('INSERT INTO reads (email, section, last_id) VALUES (?, ?, ?) ON CONFLICT(email, section) DO UPDATE SET last_id=MAX(last_id, excluded.last_id)', email, m[1], id);
        return json({ ok: true });
      }
      if ((m = p.match(/^\/api\/messages\/(\d+)$/)) && method === 'DELETE') {
        const r = this.one('SELECT * FROM messages WHERE id=?', Number(m[1]));
        if (!r) return fail(404, 'no-message');
        if (r.author !== email) return fail(403, 'not-yours', 'You can only delete your own messages.');
        this.run('UPDATE messages SET deleted=1, body=?, refs=? WHERE id=?', '', '[]', r.id);
        this.markDirty(`chat:${r.section}:${new Date(r.ts).toISOString().slice(0, 10)}`);
        this.bcAll({ t: 'msg', msg: this.msgOut(this.one('SELECT * FROM messages WHERE id=?', r.id)) });
        return json({ ok: true });
      }

      if (p === '/api/images' && method === 'POST') {
        const len = Number(request.headers.get('content-length') || 0);
        if (len > LIMITS.image + 1024) return fail(413, 'size', 'The image is too big (10 MB at most).');
        const bytes = new Uint8Array(await request.arrayBuffer());
        try {
          const r = await this.saveImage(bytes, { name: url.searchParams.get('name') || '', w: url.searchParams.get('w'), h: url.searchParams.get('h') }, email);
          return json({ ok: true, ...r });
        } catch (e) {
          return fail(400, e.message === 'size' ? 'size' : 'type', e.message === 'size' ? 'The image is empty or too big (10 MB at most).' : 'Only PNG, JPEG, WebP and GIF images.');
        }
      }
      // a PDF (kept like an image: in pieces, and backed up with them)
      if (p === '/api/files' && method === 'POST') {
        const len = Number(request.headers.get('content-length') || 0);
        if (len > LIMITS.image + 1024) return fail(413, 'size', 'The file is too big (10 MB at most).');
        const bytes = new Uint8Array(await request.arrayBuffer());
        try {
          const r = await this.saveImage(bytes, { name: url.searchParams.get('name') || '' }, email, true);
          return json({ ok: true, ...r });
        } catch (e) {
          return fail(400, e.message === 'size' ? 'size' : 'type', e.message === 'size' ? 'The file is empty or too big (10 MB at most).' : 'Only PDF files.');
        }
      }
      if ((m = p.match(/^\/api\/images\/([a-f0-9]{24})$/)) && method === 'GET') return this.imageResponse(m[1], request);

      if (p === '/api/bugs' && method === 'GET') return json({ ok: true, ...this.bugLists(url.searchParams.get('section') || 'bugs') });
      if (p === '/api/bugs' && method === 'POST') {
        const b = await this.readBody(request, 100000);
        const message = clip(b.message, LIMITS.bug).trim();
        if (!message) return fail(400, 'message');
        const u = this.ensureUser(email);
        const images = (Array.isArray(b.images) ? b.images : []).filter((i) => /^[a-f0-9]{24}$/.test(String(i)) && this.one('SELECT id FROM images WHERE id=?', i)).slice(0, 5);
        const branch = this.cleanBranch(b.branch) || (await this.branches()).latest;
        if (branch.toLowerCase() === 'viti' && this.section(b.section || 'bugs')?.kind !== 'todo') return fail(400, 'branch', 'The viti tag is only for the to-do list.');
        let row = this.insertBug({ name: u.name, email, ua: request.headers.get('user-agent'), page: '', message, images, source: 'manual', section: b.section, branch });
        // a priority (and the deadline it brings) can be given straight away
        if (['high', 'medium', 'low'].includes(b.priority)) {
          this.run('UPDATE bugs SET priority=?, due=? WHERE id=?', b.priority, /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || '')) ? b.due : '', row.id);
          row = this.one('SELECT * FROM bugs WHERE id=?', row.id);
        }
        const bug = this.bugOut(row);
        this.bcAll({ t: 'bug', bug });
        return json({ ok: true, id: bug.id });
      }
      if ((m = p.match(/^\/api\/bugs\/([a-z0-9]+)$/))) {
        const row = this.one('SELECT * FROM bugs WHERE id=?', m[1]);
        if (!row) return fail(404, 'no-bug');
        if (method === 'PATCH') {
          const b = await this.readBody(request);
          if (b.branch !== undefined) {
            const br = this.cleanBranch(b.branch);
            if (b.branch && !br) return fail(400, 'branch');
            if (br.toLowerCase() === 'viti' && this.section(row.section || 'bugs')?.kind !== 'todo') return fail(400, 'branch', 'The viti tag is only for the to-do list.');
            this.run('UPDATE bugs SET branch=? WHERE id=?', br, row.id);
          }
          if (b.message !== undefined) {
            const message = clip(b.message, LIMITS.bug).trim();
            if (!message) return fail(400, 'message');
            if (this.section(row.section || 'bugs')?.kind === 'mail') return fail(400, 'message', 'Mail cannot be edited.');
            this.run('UPDATE bugs SET message=? WHERE id=?', message, row.id);
          }
          if (b.priority !== undefined) {
            if (!['', 'high', 'medium', 'low'].includes(b.priority)) return fail(400, 'priority');
            this.run('UPDATE bugs SET priority=? WHERE id=?', b.priority, row.id);
          }
          if (b.due !== undefined) {
            if (!/^(\d{4}-\d{2}-\d{2})?$/.test(b.due)) return fail(400, 'due');
            this.run('UPDATE bugs SET due=? WHERE id=?', b.due, row.id);
          }
          if (b.status === undefined && b.seen === undefined && b.branch === undefined && b.message === undefined && b.priority === undefined && b.due === undefined) return fail(400, 'status');
          if (b.status !== undefined && !BUG_STATUS.includes(b.status)) return fail(400, 'status');
          if (b.seen !== undefined) this.run('UPDATE bugs SET seen=? WHERE id=?', b.seen ? 1 : 0, row.id);
          if (b.status !== undefined && b.status !== row.status) this.run('UPDATE bugs SET status=?, moved=?, moved_by=? WHERE id=?', b.status, Date.now(), email, row.id);
          this.markDirty('bug:' + row.id, 'bugs-index');
          const bug = this.bugOut(this.one('SELECT * FROM bugs WHERE id=?', row.id));
          this.bcAll({ t: 'bug', bug });
          return json({ ok: true });
        }
        if (method === 'DELETE') {
          if (row.status !== 'trash') return fail(400, 'not-trash', 'Only reports in the trash can be deleted for good.');
          this.run('DELETE FROM bugs WHERE id=?', row.id);
          this.markDirty('bug-del:' + row.id, 'bugs-index');
          this.bcAll({ t: 'bug-del', id: row.id });
          return json({ ok: true });
        }
      }

      if (p === '/api/admin/sync' && method === 'GET') return json({ ok: true, sync: this.mirror.status() });
      // an empty repository: Viti gives it its first commit (a README), then backs up
      if (p === '/api/admin/start-repo' && method === 'POST') {
        if (!this.mirror.gh.configured) return fail(400, 'not-configured', 'This project is not connected to GitHub.');
        await this.mirror.gh.startEmpty(String(this.mirror.gh.repo || '').split('/')[1] || 'Project');
        return json({ ok: true, sync: await this.mirror.syncNow(true) });
      }
      if (p === '/api/admin/sync' && method === 'POST') {
        const b = await this.readBody(request);
        return json({ ok: true, sync: await this.mirror.syncNow(!!b.full) });
      }
      // import a bundle of boards, reports and to-do rows (made from the team's Figma notes; the images are uploaded first)
      if (p === '/api/admin/import' && method === 'POST') {
        const b = await this.readBody(request, 4 * 1024 * 1024);
        try {
          return json({ ok: true, ...this.importBundle(b, email) });
        } catch (e) {
          return fail(409, 'import', e?.message || 'The import failed.');
        }
      }
      if (p === '/api/admin/restore' && method === 'POST') {
        const b = await this.readBody(request);
        if (b.confirm !== 'RESTORE') return fail(400, 'confirm', 'Send {"confirm":"RESTORE"}.');
        const result = await this.mirror.restore();
        this.bcAll({ t: 'reload' });
        return json({ ok: true, ...result });
      }
      return fail(404, 'not-found');
    } catch (e) {
      console.error('hub error', p, e?.stack || e?.message || e);
      return fail(e instanceof SyntaxError ? 400 : 500, 'error', e instanceof SyntaxError ? 'Bad JSON.' : e?.message || 'Something went wrong.');
    }
  }

  // the website's contact form (a bug report with its screenshots), through a service binding
  async intake(request) {
    const secret = this.env.INTAKE_SECRET;
    // (a refused request's body is read first: answering before it is read drops the connection)
    if (!secret) return (await request.arrayBuffer().catch(() => {}), fail(503, 'intake-off', 'INTAKE_SECRET is not set.'));
    if (!safeEqual(request.headers.get('x-intake-secret'), secret)) return (await request.arrayBuffer().catch(() => {}), fail(401, 'bad-secret'));
    const b = await this.readBody(request, 25 * 1024 * 1024);
    const message = clip(b.message, LIMITS.bug).trim();
    if (!message) return fail(400, 'message');
    const images = [];
    for (const a of (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 5)) {
      try {
        images.push((await this.saveImage(b64decode(a.data), { name: a.name }, null)).id);
      } catch {}
    }
    const row = this.insertBug({ name: b.name, email: b.email, ua: b.ua, page: b.page, message, images, source: 'form', branch: (await this.branches()).latest });
    this.bcAll({ t: 'bug', bug: this.bugOut(row) });
    return json({ ok: true, id: row.id });
  }

  // the website's contact form, for the kinds of mail that are read in the MAIL category (through the service binding)
  async intakeMail(request) {
    const secret = this.env.INTAKE_SECRET;
    // (a refused request's body is read first: answering before it is read drops the connection)
    if (!secret) return (await request.arrayBuffer().catch(() => {}), fail(503, 'intake-off', 'INTAKE_SECRET is not set.'));
    if (!safeEqual(request.headers.get('x-intake-secret'), secret)) return (await request.arrayBuffer().catch(() => {}), fail(401, 'bad-secret'));
    const b = await this.readBody(request, 200000);
    const message = clip(b.message, LIMITS.bug).trim();
    if (!message) return fail(400, 'message');
    const section = b.category === 'feedback' ? 'feedback' : 'general-inquiry';
    const subject = clip(b.subject || message.split('\n')[0], 200).trim();
    const row = this.insertBug({ name: b.name, email: b.email, ua: b.ua, page: b.page, message, images: [], source: 'form', section, subject });
    this.bcAll({ t: 'bug', bug: this.bugOut(row) });
    return json({ ok: true, id: row.id });
  }

  // the mirror runs from an alarm
  async alarm() {
    await this.mirror.run();
  }
}
