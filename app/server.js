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
import { openProject } from '../server/host.js';
import { GITHUB_CLIENT_ID, SCOPE } from './github-app.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webp': 'image/webp' };
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const DATA_BRANCH = 'viti-data';
// GitHub's addresses (another one only for testing)
const GH_API = process.env.VITI_GITHUB_API || 'https://api.github.com';
const GH_WEB = process.env.VITI_GITHUB_WEB || 'https://github.com';

// root: the app folder; dataDir: where projects and settings live; seal/unseal: keep tokens encrypted
export async function startServer({ root, dataDir, seal, unseal, port = 0, key: givenKey }) {
  const PUBLIC = path.join(root, 'public');
  const UI = path.join(root, 'app', 'ui');
  const key = givenKey || crypto.randomBytes(24).toString('hex');
  const cfgFile = path.join(dataDir, 'viti.json');
  const tokFile = path.join(dataDir, 'tokens.json');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });

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
  cfg.prefs = { theme: 'system', accent: '#6d5efc', ...(cfg.prefs || {}) };
  cfg.projects ||= [];
  const tokens = load(tokFile, {});
  const saveCfg = () => save(cfgFile, cfg);
  // a project's own token (pasted in by hand), or else the one from signing in with GitHub
  const ACCOUNT = '@account';
  const tokenOf = (id) => (tokens[id] ? unseal(tokens[id]) : tokens[ACCOUNT] ? unseal(tokens[ACCOUNT]) : '');
  const hasToken = (id) => !!(tokens[id] || tokens[ACCOUNT]);

  let current = null; // { id, host }

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

  // ---- where a repository's Viti backup is: the desktop app's own place (viti-data, folder viti), or the web
  // Viti's (hub-data, folder hub: the team hub in vardengames_dev). A viti.json beside it can say where the
  // branch tags come from (another repository: the web hub takes them from the game's). None yet: the
  // desktop's place, and the repository's own branches.
  const PLACES = [[DATA_BRANCH, 'viti'], ['hub-data', 'hub']];
  async function findBackup(repo, token) {
    for (const [branch, dir] of PLACES) {
      const meta = await gh(token, `/repos/${repo}/contents/${dir}/meta.json?ref=${branch}`);
      if (meta.status !== 200) continue;
      let branchesFrom = '';
      const desc = await gh(token, `/repos/${repo}/contents/${dir}/viti.json?ref=${branch}`);
      if (desc.status === 200 && desc.body.content) {
        try {
          const d = JSON.parse(Buffer.from(desc.body.content, 'base64').toString('utf8'));
          if (/^[\w.-]+\/[\w.-]+$/.test(d.branchesFrom || '')) branchesFrom = d.branchesFrom;
        } catch {}
      }
      return { branch, dir, branchesFrom };
    }
    return { branch: DATA_BRANCH, dir: 'viti', branchesFrom: '' };
  }

  // ---- open and close a project
  async function open(id) {
    const p = cfg.projects.find((x) => x.id === id);
    if (!p) throw new Error('That project is gone.');
    if (current?.id === id) return current;
    await close();
    const dir = path.join(dataDir, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, 'viti.sqlite');
    const fresh = !fs.existsSync(dbFile);
    const token = tokenOf(id);
    const env = { GITHUB_REPO: p.repo, GITHUB_TOKEN: token, GITHUB_BRANCH: p.branch || DATA_BRANCH, GITHUB_DIR: p.dir || 'viti', KOLVER_REPO: p.branchesFrom || p.repo, KOLVER_TOKEN: token, MIRROR_DELAY_MS: '60000' };
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
    await host.name(p.user?.name);
    p.opened = Date.now();
    saveCfg();
    current = { id, host };
    return current;
  }
  async function close() {
    if (!current) return;
    const c = current;
    current = null;
    await c.host.close();
  }

  // ---- the home screen's API
  const view = (p) => ({ id: p.id, repo: p.repo, branch: p.branch, private: p.private, user: p.user, added: p.added, opened: p.opened || 0, open: current?.id === p.id, hasToken: hasToken(p.id), ownToken: !!tokens[p.id] });

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
    const body = req.method === 'GET' ? {} : await readJson(req);
    const p = url.pathname;
    if (p === '/app/state' && req.method === 'GET') return send(200, { ok: true, prefs: cfg.prefs, account: tokens[ACCOUNT] ? cfg.account || null : null, canSignIn: !!GITHUB_CLIENT_ID, projects: cfg.projects.map(view).sort((a, b) => b.opened - a.opened || b.added - a.added), current: current?.id || null });
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
    if (p === '/app/repos' && req.method === 'GET') {
      try {
        const have = new Set(cfg.projects.map((x) => x.repo.toLowerCase()));
        return send(200, { ok: true, repos: (await myRepos()).map((r) => ({ ...r, added: have.has(r.repo.toLowerCase()) })) });
      } catch (e) {
        return send(502, { ok: false, error: e.message });
      }
    }
    if (p === '/app/prefs' && req.method === 'PUT') {
      if (['system', 'light', 'dark'].includes(body.theme)) cfg.prefs.theme = body.theme;
      if (/^#[0-9a-f]{6}$/i.test(body.accent || '')) cfg.prefs.accent = body.accent.toLowerCase();
      saveCfg();
      return send(200, { ok: true, prefs: cfg.prefs });
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
        fs.rmSync(path.join(dataDir, 'projects', proj.id), { recursive: true, force: true });
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
    async stop() {
      await close();
      server.close();
    },
  };
}

async function readJson(req) {
  const parts = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) break;
    parts.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
