// One open project: its Hub (server/hub.js) on its own database file, and the bridge from Node's HTTP
// server and WebSockets to it. The app (app/main.js) serves the pages and hands /api/* and the live
// connection here.
import { WebSocketServer } from 'ws';
import { Hub } from './hub.js';
import { makeContext } from './do-shim.js';

export async function openProject({ dbFile, env, user }) {
  const ctx = makeContext(dbFile);
  const hub = new Hub(ctx, env);
  ctx.onAlarm = () => hub.alarm().catch((e) => console.error('backup:', e?.message || e));
  await ctx.ready;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  // a Node request -> a web Request with the person set (as Cloudflare Access does on the web)
  const toRequest = async (req) => {
    const url = `http://${req.headers.host || '127.0.0.1'}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null && k !== 'x-hub-user') headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    headers.set('x-hub-user', user.email);
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const parts = [];
      for await (const c of req) parts.push(c);
      body = Buffer.concat(parts);
    }
    return new Request(url, { method: req.method, headers, body });
  };

  return {
    hub,
    ctx,
    // /api/* (not the live connection)
    async handle(req, res) {
      const out = await hub.fetch(await toRequest(req));
      const headers = {};
      out.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(out.status, headers);
      res.end(Buffer.from(await out.arrayBuffer()));
    },
    // /api/ws: the live connection, handled here instead of by the Hub's upgrade() (which uses
    // Cloudflare's WebSocketPair); the Hub's own message and close handlers do the rest
    upgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        let att = { id: Math.random().toString(36).slice(2, 8), email: user.email, section: null };
        ws.serializeAttachment = (a) => (att = a);
        ws.deserializeAttachment = () => att;
        hub.ensureUser(user.email);
        ctx.acceptWebSocket(ws);
        ws.on('message', (data) => {
          const text = data.toString();
          if (text === 'ping') return ws.send('pong');
          Promise.resolve(hub.webSocketMessage(ws, text)).catch((e) => console.error('live:', e?.message || e));
        });
        ws.on('close', () => {
          ctx.dropWebSocket(ws);
          hub.webSocketClose(ws);
        });
        ws.on('error', () => {
          ctx.dropWebSocket(ws);
          hub.webSocketError(ws);
        });
      });
    },
    // who you are here: your GitHub account, as on the home screen (its name, or the username if it has none,
    // and its picture), every time the project is opened
    async profile({ login = '', name = '', avatar = '' } = {}) {
      hub.ensureUser(user.email);
      const r = hub.one('SELECT name, named, COALESCE(avatar, \'\') AS avatar FROM users WHERE email=?', user.email);
      let changed = false;
      if (avatar && r.avatar !== avatar) {
        hub.run('UPDATE users SET avatar=? WHERE email=?', avatar, user.email);
        changed = true;
      }
      // (always your GitHub name, as on the home screen: the username if you have none)
      const shown = name || login;
      if (shown && r.name !== shown) {
        hub.run('UPDATE users SET name=?, named=1 WHERE email=?', shown, user.email);
        changed = true;
      }
      if (changed) {
        hub.markDirty('meta');
        hub.bcAll({ t: 'users', users: hub.users() });
      }
    },
    // the backup now (before closing), then shut
    async close() {
      hub.mirror.stopPolling();
      try {
        if (hub.mirror.gh?.configured) await hub.mirror.run();
      } catch {}
      wss.close();
      ctx.close();
    },
  };
}
