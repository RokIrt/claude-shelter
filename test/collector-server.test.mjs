import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createApp, isLocalHost, resolveStatic } from '../src/collector/http.mjs';
import { parseArgs, startServer } from '../server.mjs';

/** A throwaway project: public/, src/, and private files that must never be served. */
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-web-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('public/index.html', '<!doctype html><title>shelter</title>');
  write('public/style.css', 'body{}');
  write('public/app/main.js', 'export const main = 1;');
  write('public/.secret', 'hidden');
  write('src/shared/contract.mjs', 'export const SNAPSHOT_VERSION = 1;');
  write('package.json', '{"private":true}');
  write('shelter.config.json', '{"port":4780}');
  write('.data/usage-samples.json', '{"v":1}');
  return root;
}

/** Raw GET, so the test controls the Host header and nothing normalises the path. */
function get(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    // agent: false = a fresh connection every time, never a pooled keep-alive socket.
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function app(t, snapshot = { v: 1, at: 1, agents: [], marker: 'first' }) {
  const state = { snapshot };
  const a = createApp({ projectRoot: project(t), getSnapshot: () => state.snapshot, getHealth: () => ({ agents: state.snapshot.agents.length }) });
  const port = await a.listen(0);
  t.after(() => a.close());
  return { a, port, state };
}

test('server: binds to loopback only', async (t) => {
  const { a } = await app(t);
  assert.equal(a.server.address().address, '127.0.0.1');
});

test('server: api endpoints', async (t) => {
  const { port, state } = await app(t);
  const snap = await get(port, '/api/snapshot');
  assert.equal(snap.status, 200);
  assert.match(snap.headers['content-type'], /^application\/json/);
  assert.equal(snap.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(snap.body), state.snapshot);
  assert.deepEqual(JSON.parse((await get(port, '/api/snapshot?x=1')).body), state.snapshot, 'a query string is fine');

  const health = await get(port, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, agents: 0 });

  assert.equal((await get(port, '/api/nope')).status, 404);
  const post = await get(port, '/api/snapshot', {}, 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  const head = await get(port, '/api/snapshot', {}, 'HEAD');
  assert.deepEqual([head.status, head.body], [200, '']);
});

test('server: no CORS headers, on anything', async (t) => {
  const { port } = await app(t);
  for (const p of ['/', '/api/snapshot', '/api/health', '/app/main.js', '/missing']) {
    const res = await get(port, p);
    for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith('access-control-'), `${p}: ${name}`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
});

test('server: requests for any other Host are refused (DNS rebinding)', async (t) => {
  const { port } = await app(t);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.equal((await get(port, '/api/snapshot', { Host: host })).status, 200, host);
  }
  const refused = [
    `evil.example:${port}`, 'evil.example', `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`,
    `127.0.0.1:${port + 1}`, 'localhost', `192.168.1.10:${port}`, `0.0.0.0:${port}`, `localhost:${port}@evil.example`,
  ];
  for (const host of refused) {
    for (const p of ['/api/snapshot', '/api/events', '/', '/app/main.js']) {
      const res = await get(port, p, { Host: host });
      assert.equal(res.status, 403, `${host} ${p}`);
      assert.ok(!res.body.includes('marker'), 'and nothing leaks in the refusal');
    }
  }
  assert.equal(isLocalHost(undefined, port), false);
  assert.equal(isLocalHost('', port), false);
  assert.equal(isLocalHost('localhost', 80), true);
});

test('server: a request without a Host header is refused', async (t) => {
  const { port } = await app(t);
  const raw = (request) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(request));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { data += d; });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
  const old = await raw('GET /api/snapshot HTTP/1.0\r\n\r\n');
  assert.match(old, /^HTTP\/1\.[01] 403 /);
  assert.ok(!old.includes('marker'));
  const modern = await raw('GET /api/snapshot HTTP/1.1\r\nConnection: close\r\n\r\n');
  assert.match(modern, /^HTTP\/1\.1 40[03] /);
  assert.ok(!modern.includes('marker'));
});

test('server: cross-origin requests are refused', async (t) => {
  const { port } = await app(t);
  assert.equal((await get(port, '/api/snapshot', { Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await get(port, '/api/snapshot', { Origin: `http://localhost:${port}` })).status, 200);
  for (const origin of ['https://evil.example', 'null', `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`]) {
    assert.equal((await get(port, '/api/snapshot', { Origin: origin })).status, 403, origin);
  }
});

test('server: static files with the right types', async (t) => {
  const { port } = await app(t);
  const cases = {
    '/': ['text/html; charset=utf-8', '<!doctype html><title>shelter</title>'],
    '/index.html': ['text/html; charset=utf-8', '<!doctype html><title>shelter</title>'],
    '/style.css': ['text/css; charset=utf-8', 'body{}'],
    '/app/main.js': ['text/javascript; charset=utf-8', 'export const main = 1;'],
    '/src/shared/contract.mjs': ['text/javascript; charset=utf-8', 'export const SNAPSHOT_VERSION = 1;'],
  };
  for (const [p, [type, body]] of Object.entries(cases)) {
    const res = await get(port, p);
    assert.deepEqual([res.status, res.headers['content-type'], res.body], [200, type, body], p);
    assert.equal(res.headers['cache-control'], 'no-store', p);
  }
  const head = await get(port, '/style.css', {}, 'HEAD');
  assert.deepEqual([head.status, head.headers['content-length'], head.body], [200, '6', '']);
});

test('server: nothing outside public/ and src/ can be reached', async (t) => {
  const { port } = await app(t);
  const blocked = [
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json',
    '/app/../../package.json', '/src/../package.json', '/src/%2e%2e/shelter.config.json', '/src/..%2f.data/usage-samples.json',
    '/..\\package.json', '/app/..%5c..%5cpackage.json', '//etc/passwd', '/%00', '/app/main.js%00.html', '/%zz',
    '/package.json', '/shelter.config.json', '/.data/usage-samples.json', '/.secret', '/src/.hidden',
    '/app', '/app/', '/src', '/src/', '/src/shared', '/nope.js', '/public/index.html',
  ];
  for (const p of blocked) {
    const res = await get(port, p);
    assert.equal(res.status, 404, p);
    assert.ok(!/private|"port"|"v":1|hidden|root:/.test(res.body), p);
  }
});

test('server: static resolution follows symlinks only inside the roots', (t) => {
  const root = project(t);
  assert.equal(resolveStatic(root, '/app/main.js'), fs.realpathSync(path.join(root, 'public/app/main.js')));
  fs.symlinkSync(path.join(root, 'public/style.css'), path.join(root, 'public/alias.css'));
  fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'public/leak.json'));
  fs.symlinkSync(root, path.join(root, 'public/up'));
  assert.equal(resolveStatic(root, '/alias.css'), fs.realpathSync(path.join(root, 'public/style.css')));
  assert.equal(resolveStatic(root, '/leak.json'), null);
  assert.equal(resolveStatic(root, '/up/package.json'), null);
});

test('server: /api/events streams snapshots and cleans up on disconnect', async (t) => {
  const { a, port, state } = await app(t);
  const frames = [];
  let buffer = '';
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/event-stream/);
  assert.match(res.headers['cache-control'], /no-store/);
  res.setEncoding('utf8');
  const waitFor = (n) => new Promise((resolve) => {
    const check = () => {
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)));
      }
      if (frames.length >= n) {
        res.off('data', onData);
        resolve();
      }
    };
    const onData = (chunk) => { buffer += chunk; check(); };
    res.on('data', onData);
    check();
  });

  await waitFor(1);
  assert.equal(frames[0].marker, 'first', 'the current snapshot arrives immediately');
  assert.equal(a.clients.size, 1);

  state.snapshot = { v: 1, at: 2, agents: [], marker: 'second' };
  a.broadcast(state.snapshot);
  await waitFor(2);
  assert.equal(frames[1].marker, 'second');

  res.destroy();
  for (let i = 0; i < 100 && a.clients.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.clients.size, 0, 'the listener is forgotten when the browser goes away');
  a.broadcast(state.snapshot);   // and broadcasting to nobody is fine
});

test('server: close() ends open event streams', async (t) => {
  const a = createApp({ projectRoot: project(t), getSnapshot: () => ({ v: 1 }) });
  const port = await a.listen(0);
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, resolve).on('error', reject);
  });
  res.resume();
  const ended = new Promise((resolve) => res.on('close', resolve));
  await a.close();
  await ended;
  await assert.rejects(get(port, '/api/health'), /ECONNREFUSED/);
});

test('cli: arguments', () => {
  assert.deepEqual(parseArgs([]), { port: null, sim: null, open: false, help: false });
  assert.deepEqual(parseArgs(['--port', '4781', '--sim', 'tour', '--open']), { port: 4781, sim: 'tour', open: true, help: false });
  assert.deepEqual(parseArgs(['--port=5000', '--sim=calm']), { port: 5000, sim: 'calm', open: false, help: false });
  assert.equal(parseArgs(['--sim']).sim, '', 'no name: the default scenario');
  assert.equal(parseArgs(['--sim', '--open']).sim, '');
  assert.equal(parseArgs(['-h']).help, true);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port needs a number/);
  assert.throws(() => parseArgs(['--port']), /--port needs a number/);
  assert.throws(() => parseArgs(['--port', '70000']), /--port needs a number/);
  assert.throws(() => parseArgs(['--frobnicate']), /unknown option/);
});

test('server: --sim serves a scenario on the same endpoints, without touching live telemetry', async (t) => {
  const root = project(t);
  const logs = [];
  // CLAUDE_CONFIG_DIR / SHELTER_DATA_DIR point nowhere: simulation must not need or create them.
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'no-claude'), SHELTER_DATA_DIR: path.join(root, 'no-data') };
  const srv = await startServer({ sim: 'calm', port: 0, projectRoot: root, env, log: (m) => logs.push(m) });
  t.after(() => srv.close());

  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(logs[0].includes(srv.url));
  assert.match(logs[1], /simulation "calm"/);

  const snap = JSON.parse((await get(srv.port, '/api/snapshot')).body);
  assert.deepEqual([snap.v, snap.source, snap.scenario], [1, 'simulation', 'calm']);
  assert.ok(Array.isArray(snap.agents) && Array.isArray(snap.models) && Array.isArray(snap.limits.rows));
  const health = JSON.parse((await get(srv.port, '/api/health')).body);
  assert.deepEqual([health.ok, health.source, health.scenario, health.agents], [true, 'simulation', 'calm', snap.agents.length]);
  assert.equal((await get(srv.port, '/')).status, 200);

  await srv.close();
  assert.ok(!fs.existsSync(env.SHELTER_DATA_DIR), 'no usage history is written in simulation');
  assert.ok(!fs.existsSync(env.CLAUDE_CONFIG_DIR));
});

test('server: bad options fail with a clear message', async (t) => {
  const root = project(t);
  await assert.rejects(startServer({ sim: 'no-such-scenario', port: 0, projectRoot: root, env: {}, log() {} }), /unknown scenario "no-such-scenario"\. Available: .*tour/);
  await assert.rejects(startServer({ sim: 'calm', projectRoot: root, env: { PORT: 'abc' }, log() {} }), /PORT must be a number/);

  const first = await startServer({ sim: 'calm', port: 0, projectRoot: root, env: {}, log() {} });
  t.after(() => first.close());
  await assert.rejects(startServer({ sim: 'calm', port: first.port, projectRoot: root, env: {}, log() {} }), /already in use/);
});
