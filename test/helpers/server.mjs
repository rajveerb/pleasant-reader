// Minimal static file server for the HTML fixtures. No dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript'
};

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

// Start a server rooted at test/fixtures. Returns { origin, close }.
export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(req.url.split('?')[0]);
        const file = join(FIXTURES, path === '/' ? 'index.html' : path);
        if (!file.startsWith(FIXTURES)) { res.writeHead(403).end('forbidden'); return; }
        const body = await readFile(file);
        const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
        // Honor a per-fixture CSP via a sibling .csp file (raw header value).
        try {
          const csp = await readFile(file + '.csp', 'utf8');
          headers['Content-Security-Policy'] = csp.trim();
        } catch { /* no CSP file */ }
        res.writeHead(200, headers).end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    // Track open sockets so close() can destroy lingering keep-alive
    // connections from the browser — otherwise server.close() blocks forever
    // waiting for them to drain.
    const sockets = new Set();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(r);
        })
      });
    });
  });
}
