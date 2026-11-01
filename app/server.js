// The app's local server (127.0.0.1 only): the home screen and its API (/home, /app/*), the pages of the
// open project (public/) and its API and live connection (/api/*), handed to server/host.js.
//
// Every request to /app and /api must carry the cookie the app's own window was given at start (a
// random key per run), so nothing else on the computer (another program, or a web page in a browser)
// can use it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openProject } from '../server/host.js';
import { GITHUB_CLIENT_ID, SCOPE } from './github-app.js';
import * as mail from './mail.js';
import { zip } from './zip.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webp': 'image/webp' };
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const DATA_BRANCH = 'viti-data';
// GitHub's addresses (another one only for testing)
const GH_API = process.env.VITI_GITHUB_API || 'https://api.github.com';
const GH_WEB = process.env.VITI_GITHUB_WEB || 'https://github.com';

// root: the app folder; dataDir: where projects and settings live; seal/unseal: keep tokens encrypted
export async function startServer({ root, dataDir, seal, unseal, port = 0, key: givenKey, version = '', logFile = '', openPath = null, notify = null, desktop = null }) {
  const PUBLIC = path.join(root, 'public');
  const UI = path.join(root, 'app', 'ui');
  const key = givenKey || crypto.randomBytes(24).toString('hex');
  const cfgFile = path.join(dataDir, 'viti.json');
  const tokFile = path.join(dataDir, 'tokens.json');
  // (where the projects are kept is read from the settings below: projectsRoot())

  const load = (f, d) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return d;
    }
  };
  const save = (f, v) => {
    fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2));
    fs.renameSync(f + '.tmp', f);
  };
  const cfg = load(cfgFile, {});
  // the projects' own copies: in the app's data folder, or in a folder you chose (Settings › Where your projects are)
  const projectsRoot = () => cfg.projectsDir || path.join(dataDir, 'projects');
  const projDir = (id) => path.join(projectsRoot(), id);
  cfg.prefs = { theme: 'system', accent: '#6d5efc', ...(cfg.prefs || {}) };
  cfg.projects ||= [];
  const tokens = load(tokFile, {});
  const saveCfg = () => save(cfgFile, cfg);
  // a project's own token (pasted in by hand), or else the one from signing in with GitHub
  const ACCOUNT = '@account';
  const tokenOf = (id) => (tokens[id] ? unseal(tokens[id]) : tokens[ACCOUNT] ? unseal(tokens[ACCOUNT]) : '');
  const hasToken = (id) => !!(tokens[id] || tokens[ACCOUNT]);

  let current = null; // { id, host }
  // the projects most recently opened (for the jump list and the tray), and telling the window of a change
  const recent = () => [...cfg.projects].sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, 8).map((p) => ({ id: p.id, repo: p.repo }));
  const changed = () => desktop?.changed?.({ recent: recent(), prefs: { ...cfg.prefs } });

  // ---- mail: the email accounts you connected (yours, on this computer: they are never in a repository), and
  // which folder each mailbox of a project reads. Credentials are kept encrypted, like the GitHub sign-in.
  cfg.mail ||= { accounts: [], links: {} };
  const credOf = (accId) => {
    try {
      return tokens['mail:' + accId] ? JSON.parse(unseal(tokens['mail:' + accId])) : null;
    } catch {
      return null;
    }
  };
  const keepCred = (accId) => (cred) => {
    tokens['mail:' + accId] = seal(JSON.stringify(cred));
    save(tokFile, tokens);
  };
  let fetching = false;
  // read the new mail of every linked mailbox in the open project (or of one) -> { [section]: { added, error } }
  async function fetchMail(only) {
    if (!current || fetching) return {};
    fetching = true;
    const proj = cfg.projects.find((x) => x.id === current.id);
    const links = cfg.mail.links[current.id] || {};
    const out = {};
    try {
      for (const [section, link] of Object.entries(links)) {
        if (only && section !== only) continue;
        const acc = cfg.mail.accounts.find((a) => a.id === link.account);
        const cred = acc && credOf(acc.id);
        if (!acc || !cred) {
          out[section] = { added: 0, error: 'The email account of this mailbox is not connected any more.' };
          continue;
        }
        if (!proj?.private) {
          out[section] = { added: 0, error: 'This repository is public: Viti does not put email in it.' };
          continue;
        }
        try {
          const hub = current?.host.hub;
          // (emails you sent yourself, before Viti put them in Sent: they go there now)
          hub?.ownToSent(section, acc.address);
          const r = await mail.fetchNew(cred, link.folder, link.state);
          let added = 0;
          let last = null;
          // what you sent yourself (Gmail labels your replies with the conversation's label) goes to Sent
          for (const m of r.messages) {
            if (m.own) await hub?.importSent(section, { ...m, from: acc.address });
            else if (await hub?.importMail(section, m)) (added++, (last = m));
          }
          Object.assign(link, { state: r.state, fetched: Date.now(), error: '' });
          out[section] = { added };
          // new mail: a notification from Windows (when Viti is not the window in front); not for the first fetch
          // of a newly linked label, which brings in what was already there
          if (added && link.notified !== undefined && notify) {
            const box = hub?.section(section)?.name || 'a mailbox';
            notify(added === 1 ? `${last.name || last.email}: ${last.subject || 'New email'}` : `${added} new emails`, `In ${box} · ${proj.repo.split('/')[1]}`);
          }
          link.notified = true;
        } catch (e) {
          link.error = e.message;
          out[section] = { added: 0, error: e.message };
        }
      }
      saveCfg();
    } finally {
      fetching = false;
    }
    return out;
  }
  // every two minutes while a project is open
  const mailTimer = setInterval(() => fetchMail().catch((e) => console.error('mail:', e.message)), 2 * 60 * 1000);
  mailTimer.unref?.();

  // ---- GitHub: is this a repository the token can write to, and who is the token's owner
  async function gh(token, p) {
    const r = await fetch(GH_API + p, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'viti-desktop' } });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  }
  const cleanRepo = (s) =>
    String(s || '')
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .split('/')
      .slice(0, 2)
      .join('/');
  async function check(repoIn, token) {
    const repo = cleanRepo(repoIn);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: 'Write the repository as owner/name, or paste its GitHub address.' };
    if (!token) return { error: 'Sign in with GitHub first (or paste a token).' };
    const me = await gh(token, '/user');
    if (me.status === 401) return { error: 'GitHub did not accept the sign-in. Sign in again (or check that a pasted token is whole and has not expired).' };
    const r = await gh(token, `/repos/${repo}`);
    if (r.status === 404) return { error: `GitHub does not show ${repo} to you. Check the name, and that you (or the token) may see this repository.` };
    if (r.status >= 400) return { error: `GitHub answered ${r.status}: ${r.body.message || 'something went wrong'}.` };
    if (!r.body.permissions?.push) return { error: 'You can read this repository but not write to it, and Viti needs to write its backup branch.' };
    const u = me.body;
    return {
      repo: r.body.full_name,
      private: !!r.body.private,
      user: { login: u.login, name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com`, avatar: u.avatar_url },
    };
  }

  // ---- where a repository's Viti backup is: its usual place (branch viti-data, folder viti), or where an older
  // Viti kept it (branch hub-data, folder hub). A viti.json beside it can say where the branch tags come from
  // (another repository). None yet: the usual place, and the repository's own branches.
  const PLACES = [[DATA_BRANCH, 'viti'], ['hub-data', 'hub']];
  // (both there: the one with more in it; an empty one can be left by Viti 0.1.0, which only knew its own place)
  async function findBackup(repo, token) {
    let best = null;
    for (const [branch, dir] of PLACES) {
      const meta = await gh(token, `/repos/${repo}/contents/${dir}/meta.json?ref=${branch}`);
      if (meta.status !== 200) continue;
      const tree = await gh(token, `/repos/${repo}/git/trees/${branch}?recursive=1`);
      const files = Array.isArray(tree.body.tree) ? tree.body.tree.filter((t) => t.type === 'blob' && t.path.startsWith(dir + '/')).length : 0;
      if (best && best.files >= files) continue;
      best = { branch, dir, files };
    }
    if (best) {
      const { branch, dir } = best;
      let branchesFrom = '';
      const desc = await gh(token, `/repos/${repo}/contents/${dir}/viti.json?ref=${branch}`);
      if (desc.status === 200 && desc.body.content) {
        try {
          const d = JSON.parse(Buffer.from(desc.body.content, 'base64').toString('utf8'));
          if (/^[\w.-]+\/[\w.-]+$/.test(d.branchesFrom || '')) branchesFrom = d.branchesFrom;
        } catch {}
      }
      return { branch, dir, branchesFrom, found: true };
    }
    return { branch: DATA_BRANCH, dir: 'viti', branchesFrom: '', found: false };
  }

  // ---- open and close a project
  async function open(id) {
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) throw new Error('That project is gone.');
    if (current?.id === id) return current;
    await close();
    const dir = projDir(id);
    const token = tokenOf(id);
    // a project connected by Viti 0.1.0 (which only looked for its own backup place): look again. If the
    // backup is elsewhere (the older layout, say), the copy here was started empty: it is set aside
    // (kept, renamed) and the project is fetched from the real backup.
    if (!p.dir && token) {
      try {
        const place = await findBackup(p.repo, token);
        if (place.found && (place.branch !== (p.branch || DATA_BRANCH) || place.dir !== 'viti') && fs.existsSync(dir)) fs.renameSync(dir, `${dir}.set-aside-${Date.now()}`);
        Object.assign(p, { branch: place.branch, dir: place.dir, branchesFrom: place.branchesFrom });
        saveCfg();
      } catch (e) {
        console.error('finding the backup:', e.message);
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, 'viti.sqlite');
    const fresh = !fs.existsSync(dbFile);
    const env = { GITHUB_API: GH_API, BRANCHES_API: GH_API, GITHUB_REPO: p.repo, GITHUB_TOKEN: token, GITHUB_BRANCH: p.branch || DATA_BRANCH, GITHUB_DIR: p.dir || 'viti', BRANCHES_REPO: p.branchesFrom || p.repo, BRANCHES_TOKEN: token, MIRROR_DELAY_MS: '15000' };
    // (who you are in this project: your GitHub sign-in, unless the backup already knows you by another address)
    const who = { ...(p.user || {}), ...(p.as ? { email: p.as } : {}) };
    const host = await openProject({ dbFile, env, user: who });
    // a new copy of a project others already use: start from what is on GitHub
    if (fresh && token) {
      try {
        await host.hub.mirror.restore();
        p.restored = Date.now();
        // a backup from an older Viti (the web version as deployed, say): bring it up to date, as the app
        // does with its own database when it starts (the Calendar, the PROJECT category...)
        host.hub.run("DELETE FROM meta WHERE k LIKE 'layout%'");
        host.hub.init();
        // someone in the backup with your name is you (the web version knew people by another address)
        // (by the whole name or the login; else by the first name, if only one person there has it)
        const people = host.hub.q('SELECT email, name FROM users');
        const low = (n) => String(n || '').trim().toLowerCase();
        const names = [p.user?.name, p.user?.login].filter(Boolean).map(low);
        let same = people.filter((u) => names.includes(low(u.name)));
        const first = low(p.user?.name).split(/\s+/)[0];
        if (!same.length && first) same = people.filter((u) => low(u.name).split(/\s+/)[0] === first);
        if (same.length === 1) p.as = who.email = same[0].email;
      } catch (e) {
        if (!/no backup/i.test(e.message)) console.error('restore:', e.message);
      }
    }
    await host.profile(p.user || {});
    // teammates' changes: looked for while the project is open
    host.hub.mirror.startPolling();
    p.opened = Date.now();
    saveCfg();
    current = { id, host };
    changed();
    return current;
  }
  async function close() {
    if (!current) return;
    const c = current;
    current = null;
    await c.host.close();
  }

  // ---- the home screen's API
  // ---- what is going on in a project, for its card on the home screen: open to-dos and reports, new mail, and
  // the last backup. Read straight from its database (read only), and kept until the database changes.
  const statsCache = new Map();
  function stats(p) {
    const file = path.join(projDir(p.id), 'viti.sqlite');
    let stamp = 0;
    try {
      stamp = fs.statSync(file).mtimeMs + (fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').mtimeMs : 0);
    } catch {
      return null; // (never opened on this computer)
    }
    const had = statsCache.get(p.id);
    if (had && had.stamp === stamp) return had.v;
    let v = null;
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const n = (sql, ...a) => db.prepare(sql).get(...a)?.c || 0;
      const kind = "JOIN sections s ON s.id = COALESCE(b.section, 'bugs') WHERE s.kind = ?";
      const meta = (k) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v || '';
      v = {
        todos: n(`SELECT COUNT(*) c FROM bugs b ${kind} AND b.status='open'`, 'todo'),
        reports: n(`SELECT COUNT(*) c FROM bugs b ${kind} AND b.status='open'`, 'bugs'),
        mail: n(`SELECT COUNT(*) c FROM bugs b ${kind} AND b.status='open' AND COALESCE(b.seen, 0)=0 AND COALESCE(b.source, '') != 'sent'`, 'mail'),
        backedUp: Number(meta('mirror_at')) || 0,
        backupError: meta('mirror_err') ? true : false,
      };
    } catch {
      v = null;
    } finally {
      try {
        db?.close();
      } catch {}
    }
    statsCache.set(p.id, { stamp, v });
    return v;
  }
  const view = (p) => ({ id: p.id, repo: p.repo, branch: p.branch, private: p.private, user: p.user, added: p.added, opened: p.opened || 0, open: current?.id === p.id, hasToken: hasToken(p.id), ownToken: !!tokens[p.id], stats: stats(p) });

  // ---- signing in with GitHub (the device flow): Viti shows a code, you enter it on github.com, and Viti
  // asks GitHub every few seconds whether you have; then it has a token for your account (kept encrypted)
  let device = null; // { code, interval, until }
  async function ghPost(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'viti-desktop' }, body: new URLSearchParams(params) });
    return r.json().catch(() => ({}));
  }
  async function signedIn(token) {
    const me = await gh(token, '/user');
    if (me.status !== 200) throw new Error('GitHub did not accept the sign-in.');
    const u = me.body;
    tokens[ACCOUNT] = seal(token);
    save(tokFile, tokens);
    cfg.account = { login: u.login, name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com`, avatar: u.avatar_url };
    // the projects that use the sign-in (no token of their own) are you now
    for (const p of cfg.projects) if (!tokens[p.id]) p.user = cfg.account;
    saveCfg();
    repoCache = null;
  }
  // the repositories you can write to (most recently pushed first), to pick one from
  let repoCache = null;
  async function myRepos() {
    if (repoCache && Date.now() - repoCache.at < 60000) return repoCache.list;
    const token = tokens[ACCOUNT] ? unseal(tokens[ACCOUNT]) : '';
    if (!token) return [];
    const list = [];
    for (let page = 1; page <= 5; page++) {
      const r = await gh(token, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      if (r.status !== 200 || !Array.isArray(r.body)) break;
      for (const x of r.body) if (x.permissions?.push && !x.archived) list.push({ repo: x.full_name, private: !!x.private, description: x.description || '', pushed: Date.parse(x.pushed_at) || 0 });
      if (r.body.length < 100) break;
    }
    repoCache = { at: Date.now(), list };
    return list;
  }
  async function appApi(req, res, url) {
    const send = (status, body) => (res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }), res.end(JSON.stringify(body)));
    const body = req.method === 'GET' ? {} : await readJson(req, url.pathname.startsWith('/app/mail/send/') ? 40 * 1024 * 1024 : 64 * 1024);
    const p = url.pathname;
    let m0;
    if (p === '/app/state' && req.method === 'GET') return send(200, { ok: true, prefs: cfg.prefs, desktop: !!desktop, projectsDir: projectsRoot(), account: tokens[ACCOUNT] ? cfg.account || null : null, canSignIn: !!GITHUB_CLIENT_ID, projects: cfg.projects.map(view).sort((a, b) => b.opened - a.opened || b.added - a.added), current: current?.id || null });
    if (p === '/app/signin/start' && req.method === 'POST') {
      if (!GITHUB_CLIENT_ID) return send(400, { ok: false, error: 'Signing in with GitHub is not set up in this build of Viti yet. Use a token for now.' });
      const r = await ghPost(GH_WEB + '/login/device/code', { client_id: GITHUB_CLIENT_ID, scope: SCOPE });
      if (!r.device_code) return send(502, { ok: false, error: 'GitHub did not start the sign-in' + (r.error_description ? ': ' + r.error_description : '.') });
      device = { code: r.device_code, interval: Math.max(5, r.interval || 5), until: Date.now() + (r.expires_in || 900) * 1000 };
      return send(200, { ok: true, userCode: r.user_code, url: r.verification_uri || 'https://github.com/login/device', interval: device.interval, expiresIn: r.expires_in || 900 });
    }
    if (p === '/app/signin/poll' && req.method === 'POST') {
      if (!device || Date.now() > device.until) return send(200, { ok: true, status: 'expired' });
      const r = await ghPost(GH_WEB + '/login/oauth/access_token', { client_id: GITHUB_CLIENT_ID, device_code: device.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (r.access_token) {
        device = null;
        try {
          await signedIn(r.access_token);
        } catch (e) {
          return send(200, { ok: true, status: 'failed', error: e.message });
        }
        return send(200, { ok: true, status: 'done', account: cfg.account });
      }
      if (r.error === 'slow_down') device.interval += 5;
      if (r.error === 'authorization_pending' || r.error === 'slow_down') return send(200, { ok: true, status: 'pending', interval: device.interval });
      device = null;
      return send(200, { ok: true, status: r.error === 'access_denied' ? 'denied' : 'expired' });
    }
    if (p === '/app/signout' && req.method === 'POST') {
      delete tokens[ACCOUNT];
      save(tokFile, tokens);
      cfg.account = null;
      saveCfg();
      repoCache = null;
      return send(200, { ok: true });
    }
    // ---- mail (for the open project's mailboxes)
    if (p === '/app/mail' && req.method === 'GET') {
      const proj = current && cfg.projects.find((x) => x.id === current.id);
      return send(200, { ok: true, accounts: cfg.mail.accounts, links: (current && cfg.mail.links[current.id]) || {}, private: !!proj?.private });
    }
    if (p === '/app/mail/gmail' && req.method === 'POST') {
      const address = String(body.address || '').trim().toLowerCase();
      const password = String(body.password || '').replace(/\s+/g, '');
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(address)) return send(400, { ok: false, error: 'Write the whole email address.' });
      if (password.length < 8) return send(400, { ok: false, error: 'Paste the app password (16 letters).' });
      try {
        await mail.folders({ address, password }); // (it works, or says why not)
      } catch (e) {
        return send(400, { ok: false, error: e.message });
      }
      let acc = cfg.mail.accounts.find((a) => a.provider === 'gmail' && a.address === address);
      if (!acc) cfg.mail.accounts.push((acc = { id: crypto.randomBytes(5).toString('hex'), provider: 'gmail', address }));
      keepCred(acc.id)({ address, password });
      saveCfg();
      return send(200, { ok: true, account: acc });
    }
    if ((m0 = p.match(/^\/app\/mail\/accounts\/([a-f0-9]+)(\/folders)?$/))) {
      const acc = cfg.mail.accounts.find((a) => a.id === m0[1]);
      if (!acc) return send(404, { ok: false, error: 'That account is not connected.' });
      if (m0[2] && req.method === 'GET') {
        try {
          return send(200, { ok: true, folders: await mail.folders(credOf(acc.id)) });
        } catch (e) {
          return send(502, { ok: false, error: e.message });
        }
      }
      if (!m0[2] && req.method === 'PATCH') {
        acc.signature = String(body.signature || '').slice(0, 2000);
        saveCfg();
        return send(200, { ok: true, account: acc });
      }
      if (!m0[2] && req.method === 'DELETE') {
        // forgotten here, and unlinked from every mailbox (the mail already in Viti stays)
        cfg.mail.accounts = cfg.mail.accounts.filter((a) => a.id !== acc.id);
        for (const links of Object.values(cfg.mail.links)) for (const [sec, l] of Object.entries(links)) if (l.account === acc.id) delete links[sec];
        delete tokens['mail:' + acc.id];
        save(tokFile, tokens);
        saveCfg();
        return send(200, { ok: true });
      }
    }
    if ((m0 = p.match(/^\/app\/mail\/links\/([a-z0-9-]+)$/)) && current) {
      const links = (cfg.mail.links[current.id] ||= {});
      if (req.method === 'PUT') {
        const proj = cfg.projects.find((x) => x.id === current.id);
        if (!proj?.private) return send(400, { ok: false, error: 'This repository is public, and everything in a project is backed up to it: Viti does not put email there. Use a private repository for mail.' });
        if (current.host.hub.section(m0[1])?.kind !== 'mail') return send(400, { ok: false, error: 'That is not a mailbox.' });
        if (!cfg.mail.accounts.some((a) => a.id === body.account) || !body.folder) return send(400, { ok: false, error: 'Pick an account and a folder.' });
        links[m0[1]] = { account: body.account, folder: String(body.folder), folderName: String(body.folderName || body.folder), state: {}, fetched: 0, error: '' };
        saveCfg();
        const r = await fetchMail(m0[1]);
        return send(200, { ok: true, ...(r[m0[1]] || {}) });
      }
      if (req.method === 'DELETE') {
        delete links[m0[1]];
        saveCfg();
        return send(200, { ok: true });
      }
    }
    // sending from a mailbox, with the account its folder is read from (a reply threads with the original)
    if ((m0 = p.match(/^\/app\/mail\/send\/([a-z0-9-]+)$/)) && req.method === 'POST' && current) {
      const link = (cfg.mail.links[current.id] || {})[m0[1]];
      const acc = link && cfg.mail.accounts.find((a) => a.id === link.account);
      if (!acc || !credOf(acc.id)) return send(400, { ok: false, error: 'Link this mailbox to an email account first (the bar above the mailbox).' });
      const addrs = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const ok = (a) => /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(a);
      const to = addrs(body.to);
      const cc = addrs(body.cc);
      if (!to.length || ![...to, ...cc].every(ok)) return send(400, { ok: false, error: 'Check the address (or addresses, with commas between them).' });
      const text = String(body.text || '').slice(0, 50000);
      if (!text.trim()) return send(400, { ok: false, error: 'Write something first.' });
      let inReplyTo = '';
      if (body.reply) {
        const orig = current.host.hub.one('SELECT page FROM bugs WHERE id=?', String(body.reply));
        if (orig?.page?.startsWith('mail:')) inReplyTo = orig.page.slice(5);
      }
      // what it answers (threads with it), and the conversation both belong to
      let thread = '';
      if (body.reply) {
        const orig = current.host.hub.one('SELECT thread FROM bugs WHERE id=?', String(body.reply));
        thread = orig?.thread || inReplyTo;
      }
      const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 10).map((a) => ({ name: String(a.name || 'attachment').slice(0, 120), type: String(a.type || ''), content: Buffer.from(String(a.data || ''), 'base64') }));
      if (attachments.reduce((n, a) => n + a.content.length, 0) > 24 * 1024 * 1024) return send(400, { ok: false, error: 'The attachments are over 24 MB together; Gmail takes up to 25 MB.' });
      const ok2 = /^<.+>$/.test(inReplyTo);
      const msg = { to: to.join(', '), cc: cc.join(', '), subject: String(body.subject || '').slice(0, 300), text, inReplyTo: ok2 ? inReplyTo : '', references: ok2 ? [thread !== inReplyTo && /^<.+>$/.test(thread) ? thread : '', inReplyTo].filter(Boolean).join(' ') : '', attachments };
      try {
        const r = await mail.send(credOf(acc.id), msg);
        const files = [];
        for (const a of attachments) if (a.content.length <= 10 * 1024 * 1024) files.push({ id: await current.host.hub.saveFile(new Uint8Array(a.content), a.name, a.type, 'mail'), name: a.name, type: a.type, size: a.content.length });
        const bug = current.host.hub.recordSent(m0[1], { to: msg.to, cc: msg.cc, toName: String(body.toName || ''), from: acc.address, subject: msg.subject, text, files, messageId: r.messageId, thread: thread || r.messageId });
        return send(200, { ok: true, id: bug?.id, from: acc.address });
      } catch (e) {
        return send(502, { ok: false, error: e.message });
      }
    }
    if ((m0 = p.match(/^\/app\/mail\/fetch\/([a-z0-9-]+)$/)) && req.method === 'POST' && current) {
      const r = await fetchMail(m0[1]);
      return send(200, { ok: true, ...(r[m0[1]] || { added: 0, error: fetching ? 'Already fetching: try again in a moment.' : '' }) });
    }
    if (p === '/app/repos' && req.method === 'GET') {
      try {
        const have = new Set(cfg.projects.map((x) => x.repo.toLowerCase()));
        return send(200, { ok: true, repos: (await myRepos()).map((r) => ({ ...r, added: have.has(r.repo.toLowerCase()) })) });
      } catch (e) {
        return send(502, { ok: false, error: e.message });
      }
    }
    // ---- About: the version, where your data is, and the log
    // ---- updates (the window does the work: app/main.js)
    if (p === '/app/update' && req.method === 'GET') return send(200, { ok: true, ...(desktop?.update?.get() || { state: 'off' }) });
    if (p === '/app/update/check' && req.method === 'POST') return send(200, { ok: true, ...(desktop?.update ? await desktop.update.check() : { state: 'off' }) });
    if (p === '/app/update/install' && req.method === 'POST') return send(200, { ok: !!desktop?.update?.install() });
    if (p === '/app/about' && req.method === 'GET') return send(200, { ok: true, version, dataDir, logFile, canOpen: !!openPath, repo: 'ionodev/viti' });
    if (p === '/app/reveal' && req.method === 'POST') {
      const what = body.what === 'log' ? logFile : body.what === 'data' ? dataDir : '';
      if (!what || !openPath) return send(400, { ok: false, error: 'That cannot be opened here.' });
      const err = await openPath(what);
      return err ? send(500, { ok: false, error: err }) : send(200, { ok: true });
    }
    if (p === '/app/prefs' && req.method === 'PUT') {
      if (['system', 'light', 'dark'].includes(body.theme)) cfg.prefs.theme = body.theme;
      if (/^#[0-9a-f]{6}$/i.test(body.accent || '')) cfg.prefs.accent = body.accent.toLowerCase();
      if (body.welcomed === true) cfg.prefs.welcomed = true;
      if (typeof body.tray === 'boolean') cfg.prefs.tray = body.tray;
      if (typeof body.startup === 'boolean') {
        cfg.prefs.startup = body.startup;
        desktop?.setStartup?.(body.startup);
      }
      saveCfg();
      changed();
      return send(200, { ok: true, prefs: cfg.prefs });
    }
    // ---- where the projects are kept: moved to a folder you choose (closed and copied, then the old copy removed)
    if (p === '/app/data-location' && req.method === 'POST') {
      if (!desktop?.pickFolder) return send(400, { ok: false, error: 'Only in the app.' });
      const to = await desktop.pickFolder(projectsRoot());
      if (!to) return send(200, { ok: true, cancelled: true });
      const target = path.join(to, 'Viti projects');
      if (path.resolve(target) === path.resolve(projectsRoot())) return send(200, { ok: true, where: target });
      try {
        await close();
        fs.mkdirSync(target, { recursive: true });
        const from = projectsRoot();
        if (fs.existsSync(from)) fs.cpSync(from, target, { recursive: true, errorOnExist: false });
        const before = cfg.projectsDir;
        cfg.projectsDir = target;
        saveCfg();
        // (the old copy goes only once everything is safely in the new place)
        if (fs.existsSync(from) && fs.readdirSync(from).every((id) => fs.existsSync(path.join(target, id)))) fs.rmSync(from, { recursive: true, force: true });
        console.log('projects moved from', before || 'the data folder', 'to', target);
        return send(200, { ok: true, where: target });
      } catch (e) {
        return send(500, { ok: false, error: `They could not be moved: ${e.message}` });
      }
    }
    // ---- a project as a .zip of readable files (boards as markdown and JSON, reports, chats, pictures, files)
    if ((m0 = p.match(/^\/app\/projects\/([a-f0-9]+)\/export$/)) && req.method === 'POST') {
      const proj = cfg.projects.find((x) => x.id === m0[1]);
      if (!proj) return send(404, { ok: false, error: 'That project is gone.' });
      const dbFile = path.join(projDir(proj.id), 'viti.sqlite');
      if (!fs.existsSync(dbFile)) return send(400, { ok: false, error: 'Open the project once first: there is nothing of it on this computer yet.' });
      const name = proj.repo.split('/')[1];
      const where = desktop?.saveFile ? await desktop.saveFile(`${name}-viti-${new Date().toISOString().slice(0, 10)}.zip`) : path.join(dataDir, `${name}-export.zip`);
      if (!where) return send(200, { ok: true, cancelled: true });
      try {
        const hub = current?.id === proj.id ? current.host.hub : null;
        const host = hub ? null : await openProject({ dbFile, env: { GITHUB_DIR: name }, user: proj.user || { email: 'export@viti' } });
        const h = hub || host.hub;
        const dir = h.mirror.dir;
        h.mirror.dir = name;
        const files = {};
        for (const k of h.mirror.allKeys()) Object.assign(files, h.mirror.filesFor(k));
        h.mirror.dir = dir;
        if (host) host.ctx.close();
        fs.writeFileSync(where, zip(files));
        desktop?.reveal?.(where);
        return send(200, { ok: true, where, files: Object.values(files).filter((v) => v != null).length });
      } catch (e) {
        return send(500, { ok: false, error: `The export did not work: ${e.message}` });
      }
    }
    if (p === '/app/projects' && req.method === 'POST') {
      // with your GitHub sign-in, or with a pasted token of its own
      const own = String(body.token || '').trim();
      const c = await check(body.repo, own || (tokens[ACCOUNT] ? unseal(tokens[ACCOUNT]) : ''));
      if (c.error) return send(400, { ok: false, error: c.error });
      if (cfg.projects.some((x) => x.repo.toLowerCase() === c.repo.toLowerCase())) return send(400, { ok: false, error: `${c.repo} is already on your list.` });
      const id = crypto.randomBytes(6).toString('hex');
      const place = await findBackup(c.repo, own || unseal(tokens[ACCOUNT] || ''));
      cfg.projects.push({ id, repo: c.repo, branch: place.branch, dir: place.dir, branchesFrom: place.branchesFrom, private: c.private, user: c.user, added: Date.now(), opened: 0 });
      if (own) {
        tokens[id] = seal(own);
        save(tokFile, tokens);
      }
      repoCache = null;
      saveCfg();
      return send(200, { ok: true, id });
    }
    let m;
    if ((m = p.match(/^\/app\/projects\/([a-f0-9]+)$/))) {
      const proj = cfg.projects.find((x) => x.id === m[1]);
      if (!proj) return send(404, { ok: false, error: 'That project is gone.' });
      if (req.method === 'PATCH') {
        // a new token (the old one expired)
        const c = await check(proj.repo, String(body.token || '').trim());
        if (c.error) return send(400, { ok: false, error: c.error });
        tokens[proj.id] = seal(String(body.token).trim());
        proj.user = c.user;
        save(tokFile, tokens);
        saveCfg();
        if (current?.id === proj.id) await close();
        return send(200, { ok: true });
      }
      if (req.method === 'DELETE') {
        // off the list; its local copy is deleted too (what was backed up stays on GitHub)
        if (current?.id === proj.id) await close();
        cfg.projects = cfg.projects.filter((x) => x.id !== proj.id);
        delete tokens[proj.id];
        save(tokFile, tokens);
        saveCfg();
        fs.rmSync(projDir(proj.id), { recursive: true, force: true });
        return send(200, { ok: true });
      }
    }
    if ((m = p.match(/^\/app\/open\/([a-f0-9]+)$/)) && req.method === 'POST') {
      try {
        await open(m[1]);
        return send(200, { ok: true });
      } catch (e) {
        return send(500, { ok: false, error: e.message });
      }
    }
    if (p === '/app/close' && req.method === 'POST') {
      await close();
      return send(200, { ok: true });
    }
    return send(404, { ok: false, error: 'not-found' });
  }

  // ---- files
  function file(res, base, rel, extra = {}) {
    const f = path.normalize(path.join(base, rel));
    if (!f.startsWith(base)) return notFound(res);
    fs.readFile(f, (err, data) => {
      if (err) return notFound(res);
      res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', ...extra });
      res.end(data);
    });
  }
  const notFound = (res) => (res.writeHead(404, { 'content-type': 'text/plain' }), res.end('Not found'));
  const keyOk = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`viti=${key}`);
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return req.method === 'GET' || req.method === 'HEAD';
    try {
      return new URL(o).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = decodeURIComponent(url.pathname);
      if (p.startsWith('/app/') || p.startsWith('/api/')) {
        if (!keyOk(req) || !sameOrigin(req)) return res.writeHead(403, { 'content-type': 'application/json' }), res.end('{"ok":false,"error":"forbidden"}');
        if (p.startsWith('/app/')) return await appApi(req, res, url);
        if (!current) return res.writeHead(409, { 'content-type': 'application/json' }), res.end('{"ok":false,"error":"no-project","message":"No project is open."}');
        return await current.host.handle(req, res);
      }
      if (p === '/home' || p === '/home/') return file(res, UI, 'home.html');
      if (p.startsWith('/ui/')) return file(res, UI, p.slice(4));
      if (p === '/' && !current) return res.writeHead(302, { location: '/home' }), res.end();
      return file(res, PUBLIC, p === '/' ? 'index.html' : p);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Something went wrong.');
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/ws') || !keyOk(req) || !sameOrigin(req) || !current) return socket.destroy();
    current.host.upgrade(req, socket, head);
  });
  await new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    key,
    // for the window: open a project by its id (the jump list, the tray), and what to list there
    openProject: (id) => open(id),
    recent,
    prefs: () => ({ ...cfg.prefs }),
    async stop() {
      clearInterval(mailTimer);
      await close();
      server.close();
    },
  };
}

async function readJson(req, limit = 64 * 1024) {
  const parts = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) break;
    parts.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
