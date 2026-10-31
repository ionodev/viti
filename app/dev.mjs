// For working on the pages in a normal browser: the app's server without the window, on a fixed port,
// with a known key and its own data folder. Open http://127.0.0.1:8795/dev-login, which sets the key.
//   node app/dev.mjs [data folder]
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.argv[2] || path.join(os.tmpdir(), 'viti-dev');
const key = 'dev';
const s = await startServer({ root, dataDir, seal: (t) => 'v0:' + Buffer.from(t).toString('base64'), unseal: (t) => Buffer.from(t.slice(3), 'base64').toString(), port: 8796, key });
// in front: /dev-login gives the browser the key, everything else goes to the app
http
  .createServer((req, res) => {
    if (req.url === '/dev-login') return res.writeHead(302, { 'set-cookie': `viti=${key}; Path=/; HttpOnly; SameSite=Strict`, location: '/home' }), res.end();
    const p = http.request({ host: '127.0.0.1', port: 8796, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:8795' } }, (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)));
    p.on('error', () => (res.headersSent ? res.destroy() : (res.writeHead(502), res.end())));
    req.pipe(p);
  })
  .on('upgrade', (req, socket, head) => {
    const p = http.request({ host: '127.0.0.1', port: 8796, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:8795' } });
    // (the app refuses a live connection while no project is open: just close this end too)
    p.on('error', () => socket.destroy());
    socket.on('error', () => p.destroy());
    p.on('upgrade', (r, s2, h2) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      s2.write(head);
      socket.write(h2);
      s2.pipe(socket).pipe(s2);
    });
    p.end();
  })
  .listen(8795, '127.0.0.1', () => console.log(`Viti (dev) on http://127.0.0.1:8795/dev-login  data: ${dataDir}`));
