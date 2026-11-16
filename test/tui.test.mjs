// Terminal view: size guarantees, content, colour/no-colour, edge-case states, CLI.
// Run: node --test test/tui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { derive } from '../src/shared/derive.mjs';
import { SCENARIOS, scenarioSnapshot } from '../src/shared/scenarios.mjs';
import { renderCompact, stripAnsi, visibleWidth } from '../src/tui/render.mjs';
import { renderNotice } from '../src/tui/screens.mjs';
import { clean } from '../src/tui/ansi.mjs';
import { parseArgs, stepWhatIf, fetchSnapshot, UsageError } from '../src/tui/app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_800_000_000_000;
const SIZES = [[36, 16], [48, 24], [60, 40], [100, 50]];
const TIMES = [0, 5, 12, 30, 45, 55];
const TOUR_TIMES = [5, 30, 55, 90];
/** Everything the view may print: printable ASCII, box drawing and block elements. */
const SAFE = /^[\x20-\x7e─-▟]*$/;

const stateOf = (name, t, whatIf = 1) => derive(scenarioSnapshot(name, t, NOW), { now: NOW, whatIf });

function checkSize(lines, cols, rows, where) {
  assert.ok(Array.isArray(lines), `${where}: returns an array`);
  assert.ok(lines.length <= rows, `${where}: ${lines.length} lines > ${rows} rows`);
  lines.forEach((l, i) => {
    assert.equal(typeof l, 'string', `${where}: line ${i} is a string`);
    const plain = stripAnsi(l);
    assert.ok(visibleWidth(l) <= cols, `${where}: line ${i} is ${visibleWidth(l)} wide > ${cols}: ${JSON.stringify(plain)}`);
    assert.ok(SAFE.test(plain), `${where}: line ${i} has a character outside the safe set: ${JSON.stringify(plain)}`);
    assert.ok(!/[\x00-\x08\x0a-\x1a\x1c-\x1f]/.test(l), `${where}: line ${i} has a control byte`);
  });
}

/** Strip escapes and box drawing, join lines, collapse whitespace: for finding wrapped text. */
const flat = (lines) => lines.map((l) => stripAnsi(l).replace(/[─-╿]/g, ' ')).join(' ').replace(/\s+/g, ' ');
const hasPct = (text, n) => new RegExp(`(?<!\\d)${Math.round(n)}%`).test(text);

// ───────────────────────────── size guarantees ─────────────────────────────

test('every scenario at every size stays inside rows x cols (colour and plain)', () => {
  for (const name of SCENARIOS) {
    const times = name === 'tour' ? [...TIMES, ...TOUR_TIMES, 100, 120] : TIMES;
    for (const t of times) {
      const state = stateOf(name, t);
      for (const [cols, rows] of SIZES) {
        for (const color of [true, false, 'truecolor']) {
          for (const frame of [0, 1, 2, 3]) {
            checkSize(renderCompact(state, { cols, rows, color, frame }), cols, rows, `${name}@${t}s ${cols}x${rows} color=${color} f${frame}`);
          }
        }
      }
    }
  }
});

test('odd sizes in between and tiny panes never overflow or throw', () => {
  const states = [stateOf('tour', 30), stateOf('reset', 5), stateOf('busy', 30), stateOf('generator', 30)];
  const sizes = [[1, 1], [10, 3], [20, 4], [30, 5], [36, 10], [37, 17], [41, 19], [43, 21], [44, 12], [53, 30], [54, 18], [70, 16], [75, 33], [89, 45], [91, 50], [140, 60], [36, 60]];
  for (const s of states) {
    for (const [cols, rows] of sizes) {
      for (const color of [true, false]) checkSize(renderCompact(s, { cols, rows, color, frame: 5 }), cols, rows, `${s.scenario} ${cols}x${rows}`);
    }
  }
  assert.deepEqual(renderCompact(stateOf('tour', 0), { cols: 0, rows: 10 }), []);
  assert.deepEqual(renderCompact(stateOf('tour', 0), { cols: 40, rows: 0 }), []);
});

test('a wide terminal gets a capped width, not a stretched layout', () => {
  const lines = renderCompact(stateOf('busy', 30), { cols: 220, rows: 60, color: false });
  checkSize(lines, 220, 60, 'busy 220x60');
  assert.ok(Math.max(...lines.map(visibleWidth)) <= 100);
});

// ───────────────────────────── content ─────────────────────────────

test('tour: power mode, key percentages and the top alert at every size', () => {
  const expectPower = { 5: /NORMAL/, 30: /NORMAL/, 55: /PIT STOP/, 90: /EMERGENCY/ };
  for (const t of TOUR_TIMES) {
    const state = stateOf('tour', t);
    for (const [cols, rows] of SIZES) {
      for (const color of [true, false]) {
        const lines = renderCompact(state, { cols, rows, color, frame: t });
        const text = flat(lines);
        const where = `tour@${t}s ${cols}x${rows} color=${color}`;
        assert.match(stripAnsi(lines[0]), expectPower[t], `${where}: power mode in the header`);
        assert.ok(hasPct(text, state.switchboard.limit.percent), `${where}: session percent`);
        assert.ok(hasPct(text, state.reactor.limit.percent), `${where}: weekly percent`);
        const hottest = [...state.machines].filter((m) => m.limit).sort((a, b) => b.limit.percent - a.limit.percent)[0];
        assert.ok(hasPct(text, hottest.limit.percent), `${where}: hottest machine percent`);
        if (state.alerts.length) assert.ok(text.includes(clean(state.alerts[0].text)), `${where}: top alert "${state.alerts[0].text}" in\n${lines.map(stripAnsi).join('\n')}`);
      }
    }
  }
});

test('tour: fire, pit stop and meltdown are spelled out without colour', () => {
  const at = (t) => renderCompact(stateOf('tour', t), { cols: 48, rows: 24, color: false }).join('\n');
  assert.match(at(5), /POWER NORMAL/);
  assert.match(at(30), /Fable .*100% FIRE/);
  assert.match(at(55), /PIT STOP/);
  assert.match(at(55), /Session .*100% TRIPPED/);
  assert.match(at(90), /EMERGENCY/);
  assert.match(at(90), /Weekly .*100% MELTDOWN/);
  assert.match(at(90), /BLOCKED|!/, 'blocked residents are marked');
});

test('every scenario shows every allowance percent and the top alert at 48x24 and up', () => {
  for (const name of SCENARIOS) {
    for (const t of [3, 20, 50]) {
      const state = stateOf(name, t);
      for (const [cols, rows] of SIZES.slice(1)) {
        const lines = renderCompact(state, { cols, rows, color: false });
        const text = flat(lines);
        const where = `${name}@${t}s ${cols}x${rows}`;
        for (const v of [state.switchboard.limit, state.reactor.limit, ...state.machines.map((m) => m.limit)].filter(Boolean)) {
          assert.ok(hasPct(text, v.percent), `${where}: ${v.label} ${v.percent}% missing in\n${lines.join('\n')}`);
        }
        if (state.alerts.length) assert.ok(text.includes(clean(state.alerts[0].text)), `${where}: top alert`);
        for (const m of state.machines) if (!m.limit) assert.match(text, /shared/, `${where}: machine without its own allowance`);
      }
    }
  }
});

test('header names the source and shows the what-if badge only when not x1', () => {
  const sim = stripAnsi(renderCompact(stateOf('tour', 30), { cols: 60, rows: 30, color: false })[0]);
  assert.match(sim, /TOKEN SHELTER/);
  assert.match(sim, /SIM: Grand tour/);
  assert.doesNotMatch(sim, /x1\b/);
  const boosted = stripAnsi(renderCompact(stateOf('tour', 30, 2.5), { cols: 60, rows: 30, color: false })[0]);
  assert.match(boosted, /x2\.5/);
  const live = { ...stateOf('calm', 10), source: 'live', scenario: null };
  assert.match(stripAnsi(renderCompact(live, { cols: 48, rows: 20, color: false })[0]), /LIVE/);
});

test('generous sizes add per-resident lines, the generator and labelled telemetry', () => {
  const state = stateOf('busy', 30);
  const text = renderCompact(state, { cols: 100, rows: 50, color: false }).join('\n');
  assert.match(text, /LOUNGE/);
  assert.doesNotMatch(text, /CONTROL ROOM/, 'nobody works at the console any more: no empty room listed');
  assert.match(text, /MACHINES[^]*shelter-dev/, 'the foreman is listed at its machine');
  assert.match(text, /REACTOR/);
  assert.match(text, /TELEMETRY: raw tokens, not allowance/);
  assert.match(text, /Implement telemetry collector/);
  assert.match(text, /shelter-dev/);
  const gen = renderCompact(stateOf('generator', 30), { cols: 60, rows: 40, color: false }).join('\n');
  assert.match(gen, /Backup .*RUNNING/);
  assert.match(gen, /PIT STOP/);
  const small = renderCompact(state, { cols: 36, rows: 16, color: false }).join('\n');
  assert.doesNotMatch(small, /Implement telemetry collector/, 'resident detail is the first thing dropped');
});

// ───────────────────────────── colour ─────────────────────────────

test('color:false output has no escape codes; colour output does and ends lines with a reset', () => {
  for (const name of SCENARIOS) {
    const state = stateOf(name, 20);
    for (const [cols, rows] of SIZES) {
      const plain = renderCompact(state, { cols, rows, color: false, frame: 1 });
      assert.ok(plain.every((l) => !l.includes('\x1b')), `${name} ${cols}x${rows}: escape in plain output`);
      const coloured = renderCompact(state, { cols, rows, color: true, frame: 1 });
      assert.ok(coloured.some((l) => l.includes('\x1b[')), `${name}: colour output has escapes`);
      for (const l of coloured) if (l.includes('\x1b[')) assert.ok(l.endsWith('\x1b[0m'), `${name}: coloured line ends with a reset`);
    }
  }
});

test('animation frames change glyphs, never the layout, status words or percents', () => {
  for (const t of TOUR_TIMES) {
    const state = stateOf('tour', t);
    for (const [cols, rows] of SIZES) {
      const frames = [0, 1, 2, 3, 4, 5, 6, 7].map((frame) => renderCompact(state, { cols, rows, color: false, frame }).map(stripAnsi));
      const shape = (f) => f.map((l) => l.length).join(',');
      const words = (f) => f.join('\n').match(/\d+%|FIRE|TRIPPED|MELTDOWN|PIT STOP|EMERGENCY|BLOCKED|shared/g)?.join(' ');
      for (const f of frames.slice(1)) {
        assert.equal(f.length, frames[0].length, `tour@${t} ${cols}x${rows}: row count changes between frames`);
        assert.equal(shape(f), shape(frames[0]), `tour@${t} ${cols}x${rows}: row widths change between frames`);
        assert.equal(words(f), words(frames[0]), `tour@${t} ${cols}x${rows}: status words change between frames`);
      }
    }
  }
});

test('deterministic for the same state and options', () => {
  const s = stateOf('reset', 7);
  assert.deepEqual(renderCompact(s, { cols: 60, rows: 30, frame: 3 }), renderCompact(s, { cols: 60, rows: 30, frame: 3 }));
});

// ───────────────────────────── states the simulation never produces ─────────────────────────────

const limit = (scope, modelKey, percent, extra = {}) => ({
  id: scope === 'model' ? `model:${modelKey}` : scope, scope, modelKey, label: scope, percent,
  resetsAt: null, resetInMs: null, ratePctPerHour: null, exhaustInMs: null, survives: null, shortfallMs: null,
  level: percent >= 100 ? 'exhausted' : percent >= 92 ? 'critical' : percent >= 80 ? 'warn' : 'ok', forecast: '', stale: false, ...extra,
});
const resident = (i, o = {}) => ({
  id: `r${i}`, kind: 'sub', role: ['programmer', 'researcher', 'reviewer', 'operator'][i % 4], name: `agent ${i}`, agentType: null, project: null,
  parentId: null, parentName: null, model: 'm', modelKey: 'm0', place: 'machine', status: 'working', activity: 'code', station: 'terminal',
  icon: 'code', mood: 'focused', blocked: false, tool: 'Edit', task: null, startedAt: NOW - 60_000, lastActiveAt: NOW, tokens: {}, rate: {}, ...o,
});
const machine = (i, o = {}) => ({
  modelKey: `m${i}`, label: `Model${i}`, design: 'generic', style: { accent: 40, accent2: 32, variant: 0 }, limit: null, heat: 0,
  status: 'running', powered: true, speed: 0.5, rate: { input: 0, output: 1200, cacheRead: 0 }, tokens: {}, residentIds: [], ...o,
});
const baseState = (o = {}) => ({
  now: NOW, source: 'live', scenario: null, whatIf: 1, machines: [], switchboard: { limit: null, status: 'ok' },
  reactor: { limit: null, heat: 0, status: 'ok', speed: 0 }, generator: { present: false, running: false, utilization: null },
  power: 'normal', residents: [], alerts: [], rate: { input: 0, output: 0, cacheRead: 0 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  speed: 0, telemetry: { at: null, stale: true, error: null, known: false }, ...o,
});

const EDGE = {
  empty: baseState(),
  'no readings yet': baseState({ machines: [machine(0)], alerts: [{ id: 't', level: 'info', scope: 'telemetry', modelKey: null, text: 'Waiting for the first allowance reading' }] }),
  'over 100 percent': baseState({
    machines: [machine(0, { limit: limit('model', 'm0', 187), status: 'fire', heat: 1, powered: false })],
    switchboard: { limit: limit('session', null, 250, { exhaustInMs: 0 }), status: 'tripped' }, power: 'pitstop',
    reactor: { limit: limit('weekly', null, 104), heat: 1, status: 'meltdown', speed: 0 },
  }),
  'nine machines': baseState({
    machines: Array.from({ length: 9 }, (_, i) => machine(i, { limit: i % 3 ? limit('model', `m${i}`, i * 11) : null })),
    switchboard: { limit: limit('session', null, 40), status: 'ok' }, reactor: { limit: limit('weekly', null, 20), heat: 0, status: 'ok', speed: 0 },
  }),
  'forty residents on one machine': baseState({
    machines: [machine(0, { limit: limit('model', 'm0', 50) }), machine(1)],
    residents: [...Array.from({ length: 40 }, (_, i) => resident(i, { blocked: i % 7 === 0 })), resident(99, { kind: 'main', role: 'foreman', place: 'control' }), ...Array.from({ length: 12 }, (_, i) => resident(100 + i, { place: 'lounge', status: 'waiting', mood: 'sleepy', lastActiveAt: NOW - 3_600_000 }))],
    switchboard: { limit: limit('session', null, 40), status: 'ok' }, reactor: { limit: limit('weekly', null, 20), heat: 0, status: 'ok', speed: 0 },
  }),
  'hostile strings': baseState({
    machines: [machine(0, { label: '\u{1F600}你好\x1b[31mRED\x07', limit: limit('model', 'm0', 60, { forecast: 'emoji \u{1F525} and éè accents — dash' }) })],
    residents: [resident(1, { name: '你好世界\u{1F600}\x1b]0;title\x07\ttab\nnewline', task: '́​ weird', tool: '\x1b[2J', activity: 'nonsense' })],
    alerts: [{ id: 'x', level: 'critical', scope: 'model', modelKey: 'm0', text: '\u{1F525} Fire 你好 \x1b[5mblink\x1b[0m café → ok' }],
    telemetry: { at: null, stale: true, error: '\u{1F4A5} boom', known: false },
  }),
  'nulls everywhere': { machines: [null, { modelKey: null }], residents: [null, {}], alerts: [null, { text: null }, { text: 'kept' }], switchboard: null, reactor: undefined, generator: null },
  'generator without numbers': baseState({ generator: { present: true, running: true, utilization: null, usedCredits: null, monthlyLimit: null, currency: null }, power: 'emergency' }),
};

test('hand-built states: >100%, no readings, nulls, 0/9 machines, 40 residents, hostile text', () => {
  const sizes = [[1, 1], [10, 3], [36, 16], [48, 24], [60, 40], [100, 50]];
  for (const [name, state] of Object.entries(EDGE)) {
    for (const [cols, rows] of sizes) {
      for (const color of [true, false]) {
        for (const frame of [0, 3]) checkSize(renderCompact(state, { cols, rows, color, frame }), cols, rows, `${name} ${cols}x${rows}`);
      }
    }
  }
  assert.doesNotThrow(() => renderCompact(null, { cols: 40, rows: 10 }));
  assert.doesNotThrow(() => renderCompact(EDGE.empty, { cols: 'x', rows: NaN, frame: -9 }));
  assert.doesNotThrow(() => renderCompact(EDGE.empty));
});

test('missing allowance data says so instead of showing 0%', () => {
  const text = renderCompact(EDGE['no readings yet'], { cols: 48, rows: 24, color: false }).join('\n');
  assert.match(text, /Session .*no data/);
  assert.match(text, /Weekly .*no data/);
  assert.doesNotMatch(text, /(?<!\d)0%/);
  assert.match(text, /Waiting for the first allowance reading/);
});

test('percentages over 100 keep the bar inside the row', () => {
  const lines = renderCompact(EDGE['over 100 percent'], { cols: 48, rows: 24, color: false });
  const text = lines.join('\n');
  assert.match(text, /187%/);
  assert.match(text, /250%/);
  assert.match(text, /PIT STOP/);
});

test('crowded machines collapse into a count and keep the hottest visible', () => {
  const all = renderCompact(EDGE['nine machines'], { cols: 36, rows: 16, color: false }).join('\n');
  assert.match(all, /Model0[\s\S]*Model8/, 'nine machines fit in 16 rows');
  const nine = renderCompact(EDGE['nine machines'], { cols: 36, rows: 10, color: false }).join('\n');
  assert.match(nine, /\+\d+ more machines?/);
  assert.match(nine, /88%/, 'the hottest machine (m8 at 88%) stays');
  assert.match(nine, /Session .*40%/);
  assert.match(nine, /Weekly .*20%/);
  const crowd = renderCompact(EDGE['forty residents on one machine'], { cols: 60, rows: 40, color: false }).join('\n');
  assert.match(crowd, /\+\d+ more/);
});

// ───────────────────────────── notices ─────────────────────────────

test('notice screens fit every size and explain how to recover', () => {
  const notices = [
    { kind: 'unreachable', url: 'http://127.0.0.1:4780', detail: 'connection refused', attempt: 7 },
    { kind: 'refused', url: 'http://127.0.0.1:4780', status: 403, detail: 'Forbidden' },
    { kind: 'version', url: 'http://127.0.0.1:4780', version: 2 },
    { kind: 'invalid', url: 'http://127.0.0.1:4780', detail: '\u{1F4A5} bad' },
    { kind: 'connecting', url: 'http://127.0.0.1:4780' },
    null,
  ];
  for (const n of notices) {
    for (const [cols, rows] of [[1, 1], [10, 3], [36, 8], [...SIZES[0]], ...SIZES.slice(1)]) {
      for (const color of [true, false]) checkSize(renderNotice(n, { cols, rows, color, frame: 2 }), cols, rows, `notice ${n?.kind} ${cols}x${rows}`);
    }
  }
  const down = flat(renderNotice(notices[0], { cols: 48, rows: 24, color: false }));
  assert.match(down, /Cannot reach the shelter server/);
  assert.match(down, /npm start/);
  assert.match(down, /--sim tour/);
  assert.match(down, /Retrying/);
  assert.match(flat(renderNotice(notices[2], { cols: 48, rows: 24, color: false })), /Versions differ/);
  assert.doesNotMatch(flat(renderNotice({ ...notices[0], once: true }, { cols: 48, rows: 24, color: false })), /Retrying/);
});

// ───────────────────────────── app pieces ─────────────────────────────

test('argument parsing', () => {
  assert.equal(parseArgs([]).url, 'http://127.0.0.1:4780');
  assert.equal(parseArgs(['--url', 'localhost:9000/']).url, 'http://localhost:9000');
  assert.equal(parseArgs(['--sim']).sim, 'tour');
  assert.equal(parseArgs(['--sim', 'calm', '--once']).sim, 'calm');
  assert.equal(parseArgs(['--sim=busy', '--what-if=2']).whatIf, 2);
  assert.equal(parseArgs(['--no-color']).color, false);
  assert.equal(parseArgs([], { NO_COLOR: '1' }).color, false);
  assert.equal(parseArgs([], { COLORTERM: 'truecolor' }).color, 'truecolor');
  const o = parseArgs(['--sim', 'tour', '--once', '--cols', '48', '--rows', '24', '--at', '30']);
  assert.deepEqual([o.cols, o.rows, o.at, o.once], [48, 24, 30, true]);
  assert.throws(() => parseArgs(['--sim', 'nope']), UsageError);
  assert.throws(() => parseArgs(['--what-if', '0']), UsageError);
  assert.throws(() => parseArgs(['--bogus']), UsageError);
  assert.throws(() => parseArgs(['--url', 'x', '--sim']), UsageError);
});

test('what-if steps', () => {
  assert.equal(stepWhatIf(1, 1), 1.25);
  assert.equal(stepWhatIf(1, -1), 0.75);
  assert.equal(stepWhatIf(1.1, 1), 1.25);
  assert.equal(stepWhatIf(10, 1), 10);
  assert.equal(stepWhatIf(0.25, -1), 0.25);
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('fetchSnapshot: ok, version mismatch, refused, not JSON, unreachable', async () => {
  const snap = scenarioSnapshot('tour', 30, Date.now());
  const routes = {
    '/ok/api/snapshot': [200, JSON.stringify(snap)],
    '/v2/api/snapshot': [200, JSON.stringify({ ...snap, v: 2 })],
    '/deny/api/snapshot': [403, 'Forbidden: cross-origin request\n'],
    '/html/api/snapshot': [200, '<html></html>'],
  };
  const { server, base } = await serve((req, res) => {
    const [status, body] = routes[req.url] ?? [404, '{"error":"not found"}'];
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  try {
    const ok = await fetchSnapshot(`${base}/ok`);
    assert.equal(ok.ok, true);
    assert.equal(ok.snapshot.v, 1);
    assert.equal((await fetchSnapshot(`${base}/v2`)).notice.kind, 'version');
    const deny = await fetchSnapshot(`${base}/deny`);
    assert.equal(deny.notice.kind, 'refused');
    assert.equal(deny.notice.status, 403);
    assert.equal((await fetchSnapshot(`${base}/html`)).notice.kind, 'invalid');
    assert.equal((await fetchSnapshot(`${base}/missing`)).notice.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
  const closed = await serve(() => {});
  const port = closed.server.address().port;
  await new Promise((r) => closed.server.close(r));
  const down = await fetchSnapshot(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
  assert.equal(down.ok, false);
  assert.equal(down.notice.kind, 'unreachable');
});

// ───────────────────────────── the CLI ─────────────────────────────

const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/shelter-tui.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NO_COLOR: '' } });

test('CLI --once renders one sensible frame and exits 0', () => {
  const r = cli(['--sim', 'tour', '--once', '--cols', '48', '--rows', '24', '--at', '30']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.replace(/\n$/, '').split('\n');
  checkSize(lines, 48, 24, 'cli');
  const text = flat(lines);
  assert.match(text, /TOKEN SHELTER/);
  assert.match(text, /Fable .*100%/);
  assert.match(text, /FIRE/);
  assert.match(text, /Fable machine is down: allowance used up\./);
  assert.ok(r.stdout.includes('\x1b['), 'colour by default, even when piped');

  const plain = cli(['--sim', 'tour', '--once', '--cols', '36', '--rows', '16', '--at', '90', '--no-color']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!plain.stdout.includes('\x1b'), 'no escapes with --no-color');
  assert.match(plain.stdout, /EMERGENCY/);
  checkSize(plain.stdout.replace(/\n$/, '').split('\n'), 36, 16, 'cli plain');
});

test('CLI rejects unknown scenarios and options with exit 2', () => {
  const r = cli(['--sim', 'nope', '--once']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown scenario/);
  assert.equal(cli(['--frobnicate']).status, 2);
  assert.equal(cli(['--help']).status, 0);
});

test('CLI --once against a server that is not there explains and exits 1', async () => {
  const closed = await serve(() => {});
  const port = closed.server.address().port;
  await new Promise((r) => closed.server.close(r));
  const r = cli(['--url', `http://127.0.0.1:${port}`, '--once', '--cols', '48', '--rows', '20', '--no-color']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Cannot reach the shelter server/);
  assert.match(r.stdout, /npm start/);
});
