import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentTracker, clip } from '../src/collector/agents.mjs';
import { buildModels, createCollector } from '../src/collector/collector.mjs';
import { claudeConfigDir, dataDirOf, loadConfig, normalizeConfig } from '../src/collector/config.mjs';
import { LimitsTracker } from '../src/collector/limits.mjs';
import { SampleStore, isReset } from '../src/collector/samples.mjs';
import { SessionReader, findTranscript, pidAlive } from '../src/collector/sessions.mjs';
import { JsonlTail } from '../src/collector/tail.mjs';
import { TranscriptStats, activityForTool, withAgentType } from '../src/collector/transcript.mjs';
import { PROBE_ARGS, createCliProbe, mapUsageReport, parseResetTime, parseUsageOutput } from '../src/collector/usage.mjs';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 22, 0, 0);
const SESSION = '11111111-2222-4333-8444-555555555555';
const CWD = '/home/dev/projects/bunker-7';
const SLUG = '-home-dev-projects-bunker-7';

// ───────────────────────────── fixture helpers ─────────────────────────────

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelter-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake Claude Code config dir with a movable clock and a set of "alive" pids. */
function fixture(t) {
  const configDir = path.join(tempDir(t), 'claude');
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'projects', SLUG), { recursive: true });
  const fx = {
    configDir,
    t: T0,
    alive: new Set(),
    now: () => fx.t,
    isAlive: (pid) => fx.alive.has(pid),
    transcript: (sessionId = SESSION) => path.join(configDir, 'projects', SLUG, `${sessionId}.jsonl`),
    subDir: (sessionId = SESSION) => path.join(configDir, 'projects', SLUG, sessionId, 'subagents'),
    session(over = {}) {
      const s = {
        pid: 4242, sessionId: SESSION, cwd: CWD, startedAt: T0 - 10 * MIN, name: 'bunker-7',
        nameSource: 'derived', status: 'busy', updatedAt: fx.t, statusUpdatedAt: fx.t,
        kind: 'interactive', entrypoint: 'cli', version: '2.1.325', ...over,
      };
      fs.writeFileSync(path.join(configDir, 'sessions', `${s.pid}.json`), JSON.stringify(s));
      fx.alive.add(s.pid);
      return s;
    },
    append(file, ...entries) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, entries.map((e) => `${typeof e === 'string' ? e : JSON.stringify(e)}\n`).join(''));
    },
    sub(agentId, meta = {}, sessionId = SESSION) {
      const dir = fx.subDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({
        agentType: 'general-purpose', description: `Task ${agentId}`, toolUseId: `toolu_${agentId}`, spawnDepth: 1, ...meta,
      }));
      return path.join(dir, `agent-${agentId}.jsonl`);
    },
    tracker: (over = {}) => new AgentTracker({ configDir, isAlive: fx.isAlive, ...over }),
  };
  return fx;
}

let seq = 0;
/** One transcript line of an assistant message (one content block per line, as Claude Code writes them). */
function assistant({ id = `msg_${++seq}`, at = T0, model = 'claude-fable-5-2', usage, block, sidechain = false } = {}) {
  return {
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    isSidechain: sidechain,
    uuid: `uuid-${++seq}`,
    message: {
      id, model, role: 'assistant', stop_reason: 'tool_use',
      usage: usage ?? { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 },
      content: [block ?? { type: 'text', text: 'ok' }],
    },
  };
}
const toolUse = (name, id = `toolu_${++seq}`) => ({ type: 'tool_use', id, name, input: {} });
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
});

/** The usage_report from the task's verified facts (Claude Code 2.1.325). */
const REPORT = {
  session: {},
  rate_limits: {
    limits: [
      { kind: 'session', group: 'session', percent: 7, resets_at: '2026-11-16T02:40:00.699822+00:00', scope: null, severity: 'normal', is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 20, resets_at: '2026-11-21T10:00:00.699851+00:00', scope: null, severity: 'normal', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 39, resets_at: '2026-11-21T10:00:00.700190+00:00', scope: { model: { display_name: 'Fable' }, surface: null }, severity: 'normal', is_active: true },
    ],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
  },
};
const reportWith = (percents, resets = {}) => {
  const r = structuredClone(REPORT);
  r.rate_limits.limits.forEach((row, i) => {
    if (percents[i] != null) row.percent = percents[i];
    if (resets[i]) row.resets_at = resets[i];
  });
  return r;
};

// ───────────────────────────── transcript tailing ─────────────────────────────

test('tail: reads only what was appended and waits for a partial last line', (t) => {
  const file = path.join(tempDir(t), 'a.jsonl');
  const tail = new JsonlTail(file);
  const lines = [];
  const poll = () => tail.poll((l) => lines.push(l));

  assert.equal(poll(), 0, 'a missing file is not an error');
  assert.equal(tail.exists, false);

  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3,"text":"par');
  poll();
  assert.deepEqual(lines, ['{"n":1}', '{"n":2}']);
  assert.equal(tail.offset, 16, 'offset stops at the start of the unfinished line');

  poll();
  assert.equal(lines.length, 2, 'nothing new: nothing delivered twice');

  fs.appendFileSync(file, 'tial"}\n{"n":4}\n');
  poll();
  assert.deepEqual(lines.slice(2), ['{"n":3,"text":"partial"}', '{"n":4}']);
  assert.equal(tail.offset, fs.statSync(file).size);
});

test('tail: lines longer than a read chunk and multi-byte text survive intact', (t) => {
  const file = path.join(tempDir(t), 'big.jsonl');
  // 2-byte and 4-byte characters, long enough that chunk boundaries fall inside them.
  const big = JSON.stringify({ text: 'ž🙂'.repeat(450_000) });
  assert.ok(Buffer.byteLength(big) > 2 * (1 << 20));
  fs.writeFileSync(file, `${big}\n{"after":true}\n`);
  const lines = [];
  new JsonlTail(file).poll((l) => lines.push(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], big);
  assert.equal(lines[1], '{"after":true}');
});

test('tail: a file that shrank is read again from the start', (t) => {
  const file = path.join(tempDir(t), 'a.jsonl');
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const tail = new JsonlTail(file);
  const lines = [];
  let resets = 0;
  const poll = () => tail.poll((l) => lines.push(l), () => { resets++; lines.length = 0; });
  poll();
  assert.equal(resets, 0);
  fs.writeFileSync(file, '{"n":9}\n');
  poll();
  assert.equal(resets, 1);
  assert.deepEqual(lines, ['{"n":9}']);
});

// ───────────────────────────── transcript contents ─────────────────────────────

test('transcript: usage is counted once per message id', () => {
  const s = new TranscriptStats();
  const u = usage(2, 571, 29148, 17845);
  // One API message written as three lines (thinking, text, tool_use) with identical usage.
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_A', usage: u, block: { type: 'thinking', thinking: '...' } })));
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_A', usage: u, block: { type: 'text', text: 'hi' } })));
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_A', usage: u, block: toolUse('Bash') })));
  assert.deepEqual(s.tokens, { input: 2, output: 571, cacheRead: 29148, cacheWrite: 17845 });

  s.consumeLine(JSON.stringify(assistant({ id: 'msg_B', usage: usage(1, 100, 50, 5) })));
  assert.deepEqual(s.tokens, { input: 3, output: 671, cacheRead: 29198, cacheWrite: 17850 });
  assert.equal(s.byId.size, 2);
});

test('transcript: when lines of one message disagree, the last one wins (no double count)', () => {
  const s = new TranscriptStats();
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_A', usage: usage(5, 1, 100, 0) })));
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_A', usage: usage(5, 250, 100, 0) })));
  assert.deepEqual(s.tokens, { input: 5, output: 250, cacheRead: 100, cacheWrite: 0 });
});

test('transcript: synthetic messages are skipped entirely', () => {
  const s = new TranscriptStats();
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_A', usage: usage(1, 2, 3, 4), block: toolUse('Read') })));
  s.consumeLine(JSON.stringify(assistant({ id: 'msg_S', model: '<synthetic>', usage: usage(999, 999, 999, 999), block: toolUse('Bash') })));
  assert.deepEqual(s.tokens, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.equal(s.model, 'claude-fable-5-2');
  assert.equal(s.tool, 'Read', 'a synthetic entry does not change the activity either');
});

test('transcript: title, model hints, sidechains, junk lines', () => {
  const main = new TranscriptStats({ main: true });
  main.consumeLine('{"type":"mode","mode":"normal"}');
  main.consumeLine('not json at all');
  main.consumeLine('{"type":"assistant", broken');
  main.consumeLine(JSON.stringify({ type: 'user', message: { content: 'please print "type":"assistant"' } }));
  main.consumeLine(JSON.stringify({ type: 'ai-title', aiTitle: 'First title' }));
  main.consumeLine(JSON.stringify({ type: 'ai-title', aiTitle: '  Build the reactor  ' }));
  assert.equal(main.title, 'Build the reactor');
  assert.equal(main.model, null);

  main.consumeLine(JSON.stringify({ type: 'api-request', timestamp: new Date(T0).toISOString(), params: { model: 'claude-opus-5-5' } }));
  assert.equal(main.requestedModel, 'claude-opus-5-5', 'the request names the model before any reply exists');
  assert.equal(main.firstTs, T0);

  // In a main transcript a sidechain entry belongs to a subagent.
  main.consumeLine(JSON.stringify(assistant({ sidechain: true, usage: usage(7, 7, 7, 7) })));
  assert.deepEqual(main.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // A subagent's own transcript is all sidechain entries, and they count.
  const sub = new TranscriptStats();
  sub.consumeLine(JSON.stringify(assistant({ sidechain: true, usage: usage(7, 7, 7, 7) })));
  assert.equal(sub.tokens.input, 7);
});

test('transcript: rate is tokens per minute over the trailing 60 s', () => {
  const s = new TranscriptStats();
  s.consumeLine(JSON.stringify(assistant({ at: T0 - 5 * MIN, usage: usage(1000, 1000, 1000, 1000) })));
  s.consumeLine(JSON.stringify(assistant({ at: T0 - 50_000, usage: usage(10, 200, 3000, 77) })));
  s.consumeLine(JSON.stringify(assistant({ at: T0 - 5_000, usage: usage(5, 100, 1000, 33) })));
  assert.deepEqual(s.rate(T0), { input: 15, output: 300, cacheRead: 4000 });
  assert.deepEqual(s.rate(T0 + 30_000), { input: 5, output: 100, cacheRead: 1000 });
  assert.deepEqual(s.rate(T0 + 2 * MIN), { input: 0, output: 0, cacheRead: 0 });
  assert.equal(s.tokens.output, 1300, 'the cumulative totals are untouched');
});

test('activity: tool names map to shelter activities', () => {
  const expected = {
    Edit: 'code', Write: 'code', NotebookEdit: 'code',
    Bash: 'shell',
    Read: 'research', Grep: 'research', Glob: 'research', ToolSearch: 'research',
    WebFetch: 'web', WebSearch: 'web',
    Agent: 'delegate', Task: 'delegate', SendMessage: 'delegate', Workflow: 'delegate',
    EnterPlanMode: 'plan', ExitPlanMode: 'plan', TodoWrite: 'plan', AskUserQuestion: 'plan',
    // No station for these: they read as thinking.
    Skill: 'think', SubagentHandback: 'think', mcp__browser__navigate: 'think',
  };
  for (const [tool, activity] of Object.entries(expected)) assert.equal(activityForTool(tool), activity, tool);

  const s = new TranscriptStats();
  s.consumeLine(JSON.stringify(assistant({ block: toolUse('Edit') })));
  assert.deepEqual([s.activity, s.tool], ['code', 'Edit']);
  s.consumeLine(JSON.stringify(assistant({ block: { type: 'thinking', thinking: 'hm' } })));
  assert.deepEqual([s.activity, s.tool], ['think', 'Edit'], 'thinking after a tool: think, but the last tool is remembered');
  s.consumeLine(JSON.stringify(assistant({ block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } })));
  assert.deepEqual([s.activity, s.tool], ['web', 'web_search']);
});

test('activity: reviewer agents review instead of code / research / think', () => {
  for (const a of ['code', 'research', 'think']) assert.equal(withAgentType(a, 'Code-Reviewer'), 'review');
  for (const a of ['shell', 'web', 'plan', 'delegate', 'idle']) assert.equal(withAgentType(a, 'code-reviewer'), a);
  assert.equal(withAgentType('code', 'general-purpose'), 'code');
  assert.equal(withAgentType('code', null), 'code');
});

// ───────────────────────────── sessions ─────────────────────────────

test('sessions: only live processes count', (t) => {
  const fx = fixture(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;   // has exited by now
  fx.session({ pid: process.pid, sessionId: 'alive-session' });
  fx.session({ pid: dead, sessionId: 'dead-session' });
  // Not session files: must be ignored, not parsed.
  fs.writeFileSync(path.join(fx.configDir, 'sessions', `${process.pid}.a678d7b0.key`), 'secret');
  fs.writeFileSync(path.join(fx.configDir, 'sessions', 'notes.json'), '{"sessionId":"x","pid":1}');

  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(dead), false);
  assert.equal(pidAlive(-1), false);
  const sessions = new SessionReader({ configDir: fx.configDir }).read();   // real liveness check
  assert.deepEqual(sessions.map((s) => s.sessionId), ['alive-session']);
  assert.equal(sessions[0].cwd, CWD);
  assert.equal(sessions[0].status, 'busy');
});

test('sessions: a file caught mid-write keeps its last good contents', (t) => {
  const fx = fixture(t);
  fx.session({ status: 'busy' });
  const reader = new SessionReader({ configDir: fx.configDir, isAlive: fx.isAlive });
  assert.equal(reader.read().length, 1);
  fs.writeFileSync(path.join(fx.configDir, 'sessions', '4242.json'), '{"pid":4242,"sessio');
  assert.deepEqual(reader.read().map((s) => s.status), ['busy'], 'still listed from the previous read');
  fs.rmSync(path.join(fx.configDir, 'sessions', '4242.json'));
  assert.equal(reader.read().length, 0, 'the file is gone: so is the session');
});

test('sessions: excluded directories and pids (the usage probe) never show up', (t) => {
  const fx = fixture(t);
  fx.session({ pid: 1, sessionId: 'real' });
  fx.session({ pid: 2, sessionId: 'probe-by-cwd', cwd: '/tmp/token-shelter-probe' });
  fx.session({ pid: 3, sessionId: 'probe-by-pid', cwd: '/somewhere/else' });
  const reader = new SessionReader({
    configDir: fx.configDir, isAlive: fx.isAlive,
    excludeCwds: ['/tmp/token-shelter-probe'], excludePids: () => [3],
  });
  assert.deepEqual(reader.read().map((s) => s.sessionId), ['real']);
});

test('sessions: the transcript is found by slug, or by searching every project', (t) => {
  const fx = fixture(t);
  fx.append(fx.transcript(), { type: 'mode' });
  assert.equal(findTranscript(fx.configDir, SESSION, CWD), fx.transcript());
  assert.equal(findTranscript(fx.configDir, SESSION, '/moved/elsewhere'), fx.transcript(), 'cwd changed since');
  assert.equal(findTranscript(fx.configDir, 'no-such-session', CWD), null);
  assert.equal(findTranscript(fx.configDir, '../../etc/passwd', CWD), null, 'ids are never used as paths blindly');
});

// ───────────────────────────── agents ─────────────────────────────

test('agents: a live session becomes a main agent', (t) => {
  const fx = fixture(t);
  const session = fx.session();
  const longTitle = 'Design the water purification subsystem and wire it into the reactor cooling loop today';
  fx.append(fx.transcript(),
    { type: 'mode', mode: 'normal' },
    { type: 'ai-title', aiTitle: longTitle },
    assistant({ id: 'm1', at: T0 - 30_000, usage: usage(2, 500, 29000, 17000), block: { type: 'thinking', thinking: '…' } }),
    assistant({ id: 'm1', at: T0 - 29_000, usage: usage(2, 500, 29000, 17000), block: toolUse('Bash') }),
    assistant({ id: 'm2', at: T0 - 10_000, usage: usage(3, 100, 46000, 900), block: toolUse('Edit') }));
  const tracker = fx.tracker();
  const [main, ...rest] = tracker.update(fx.now());

  assert.equal(rest.length, 0);
  assert.deepEqual(main, {
    id: SESSION, sessionId: SESSION, parentId: null, kind: 'main',
    name: 'bunker-7', agentType: null, project: 'bunker-7',
    model: 'claude-fable-5-2', modelKey: 'fable',
    status: 'working', activity: 'code', tool: 'Edit',
    task: main.task,
    startedAt: session.startedAt, lastActiveAt: T0, finishedAt: null,
    tokens: { input: 5, output: 600, cacheRead: 75000, cacheWrite: 17900 },
    rate: { input: 5, output: 600, cacheRead: 75000 },
  });
  assert.equal(main.task.length, 80);
  assert.ok(main.task.startsWith('Design the water purification subsystem'));

  // Waiting for the user: idle, whatever it did last. Only the new bytes are read.
  fx.t += 5_000;
  fx.session({ status: 'idle' });
  fx.append(fx.transcript(), assistant({ id: 'm3', at: fx.t - 1000, usage: usage(1, 50, 100, 0), block: { type: 'text', text: 'done' } }));
  const [later] = tracker.update(fx.now());
  assert.deepEqual([later.status, later.activity, later.tool], ['waiting', 'idle', 'Edit']);
  assert.equal(later.tokens.output, 650);
});

test('agents: dead sessions are not listed, and a session without a transcript still is', (t) => {
  const fx = fixture(t);
  fx.session({ pid: 100, sessionId: 'fresh-session', status: 'idle', name: undefined });
  fx.session({ pid: 200, sessionId: 'crashed-session' });
  fx.alive.delete(200);   // the file is still there, the process is not
  fs.writeFileSync(path.join(fx.configDir, 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));

  const agents = fx.tracker().update(fx.now());
  assert.equal(agents.length, 1);
  const [a] = agents;
  assert.equal(a.id, 'fresh-session');
  assert.deepEqual([a.status, a.activity, a.tool, a.task], ['waiting', 'idle', null, null]);
  assert.equal(a.name, 'bunker-7', 'no session name: falls back to the project');
  assert.deepEqual([a.model, a.modelKey], ['opus[1m]', 'opus'], 'no request yet: the configured default model');
  assert.deepEqual(a.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('agents: a session with no model information at all is "unknown", not a guess', (t) => {
  const fx = fixture(t);
  fx.session({ status: 'idle' });
  const [a] = fx.tracker().update(fx.now());
  assert.deepEqual([a.model, a.modelKey], ['', 'unknown']);
  assert.ok(!buildModels([a], []).some((m) => m.key === 'unknown'), 'and it gets no machine');
});

test('agents: subagent running -> done -> dropped', (t) => {
  const fx = fixture(t);
  fx.session();
  fx.append(fx.transcript(), assistant({ at: T0 - MIN, block: toolUse('Agent', 'toolu_run1') }));
  // Finished before the collector started: never listed.
  fx.append(fx.sub('old1', { finished: true }), assistant({ at: T0 - 5 * MIN, sidechain: true }));
  const runFile = fx.sub('run1', { agentType: 'Explore', description: 'Map the tunnels' });
  fx.append(runFile,
    { type: 'api-request', timestamp: new Date(T0 - 40_000).toISOString(), params: { model: 'claude-haiku-5-5' } },
    assistant({ id: 's1', at: T0 - 20_000, model: 'claude-haiku-5-5', sidechain: true, usage: usage(4, 40, 400, 4000), block: toolUse('Grep') }));

  const tracker = fx.tracker();
  let agents = tracker.update(fx.now());
  assert.deepEqual(agents.map((a) => a.id), [SESSION, `${SESSION}:run1`]);
  const sub = agents[1];
  assert.deepEqual(
    { ...sub, rate: null },
    {
      id: `${SESSION}:run1`, sessionId: SESSION, parentId: SESSION, kind: 'sub',
      name: 'Map the tunnels', agentType: 'Explore', project: 'bunker-7',
      model: 'claude-haiku-5-5', modelKey: 'haiku',
      status: 'working', activity: 'research', tool: 'Grep', task: 'Map the tunnels',
      startedAt: T0 - 40_000, lastActiveAt: T0 - 20_000, finishedAt: null,
      tokens: { input: 4, output: 40, cacheRead: 400, cacheWrite: 4000 },
      rate: null,
    });

  // A subagent that starts and finishes between two ticks did finish while we watched.
  fx.t += 5_000;
  fx.sub('quick', { finished: true });
  agents = tracker.update(fx.now());
  assert.deepEqual(agents.map((a) => [a.id.split(':')[1] ?? 'main', a.status]), [['main', 'working'], ['run1', 'working'], ['quick', 'done']]);

  // run1 finishes: more tokens arrive with the final message, then the meta flips.
  fx.t += 5_000;
  fx.append(runFile, assistant({ id: 's2', at: fx.t - 500, model: 'claude-haiku-5-5', sidechain: true, usage: usage(1, 60, 0, 0) }));
  fx.sub('run1', { agentType: 'Explore', description: 'Map the tunnels', finished: true });
  agents = tracker.update(fx.now());
  const done = agents.find((a) => a.id.endsWith(':run1'));
  assert.deepEqual([done.status, done.activity, done.finishedAt], ['done', 'idle', fx.t]);
  assert.equal(done.tokens.output, 100);
  const finishedAt = fx.t;

  fx.t = finishedAt + 29_000;
  assert.ok(tracker.update(fx.now()).some((a) => a.id.endsWith(':run1')), 'still clocking out after 29 s');
  fx.t = finishedAt + 30_000;
  assert.deepEqual(tracker.update(fx.now()).map((a) => a.id), [SESSION], 'gone after 30 s (quick left earlier)');
  fx.t += 10 * MIN;
  assert.deepEqual(tracker.update(fx.now()).map((a) => a.id), [SESSION], 'and never comes back');
});

test('agents: a finished subagent that is resumed comes back with complete totals', (t) => {
  const fx = fixture(t);
  fx.session();
  fx.append(fx.transcript(), assistant({ at: T0 - MIN }));
  const file = fx.sub('r1');
  fx.append(file, assistant({ id: 'r1a', at: T0 - 5_000, sidechain: true, usage: usage(1, 10, 0, 0), block: toolUse('Read') }));
  const tracker = fx.tracker();
  const find = () => tracker.update(fx.now()).find((a) => a.id === `${SESSION}:r1`);
  assert.equal(find().status, 'working');

  // Finished, then resumed while still clocking out.
  fx.t += 5_000;
  fx.sub('r1', { finished: true });
  assert.equal(find().status, 'done');
  fx.t += 5_000;
  fx.sub('r1', {});
  fx.append(file, assistant({ id: 'r1b', at: fx.t - 500, sidechain: true, usage: usage(1, 20, 0, 0), block: toolUse('Bash') }));
  let r1 = find();
  assert.deepEqual([r1.status, r1.activity, r1.finishedAt, r1.tokens.output], ['working', 'shell', null, 30]);

  // Finished and gone, then resumed again: listed again, and nothing it did is lost.
  fx.t += 5_000;
  fx.sub('r1', { finished: true });
  assert.equal(find().status, 'done');
  fx.t += 30_000;
  assert.equal(find(), undefined);
  fx.t += 10 * MIN;
  assert.equal(find(), undefined, 'an unchanged meta file keeps it away');
  fx.sub('r1', {});
  fx.append(file, assistant({ id: 'r1c', at: fx.t - 500, sidechain: true, usage: usage(1, 40, 0, 0) }));
  r1 = find();
  assert.deepEqual([r1.status, r1.finishedAt, r1.tokens.output, r1.tokens.input], ['working', null, 70, 3]);
});

test('agents: a subagent that finished before the collector started appears once it is resumed', (t) => {
  const fx = fixture(t);
  fx.session();
  fx.append(fx.transcript(), assistant({ at: T0 - MIN }));
  const file = fx.sub('old', { finished: true });
  fx.append(file, assistant({ id: 'o1', at: T0 - 20 * MIN, sidechain: true, usage: usage(2, 200, 0, 0) }));
  const tracker = fx.tracker();
  assert.deepEqual(tracker.update(fx.now()).map((a) => a.id), [SESSION]);
  fx.t += MIN;
  assert.deepEqual(tracker.update(fx.now()).map((a) => a.id), [SESSION]);

  fx.t += MIN;
  fx.sub('old', {});
  fx.append(file, assistant({ id: 'o2', at: fx.t - 500, sidechain: true, usage: usage(1, 50, 0, 0), block: toolUse('Grep') }));
  const old = tracker.update(fx.now()).find((a) => a.id === `${SESSION}:old`);
  assert.deepEqual([old.status, old.activity, old.tokens.output], ['working', 'research', 250]);
});

test('agents: subagents leave with their session', (t) => {
  const fx = fixture(t);
  fx.session();
  fx.append(fx.transcript(), assistant({ at: T0 - MIN }));
  fx.append(fx.sub('run1'), assistant({ at: T0 - 1000, sidechain: true }));
  const tracker = fx.tracker();
  assert.equal(tracker.update(fx.now()).length, 2);
  fx.alive.delete(4242);
  assert.deepEqual(tracker.update(fx.now()), []);
});

test('agents: subagents left unfinished by an earlier run of the session are not revived', (t) => {
  const fx = fixture(t);
  fx.session({ startedAt: T0 - 10 * MIN });   // resumed 10 minutes ago
  fx.append(fx.transcript(), assistant({ at: T0 - MIN }));
  fx.append(fx.sub('orphan'), assistant({ at: T0 - 3 * HOUR, sidechain: true }));   // no `finished`, but long dead
  fx.append(fx.sub('current'), assistant({ at: T0 - 2 * MIN, sidechain: true }));
  assert.deepEqual(fx.tracker().update(fx.now()).map((a) => a.id), [SESSION, `${SESSION}:current`]);
});

test('agents: subagent model falls back to its alias, then to the parent', (t) => {
  const fx = fixture(t);
  fx.session();
  fx.append(fx.transcript(), assistant({ at: T0 - MIN, model: 'claude-opus-5-5' }));
  fx.sub('a1', { model: 'haiku' });                // alias, no transcript yet
  fx.sub('a2', {});                                // nothing: inherits the parent's model
  fx.sub('a3', { model: 'some-future-alias' });    // unknown alias must not invent a machine
  const byId = Object.fromEntries(fx.tracker().update(fx.now()).map((a) => [a.id.split(':')[1] ?? 'main', a]));
  assert.deepEqual([byId.a1.model, byId.a1.modelKey], ['haiku', 'haiku']);
  assert.deepEqual([byId.a2.model, byId.a2.modelKey], ['claude-opus-5-5', 'opus']);
  assert.deepEqual([byId.a3.model, byId.a3.modelKey], ['claude-opus-5-5', 'opus']);
  assert.equal(byId.a1.activity, 'think', 'nothing done yet');
  assert.equal(byId.a1.startedAt, T0, 'no timestamps yet: when it was first seen');
});

test('agents: reviewers review, and nested subagents point at their spawner', (t) => {
  const fx = fixture(t);
  fx.session();
  fx.append(fx.transcript(), assistant({ at: T0 - MIN, block: toolUse('Agent', 'toolu_lead') }));
  fx.append(fx.sub('lead', { toolUseId: 'toolu_lead', agentType: 'code-reviewer' }),
    assistant({ at: T0 - 50_000, sidechain: true, block: toolUse('Read') }),
    assistant({ at: T0 - 40_000, sidechain: true, block: toolUse('Agent', 'toolu_helper') }));
  fx.append(fx.sub('helper', { toolUseId: 'toolu_helper', spawnDepth: 2, agentType: 'security-review' }),
    assistant({ at: T0 - 30_000, sidechain: true, block: toolUse('Bash') }),
    assistant({ at: T0 - 20_000, sidechain: true, block: toolUse('Edit') }));
  const [, lead, helper] = fx.tracker().update(fx.now());
  assert.deepEqual([lead.parentId, lead.activity], [SESSION, 'delegate']);
  assert.deepEqual([helper.parentId, helper.activity, helper.tool], [`${SESSION}:lead`, 'review', 'Edit']);
});

test('clip: one line, at most 80 characters', () => {
  assert.equal(clip('  short\n  text '), 'short text');
  assert.equal(clip('x'.repeat(80)).length, 80);
  const long = clip('word '.repeat(40));
  assert.equal(long.length <= 80, true);
  assert.ok(long.endsWith('…'));
  assert.equal(clip(''), null);
  assert.equal(clip(undefined), null);
});

// ───────────────────────────── plan allowances ─────────────────────────────

test('usage: the CLI report maps to limit rows', () => {
  const { rows, extra } = mapUsageReport(REPORT);
  assert.deepEqual(rows, [
    { id: 'session', scope: 'session', modelKey: null, label: 'Session', percent: 7,
      resetsAt: Date.UTC(2026, 10, 16, 2, 40, 0), ratePctPerHour: null, severity: 'normal', active: false },
    { id: 'weekly', scope: 'weekly', modelKey: null, label: 'Weekly (all models)', percent: 20,
      resetsAt: Date.UTC(2026, 10, 21, 10, 0, 0), ratePctPerHour: null, severity: 'normal', active: false },
    { id: 'model:fable', scope: 'model', modelKey: 'fable', label: 'Fable weekly', percent: 39,
      resetsAt: Date.UTC(2026, 10, 21, 10, 0, 0), ratePctPerHour: null, severity: 'normal', active: true },
  ]);
  assert.deepEqual(extra, { enabled: false, utilization: null, usedCredits: null, monthlyLimit: null, currency: null });
  // The two weekly rows differ in their sub-second digits; as numbers they are the same instant.
  assert.equal(rows[1].resetsAt, rows[2].resetsAt);
});

test('usage: reset times ignore sub-second noise', () => {
  assert.equal(parseResetTime('2026-11-16T02:40:00.106086+00:00'), Date.UTC(2026, 10, 16, 2, 40, 0));
  assert.equal(parseResetTime('2026-11-16T02:40:00.106086+00:00'), parseResetTime('2026-11-16T02:40:00.699822+00:00'));
  assert.equal(parseResetTime('2026-11-16T03:40:00+01:00'), Date.UTC(2026, 10, 16, 2, 40, 0));
  // Seen on the real CLI: two rows of one report, a second apart around the same reset.
  assert.equal(parseResetTime('2026-11-21T09:59:59.816318+00:00'), Date.UTC(2026, 10, 21, 10, 0, 0));
  assert.equal(parseResetTime('2026-11-21T10:00:00.816057+00:00'), Date.UTC(2026, 10, 21, 10, 0, 0));
  assert.equal(parseResetTime(null), null);
  assert.equal(parseResetTime('soon'), null);
});

test('usage: odd reports are handled defensively', () => {
  assert.deepEqual(mapUsageReport({ session: {}, rate_limits: null }), { rows: [], extra: null }, 'no plan: no rows');
  assert.deepEqual(mapUsageReport(undefined), { rows: [], extra: null });

  const { rows, extra } = mapUsageReport({
    rate_limits: {
      limits: [
        { kind: 'weekly_scoped', percent: 12, resets_at: '2026-11-21T10:00:00+00:00', scope: { model: null, surface: 'web' } },   // no model
        { kind: 'monthly_galactic', percent: 99, resets_at: null },                                                                // unknown kind
        { kind: 'session', percent: null },                                                                                        // no number
        null,
        { kind: 'weekly_scoped', percent: 64, resets_at: 'garbage', scope: { model: { display_name: 'Nova' } }, severity: 'toasty' },
        { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 'Claude Opus' } }, severity: 7, is_active: 'yes' },
        { kind: 'weekly_all', percent: 120, resets_at: '2026-11-21T10:00:00+00:00' },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: 'USD' },
    },
  }, [{ key: 'nova', label: 'Nova', match: 'nova' }]);
  assert.deepEqual(rows.map((r) => [r.id, r.percent, r.resetsAt, r.severity, r.active, r.label]), [
    ['weekly', 120, Date.UTC(2026, 10, 21, 10), null, null, 'Weekly (all models)'],
    ['model:nova', 64, null, 'toasty', null, 'Nova weekly'],
    ['model:opus', 5, null, null, null, 'Opus weekly'],
  ]);
  assert.deepEqual(extra, { enabled: true, utilization: 24, usedCredits: 1200, monthlyLimit: 5000, currency: 'USD' });
});

test('usage: the report is picked out of the CLI stream', () => {
  const out = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp/token-shelter-probe' }),
    JSON.stringify({ type: 'assistant', message: { content: [] }, usage_report: REPORT }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' }),
  ].join('\n');
  assert.deepEqual(parseUsageOutput(out), REPORT);
  assert.throws(() => parseUsageOutput('{"type":"system"}\n'), /no usage report/);
  assert.throws(() => parseUsageOutput(''), /no usage report/);
  assert.throws(
    () => parseUsageOutput(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })),
    /claude reported: Not logged in/);
});

/** A stand-in for child_process.spawn that records the call and lets the test drive the process. */
function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    const proc = new EventEmitter();
    proc.pid = 31337;
    proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    proc.signals = [];
    proc.kill = (signal) => {
      proc.signals.push(signal);
      if (signal === 'SIGTERM' && proc.stubborn) return;   // ignores a polite request
      queueMicrotask(() => proc.emit('close', null, signal));
    };
    calls.push({ command, args, options, proc });
    return proc;
  };
  return { spawn, calls };
}

test('usage: the probe runs the CLI in its own directory, without leaving traces', async (t) => {
  const cwd = path.join(tempDir(t), 'token-shelter-probe');
  const { spawn, calls } = fakeSpawn();
  const probe = createCliProbe({ cwd, spawn, env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/elsewhere' } });
  assert.equal(probe.pid(), null);

  const pending = probe.run();
  const [{ command, args, options, proc }] = calls;
  assert.equal(command, 'claude');
  assert.deepEqual(args, ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
  assert.equal(args, PROBE_ARGS);
  assert.equal(options.cwd, cwd);
  assert.ok(fs.statSync(cwd).isDirectory(), 'the probe directory is created');
  assert.equal(options.stdio[0], 'ignore', 'stdin is closed so print mode never waits for input');
  assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(options.env.CLAUDE_CONFIG_DIR, '/elsewhere', 'the rest of the environment is passed through');
  assert.equal(probe.pid(), 31337);
  await assert.rejects(probe.run(), /already running/, 'probes never overlap');

  const line = JSON.stringify({ type: 'assistant', usage_report: REPORT });
  proc.stdout.emit('data', line.slice(0, 50));
  proc.stdout.emit('data', `${line.slice(50)}\n`);
  proc.emit('close', 0, null);
  assert.deepEqual(await pending, REPORT);
  assert.equal(probe.pid(), null);
});

test('usage: probe failures are errors, never empty readings', async (t) => {
  const cwd = path.join(tempDir(t), 'probe');
  {
    const { spawn, calls } = fakeSpawn();
    const pending = createCliProbe({ cwd, spawn }).run();
    calls[0].proc.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await assert.rejects(pending, /"claude" was not found on PATH/);
  }
  {
    const { spawn, calls } = fakeSpawn();
    const pending = createCliProbe({ cwd, spawn }).run();
    calls[0].proc.stderr.emit('data', 'Error: network unreachable\n');
    calls[0].proc.emit('close', 1, null);
    await assert.rejects(pending, /claude exited with code 1: Error: network unreachable/);
  }
  {
    const { spawn, calls } = fakeSpawn();
    const probe = createCliProbe({ cwd, spawn, timeoutMs: 20 });
    await assert.rejects(probe.run(), /timed out after 0 s/);
    assert.deepEqual(calls[0].proc.signals, ['SIGTERM'], 'asked to stop, so it can remove its session file');
    assert.equal(probe.pid(), null, 'and a new probe can start afterwards');
  }
  {
    const { spawn, calls } = fakeSpawn();
    const probe = createCliProbe({ cwd, spawn, timeoutMs: 20, graceMs: 20 });
    const pending = probe.run();
    calls[0].proc.stubborn = true;
    await assert.rejects(pending, /timed out/);
    assert.deepEqual(calls[0].proc.signals, ['SIGTERM', 'SIGKILL'], 'a hung CLI is killed after the grace period');
  }
  {
    const { spawn, calls } = fakeSpawn();
    const probe = createCliProbe({ cwd, spawn });
    const pending = probe.run();
    probe.kill();   // shutdown while a probe is running
    await assert.rejects(pending, /stopped by SIGTERM/);
    assert.deepEqual(calls[0].proc.signals, ['SIGTERM']);
  }
});

// ───────────────────────────── limits: staleness, resets, history ─────────────────────────────

/** A LimitsTracker on a fake clock with a scripted probe. */
function limitsFixture(t, { intervalMs = MIN } = {}) {
  const dir = path.join(tempDir(t), 'data');
  const fx = {
    dir,
    t: T0,
    next: REPORT,     // what the probe returns; an Error makes it fail
    calls: 0,
    probe: async () => {
      fx.calls++;
      if (fx.next instanceof Error) throw fx.next;
      return fx.next;
    },
    make: () => new LimitsTracker({
      probe: fx.probe, store: new SampleStore({ dir }).load(), intervalMs, now: () => fx.t,
    }),
  };
  return fx;
}

test('limits: nothing is known before the first reading', (t) => {
  const fx = limitsFixture(t);
  assert.deepEqual(fx.make().view(), { at: null, stale: false, error: null, rows: [], extra: null });
});

test('limits: a failed probe keeps the previous rows and marks them stale', async (t) => {
  const fx = limitsFixture(t);
  const limits = fx.make();
  await limits.poll();
  let view = limits.view();
  assert.deepEqual([view.at, view.stale, view.error], [T0, false, null]);
  assert.deepEqual(view.rows.map((r) => [r.id, r.percent]), [['session', 7], ['weekly', 20], ['model:fable', 39]]);

  fx.t += MIN;
  fx.next = new Error('usage probe timed out after 30 s');
  await limits.poll();
  view = limits.view();
  assert.equal(view.stale, true);
  assert.equal(view.error, 'usage probe timed out after 30 s');
  assert.equal(view.at, T0, 'the time of the last GOOD reading');
  assert.deepEqual(view.rows.map((r) => [r.id, r.percent]), [['session', 7], ['weekly', 20], ['model:fable', 39]], 'never zeros');
  assert.deepEqual(view.extra, { enabled: false, utilization: null, usedCredits: null, monthlyLimit: null, currency: null });

  fx.t += MIN;
  fx.next = reportWith([9, 21, 40]);
  await limits.poll();
  view = limits.view();
  assert.deepEqual([view.at, view.stale, view.error], [fx.t, false, null], 'recovered');
  assert.equal(view.rows[0].percent, 9);
});

test('limits: a first probe that fails reports the error with no rows', async (t) => {
  const fx = limitsFixture(t);
  fx.next = new Error('"claude" was not found on PATH');
  const limits = fx.make();
  await limits.poll();
  assert.deepEqual(limits.view(), { at: null, stale: true, error: '"claude" was not found on PATH', rows: [], extra: null });
});

test('limits: a reading older than three intervals is stale even without an error', async (t) => {
  const fx = limitsFixture(t, { intervalMs: MIN });
  const limits = fx.make();
  await limits.poll();
  assert.equal(limits.view(T0 + 3 * MIN).stale, false);
  assert.equal(limits.view(T0 + 3 * MIN + 1).stale, true);
  assert.equal(limits.view(T0 + 3 * MIN + 1).error, null);
});

test('limits: no plan (rate_limits null) is a good reading with no rows', async (t) => {
  const fx = limitsFixture(t);
  fx.next = { session: {}, rate_limits: null };
  const limits = fx.make();
  await limits.poll();
  assert.deepEqual(limits.view(), { at: T0, stale: false, error: null, rows: [], extra: null });
});

test('limits: a stray empty reading is no news; a long run of them is believed', async (t) => {
  const fx = limitsFixture(t);
  const limits = fx.make();
  await limits.poll();
  const empty = { session: {}, rate_limits: { limits: [], extra_usage: { is_enabled: false } } };
  const ids = () => limits.view().rows.map((r) => [r.id, r.percent]);
  const before = ids();

  // Every other probe empty (what the CLI does while idle): the meters never blink.
  for (let i = 0; i < 6; i++) {
    fx.t += MIN; fx.next = i % 2 ? reportWith([9, 21, 40]) : empty;
    await limits.poll();
    const view = limits.view();
    assert.equal(view.rows.length, 3, `alternating reading ${i}`);
    assert.deepEqual([view.stale, view.error], [false, null], `alternating reading ${i}: not stale, no error`);
  }
  assert.notDeepEqual(ids(), before);

  // A failed probe after an empty one is still a failure.
  fx.t += MIN; fx.next = empty;
  await limits.poll();
  fx.t += MIN; fx.next = new Error('usage probe timed out after 30 s');
  await limits.poll();
  assert.deepEqual([limits.view().stale, limits.view().rows.length], [true, 3]);

  // Empty readings age the last rows like any lull, then five in a row clear them.
  fx.next = empty;
  for (let i = 2; i <= 5; i++) {
    fx.t += MIN;
    await limits.poll();
    assert.equal(limits.view().rows.length, i < 5 ? 3 : 0, `empty reading ${i}`);
  }
  const view = limits.view();
  assert.deepEqual([view.at, view.stale, view.error], [fx.t, false, null], 'the plan really reports no limits now');
});

test('limits: probes never overlap', async (t) => {
  const fx = limitsFixture(t);
  let release;
  fx.probe = () => { fx.calls++; return new Promise((resolve) => { release = () => resolve(REPORT); }); };
  const limits = fx.make();
  const a = limits.poll();
  const b = limits.poll();
  assert.equal(a, b, 'the second call joins the probe in flight');
  release();
  await a;
  assert.equal(fx.calls, 1);
  release = null;
  const c = limits.poll();
  assert.notEqual(c, a, 'after it finished, a new one may start');
  release();
  await c;
  assert.equal(fx.calls, 2);
});

test('limits: every good probe records a sample, and the burn rate comes from them', async (t) => {
  const fx = limitsFixture(t);
  const limits = fx.make();
  // 1 % per 3 minutes on the session row = 20 %/h; the weekly rows do not move.
  for (let i = 0; i <= 30; i++) {
    fx.next = reportWith([7 + Math.floor(i / 3), 20, 39]);
    await limits.poll();
    if (i === 5) assert.equal(limits.view().rows[0].ratePctPerHour, null, 'five minutes is not enough history');
    fx.t += MIN;
  }
  const store = new SampleStore({ dir: fx.dir }).load();
  assert.equal(store.window('session').length, 31, 'one sample per probe, saved to disk');
  assert.deepEqual(store.window('session')[0], { at: T0, percent: 7, resetsAt: Date.UTC(2026, 10, 16, 2, 40, 0) });

  const [session, weekly, fable] = limits.view().rows;
  assert.ok(Math.abs(session.ratePctPerHour - 20) < 2, `session rate ${session.ratePctPerHour} ≈ 20 %/h`);
  assert.equal(weekly.ratePctPerHour, 0);
  assert.equal(fable.ratePctPerHour, 0);
});

test('limits: history survives a restart', async (t) => {
  const fx = limitsFixture(t);
  let limits = fx.make();
  for (let i = 0; i < 30; i++) {
    fx.next = reportWith([10 + i, 20, 39]);   // 60 %/h
    await limits.poll();
    fx.t += MIN;
  }
  const file = path.join(fx.dir, 'usage-samples.json');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(fx.dir).sort(), ['.gitignore', 'usage-samples.json'], 'no temp files left behind');
  assert.equal(fs.readFileSync(path.join(fx.dir, '.gitignore'), 'utf8'), '*\n');

  limits = fx.make();   // a new process: fresh tracker, same data dir
  assert.deepEqual(limits.view().rows, [], 'rows themselves are not invented from history');
  fx.next = reportWith([40, 20, 39]);
  await limits.poll();
  const rate = limits.view().rows[0].ratePctPerHour;
  assert.ok(Math.abs(rate - 60) < 3, `first reading after the restart already has a rate (${rate})`);
});

test('limits: a damaged history file is ignored, then replaced', async (t) => {
  const fx = limitsFixture(t);
  fs.mkdirSync(fx.dir, { recursive: true });
  fs.writeFileSync(path.join(fx.dir, 'usage-samples.json'), '{"v":1,"rows":{"session":{"samples":[[1,2');
  const limits = fx.make();
  await limits.poll();
  assert.equal(limits.view().rows.length, 3);
  assert.equal(new SampleStore({ dir: fx.dir }).load().window('session').length, 1);
});

test('reset detection: percent drops and the reset time moves ahead by more than an hour', () => {
  const at = T0;
  const a = { at, percent: 80, resetsAt: at + 10 * MIN };
  assert.equal(isReset(undefined, a), false);
  assert.equal(isReset(a, { at: at + MIN, percent: 81, resetsAt: at + 10 * MIN }), false, 'ordinary progress');
  assert.equal(isReset(a, { at: at + MIN, percent: 79, resetsAt: at + 10 * MIN + 400 }), false, 'a correction plus sub-second wobble');
  assert.equal(isReset(a, { at: at + MIN, percent: 3, resetsAt: at + 59 * MIN }), false, 'moved, but by less than an hour');
  assert.equal(isReset(a, { at: at + MIN, percent: 85, resetsAt: at + 5 * HOUR }), false, 'reset time moved but usage did not drop');
  assert.equal(isReset(a, { at: at + 11 * MIN, percent: 3, resetsAt: at + 5 * HOUR + 10 * MIN }), true, 'the real thing');
  // Collector was off across the reset and usage is already higher than before: the old
  // window's reset time has passed, so this is a new window all the same.
  assert.equal(isReset(a, { at: at + 3 * HOUR, percent: 90, resetsAt: at + 5 * HOUR + 10 * MIN }), true);
  // No reset times at all: a drop is all there is to go on.
  assert.equal(isReset({ at, percent: 50, resetsAt: null }, { at: at + MIN, percent: 0, resetsAt: null }), true);
  assert.equal(isReset({ at, percent: 50, resetsAt: null }, { at: at + MIN, percent: 51, resetsAt: at + HOUR }), false);
});

test('reset detection: a reset starts a fresh window for the forecast', async (t) => {
  const fx = limitsFixture(t);
  let limits = fx.make();
  const before = '2026-11-15T22:40:00.123456+00:00';
  const after = '2026-11-16T03:40:00.654321+00:00';
  // 30 minutes of heavy use: 2 % a minute.
  for (let i = 0; i <= 30; i++) {
    fx.next = reportWith([30 + 2 * i, 20, 39], { 0: before });
    await limits.poll();
    fx.t += MIN;
  }
  assert.ok(limits.view().rows[0].ratePctPerHour > 100);

  // The session window rolls over: percent drops, the reset time jumps five hours.
  fx.t = Date.parse(before) + MIN;
  fx.next = reportWith([1, 20, 39], { 0: after });
  await limits.poll();
  let store = new SampleStore({ dir: fx.dir }).load();
  assert.deepEqual(store.window('session').map((s) => s.percent), [1], 'the new window starts empty');
  assert.equal(store.rows.get('session').samples.length, 32, 'older samples are kept, they just no longer feed the estimate');
  assert.equal(store.window('weekly').length, 32, 'other rows are unaffected');
  assert.equal(limits.view().rows[0].ratePctPerHour, null, 'no forecast from the old window');

  // Quiet use in the new window, across a restart: the rate reflects the new window only.
  limits = fx.make();
  for (let i = 1; i <= 20; i++) {
    fx.t += MIN;
    fx.next = reportWith([1 + Math.floor(i / 10), 20, 39], { 0: after });
    await limits.poll();
  }
  store = new SampleStore({ dir: fx.dir }).load();
  assert.equal(store.window('session').length, 21, 'the window boundary survived the restart');
  const rate = limits.view().rows[0].ratePctPerHour;
  assert.ok(rate > 0 && rate < 12, `rate ${rate} comes from the new window, not the 120 %/h before the reset`);
});

test('samples: history is pruned to eight days', (t) => {
  const store = new SampleStore({ dir: path.join(tempDir(t), 'data') });
  for (let d = 0; d <= 10; d++) store.record('weekly', { at: T0 + d * DAY, percent: d, resetsAt: T0 + 30 * DAY });
  const kept = store.rows.get('weekly').samples;
  assert.equal(kept[0].at, T0 + 2 * DAY);
  assert.equal(kept.length, 9);

  store.record('weekly', { at: T0 + 9 * DAY, percent: 99, resetsAt: null });
  assert.equal(store.rows.get('weekly').samples.length, 9, 'a reading from the past is not inserted out of order');

  // A row the plan stopped reporting disappears once its last sample is too old.
  store.record('model:retired', { at: T0, percent: 1, resetsAt: null });
  store.prune(T0 + 5 * DAY);
  assert.ok(store.rows.has('model:retired'));
  store.prune(T0 + 9 * DAY);
  assert.ok(!store.rows.has('model:retired'));
  store.save();
  assert.deepEqual([...new SampleStore({ dir: store.dir }).load().rows.keys()], ['weekly']);
});

// ───────────────────────────── the snapshot ─────────────────────────────

test('models: built-ins first, then extras, then whatever else is in use', () => {
  const extra = [{ key: 'nova', label: 'Nova', match: 'nova', design: 'generic', style: { accent: 41, accent2: 31, variant: 2 } }];
  const agent = (modelKey, status, tokens, rate) => ({ modelKey, status, tokens, rate });
  const models = buildModels([
    agent('fable', 'working', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30 }),
    agent('fable', 'waiting', { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, { input: 0, output: 0, cacheRead: 0 }),
    agent('fable', 'done', { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }, { input: 1, output: 1, cacheRead: 1 }),
    agent('zeta', 'working', { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }, { input: 5, output: 5, cacheRead: 5 }),
    agent('unknown', 'waiting', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: 0, output: 0, cacheRead: 0 }),
  ], [{ modelKey: null }, { modelKey: 'atlas' }, { modelKey: 'fable' }], extra);

  assert.deepEqual(models.map((m) => m.key), ['fable', 'opus', 'sonnet', 'haiku', 'nova', 'atlas', 'zeta']);
  const [fable, opus, , , nova, atlas, zeta] = models;
  assert.deepEqual(fable.tokens, { input: 111, output: 222, cacheRead: 333, cacheWrite: 444 });
  assert.deepEqual(fable.rate, { input: 11, output: 21, cacheRead: 31 });
  assert.equal(fable.activeAgents, 1, 'only working agents are active');
  assert.deepEqual([fable.label, fable.design], ['Fable', 'fable']);
  assert.deepEqual([opus.activeAgents, opus.tokens.output], [0, 0]);
  assert.deepEqual([nova.label, nova.design, nova.style], ['Nova', 'generic', { accent: 41, accent2: 31, variant: 2 }]);
  assert.deepEqual([atlas.design, atlas.activeAgents], ['generic', 0], 'metered by the plan, nobody on it');
  assert.equal(zeta.activeAgents, 1);
  for (const m of models) assert.deepEqual(Object.keys(m).sort(), ['activeAgents', 'design', 'key', 'label', 'rate', 'style', 'tokens']);
});

test('collector: fixture config dir in, contract Snapshot out', async (t) => {
  const fx = fixture(t);
  fx.session();
  fx.session({ pid: 77, sessionId: 'second-session', cwd: '/home/dev/projects/nova-lab', status: 'idle', name: 'nova', startedAt: T0 - 5 * MIN });
  fx.append(fx.transcript(), assistant({ at: T0 - 20_000, usage: usage(2, 500, 29000, 17000), block: toolUse('Agent') }));
  fx.append(path.join(fx.configDir, 'projects', '-home-dev-projects-nova-lab', 'second-session.jsonl'),
    assistant({ at: T0 - HOUR, model: 'claude-nova-9-1', usage: usage(1, 10, 100, 1000) }));
  fx.append(fx.sub('w1', { description: 'Dig the east tunnel' }),
    assistant({ at: T0 - 5_000, model: 'claude-haiku-5-5', sidechain: true, usage: usage(4, 40, 400, 4000), block: toolUse('Bash') }));

  let probes = 0;
  const collector = createCollector({
    configDir: fx.configDir,
    dataDir: path.join(path.dirname(fx.configDir), 'data'),
    now: fx.now,
    isAlive: fx.isAlive,
    probe: async () => { probes++; return REPORT; },
    usageIntervalMs: MIN,
    extraModels: normalizeConfig({ extraModels: [{ key: 'nova', label: 'Nova', match: 'nova' }] }).extraModels,
  });

  let snap = collector.tick();
  assert.deepEqual([snap.v, snap.at, snap.source, snap.scenario], [1, T0, 'live', null]);
  assert.deepEqual(snap.limits, { at: null, stale: false, error: null, rows: [], extra: null }, 'no reading yet');
  assert.deepEqual(snap.agents.map((a) => [a.kind, a.name, a.modelKey, a.status, a.activity]), [
    ['main', 'bunker-7', 'fable', 'working', 'delegate'],
    ['sub', 'Dig the east tunnel', 'haiku', 'working', 'shell'],
    ['main', 'nova', 'nova', 'waiting', 'idle'],
  ]);
  assert.equal(collector.snapshot(), snap, 'snapshot() is the latest tick');

  await collector.pollUsage();
  assert.equal(probes, 1);
  snap = collector.tick();
  assert.deepEqual(snap.limits.rows.map((r) => r.id), ['session', 'weekly', 'model:fable']);
  assert.deepEqual([snap.limits.at, snap.limits.stale], [T0, false]);

  assert.deepEqual(snap.models.map((m) => m.key), ['fable', 'opus', 'sonnet', 'haiku', 'nova']);
  const byKey = Object.fromEntries(snap.models.map((m) => [m.key, m]));
  assert.deepEqual(byKey.fable.tokens, { input: 2, output: 500, cacheRead: 29000, cacheWrite: 17000 });
  assert.deepEqual(byKey.fable.rate, { input: 2, output: 500, cacheRead: 29000 });
  assert.deepEqual([byKey.fable.activeAgents, byKey.haiku.activeAgents, byKey.nova.activeAgents, byKey.opus.activeAgents], [1, 1, 0, 0]);
  assert.deepEqual(byKey.nova.tokens, { input: 1, output: 10, cacheRead: 100, cacheWrite: 1000 });
  assert.deepEqual(byKey.nova.rate, { input: 0, output: 0, cacheRead: 0 }, 'an hour ago is not "recent"');

  // The whole thing is plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test('collector: its snapshots are accepted by derive()', async (t) => {
  const { derive } = await import('../src/shared/derive.mjs');
  const fx = fixture(t);
  fx.session();
  fx.session({ pid: 99, sessionId: 'brand-new', status: 'idle' });   // no model known: no machine
  fx.append(fx.transcript(), assistant({ at: T0 - 20_000, block: toolUse('Agent') }));
  fx.append(fx.sub('w1'), assistant({ at: T0 - 5_000, model: 'claude-haiku-5-5', sidechain: true, block: toolUse('Bash') }));
  fx.append(fx.sub('w2', { finished: true }), assistant({ at: T0 - 5 * MIN, sidechain: true }));
  const collector = createCollector({
    configDir: fx.configDir, dataDir: path.join(path.dirname(fx.configDir), 'data'),
    now: fx.now, isAlive: fx.isAlive, probe: async () => REPORT,
  });
  for (const snap of [collector.tick(), (await collector.pollUsage(), collector.tick())]) {
    const unknown = snap.agents.find((a) => a.id === 'brand-new');
    assert.deepEqual([unknown.model, unknown.modelKey], ['', 'unknown']);
    const state = derive(snap);
    assert.equal(state.residents.length, snap.agents.length, 'one resident per agent');
    assert.equal(state.machines.length, snap.models.length, 'one machine per model');
    assert.ok(!state.machines.some((m) => m.modelKey === 'unknown'));
  }
});

// ───────────────────────────── config ─────────────────────────────

test('config: defaults, overrides and bad values', (t) => {
  const root = tempDir(t);
  assert.deepEqual(loadConfig(root), { port: null, usageIntervalSec: 60, extraModels: [] }, 'no file: defaults');

  const example = JSON.parse(fs.readFileSync(new URL('../shelter.config.example.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(root, 'shelter.config.json'), JSON.stringify(example));
  assert.deepEqual(loadConfig(root), {
    port: 4780, usageIntervalSec: 60,
    extraModels: [{ key: 'nova', design: 'generic', label: 'Nova', match: 'nova', style: { accent: 41, accent2: 31, variant: 2 } }],
  });

  const warnings = [];
  const cfg = normalizeConfig({
    port: 'eighty', usageIntervalSec: 1,
    extraModels: [{ key: 'Nova' }, { key: 'nova' }, { label: 'no key' }, { key: 'bad', match: '(' , design: 'spaceship' }, 'junk'],
  }, (w) => warnings.push(w));
  assert.equal(cfg.port, null);
  assert.equal(cfg.usageIntervalSec, 15, 'the probe interval has a floor');
  assert.deepEqual(cfg.extraModels, [{ key: 'nova', design: 'generic' }, { key: 'bad', design: 'generic' }]);
  assert.equal(warnings.length, 3);

  fs.writeFileSync(path.join(root, 'shelter.config.json'), '{ not json');
  const loadWarnings = [];
  assert.deepEqual(loadConfig(root, (w) => loadWarnings.push(w)), { port: null, usageIntervalSec: 60, extraModels: [] });
  assert.equal(loadWarnings.length, 1);
});

test('config: directories come from the environment when set', () => {
  assert.equal(claudeConfigDir({}), path.join(os.homedir(), '.claude'));
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/claude' }), '/custom/claude');
  assert.equal(dataDirOf('/project', {}), path.join('/project', '.data'));
  assert.equal(dataDirOf('/project', { SHELTER_DATA_DIR: '/var/shelter' }), '/var/shelter');
});
