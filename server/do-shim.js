// What the Hub (server/hub.js) expects from Cloudflare, provided on a normal computer: the base class, a
// SQLite database with the Durable Object's API (node:sqlite underneath), transactions, the timer
// ("alarm") the GitHub backup runs on, and the list of open live connections. hub.js itself is
// unchanged apart from where it imports these from.
import { DatabaseSync } from 'node:sqlite';

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
}

// node:sqlite takes Uint8Array (not ArrayBuffer) for blobs, and no booleans or undefined
const param = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof ArrayBuffer ? new Uint8Array(v) : v);

// one database file per project; -> the ctx a Durable Object is given
export function makeContext(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
  const cache = new Map();
  const prepared = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  const sockets = new Set();
  let alarm = null;
  const ctx = {
    db,
    storage: {
      sql: {
        // a statement with ? parameters -> its rows (an iterable, like Cloudflare's cursor)
        exec(sql, ...args) {
          return prepared(sql).all(...args.map(param));
        },
      },
      transactionSync(fn) {
        const sp = `sp${depth++}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const out = fn();
          db.exec(`RELEASE ${sp}`);
          return out;
        } catch (e) {
          db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        } finally {
          depth--;
        }
      },
      async setAlarm(when) {
        clearTimeout(alarm);
        alarm = setTimeout(() => ((alarm = null), ctx.onAlarm?.()), Math.max(0, Number(when) - Date.now()));
      },
      async getAlarm() {
        return alarm ? 1 : null;
      },
      async deleteAlarm() {
        clearTimeout(alarm);
        alarm = null;
      },
    },
    setWebSocketAutoResponse() {}, // (the host answers "ping" itself)
    blockConcurrencyWhile(fn) {
      ctx.ready = Promise.resolve().then(fn);
      return ctx.ready;
    },
    acceptWebSocket(ws) {
      sockets.add(ws);
    },
    getWebSockets() {
      return [...sockets];
    },
    dropWebSocket(ws) {
      sockets.delete(ws);
    },
    close() {
      clearTimeout(alarm);
      for (const ws of sockets) ws.close?.(1001, 'closing');
      sockets.clear();
      db.close();
    },
  };
  return ctx;
}
