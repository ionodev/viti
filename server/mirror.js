// The GitHub mirror. Everything that changes is noted in the `dirty` table; a while after the first change
// (MIRROR_DELAY_MS) an alarm turns those notes into files and puts them in ONE commit on the backup
// branch, in its folder. The Durable Object stays the live copy; this is the backup and the history, and
// restore() can rebuild everything from it.
//
//   hub/meta.json                       sections and people
//   hub/sections/<id>/board.json        the items (what restore reads)
//   hub/sections/<id>/board.md          the same, as readable text
//   hub/chat/<id>/<YYYY-MM-DD>.jsonl    one message per line
//   hub/reports/<section>/<id>.json, hub/reports/<section>/INDEX.md   (each report section has its own folder)
//   hub/images/<id>.<ext>, hub/images/index.json
import { GitHub } from './github.js';
import { sha256hex, gitsha } from './util.js';

const MAX_IMAGES_PER_RUN = 30; // each image is one GitHub call; a Worker may make 50 per invocation
const RETRY_MS = 5 * 60 * 1000;
const enc = (v) => JSON.stringify(v, null, 2) + '\n';
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const POLL_MS = 20000;
const READ = /\.(json|jsonl|md)$/; // files fetched when they change (the pictures only when one is new here)
const KEEP = /\.(json|jsonl)$/; // ... and of those, the ones kept as the "before" of the next merge
const dec = new TextDecoder();
const J = (b) => (b ? JSON.parse(dec.decode(b)) : null);
const L = (b) => (b ? dec.decode(b).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : null);
const bytesOf = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
// records compared by content (the order of their fields aside)
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x));
const same = (a, b) => stable(a) === stable(b);
const sameList = (a, b, key) => {
  const s = (l) => stable([...(l || [])].sort((p, q) => (String(p[key]) < String(q[key]) ? -1 : 1)));
  return s(a) === s(b);
};
const when = (r) => Number(r?.updated || r?.moved || r?.ts || r?.created || 0);

// Two lists of records (theirs: what is on GitHub now; ours: what is here) merged by key, knowing what both
// started from (base: what was on GitHub at the last sync; null the very first time). Changed on one side only:
// that side's version. Changed on both: the one changed last. Deleted on one side and untouched on the other:
// deleted. (Without a base, nothing is taken as deleted.)
export function merge3(base, theirs, ours, key) {
  const B = new Map((base || []).map((r) => [r[key], r]));
  const T = new Map((theirs || []).map((r) => [r[key], r]));
  const O = new Map((ours || []).map((r) => [r[key], r]));
  const out = [];
  for (const id of new Set([...T.keys(), ...O.keys()])) {
    const b = B.get(id);
    const t = T.get(id);
    const o = O.get(id);
    if (t && o) out.push(same(t, o) || (b && same(b, o)) ? t : b && same(b, t) ? o : when(o) > when(t) ? o : t);
    else if (t && !(b && same(b, t))) out.push(t);
    else if (o && !(b && same(b, o))) out.push(o);
  }
  return out;
}
// a few at a time
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

export class Mirror {
  constructor(hub) {
    this.hub = hub;
    this.armed = false;
    this.running = false;
    this.gh = new GitHub(hub.env);
    this.dir = (hub.env.GITHUB_DIR || 'hub').replace(/^\/|\/$/g, '');
  }
  get delay() {
    return Math.max(1000, Number(this.hub.env.MIRROR_DELAY_MS) || 90000);
  }

  status() {
    const h = this.hub;
    if (!this.gh.configured) return { configured: false };
    const at = Number(h.getMeta('mirror_at')) || 0;
    const err = h.getMeta('mirror_err') || '';
    return { configured: true, ok: !err, at: at || null, error: err || null, pending: h.one('SELECT COUNT(*) AS c FROM dirty').c, running: this.running, checked: Number(h.getMeta('pull_at')) || null, came: Number(h.getMeta('pull_got')) || null, checkError: h.getMeta('pull_err') || null };
  }
  tell() {
    this.hub.bcAll({ t: 'sync', sync: this.status() });
  }

  schedule(ms) {
    if (!this.gh.configured) return;
    if (this.armed && ms === undefined) return;
    this.armed = true;
    this.hub.ctx.storage.setAlarm(Date.now() + (ms ?? this.delay)).catch(() => (this.armed = false));
  }

  // ------------------------------------------------------------------ turning rows into files
  filesFor(key) {
    const h = this.hub;
    const P = (...a) => [this.dir, ...a].join('/');
    const out = {};
    const [kind, a, b] = key.split(':');
    if (kind === 'meta') {
      out[P('meta.json')] = enc({ categories: h.q('SELECT id, name, pos, created, core FROM categories ORDER BY pos, created'), sections: h.q('SELECT id, name, kind, pos, created, category, parent, branch, file FROM sections ORDER BY pos, created'), users: h.q("SELECT email, name, color, created, COALESCE(avatar, '') AS avatar FROM users ORDER BY created") });
    } else if (kind === 'board') {
      const sec = h.one('SELECT * FROM sections WHERE id=?', a);
      if (!sec || (sec.kind !== 'board' && sec.kind !== 'note')) {
        out[P('sections', a, 'board.json')] = null;
        out[P('sections', a, 'board.md')] = null;
      } else {
        const items = h.q('SELECT * FROM items WHERE section=? ORDER BY z, id', a).map((r) => ({ ...r, data: JSON.parse(r.data || '{}') }));
        out[P('sections', a, 'board.json')] = enc(items);
        out[P('sections', a, 'board.md')] = this.boardMd(sec, items);
      }
    } else if (kind === 'calendar') {
      out[P('calendar.json')] = enc(h.q('SELECT id, date, title, ref, author, ts FROM calendar ORDER BY date, ts, id').map((r) => ({ ...r, ref: JSON.parse(r.ref || 'null') })));
    } else if (kind === 'chat') {
      const from = Date.parse(b + 'T00:00:00Z');
      const rows = h.q('SELECT id, author, name, ts, body, refs, deleted FROM messages WHERE section=? AND ts>=? AND ts<? ORDER BY id', a, from, from + 86400000);
      out[P('chat', a, b + '.jsonl')] = rows.length ? jl(rows.map((r) => ({ ...r, refs: JSON.parse(r.refs || '[]'), deleted: !!r.deleted }))) : null;
    } else if (kind === 'bug') {
      const r = h.one('SELECT * FROM bugs WHERE id=?', a);
      if (r) out[P('reports', r.section || 'bugs', a + '.json')] = enc({ ...r, images: JSON.parse(r.images || '[]') });
    } else if (kind === 'bug-del') {
      for (const m of h.q('SELECT path FROM mirror WHERE path LIKE ?', P('reports') + '/%/' + a + '.json')) out[m.path] = null;
    } else if (kind === 'bugs-index') {
      for (const s of h.q("SELECT id FROM sections WHERE kind IN ('bugs', 'todo', 'mail')")) out[P('reports', s.id, 'INDEX.md')] = this.bugsMd(s.id);
    } else if (kind === 'image') {
      const r = h.one('SELECT ext, size FROM images WHERE id=?', a);
      if (r) {
        const bytes = new Uint8Array(r.size);
        let at = 0;
        for (const c of h.q('SELECT data FROM image_chunks WHERE id=? ORDER BY seq', a)) {
          bytes.set(new Uint8Array(c.data), at);
          at += c.data.byteLength;
        }
        out[P('images', `${a}.${r.ext}`)] = bytes;
      }
    } else if (kind === 'images-index') {
      out[P('images', 'index.json')] = enc(h.q('SELECT id, name, mime, ext, size, w, h, ts, by FROM images ORDER BY ts, id'));
    } else if (kind === 'section-del') {
      for (const m of h.q('SELECT path FROM mirror WHERE path LIKE ? OR path LIKE ?', P('sections', a) + '/%', P('chat', a) + '/%')) out[m.path] = null;
      for (const m of h.q('SELECT path FROM mirror WHERE path LIKE ?', P('reports', a) + '/%')) out[m.path] = null;
    }
    return out;
  }
  boardMd(sec, items) {
    const ext = new Map(this.hub.q('SELECT id, ext FROM images').map((r) => [r.id, r.ext]));
    const parts = [`# ${sec.name}\n`];
    for (const it of [...items].sort((p, q) => p.y - q.y || p.x - q.x)) {
      const d = it.data;
      if (it.type === 'image') parts.push(d.img && ext.has(d.img) ? `![${String(d.caption || d.name || 'image').replace(/[\[\]]/g, '')}](../../images/${d.img}.${ext.get(d.img)})` : '_(image)_');
      else if (it.type === 'note') parts.push(String(d.text || '').split('\n').map((l) => `> ${l}`).join('\n'));
      else if (it.type === 'doc') parts.push(`_(${d.kind === 'pdf' ? 'PDF' : 'note'}: ${String(d.name || d.section).replace(/[\[\]]/g, '')})_`);
      else if (it.type === 'group' || it.type === 'draw') continue;
      else parts.push(String(d.text || ''));
    }
    return parts.join('\n\n') + '\n';
  }
  bugsMd(section) {
    const name = this.hub.one('SELECT name FROM sections WHERE id=?', section)?.name || 'Reports';
    const rows = this.hub.q("SELECT * FROM bugs WHERE COALESCE(section, 'bugs')=?", section);
    const f = (s, asc) => rows.filter((r) => r.status === s).sort((p, q) => (asc ? p.ts - q.ts : q.ts - p.ts));
    const line = (r) => `- ${new Date(r.ts).toISOString().replace('T', ' ').slice(0, 16)} · **${r.name}** · ${r.branch ? '`' + r.branch + '` · ' : ''}${r.browser || 'unknown browser'} · \`${r.id}\` · ${String(r.message).replace(/\s+/g, ' ').slice(0, 100)}`;
    const sec = (t, list) => `## ${t} (${list.length})\n\n${list.map(line).join('\n') || '_none_'}\n`;
    return `# ${name}\n\n${sec('Open (oldest first)', f('open', true))}\n${sec('Closed (newest first)', f('closed', false))}\n${sec('Trash (newest first)', f('trash', false))}`;
  }
  allKeys() {
    const h = this.hub;
    return [
      'meta', 'bugs-index', 'images-index', 'calendar',
      ...h.q("SELECT id FROM sections WHERE kind IN ('board', 'note')").map((r) => 'board:' + r.id),
      ...h.q('SELECT DISTINCT section, ts FROM messages').map((r) => `chat:${r.section}:${day(r.ts)}`),
      ...h.q('SELECT id FROM bugs').map((r) => 'bug:' + r.id),
      ...h.q('SELECT id FROM images').map((r) => 'image:' + r.id),
    ].filter((k, i, all) => all.indexOf(k) === i);
  }

  // ------------------------------------------------------------------ one run: dirty notes → one commit
  async run(full = false) {
    const h = this.hub;
    this.armed = false;
    if (!this.gh.configured) return;
    if (this.running) return this.schedule(5000); // (a check for teammates' changes is under way: right after it)
    this.running = true;
    try {
      if (full || !h.getMeta('mirror_first')) {
        for (const k of this.allKeys()) h.run('INSERT INTO dirty (key, seq) VALUES (?, 0) ON CONFLICT(key) DO NOTHING', k);
        full = true;
      }
      for (let attempt = 0; ; attempt++) {
      // what teammates backed up first, merged in here: the commit then goes on top of it and overwrites nothing
      await this.pull();
      const todo = h.q('SELECT key, seq FROM dirty ORDER BY seq, key');
      const known = new Map(h.q('SELECT path, hash FROM mirror').map((r) => [r.path, r.hash]));
      const files = {};
      const hashes = {};
      const taken = [];
      let images = 0;
      for (const { key, seq } of todo) {
        const got = this.filesFor(key);
        const n = Object.values(got).filter((v) => v instanceof Uint8Array).length;
        if (taken.length && images + n > MAX_IMAGES_PER_RUN) break;
        images += n;
        taken.push({ key, seq });
        for (const [path, content] of Object.entries(got)) {
          if (content === null) {
            if (known.has(path)) {
              files[path] = null;
              hashes[path] = null;
            }
          } else {
            const hash = await sha256hex(content);
            if (known.get(path) !== hash) {
              files[path] = content;
              hashes[path] = hash;
            }
          }
        }
      }
      if (full && taken.length === todo.length) {
        // a full sync also removes what is on GitHub but no longer exists here
        const wanted = new Set();
        for (const k of this.allKeys()) for (const p of Object.keys(this.filesFor(k))) wanted.add(p);
        for (const p of known.keys()) {
          if (!wanted.has(p) && !(p in files)) {
            files[p] = null;
            hashes[p] = null;
          }
        }
      }
      const count = Object.keys(files).length;
      if (count) {
        let sha;
        try {
          sha = await this.gh.commit(files, `Viti backup: ${count} file${count === 1 ? '' : 's'} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, h.getMeta('remote_head') || null);
        } catch (e) {
          if (e.code === 'behind' && attempt < 4) continue; // (someone was quicker: theirs first, then again)
          throw e;
        }
        // what is on GitHub now: this commit, on top of the last one seen
        const shas = {};
        for (const [p, c] of Object.entries(files)) if (c !== null) shas[p] = await gitsha(c);
        h.ctx.storage.transactionSync(() => {
          for (const [p, hash] of Object.entries(hashes)) {
            if (hash === null) h.run('DELETE FROM mirror WHERE path=?', p);
            else h.run('INSERT INTO mirror (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash', p, hash);
          }
          for (const [p, c] of Object.entries(files)) {
            if (c === null) h.run('DELETE FROM remote WHERE path=?', p);
            else h.run('INSERT INTO remote (path, sha, body) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha=excluded.sha, body=excluded.body', p, shas[p], KEEP.test(p) ? bytesOf(c) : null);
          }
          h.setMeta('remote_head', sha);
        });
      }
      for (const t of taken) h.run('DELETE FROM dirty WHERE key=? AND seq=?', t.key, t.seq); // changed again meanwhile? it stays
      if (taken.length === todo.length) h.setMeta('mirror_first', 1);
      h.setMeta('mirror_at', Date.now());
      h.setMeta('mirror_err', '');
      if (h.one('SELECT COUNT(*) AS c FROM dirty').c) this.schedule(2000);
      break;
      }
    } catch (e) {
      console.error('mirror failed', e?.message);
      h.setMeta('mirror_err', String(e?.message || e).slice(0, 300));
      this.schedule(RETRY_MS);
    } finally {
      this.running = false;
      this.tell();
    }
  }
  // ------------------------------------------------------------------ teammates: their backups, merged in here
  // Looked for every POLL_MS while the project is open (one small call when nothing changed), and before each backup.
  startPolling(ms = POLL_MS) {
    this.stopPolling();
    if (!this.gh.configured) return;
    this.timer = setInterval(() => this.poll(), ms);
    this.timer.unref?.();
    setTimeout(() => this.poll(), 1500).unref?.();
  }
  stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }
  async poll() {
    if (!this.gh.configured || this.running) return;
    this.running = true;
    const was = this.hub.getMeta('pull_err') || '';
    try {
      await this.pull();
      this.hub.setMeta('pull_err', '');
    } catch (e) {
      this.hub.setMeta('pull_err', String(e?.message || e).slice(0, 300));
    } finally {
      this.running = false;
    }
    // (the status bar hears of it when something changed, and keeps "checked" fresh itself)
    if (was !== (this.hub.getMeta('pull_err') || '')) this.tell();
  }

  // What changed on GitHub since the last sync, merged into this copy. -> how many files came in.
  async pull() {
    const h = this.hub;
    const head = await this.gh.head();
    h.setMeta('pull_at', Date.now());
    const known = h.getMeta('remote_head') || '';
    if (!head || head === known) return 0;
    const pre = this.dir + '/';
    const now = new Map((await this.gh.tree(head)).filter((e) => e.path.startsWith(pre)).map((e) => [e.path, e.sha]));
    const was = new Map(h.q('SELECT path, sha FROM remote').map((r) => [r.path, r.sha]));
    const changed = [...new Set([...now.keys(), ...was.keys()])].filter((p) => now.get(p) !== was.get(p));
    const isChanged = new Set(changed);
    // theirs (the changed files), and what they were at the last sync
    const theirs = new Map();
    await pool(changed.filter((p) => now.has(p) && READ.test(p)), 8, async (p) => theirs.set(p, await this.gh.blob(now.get(p))));
    const base = new Map(h.q('SELECT path, body FROM remote WHERE body IS NOT NULL').filter((r) => isChanged.has(r.path)).map((r) => [r.path, new Uint8Array(r.body)]));
    // pictures new to this copy
    const pics = new Map();
    const idx = J(theirs.get(pre + 'images/index.json'));
    if (idx) {
      const have = new Set(h.q('SELECT id FROM images').map((r) => r.id));
      const need = idx.filter((im) => !have.has(im.id) && now.has(`${pre}images/${im.id}.${im.ext}`));
      await pool(need, 4, async (im) => pics.set(im.id, await this.gh.blob(now.get(`${pre}images/${im.id}.${im.ext}`))));
    }
    const hashOf = new Map();
    for (const [p, b] of theirs) hashOf.set(p, await sha256hex(b));
    for (const [id, b] of pics) {
      const im = idx.find((x) => x.id === id);
      hashOf.set(`${pre}images/${id}.${im.ext}`, await sha256hex(b));
    }

    // then all at once (nothing here can change in between): merged, and what differs from theirs is marked to go back up
    const push = new Set();
    let sectionsChanged = false;
    const ours = (key, p, parse = JSON.parse) => {
      const v = this.filesFor(key)[p];
      return v == null ? null : parse(typeof v === 'string' ? v : dec.decode(v));
    };
    const ourLines = (s) => s.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    h.ctx.storage.transactionSync(() => {
      // sections, categories and people first: the rest belongs to them
      const mp = pre + 'meta.json';
      if (theirs.has(mp)) {
        const b = J(base.get(mp));
        const t = J(theirs.get(mp));
        const o = ours('meta', mp);
        const m = { categories: merge3(b?.categories, t.categories, o.categories, 'id'), sections: merge3(b?.sections, t.sections, o.sections, 'id'), users: merge3(b?.users, t.users, o.users, 'email') };
        sectionsChanged = !sameList(m.sections, o.sections, 'id') || !sameList(m.categories, o.categories, 'id') || !sameList(m.users, o.users, 'email');
        this.applyMeta(m);
        if (!sameList(m.sections, t.sections, 'id') || !sameList(m.categories, t.categories, 'id') || !sameList(m.users, t.users, 'email')) push.add('meta');
      }
      const cp = pre + 'calendar.json';
      if (theirs.has(cp)) {
        const t = J(theirs.get(cp));
        const m = merge3(J(base.get(cp)), t, ours('calendar', cp), 'id');
        h.run('DELETE FROM calendar');
        for (const r of m) h.run('INSERT INTO calendar (id, date, title, ref, author, ts) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.date, r.title || '', JSON.stringify(r.ref ?? null), r.author, r.ts);
        if (!sameList(m, t, 'id')) push.add('calendar');
      }
      const bugs = new Map();
      for (const p of changed) {
        const rel = p.slice(pre.length);
        let x;
        if ((x = rel.match(/^sections\/([a-z0-9-]+)\/board\.json$/)) && theirs.has(p)) {
          if (!h.one('SELECT id FROM sections WHERE id=?', x[1])) continue;
          const t = J(theirs.get(p));
          const m = merge3(J(base.get(p)), t, ours('board:' + x[1], p), 'id');
          h.run('DELETE FROM items WHERE section=?', x[1]);
          for (const it of m) h.run('INSERT OR REPLACE INTO items (id, section, type, x, y, w, h, z, data, rev, author, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', it.id, x[1], it.type, it.x, it.y, it.w, it.h, it.z, JSON.stringify(it.data), it.rev || 1, it.author, it.created, it.updated);
          if (!sameList(m, t, 'id')) push.add('board:' + x[1]);
        } else if ((x = rel.match(/^chat\/([a-z0-9-]+)\/([\d-]+)\.jsonl$/)) && theirs.has(p)) {
          if (!h.one('SELECT id FROM sections WHERE id=?', x[1])) continue;
          const t = L(theirs.get(p));
          const m = merge3(L(base.get(p)), t, ours(`chat:${x[1]}:${x[2]}`, p, ourLines), 'id');
          const from = Date.parse(x[2] + 'T00:00:00Z');
          h.run('DELETE FROM messages WHERE section=? AND ts>=? AND ts<?', x[1], from, from + 86400000);
          for (const r of m) h.run('INSERT OR REPLACE INTO messages (id, section, author, name, ts, body, refs, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.id, x[1], r.author, r.name, r.ts, r.body, JSON.stringify(r.refs || []), r.deleted ? 1 : 0);
          if (!sameList(m, t, 'id')) push.add(`chat:${x[1]}:${x[2]}`);
        } else if ((x = rel.match(/^reports\/[a-z0-9-]+\/([a-z0-9]+)\.json$/))) {
          // (by the report, wherever it is filed: moving one to another list moves its file)
          const e = bugs.get(x[1]) || {};
          if (base.has(p)) e.b = J(base.get(p));
          if (theirs.has(p)) e.t = J(theirs.get(p));
          bugs.set(x[1], e);
        }
      }
      for (const [id, { b, t }] of bugs) {
        const o = h.one('SELECT id FROM bugs WHERE id=?', id) ? Object.values(this.filesFor('bug:' + id)).map((v) => JSON.parse(v))[0] : null;
        const [r] = merge3(b ? [b] : null, t ? [t] : [], o ? [o] : [], 'id');
        if (r) this.applyBug(r);
        else h.run('DELETE FROM bugs WHERE id=?', id);
        if (!(r && t ? same(r, t) : !r && !t)) push.add(r ? 'bug:' + id : 'bug-del:' + id);
        push.add('bugs-index');
      }
      const ip = pre + 'images/index.json';
      if (theirs.has(ip)) {
        const t = J(theirs.get(ip));
        const m = merge3(J(base.get(ip)), t, ours('images-index', ip), 'id');
        const keep = new Set(m.map((r) => r.id));
        for (const { id } of h.q('SELECT id FROM images')) if (!keep.has(id)) (h.run('DELETE FROM image_chunks WHERE id=?', id), h.run('DELETE FROM images WHERE id=?', id));
        for (const im of m) {
          const bytes = pics.get(im.id);
          if (!bytes || h.one('SELECT id FROM images WHERE id=?', im.id)) continue;
          h.run('INSERT INTO images (id, name, mime, ext, size, w, h, ts, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', im.id, im.name, im.mime, im.ext, bytes.length, im.w, im.h, im.ts, im.by);
          for (let i = 0, n = 0; i < bytes.length; i += 1000000, n++) h.run('INSERT INTO image_chunks (id, seq, data) VALUES (?, ?, ?)', im.id, n, bytes.slice(i, i + 1000000));
        }
        if (!sameList(h.q('SELECT id FROM images').map((r) => ({ id: r.id })), t.map((r) => ({ id: r.id })), 'id')) push.add('images-index');
      }
      // where GitHub is now (what the next backup compares against)
      for (const p of changed) {
        if (!now.has(p)) {
          h.run('DELETE FROM remote WHERE path=?', p);
          h.run('DELETE FROM mirror WHERE path=?', p);
          continue;
        }
        h.run('INSERT INTO remote (path, sha, body) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha=excluded.sha, body=excluded.body', p, now.get(p), KEEP.test(p) && theirs.has(p) ? theirs.get(p) : null);
        h.run('INSERT INTO mirror (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash', p, hashOf.get(p) || 'remote');
      }
      h.setMeta('remote_head', head);
      const n = [...theirs.keys()].filter((p) => KEEP.test(p) && !p.endsWith('index.json')).length;
      if (n && known) h.setMeta('pull_got', Date.now());
    });
    if (push.size) h.markDirty(...push);
    // the open pages: what changed, without reloading
    if (known && changed.length) {
      if (sectionsChanged) h.bcSections();
      h.bcAll({ t: 'remote', sync: this.status() });
    }
    return changed.length;
  }
  // a merged meta.json into the tables (a section gone takes what was in it)
  applyMeta(m) {
    const h = this.hub;
    h.run('DELETE FROM categories');
    for (const c of m.categories) h.run('INSERT INTO categories (id, name, pos, created, core) VALUES (?, ?, ?, ?, ?)', c.id, c.name, c.pos, c.created, c.core ? 1 : 0);
    const keep = new Set(m.sections.map((s) => s.id));
    for (const { id } of h.q('SELECT id FROM sections')) {
      if (keep.has(id)) continue;
      for (const t of ['items', 'bugs', 'messages', 'reads']) h.run(`DELETE FROM ${t} WHERE section=?`, id);
      h.run('DELETE FROM sections WHERE id=?', id);
    }
    for (const s of m.sections) h.run('INSERT INTO sections (id, name, kind, pos, created, category, parent, branch, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, pos=excluded.pos, created=excluded.created, category=excluded.category, parent=excluded.parent, branch=excluded.branch, file=excluded.file', s.id, s.name, s.kind, s.pos, s.created, s.category || '', s.parent || '', s.branch || '', s.file || '');
    for (const u of m.users) h.run('INSERT INTO users (email, name, color, created, seen, avatar) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, color=excluded.color, avatar=excluded.avatar', u.email, u.name, u.color, u.created, u.created, u.avatar || '');
    h.markCore();
  }
  applyBug(r) {
    this.hub.run('INSERT OR REPLACE INTO bugs (id, name, email, ts, browser, ua, page, message, status, moved, moved_by, images, source, section, subject, seen, branch, priority, due, html, files, rcpt, thread) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.name, r.email, r.ts, r.browser, r.ua, r.page, r.message, r.status, r.moved, r.moved_by, JSON.stringify(r.images || []), r.source, r.section || 'bugs', r.subject || '', r.seen ? 1 : 0, r.branch || '', r.priority || '', r.due || '', r.html || '', r.files || '', r.rcpt || '', r.thread || '');
  }

  async syncNow(full) {
    if (!this.gh.configured) return this.status();
    // keep going until nothing is waiting (a run takes at most a few dozen images)
    for (let i = 0; i < 20; i++) {
      await this.run(!!full && i === 0);
      if (this.hub.getMeta('mirror_err') || !this.hub.one('SELECT COUNT(*) AS c FROM dirty').c) break;
    }
    return this.status();
  }

  // ------------------------------------------------------------------ restore: GitHub → a fresh database
  async restore() {
    if (!this.gh.configured) throw new Error('The GitHub mirror is not set up.');
    const files = await this.gh.files(this.dir);
    if (!files || !files['meta.json']) throw new Error('There is no backup on GitHub to restore from.');
    const dec = new TextDecoder();
    const J = (p) => JSON.parse(dec.decode(files[p]));
    const meta = J('meta.json');
    const h = this.hub;
    const counts = { sections: 0, items: 0, messages: 0, bugs: 0, images: 0 };
    const index = files['images/index.json'] ? J('images/index.json') : [];
    h.ctx.storage.transactionSync(() => {
      for (const t of ['image_chunks', 'images', 'bugs', 'messages', 'items', 'sections', 'users', 'reads', 'dirty', 'mirror', 'remote', 'categories', 'calendar']) h.run(`DELETE FROM ${t}`);
      h.setMeta('remote_head', '');
      for (const c of meta.categories || []) h.run('INSERT INTO categories (id, name, pos, created, core) VALUES (?, ?, ?, ?, ?)', c.id, c.name, c.pos, c.created, c.core ? 1 : 0);
      for (const s of meta.sections) {
        h.run('INSERT INTO sections (id, name, kind, pos, created, category, parent, branch, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', s.id, s.name, s.kind, s.pos, s.created, s.category || '', s.parent || '', s.branch || '', s.file || '');
        counts.sections++;
      }
      for (const u of meta.users || []) h.run('INSERT INTO users (email, name, color, created, seen, avatar) VALUES (?, ?, ?, ?, ?, ?)', u.email, u.name, u.color, u.created, u.created, u.avatar || '');
      for (const [p, bytes] of Object.entries(files)) {
        if (/^sections\/[a-z0-9-]+\/board\.json$/.test(p)) {
          for (const it of JSON.parse(dec.decode(bytes))) {
            h.run('INSERT INTO items (id, section, type, x, y, w, h, z, data, rev, author, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', it.id, it.section, it.type, it.x, it.y, it.w, it.h, it.z, JSON.stringify(it.data), it.rev || 1, it.author, it.created, it.updated);
            counts.items++;
          }
        } else if (/^chat\/[a-z0-9-]+\/[\d-]+\.jsonl$/.test(p)) {
          const section = p.split('/')[1];
          for (const line of dec.decode(bytes).split('\n')) {
            if (!line.trim()) continue;
            const r = JSON.parse(line);
            h.run('INSERT INTO messages (id, section, author, name, ts, body, refs, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.id, section, r.author, r.name, r.ts, r.body, JSON.stringify(r.refs || []), r.deleted ? 1 : 0);
            counts.messages++;
          }
        } else if (p === 'calendar.json') {
          for (const r of JSON.parse(dec.decode(bytes))) h.run('INSERT INTO calendar (id, date, title, ref, author, ts) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.date, r.title || '', JSON.stringify(r.ref || null), r.author, r.ts);
        } else if (/^reports\/[a-z0-9-]+\/[a-z0-9]+\.json$/.test(p) || /^bugs\/[a-z0-9]+\.json$/.test(p)) {
          const r = JSON.parse(dec.decode(bytes));
          h.run('INSERT INTO bugs (id, name, email, ts, browser, ua, page, message, status, moved, moved_by, images, source, section, subject, seen, branch, priority, due, html, files, rcpt, thread) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.name, r.email, r.ts, r.browser, r.ua, r.page, r.message, r.status, r.moved, r.moved_by, JSON.stringify(r.images || []), r.source, r.section || 'bugs', r.subject || '', r.seen ? 1 : 0, r.branch || '', r.priority || '', r.due || '', r.html || '', r.files || '', r.rcpt || '', r.thread || '');
          counts.bugs++;
        }
      }
      for (const im of index) {
        const bytes = files[`images/${im.id}.${im.ext}`];
        if (!bytes) continue;
        h.run('INSERT INTO images (id, name, mime, ext, size, w, h, ts, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', im.id, im.name, im.mime, im.ext, bytes.length, im.w, im.h, im.ts, im.by);
        for (let i = 0, n = 0; i < bytes.length; i += 1000000, n++) h.run('INSERT INTO image_chunks (id, seq, data) VALUES (?, ?, ?)', im.id, n, bytes.slice(i, i + 1000000).buffer);
        counts.images++;
      }
      // people back from a restore have not "missed" anything
      for (const u of meta.users || []) for (const s of meta.sections) h.run('INSERT OR IGNORE INTO reads (email, section, last_id) VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE section=?))', u.email, s.id, s.id);
      // all of it is on GitHub already; the "restored" hashes are replaced by real ones in the next full run
      for (const p of Object.keys(files)) h.run('INSERT INTO mirror (path, hash) VALUES (?, ?)', `${this.dir}/${p}`, 'restored');
      h.run('UPDATE users SET named=1');
      h.setMeta('seeded', Date.now());
      h.ensureMail();
      h.markCore();
    });
    h.setMeta('mirror_first', '');
    h.setMeta('mirror_err', '');
    this.schedule(2000);
    return counts;
  }
}
