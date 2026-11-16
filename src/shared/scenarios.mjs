// Simulation fixtures: scripted Snapshots that walk the shelter through every usage
// event, so each consequence can be seen (and tested) without burning real allowance.
// Pure and deterministic: scenarioSnapshot(name, tSec, nowMs) depends only on its inputs.
import { modelDef, modelKeyOf, zeroTokens, zeroRate } from './models.mjs';
import { hash } from '../gfx/fb.mjs';

const HOUR = 3_600_000, DAY = 86_400_000;
const SESSION_WINDOW = 5 * HOUR, WEEK_WINDOW = 7 * DAY;

/**
 * A limit track: percent keyframes [tSec, percent] (linear between them), scripted
 * resets (seconds), the remaining time shown when no reset is imminent, and the
 * burn rate (percent/hour) as a step function [[tSec, rate], ...] or a constant.
 */
const track = (keys, { resets = [], remain, rate = 0 } = {}) => ({ keys, resets, remain, rate });

const CALM = {
  session: track([[0, 22]], { remain: 2.2 * HOUR, rate: 9 }),
  weekly: track([[0, 31]], { remain: 3.2 * DAY, rate: 0.5 }),
  fable: track([[0, 39]], { remain: 3.2 * DAY, rate: 0.6 }),
  opus: track([[0, 18]], { remain: 3.2 * DAY, rate: 0.2 }),
  sonnet: track([[0, 9]], { remain: 3.2 * DAY, rate: 0.1 }),
};

const SCRIPTS = {
  calm: { loop: 120, tracks: CALM },
  busy: { loop: 120, busy: true, tracks: { ...CALM, session: track([[0, 38], [120, 52]], { remain: 2.2 * HOUR, rate: 16 }) } },
  'model-warn': {
    loop: 60,
    tracks: { ...CALM, fable: track([[0, 70], [30, 94], [60, 94]], { remain: 3.2 * DAY, rate: [[0, 6], [12, 10], [30, 14]] }) },
  },
  'model-cap': {
    loop: 60,
    tracks: { ...CALM, fable: track([[0, 91], [10, 100], [60, 100]], { remain: 2.6 * DAY, rate: 14 }) },
  },
  'session-cap': {
    loop: 60,
    tracks: { ...CALM, session: track([[0, 84], [12, 100], [60, 100]], { remain: 1.3 * HOUR, rate: 40 }) },
  },
  'weekly-warn': {
    loop: 60,
    tracks: { ...CALM, weekly: track([[0, 76], [30, 93], [60, 93]], { remain: 30 * HOUR, rate: [[0, 0.6], [10, 1], [30, 1.4]] }) },
  },
  'weekly-cap': {
    loop: 60,
    tracks: { ...CALM, weekly: track([[0, 93], [12, 100], [60, 100]], { remain: 2.1 * DAY, rate: 2 }) },
  },
  generator: {
    loop: 60, extra: true,
    tracks: { ...CALM, session: track([[0, 90], [8, 100], [60, 100]], { remain: 1.3 * HOUR, rate: 40 }) },
  },
  reset: {
    loop: 60,
    tracks: {
      session: track([[0, 100], [10, 100], [10.01, 1], [60, 6]], { resets: [10], remain: 1.3 * HOUR, rate: 9 }),
      fable: track([[0, 100], [20, 100], [20.01, 2], [60, 5]], { resets: [20], remain: 2.6 * DAY, rate: 0.3 }),
      weekly: track([[0, 100], [30, 100], [30.01, 1], [60, 3]], { resets: [30], remain: 2.1 * DAY, rate: 0.3 }),
      opus: CALM.opus, sonnet: CALM.sonnet,
    },
  },
  tour: {
    loop: 124,
    tracks: {
      fable: track([[0, 39], [12, 72], [24, 94], [28, 100], [40, 100], [40.01, 3], [124, 8]], { resets: [40], remain: 3.2 * DAY, rate: [[0, 0.6], [12, 8], [20, 12], [40, 0.3]] }),
      session: track([[0, 22], [44, 30], [46, 82], [52, 100], [62, 100], [62.01, 2], [124, 9]], { resets: [62], remain: 2.2 * HOUR, rate: [[0, 9], [44, 45], [62, 9]] }),
      weekly: track([[0, 31], [64, 40], [66, 78], [78, 95], [82, 100], [100, 100], [100.01, 2], [124, 4]], { resets: [100], remain: 30 * HOUR, rate: [[0, 0.5], [64, 1], [74, 1.4], [100, 0.3]] }),
      opus: CALM.opus, sonnet: CALM.sonnet,
    },
  },
};

export const SCENARIO_INFO = Object.freeze({
  tour: { label: 'Grand tour', blurb: 'Every event in two minutes: overheat, fire, power trip, meltdown, and the resets.' },
  calm: { label: 'Calm shift', blurb: 'Normal operation with a handful of agents.' },
  busy: { label: 'Rush hour', blurb: 'Many parallel subagents and an extra model.' },
  'model-warn': { label: 'Machine overheating', blurb: 'One model approaches its limit.' },
  'model-cap': { label: 'Machine fire', blurb: 'One model reaches its limit; the others keep working.' },
  'session-cap': { label: 'Power trip', blurb: 'The session limit trips the switchboard.' },
  'weekly-warn': { label: 'Reactor running hot', blurb: 'The weekly limit is approaching.' },
  'weekly-cap': { label: 'Reactor meltdown', blurb: 'The weekly limit is reached: emergency power.' },
  generator: { label: 'Backup generator', blurb: 'Session limit reached with extra usage credits available.' },
  reset: { label: 'Reset and repair', blurb: 'Starts in full disaster, then each allowance resets.' },
});

/** Scenario names, default first. */
export const SCENARIOS = Object.freeze(Object.keys(SCENARIO_INFO));

function lerpKeys(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, p0] = keys[i - 1], [t1, p1] = keys[i];
      return t1 === t0 ? p1 : p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
    }
  }
  return keys[keys.length - 1][1];
}

function stepAt(rate, t) {
  if (!Array.isArray(rate)) return rate;
  let v = rate[0][1];
  for (const [at, r] of rate) if (t >= at) v = r;
  return v;
}

function limitRow(id, scope, modelKey, label, tr, t, now, windowLen) {
  const percent = Math.round(lerpKeys(tr.keys, t));
  const nextReset = tr.resets.find((r) => r >= t);
  const lastReset = [...tr.resets].reverse().find((r) => r < t);
  let resetsAt;
  if (lastReset !== undefined) {
    resetsAt = now - (t - lastReset) * 1000 + windowLen;          // fresh window since the scripted reset
  } else if (nextReset !== undefined && percent >= 100) {
    resetsAt = now + (nextReset - t) * 1000;                        // exhausted: count down to the reset
  } else {
    resetsAt = now + (tr.remain ?? windowLen / 2);
  }
  return {
    id, scope, modelKey, label, percent, resetsAt: Math.round(resetsAt),
    ratePctPerHour: percent >= 100 ? 0 : stepAt(tr.rate, t),
    severity: percent >= 100 ? 'exceeded' : percent >= 80 ? 'warning' : 'normal',
    active: scope !== 'session',
  };
}

// One minute of scripted subagents; the cast repeats every CYCLE seconds.
const CYCLE = 60;
const CAST = [
  { key: 'map', name: 'Map the codebase', type: 'Explore', model: 'claude-haiku-5-5', from: 3, to: 27, acts: ['research', 'research', 'web'] },
  { key: 'collector', name: 'Implement telemetry collector', type: 'general-purpose', model: 'claude-sonnet-5-5', from: 6, to: 52, acts: ['code', 'shell', 'code', 'research'] },
  { key: 'art', name: 'Draw machine sprites', type: 'general-purpose', model: 'claude-fable-5-2', from: 9, to: 56, acts: ['code', 'think', 'code'] },
  { key: 'review', name: 'Review renderer changes', type: 'code-reviewer', model: 'claude-opus-5-5', from: 14, to: 44, acts: ['review'] },
  { key: 'tests', name: 'Write unit tests', type: 'general-purpose', model: 'claude-sonnet-5-5', from: 22, to: 58, acts: ['code', 'shell'] },
  { key: 'docs', name: 'Fetch API docs', type: 'web-fetch', model: 'claude-haiku-5-5', from: 30, to: 47, acts: ['web'] },
];
const BUSY_CAST = [
  { key: 'lint', name: 'Fix lint errors', type: 'general-purpose', model: 'claude-haiku-5-5', from: 1, to: 50, acts: ['code', 'shell'] },
  { key: 'bench', name: 'Benchmark the renderer', type: 'general-purpose', model: 'claude-sonnet-5-5', from: 4, to: 57, acts: ['shell', 'research'] },
  { key: 'audit', name: 'Audit accessibility', type: 'code-reviewer', model: 'claude-fable-5-2', from: 11, to: 49, acts: ['review'] },
  { key: 'plan', name: 'Plan the audio engine', type: 'Plan', model: 'claude-opus-5-5', from: 16, to: 55, acts: ['research', 'plan'] },
  { key: 'nova1', name: 'Translate the strings', type: 'general-purpose', model: 'claude-nova-1', from: 5, to: 53, acts: ['code'] },
  { key: 'nova2', name: 'Summarise the changelog', type: 'general-purpose', model: 'claude-nova-1', from: 25, to: 59, acts: ['research', 'code'] },
  { key: 'art2', name: 'Animate the reactor', type: 'general-purpose', model: 'claude-fable-5-2', from: 19, to: 58, acts: ['code', 'think'] },
];
const TOOL_OF = { code: 'Edit', shell: 'Bash', research: 'Grep', web: 'WebFetch', review: 'Read', plan: 'TodoWrite', delegate: 'Agent', think: null, idle: null };
const DONE_LINGER = 6;

function seedOf(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function tokensFor(seed, workedSec, weight) {
  const j = 0.7 + 0.6 * hash(seed, 1);
  return {
    input: Math.round(workedSec * 6 * j * weight),
    output: Math.round(workedSec * 28 * j * weight),
    cacheRead: Math.round(workedSec * 4200 * j * weight),
    cacheWrite: Math.round(workedSec * 210 * j * weight),
  };
}

function rateFor(seed, t, weight) {
  const wob = 0.6 + 0.8 * hash(seed, Math.floor(t / 3));
  return { input: Math.round(360 * wob * weight), output: Math.round(1700 * wob * weight), cacheRead: Math.round(250_000 * wob * weight) };
}

/**
 * Build the simulated Snapshot for a scenario at tSec seconds after it started.
 * @param {string} name one of SCENARIOS (unknown names fall back to 'tour')
 * @param {number} tSec seconds since the scenario started (it loops)
 * @param {number} nowMs wall clock to stamp into the snapshot
 * @returns {import('./contract.mjs').Snapshot}
 */
export function scenarioSnapshot(name, tSec, nowMs) {
  const scenario = SCRIPTS[name] ? name : 'tour';
  const script = SCRIPTS[scenario];
  const t = ((tSec % script.loop) + script.loop) % script.loop;
  const now = Math.round(nowMs);
  const startMs = now - t * 1000;
  const tr = script.tracks;

  const rows = [
    limitRow('session', 'session', null, 'Session', tr.session, t, now, SESSION_WINDOW),
    limitRow('weekly', 'weekly', null, 'Weekly (all models)', tr.weekly, t, now, WEEK_WINDOW),
    limitRow('model:fable', 'model', 'fable', 'Fable weekly', tr.fable, t, now, WEEK_WINDOW),
    limitRow('model:opus', 'model', 'opus', 'Opus weekly', tr.opus, t, now, WEEK_WINDOW),
    limitRow('model:sonnet', 'model', 'sonnet', 'Sonnet weekly', tr.sonnet, t, now, WEEK_WINDOW),
  ];
  const pct = Object.fromEntries(rows.map((r) => [r.id, r.percent]));
  const extra = script.extra
    ? { enabled: true, utilization: Math.round(22 + Math.min(40, t * 0.6)), usedCredits: Math.round(1100 + t * 30), monthlyLimit: 5000, currency: 'USD' }
    : { enabled: false, utilization: null, usedCredits: null, monthlyLimit: null, currency: null };
  const onBackup = extra.enabled;
  const mainsDown = (pct.session >= 100 || pct.weekly >= 100) && !onBackup;
  const stalled = (modelKey) => mainsDown || (pct[`model:${modelKey}`] ?? 0) >= 100;

  const agents = [];
  const mainModel = (scenario === 'tour' || scenario === 'calm' || scenario === 'busy') && t % 100 >= 68 && t % 100 < 92
    ? 'claude-opus-5-5' : 'claude-fable-5-2';
  const mainActs = ['delegate', 'plan', 'code', 'think', 'delegate', 'research'];
  const mk = (id, kind, o) => {
    const modelKey = modelKeyOf(o.model);
    const working = o.status === 'working';
    const flowing = working && !stalled(modelKey);
    const worked = Math.max(0, o.workedSec);
    return {
      id, sessionId: o.sessionId, parentId: o.parentId ?? null, kind, name: o.name,
      agentType: o.agentType ?? null, project: o.project ?? 'token-shelter',
      model: o.model, modelKey, status: o.status, activity: o.activity,
      tool: TOOL_OF[o.activity] ?? null, task: o.task ?? o.name,
      startedAt: Math.round(o.startedAt), lastActiveAt: Math.round(o.lastActiveAt), finishedAt: o.finishedAt ?? null,
      tokens: tokensFor(seedOf(id), worked, o.weight ?? 1),
      rate: flowing ? rateFor(seedOf(id), t, o.weight ?? 1) : zeroRate(),
    };
  };

  agents.push(mk('sim-main-1', 'main', {
    sessionId: 'sim-main-1', name: 'shelter-dev', model: mainModel, status: 'working',
    activity: mainActs[Math.floor(t / 7) % mainActs.length], task: 'Build the Token Shelter game',
    startedAt: startMs - 40 * 60_000, lastActiveAt: now, workedSec: 2400 + t, weight: 1.4,
  }));
  const busyMain = !!script.busy;
  agents.push(mk('sim-main-2', 'main', {
    sessionId: 'sim-main-2', name: 'docs-site', project: 'docs-site', model: 'claude-sonnet-5-5',
    status: busyMain ? 'working' : 'waiting', activity: busyMain ? 'code' : 'idle', task: 'Update the documentation site',
    startedAt: startMs - 3 * HOUR, lastActiveAt: busyMain ? now : now - 14 * 60_000, workedSec: 5200, weight: 0.8,
  }));
  // A session left open and untouched for hours: stale, so it waits in the lounge.
  agents.push(mk('sim-main-3', 'main', {
    sessionId: 'sim-main-3', name: 'old-spike', project: 'old-spike', model: 'claude-haiku-5-5',
    status: 'waiting', activity: 'idle', task: 'Try out a parser idea',
    startedAt: startMs - 9 * HOUR, lastActiveAt: now - 3 * HOUR, workedSec: 900, weight: 0.3,
  }));

  const cast = script.busy ? [...CAST, ...BUSY_CAST] : CAST;
  const cycle = Math.floor(t / CYCLE);
  for (const c of cast) {
    for (const n of [cycle - 1, cycle]) {
      if (n < 0) continue;
      const tc = t - n * CYCLE;                       // seconds into that cycle
      if (tc < c.from || tc >= c.to + DONE_LINGER) continue;
      const done = tc >= c.to;
      const id = `sim-main-1:${c.key}-${n}`;
      agents.push(mk(id, 'sub', {
        sessionId: 'sim-main-1', parentId: 'sim-main-1', name: c.name, agentType: c.type, model: c.model,
        status: done ? 'done' : 'working',
        activity: c.acts[Math.floor((tc - c.from) / 6) % c.acts.length],
        startedAt: startMs + (n * CYCLE + c.from) * 1000,
        lastActiveAt: done ? startMs + (n * CYCLE + c.to) * 1000 : now,
        finishedAt: done ? Math.round(startMs + (n * CYCLE + c.to) * 1000) : null,
        workedSec: Math.min(tc, c.to) - c.from,
      }));
    }
  }

  const keys = ['fable', 'opus', 'sonnet', 'haiku'];
  for (const a of agents) if (!keys.includes(a.modelKey)) keys.push(a.modelKey);
  const models = keys.map((key) => {
    const def = modelDef(key);
    const tokens = zeroTokens(), rate = zeroRate();
    let activeAgents = 0;
    for (const a of agents) {
      if (a.modelKey !== key) continue;
      for (const k of Object.keys(tokens)) tokens[k] += a.tokens[k];
      for (const k of Object.keys(rate)) rate[k] += a.rate[k];
      if (a.status === 'working') activeAgents++;
    }
    return { ...def, tokens, rate, activeAgents };
  });

  return {
    v: 1, at: now, source: 'simulation', scenario,
    limits: { at: now, stale: false, error: null, rows, extra },
    agents, models,
  };
}
