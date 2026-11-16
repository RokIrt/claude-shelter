import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRate, projectLimit, heatOf, formatDuration, formatCountdown, formatTokens } from '../src/shared/forecast.mjs';
import { derive, diffStates, speedOf } from '../src/shared/derive.mjs';
import { scenarioSnapshot, SCENARIOS, SCENARIO_INFO } from '../src/shared/scenarios.mjs';
import { modelKeyOf, modelDef } from '../src/shared/models.mjs';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const NOW = 1_794_790_000_000;
const row = (o) => ({ id: 'model:fable', scope: 'model', modelKey: 'fable', label: 'Fable weekly', percent: 50, resetsAt: NOW + 2 * DAY, ratePctPerHour: null, severity: 'normal', active: true, ...o });

test('estimateRate needs enough history', () => {
  assert.equal(estimateRate([], NOW), null);
  assert.equal(estimateRate([{ at: NOW, percent: 10 }], NOW), null);
  // two readings only 5 minutes apart: too short to trust
  assert.equal(estimateRate([{ at: NOW - 5 * MIN, percent: 10 }, { at: NOW, percent: 12 }], NOW, { scope: 'session' }), null);
});

test('estimateRate measures a steady burn', () => {
  const samples = [];
  for (let m = 60; m >= 0; m -= 5) samples.push({ at: NOW - m * MIN, percent: 20 + (60 - m) / 6 });   // 10 %/h
  const r = estimateRate(samples, NOW, { scope: 'session' });
  assert.ok(Math.abs(r - 10) < 0.5, `expected about 10 %/h, got ${r}`);
});

test('estimateRate is zero when nothing changes and never negative', () => {
  const flat = [0, 10, 20, 30].map((m) => ({ at: NOW - m * MIN, percent: 40 }));
  assert.equal(estimateRate(flat, NOW, { scope: 'session' }), 0);
  const falling = [{ at: NOW - 30 * MIN, percent: 40 }, { at: NOW, percent: 30 }];
  assert.equal(estimateRate(falling, NOW, { scope: 'session' }), 0);
});

test('estimateRate ignores readings outside the lookback and discounts idle time', () => {
  const old = [{ at: NOW - 5 * HOUR, percent: 0 }, { at: NOW - 4 * HOUR, percent: 50 }];
  assert.equal(estimateRate(old, NOW, { scope: 'session' }), null);
  // burned 10% in the first half hour, then went quiet for half an hour (no later readings)
  const burst = [{ at: NOW - 60 * MIN, percent: 10 }, { at: NOW - 30 * MIN, percent: 20 }];
  const r = estimateRate(burst, NOW, { scope: 'session' });
  assert.ok(r > 5 && r < 15, `idle time should lower the rate from 20, got ${r}`);
});

test('projectLimit: the spec examples', () => {
  // "Fable machine projected to overheat in 2 hours"
  const fable = projectLimit(row({ percent: 80, ratePctPerHour: 10 }), NOW);
  assert.equal(fable.survives, false);
  assert.equal(Math.round(fable.exhaustInMs / HOUR), 2);
  assert.equal(fable.forecast, 'Fable machine projected to overheat in 2 hours');
  // "Central power will run out 18 hours before reset"
  const weekly = projectLimit(row({ id: 'weekly', scope: 'weekly', modelKey: null, label: 'Weekly (all models)', percent: 88, ratePctPerHour: 1, resetsAt: NOW + 30 * HOUR }), NOW);
  assert.equal(weekly.forecast, 'Central power will run out 18 hours before reset');
  assert.equal(Math.round(weekly.shortfallMs / HOUR), 18);
});

test('projectLimit levels', () => {
  assert.equal(projectLimit(row({ percent: 10 }), NOW).level, 'ok');
  assert.equal(projectLimit(row({ percent: 85 }), NOW).level, 'warn');
  assert.equal(projectLimit(row({ percent: 95 }), NOW).level, 'critical');
  const done = projectLimit(row({ percent: 100 }), NOW);
  assert.equal(done.level, 'exhausted');
  assert.equal(done.exhaustInMs, 0);
  // low percent but about to run out: the forecast alone raises the level
  assert.equal(projectLimit(row({ percent: 60, ratePctPerHour: 40 }), NOW).level, 'critical');
  // unknown rate: no forecast, no invented numbers
  const unknown = projectLimit(row({ percent: 50, ratePctPerHour: null }), NOW);
  assert.equal(unknown.exhaustInMs, null);
  assert.equal(unknown.survives, null);
  assert.match(unknown.forecast, /Not enough history/);
});

test('what-if scales the forecast but not the percentage', () => {
  const base = projectLimit(row({ percent: 50, ratePctPerHour: 0.5 }), NOW, 1);
  const fast = projectLimit(row({ percent: 50, ratePctPerHour: 0.5 }), NOW, 4);
  assert.equal(base.percent, fast.percent);
  assert.equal(base.survives, true);
  assert.equal(fast.survives, false);
  assert.ok(heatOf(fast) > heatOf(base));
});

test('heat rises with usage and is 1 when exhausted', () => {
  const heats = [0, 40, 60, 80, 95, 100].map((p) => heatOf(projectLimit(row({ percent: p }), NOW)));
  for (let i = 1; i < heats.length; i++) assert.ok(heats[i] >= heats[i - 1], `heat must not fall: ${heats}`);
  assert.equal(heats[0], 0);
  assert.equal(heats[heats.length - 1], 1);
  assert.equal(heatOf(null), 0);
});

test('formatters', () => {
  assert.equal(formatDuration(2 * HOUR), '2 hours');
  assert.equal(formatDuration(25 * MIN), '25 minutes');
  assert.equal(formatDuration(3 * DAY), '3 days');
  assert.equal(formatDuration(1000), '1 second');
  assert.equal(formatCountdown(2 * DAY + 4 * HOUR), '2d 4h');
  assert.equal(formatCountdown(80 * MIN), '1h 20m');
  assert.equal(formatCountdown(45_000), '45s');
  assert.equal(formatCountdown(null), '--');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_300), '12k');
  assert.equal(formatTokens(4_100_000), '4.1M');
});

test('model keys and machine definitions', () => {
  assert.equal(modelKeyOf('claude-fable-5-2'), 'fable');
  assert.equal(modelKeyOf('claude-opus-5-5'), 'opus');
  assert.equal(modelKeyOf('Fable'), 'fable');
  assert.equal(modelKeyOf('claude-nova-9-1'), 'nova');
  assert.equal(modelDef('fable').design, 'fable');
  const nova = modelDef('nova');
  assert.equal(nova.design, 'generic');
  assert.deepEqual(nova, modelDef('nova'), 'generic styles must be deterministic');
  const custom = modelDef('nova', [{ key: 'nova', label: 'Nova X', style: { accent: 41 } }]);
  assert.equal(custom.label, 'Nova X');
  assert.equal(custom.style.accent, 41);
});

test('every scenario produces a valid snapshot and state at any time', () => {
  for (const name of SCENARIOS) {
    assert.ok(SCENARIO_INFO[name].label);
    for (const t of [0, 1.5, 10, 33.3, 59.99, 60, 100, 123.9, 500]) {
      const snap = scenarioSnapshot(name, t, NOW + t * 1000);
      assert.equal(snap.v, 1);
      assert.equal(snap.source, 'simulation');
      const s = derive(snap);
      assert.ok(s.machines.length >= 4);
      for (const m of s.machines) {
        assert.ok(m.heat >= 0 && m.heat <= 1);
        assert.ok(m.speed >= 0 && m.speed <= 1);
        assert.equal(m.powered, ['idle', 'running', 'hot'].includes(m.status));
      }
      const ids = new Set(s.residents.map((r) => r.id));
      assert.equal(ids.size, s.residents.length, 'resident ids must be unique');
      for (const m of s.machines) for (const id of m.residentIds) assert.ok(ids.has(id));
      for (const r of s.residents) assert.ok(['control', 'lounge', 'machine', 'exit'].includes(r.place));
    }
  }
});

test('the five usage consequences', () => {
  const at = (name, t) => derive(scenarioSnapshot(name, t, NOW));
  const fable = (s) => s.machines.find((m) => m.modelKey === 'fable');

  const warn = at('model-warn', 35);                       // approaching a model limit
  assert.equal(fable(warn).status, 'hot');
  assert.ok(fable(warn).heat >= 0.6);
  assert.equal(warn.power, 'normal');

  const cap = at('model-cap', 30);                         // model limit reached: local fire only
  assert.equal(fable(cap).status, 'fire');
  assert.equal(fable(cap).powered, false);
  assert.equal(cap.power, 'normal');
  assert.ok(cap.machines.filter((m) => m.modelKey !== 'fable').every((m) => m.powered), 'other machines stay operational');
  assert.ok(cap.residents.some((r) => r.modelKey === 'fable' && r.blocked));

  const trip = at('session-cap', 30);                      // session limit: switchboard trips
  assert.equal(trip.switchboard.status, 'tripped');
  assert.equal(trip.power, 'pitstop');
  assert.ok(trip.machines.every((m) => m.status === 'pitstop'));
  assert.ok(trip.switchboard.limit.resetInMs > 0, 'pit stop has a reset countdown');

  const hot = at('weekly-warn', 40);                       // weekly limit approaching
  assert.ok(['hot', 'critical'].includes(hot.reactor.status));
  assert.ok(hot.reactor.heat >= 0.6);
  assert.equal(hot.power, 'normal');

  const melt = at('weekly-cap', 30);                       // weekly limit reached
  assert.equal(melt.reactor.status, 'meltdown');
  assert.equal(melt.power, 'emergency');
  assert.ok(melt.machines.every((m) => m.status === 'emergency'));
  assert.equal(melt.alerts[0].level, 'critical');
});

test('backup generator keeps machines turning on extra usage credits', () => {
  const s = derive(scenarioSnapshot('generator', 30, NOW));
  assert.equal(s.power, 'pitstop');
  assert.equal(s.generator.present, true);
  assert.equal(s.generator.running, true);
  assert.ok(s.machines.every((m) => m.powered));
  assert.ok(s.alerts.some((a) => a.scope === 'generator'));
  const none = derive(scenarioSnapshot('session-cap', 30, NOW));
  assert.equal(none.generator.present, false);
});

test('machines without a reported allowance get no heat of their own', () => {
  const s = derive(scenarioSnapshot('calm', 20, NOW));
  const haiku = s.machines.find((m) => m.modelKey === 'haiku');
  assert.equal(haiku.limit, null);
  assert.equal(haiku.heat, 0);
});

test('missing or stale telemetry is reported, never shown as zero', () => {
  const snap = scenarioSnapshot('calm', 20, NOW);
  const none = derive({ ...snap, limits: { at: null, stale: true, error: 'probe failed', rows: [], extra: null } });
  assert.equal(none.telemetry.known, false);
  assert.equal(none.switchboard.limit, null);
  assert.equal(none.reactor.limit, null);
  assert.equal(none.power, 'normal');
  assert.ok(none.alerts.some((a) => a.scope === 'telemetry'));
  const stale = derive({ ...snap, limits: { ...snap.limits, stale: true, at: NOW - 10 * MIN } }, { now: NOW });
  assert.equal(stale.telemetry.stale, true);
  assert.equal(stale.switchboard.limit.stale, true);
  assert.ok(stale.alerts.some((a) => a.id === 'telemetry:stale'));
});

test('diffStates: the tour fires each warning, limit and reset exactly once', () => {
  const counts = {};
  let prev = null;
  for (let t = 0; t < 124; t += 0.25) {
    const s = derive(scenarioSnapshot('tour', t, NOW + t * 1000));
    for (const e of diffStates(prev, s)) {
      if (e.type.startsWith('limit_')) {
        const k = `${e.type}:${e.scope}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    prev = s;
  }
  for (const scope of ['model', 'session', 'weekly']) {
    assert.equal(counts[`limit_reached:${scope}`], 1, `limit_reached:${scope} ${JSON.stringify(counts)}`);
    assert.equal(counts[`limit_reset:${scope}`], 1, `limit_reset:${scope} ${JSON.stringify(counts)}`);
    assert.ok(counts[`limit_warning:${scope}`] >= 1, `limit_warning:${scope}`);
  }
});

test('diffStates: arrivals, departures and model changes', () => {
  const a = derive(scenarioSnapshot('calm', 1, NOW));
  const first = diffStates(null, a);
  assert.ok(first.every((e) => e.type === 'agent_arrived'));
  assert.equal(first.length, a.residents.length);
  const b = derive(scenarioSnapshot('calm', 10, NOW + 9000));
  const arrived = diffStates(a, b).filter((e) => e.type === 'agent_arrived').map((e) => e.id);
  assert.ok(arrived.length >= 2);
  // the map-the-codebase subagent finishes at t=27
  const c = derive(scenarioSnapshot('calm', 26, NOW + 25_000));
  const d = derive(scenarioSnapshot('calm', 28, NOW + 27_000));
  assert.ok(diffStates(c, d).some((e) => e.type === 'agent_left' && /map/.test(e.id)));
  // the foreman changes model at t=68
  const e = derive(scenarioSnapshot('calm', 67, NOW + 66_000));
  const f = derive(scenarioSnapshot('calm', 69, NOW + 68_000));
  assert.ok(diffStates(e, f).some((x) => x.type === 'agent_model_changed' && x.id === 'sim-main-1' && x.to === 'opus'));
});

test('a real-looking reset is detected even when the reset time lags behind', () => {
  const snap = scenarioSnapshot('calm', 20, NOW);
  const withSession = (percent, resetsAt) => ({ ...snap, limits: { ...snap.limits, rows: snap.limits.rows.map((r) => (r.id === 'session' ? { ...r, percent, resetsAt } : r)) } });
  const before = derive(withSession(97, NOW + 30_000), { now: NOW });
  // reading after the window rolled over, but the plan still reports the old (now past) reset time
  const after = derive(withSession(1, NOW + 30_000), { now: NOW + 90_000 });
  assert.ok(diffStates(before, after).some((e) => e.type === 'limit_reset' && e.scope === 'session'));
  // a one-point wobble is not a reset
  const wobble = derive(withSession(96, NOW + 30_000), { now: NOW + 1000 });
  assert.equal(diffStates(before, wobble).filter((e) => e.type === 'limit_reset').length, 0);
});

test('speedOf', () => {
  assert.equal(speedOf({ input: 0, output: 0, cacheRead: 0 }, 0), 0);
  assert.equal(speedOf({ input: 0, output: 0, cacheRead: 0 }, 2), 0.25);
  const slow = speedOf({ input: 10, output: 50, cacheRead: 0 }, 1), fast = speedOf({ input: 500, output: 5000, cacheRead: 2_000_000 }, 3);
  assert.ok(fast > slow && fast <= 1);
});

test('placement: working at the machine, waiting for input in the control room, inactive in the lounge', () => {
  const agent = (o) => ({ sessionId: o.id, parentId: null, kind: 'main', name: o.id, model: 'claude-fable-5-2', modelKey: 'fable', status: 'working', activity: 'code', startedAt: NOW - 5 * HOUR, lastActiveAt: NOW, ...o });
  const models = ['fable', 'opus'].map((key) => ({ key, label: key, design: key, style: {}, tokens: {}, rate: {}, activeAgents: 0 }));
  const s = derive({ v: 1, at: NOW, source: 'live', limits: { at: NOW, stale: false, rows: [] }, models, agents: [
    agent({ id: 'boss' }),
    agent({ id: 'boss:sub', sessionId: 'boss', parentId: 'boss', kind: 'sub', model: 'claude-opus-5-5', modelKey: 'opus' }),
    agent({ id: 'between', status: 'waiting', activity: 'idle', lastActiveAt: NOW - 50 * MIN }),
    agent({ id: 'old', status: 'waiting', activity: 'idle', lastActiveAt: NOW - 61 * MIN }),
    agent({ id: 'hung', status: 'working', lastActiveAt: NOW - 2 * HOUR }),
    // Quiet itself, but its subagent is busy: the session is alive.
    agent({ id: 'waits', status: 'working', activity: 'delegate', lastActiveAt: NOW - 2 * HOUR }),
    agent({ id: 'waits:sub', sessionId: 'waits', parentId: 'waits', kind: 'sub', lastActiveAt: NOW - MIN }),
  ] }, { now: NOW });
  const by = Object.fromEntries(s.residents.map((r) => [r.id, r]));
  const place = Object.fromEntries(s.residents.map((r) => [r.id, r.place]));
  assert.deepEqual(place, { boss: 'machine', 'boss:sub': 'machine', between: 'control', old: 'lounge', hung: 'lounge', waits: 'machine', 'waits:sub': 'machine' });
  assert.deepEqual(s.machines.find((m) => m.modelKey === 'fable').residentIds, ['boss', 'waits', 'waits:sub'], 'working foremen are posted at their machine');
  assert.deepEqual(s.machines.find((m) => m.modelKey === 'opus').residentIds, ['boss:sub']);
  assert.deepEqual([by.between.stale, by.between.icon, by.old.stale, by.old.icon, by.hung.stale, by.hung.icon], [false, 'zzz', true, 'zzz', true, 'zzz']);
  assert.equal(by.hung.blocked, false);
});

test('a session idle for more than 24 hours leaves the shelter, subagents and all', () => {
  const at = (quietMs, o = {}) => ({ id: 'old', sessionId: 'old', parentId: null, kind: 'main', name: 'old', model: 'claude-opus-5-5', modelKey: 'opus', status: 'waiting', activity: 'idle', startedAt: NOW - 3 * DAY, lastActiveAt: NOW - quietMs, ...o });
  const sub = (quietMs) => ({ ...at(quietMs), id: 'old:s', parentId: 'old', kind: 'sub', status: 'working', activity: 'code' });
  const ids = (agents) => derive({ v: 1, at: NOW, source: 'live', limits: { at: NOW, stale: false, rows: [] }, models: [], agents }, { now: NOW }).residents.map((r) => r.id);

  assert.deepEqual(ids([at(DAY - MIN)]), ['old'], 'just under a day: still in the lounge');
  assert.deepEqual(ids([at(DAY + MIN)]), [], 'just over a day: gone');
  assert.deepEqual(ids([at(DAY + MIN), sub(DAY + 2 * MIN)]), [], 'its subagents go with it');
  assert.deepEqual(ids([at(DAY + MIN), sub(5 * MIN)]), ['old', 'old:s'], 'a subagent still at work keeps the session in the shelter');
  assert.deepEqual(ids([at(DAY + MIN, { status: 'working', lastActiveAt: NOW })]), ['old'], 'back as soon as it works again');
  assert.deepEqual(ids([at(MIN), sub(DAY + MIN)]), ['old'], 'a subagent silent for a day (killed, never finished) is dropped on its own');
  assert.deepEqual(ids([at(DAY + MIN, { status: 'working' })]), [], 'a session marked busy but silent for a day is gone too');
});
