// The local web server: snapshot API, server-sent events, static files. Node `http` only.
// The snapshot is private telemetry, so this is built to be reachable from this machine's
// own browser and nothing else.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const LOOPBACK = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // No CORS headers anywhere; this also stops other sites embedding our responses.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};

const HOST = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;

/**
 * Is this Host (or Origin host) one of our own loopback names on our own port?
 * A page on another site that resolves its hostname to 127.0.0.1 (DNS rebinding)
 * still sends its own name here, and is refused.
 */
export function isLocalHost(host, port) {
  const m = HOST.exec(typeof host === 'string' ? host.trim() : '');
  if (!m) return false;
  return m[2] === undefined ? port === 80 : Number(m[2]) === port;
}

/**
 * Map a URL path to a file inside public/ (or src/ for /src/...). Returns null for
 * anything that is not a plain file inside those two directories.
 */
export function resolveStatic(projectRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter(Boolean);
  // No dot-files, no '..': nothing outside the two roots and nothing hidden inside them.
  if (segs.some((s) => s.startsWith('.'))) return null;
  if (decoded.length > 1 && decoded.endsWith('/')) return null;

  let root;
  let rel;
  if (segs[0] === 'src') {
    root = path.join(projectRoot, 'src');
    rel = segs.slice(1);
  } else {
    root = path.join(projectRoot, 'public');
    rel = segs.length ? segs : ['index.html'];
  }
  if (!rel.length) return null;
  try {
    // Symlinks are followed only as long as they stay inside the root.
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(root, ...rel));
    if (!real.startsWith(realRoot + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * @param {{projectRoot:string, getSnapshot:()=>object, getHealth?:()=>object}} opts
 * @returns {{server:http.Server, listen:(port:number)=>Promise<number>,
 *            broadcast:(snapshot:object)=>void, close:()=>Promise<void>, clients:Set}}
 */
export function createApp({ projectRoot, getSnapshot, getHealth = () => ({}) }) {
  const clients = new Set();
  let port = 0;

  const send = (res, status, type, body, extra = {}) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': data.length, ...extra });
    res.end(res.req.method === 'HEAD' ? undefined : data);
  };
  const text = (res, status, msg, extra) => send(res, status, 'text/plain; charset=utf-8', `${msg}\n`, extra);
  const json = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

  const server = http.createServer((req, res) => {
    if (!isLocalHost(req.headers.host, port)) return text(res, 403, 'Forbidden: this server only answers to localhost');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost = null;
      try {
        const u = new URL(origin);
        if (u.protocol === 'http:') originHost = u.host;
      } catch { /* 'null' and other non-URLs */ }
      if (!isLocalHost(originHost, port)) return text(res, 403, 'Forbidden: cross-origin request');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

    const pathname = (req.url ?? '/').split(/[?#]/, 1)[0];
    if (pathname === '/api/snapshot') return json(res, 200, getSnapshot());
    if (pathname === '/api/health') return json(res, 200, { ok: true, ...getHealth() });
    if (pathname === '/api/events') return events(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    const file = resolveStatic(projectRoot, pathname);
    if (!file) return text(res, 404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return text(res, 404, 'Not found');
      send(res, 200, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', data);
    });
  });

  function events(req, res) {
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Cache-Control': 'no-store, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') return res.end();
    res.write(`retry: 2000\n\ndata: ${JSON.stringify(getSnapshot())}\n\n`);
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  return {
    server,
    clients,
    /** Bind to loopback only. Resolves with the port actually bound (pass 0 for any free one). */
    listen(wanted) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wanted, LOOPBACK, () => {
          server.off('error', reject);
          port = server.address().port;
          resolve(port);
        });
      });
    },
    /** Push a snapshot to every connected event stream. */
    broadcast(snapshot) {
      if (!clients.size) return;
      const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
      for (const res of clients) {
        // A reader that has fallen far behind skips frames rather than buffering them all.
        if (res.writableLength < 1 << 20) res.write(frame);
      }
    },
    close() {
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
