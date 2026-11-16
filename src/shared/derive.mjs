// Snapshot -> ShelterState, and ShelterState pairs -> ShelterEvents. Pure, isomorphic.
import { projectLimit, heatOf, formatDuration } from './forecast.mjs';
import { zeroRate, zeroTokens } from './models.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const HOUR = 3_600_000;

/**
 * A session with no sign of life for this long is inactive (stale): its agents go to the
 * lounge. Until then a working agent is at its model's machine and one waiting for input
 * is in the control room.
 */
export const STALE_AFTER_MS = 1 * HOUR;

/** A session stale for this long has left the shelter: none of its agents are shown. */
export const HIDE_AFTER_MS = 24 * HOUR;

/**
 * How long an agent has shown no sign of life. A main agent counts its whole session (it is
 * quiet while a subagent works for it); a subagent counts only itself.
 */
function quietMs(a, sessionLast, now) {
  const own = Number.isFinite(a.lastActiveAt) ? a.lastActiveAt : now;
  const since = a.kind === 'main' ? Math.max(own, sessionLast.get(a.sessionId ?? a.id) ?? own) : own;
  return Math.max(0, now - since);
}

/** sessionId -> the latest lastActiveAt among its agents. */
function lastActivityBySession(agents, now) {
  const last = new Map();
  for (const a of agents) {
    const sid = a.sessionId ?? a.id;
    const at = Number.isFinite(a.lastActiveAt) ? a.lastActiveAt : now;
    last.set(sid, Math.max(last.get(sid) ?? -Infinity, at));
  }
  return last;
}

/**
 * The agents to show: a session idle for more than HIDE_AFTER_MS (no activity from any of its
 * agents) is dropped whole, and so is any one subagent silent that long (killed, never finished).
 */
export function visibleAgents(agents, now) {
  const sessionLast = lastActivityBySession(agents, now);
  return agents.filter((a) => now - sessionLast.get(a.sessionId ?? a.id) <= HIDE_AFTER_MS
    && quietMs(a, sessionLast, now) <= HIDE_AFTER_MS);
}

/** 0..1 work rate from token throughput (log scale); floor of 0.25 while anyone is working. */
export function speedOf(rate, active) {
  const tpm = (rate?.output ?? 0) + (rate?.input ?? 0) + (rate?.cacheRead ?? 0) / 50;
  if (tpm <= 0) return active > 0 ? 0.25 : 0;
  return clamp01(0.25 + 0.75 * (Math.log10(1 + tpm) / 5));
}

// A subagent's role comes from what it was asked to do (its type and description), not its
// current activity, so a resident keeps its look while it switches between tools.
function roleOf(a) {
  if (a.kind === 'main') return 'foreman';
  const type = a.agentType ?? '', name = a.name ?? '';
  if (/review|audit|verif|critic|inspect/i.test(type) || /\b(review|audit|verify|check)/i.test(name)) return 'reviewer';
  if (/explore|research|search|guide|fetch|plan/i.test(type) || /\b(research|explore|investigat|find|look up|search|fetch|docs|read|map)/i.test(name)) return 'researcher';
  if (/general|code|build|implement|fix|engineer|dev/i.test(type) || /\b(implement|write|fix|build|refactor|add|create|draw|port)/i.test(name)) return 'programmer';
  return 'operator';
}

const STATION = { foreman: 'terminal', programmer: 'terminal', operator: 'terminal', researcher: 'documents', reviewer: 'inspection' };
const ICON = { code: 'code', shell: 'shell', research: 'search', web: 'web', review: 'check', plan: 'plan', delegate: 'delegate', think: 'think', idle: 'wait' };

/**
 * @param {import('./contract.mjs').Snapshot} snap
 * @param {{now?:number, whatIf?:number}} [opts]
 * @returns {import('./contract.mjs').ShelterState}
 */
export function derive(snap, opts = {}) {
  snap = snap && typeof snap === 'object' ? snap : {};
  const now = opts.now ?? snap.at ?? 0;
  const whatIf = Number.isFinite(opts.whatIf) && opts.whatIf > 0 ? opts.whatIf : 1;
  const limits = (snap.limits && typeof snap.limits === 'object') ? snap.limits : { at: null, stale: true, error: null, rows: [], extra: null };
  const stale = !!limits.stale;
  const views = (Array.isArray(limits.rows) ? limits.rows : []).filter((r) => r && typeof r === 'object').map((r) => projectLimit(r, now, whatIf, stale));
  const session = views.find((v) => v.scope === 'session') ?? null;
  const weekly = views.find((v) => v.scope === 'weekly') ?? null;
  const modelLimit = new Map(views.filter((v) => v.scope === 'model').map((v) => [v.modelKey, v]));

  // Extra usage credits = the backup generator. It runs once an included allowance is spent.
  const extra = limits.extra ?? null;
  const anyExhausted = views.some((v) => v.level === 'exhausted');
  const generator = {
    present: !!(extra && extra.enabled),
    running: !!(extra && extra.enabled) && anyExhausted,
    utilization: extra && extra.utilization != null ? clamp01(extra.utilization / 100) : null,
    usedCredits: extra?.usedCredits ?? null,
    monthlyLimit: extra?.monthlyLimit ?? null,
    currency: extra?.currency ?? null,
  };

  const power = weekly?.level === 'exhausted' ? 'emergency' : session?.level === 'exhausted' ? 'pitstop' : 'normal';
  // On backup power the rooms stay amber/red but the machines keep turning.
  const mainsDown = power !== 'normal' && !generator.running;

  const agents = visibleAgents((Array.isArray(snap.agents) ? snap.agents : []).filter((a) => a && typeof a.id === 'string'), now);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const sessionLast = lastActivityBySession(agents, now);
  const staleIds = new Set(agents.filter((a) => a.status !== 'done' && quietMs(a, sessionLast, now) > STALE_AFTER_MS).map((a) => a.id));
  const active = (a) => a.status === 'working' && !staleIds.has(a.id);

  const models = (Array.isArray(snap.models) ? snap.models : []).filter((m) => m && typeof m.key === 'string');
  const machines = models.map((m) => {
    const limit = modelLimit.get(m.key) ?? null;
    const working = agents.filter((a) => a.modelKey === m.key && active(a)).length;
    const heat = heatOf(limit);
    let status;
    if (limit?.level === 'exhausted') status = 'fire';
    else if (mainsDown) status = power === 'emergency' ? 'emergency' : 'pitstop';
    else if (limit && (limit.level === 'warn' || limit.level === 'critical')) status = 'hot';
    else if (working > 0 || (m.rate?.output ?? 0) > 0) status = 'running';
    else status = 'idle';
    const powered = status === 'idle' || status === 'running' || status === 'hot';
    return {
      modelKey: m.key, label: m.label, design: m.design, style: m.style,
      limit, heat, status, powered,
      speed: powered ? speedOf(m.rate, working) : 0,
      rate: m.rate ?? zeroRate(), tokens: m.tokens ?? zeroTokens(),
      residentIds: [],
    };
  });
  const machineOf = new Map(machines.map((m) => [m.modelKey, m]));

  const residents = agents.map((a) => {
    const role = roleOf(a);
    const machine = machineOf.get(a.modelKey) ?? null;
    const stale = staleIds.has(a.id);
    const blocked = active(a) && !!machine && !machine.powered;
    // Working: at its model's machine. Waiting for input: in the control room, at the
    // console. Session inactive (no activity for STALE_AFTER_MS): in the lounge.
    const place = a.status === 'done' ? 'exit' : stale ? 'lounge' : a.status === 'waiting' ? 'control' : 'machine';
    const idleMs = Math.max(0, now - (a.lastActiveAt ?? now));
    let icon = ICON[a.activity] ?? 'think';
    let mood = 'focused';
    if (a.status === 'done') { icon = 'done'; mood = 'happy'; }
    else if (blocked) {
      icon = machine.status === 'fire' ? 'fire' : machine.status === 'pitstop' ? 'power' : 'alert';
      mood = machine.status === 'fire' || machine.status === 'emergency' ? 'shocked' : 'worried';
    } else if (stale || a.status === 'waiting') {
      const asleep = stale || idleMs > 5 * 60_000;
      icon = asleep ? 'zzz' : 'wait'; mood = asleep ? 'sleepy' : 'neutral';
    } else if (power === 'emergency') mood = 'worried';
    else if (a.activity === 'delegate' || a.activity === 'plan') mood = 'happy';
    const parent = a.parentId ? byId.get(a.parentId) : null;
    if (place === 'machine' && machine) machine.residentIds.push(a.id);
    return {
      id: a.id, kind: a.kind, role, name: a.name, agentType: a.agentType ?? null, project: a.project ?? null,
      parentId: a.parentId ?? null, parentName: parent?.name ?? null,
      model: a.model, modelKey: a.modelKey, place, status: a.status, activity: a.activity,
      station: STATION[role], icon, mood, blocked, stale,
      tool: a.tool ?? null, task: a.task ?? null,
      startedAt: a.startedAt, lastActiveAt: a.lastActiveAt,
      tokens: a.tokens ?? zeroTokens(), rate: a.rate ?? zeroRate(),
    };
  });

  const rate = zeroRate(), tokens = zeroTokens();
  for (const m of models) {
    for (const k of Object.keys(rate)) rate[k] += m.rate?.[k] ?? 0;
    for (const k of Object.keys(tokens)) tokens[k] += m.tokens?.[k] ?? 0;
  }
  const workingTotal = agents.filter((a) => a.status === 'working').length;

  const state = {
    now, source: snap.source ?? 'live', scenario: snap.scenario ?? null, whatIf,
    machines,
    switchboard: {
      limit: session,
      status: session?.level === 'exhausted' ? 'tripped' : session && session.level !== 'ok' ? 'warn' : 'ok',
    },
    reactor: {
      limit: weekly,
      heat: heatOf(weekly),
      status: weekly?.level === 'exhausted' ? 'meltdown' : weekly?.level === 'critical' ? 'critical' : weekly?.level === 'warn' ? 'hot' : 'ok',
      speed: mainsDown && power === 'emergency' ? 0 : Math.max(0.2, speedOf(rate, workingTotal)),
    },
    generator, power, residents,
    alerts: [],
    rate, tokens,
    speed: mainsDown ? 0 : speedOf(rate, workingTotal),
    telemetry: { at: limits.at ?? null, stale, error: limits.error ?? null, known: views.length > 0 },
  };
  state.alerts = buildAlerts(state, views);
  return state;
}

function buildAlerts(state, views) {
  const out = [];
  const order = { critical: 0, warn: 1, info: 2 };
  for (const v of views) {
    const who = v.scope === 'model' ? `model:${v.modelKey}` : v.scope;
    if (v.level === 'exhausted') {
      out.push({ id: `${who}:exhausted`, level: 'critical', scope: v.scope, modelKey: v.modelKey, text: v.forecast });
    } else if (v.level === 'critical' || v.level === 'warn') {
      const text = v.survives === false ? v.forecast
        : v.scope === 'model' ? `${v.label.replace(/\s*weekly$/i, '')} machine is running hot: ${Math.round(v.percent)}% of its allowance used`
        : v.scope === 'session' ? `Switchboard under strain: ${Math.round(v.percent)}% of the session allowance used`
        : `Reactor running hot: ${Math.round(v.percent)}% of the weekly allowance used`;
      out.push({ id: `${who}:${v.level}`, level: v.level === 'critical' ? 'critical' : 'warn', scope: v.scope, modelKey: v.modelKey, text });
    } else if (v.survives === false) {
      out.push({ id: `${who}:forecast`, level: 'info', scope: v.scope, modelKey: v.modelKey, text: v.forecast });
    }
  }
  const g = state.generator;
  if (g.running) {
    const used = g.utilization != null ? ` (${Math.round(g.utilization * 100)}% of the monthly credit limit used)` : '';
    out.push({ id: 'generator:running', level: 'info', scope: 'generator', modelKey: null, text: `Backup generator running on extra usage credits${used}` });
  }
  const t = state.telemetry;
  if (!t.known) {
    out.push({ id: 'telemetry:none', level: 'info', scope: 'telemetry', modelKey: null, text: t.error ? `No allowance readings: ${t.error}` : 'Waiting for the first allowance reading' });
  } else if (t.stale) {
    const age = t.at != null ? ` (last reading ${formatDuration(Math.max(0, state.now - t.at))} ago)` : '';
    out.push({ id: 'telemetry:stale', level: 'info', scope: 'telemetry', modelKey: null, text: `Allowance readings are stale${age}` });
  }
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Transitions between two consecutive states (same source and scenario).
 * Pass prev = null for the first state: every resident counts as newly arrived.
 * @returns {import('./contract.mjs').ShelterEvent[]}
 */
export function diffStates(prev, next) {
  const events = [];
  const was = new Map((prev?.residents ?? []).map((r) => [r.id, r]));
  const is = new Map(next.residents.map((r) => [r.id, r]));
  for (const r of next.residents) {
    const p = was.get(r.id);
    if (!p) {
      if (r.status !== 'done') events.push({ type: 'agent_arrived', id: r.id });
      continue;
    }
    if (p.status !== 'done' && r.status === 'done') events.push({ type: 'agent_left', id: r.id });
    if (p.modelKey !== r.modelKey) events.push({ type: 'agent_model_changed', id: r.id, from: p.modelKey, to: r.modelKey });
  }
  for (const p of was.values()) {
    if (!is.has(p.id) && p.status !== 'done') events.push({ type: 'agent_left', id: p.id });
  }
  if (!prev) return events;

  const limitsOf = (s) => [s.switchboard.limit, s.reactor.limit, ...s.machines.map((m) => m.limit)].filter(Boolean);
  const before = new Map(limitsOf(prev).map((v) => [v.id, v]));
  for (const v of limitsOf(next)) {
    const p = before.get(v.id);
    if (!p) continue;
    const ref = { scope: v.scope, modelKey: v.modelKey };
    // A reset: the percentage fell, and either the reset time moved on to a new window,
    // or the old reset time has passed, or the fall is too large to be anything else.
    const fell = p.percent - v.percent;
    const movedOn = p.resetsAt != null && v.resetsAt != null && v.resetsAt - p.resetsAt > HOUR;
    const pastDue = p.resetsAt != null && p.resetsAt <= next.now + 60_000;
    const reset = fell > 0 && (fell >= 5 || p.level === 'exhausted') && (movedOn || pastDue || fell >= 20);
    if (reset) { events.push({ type: 'limit_reset', ...ref }); continue; }
    if (v.level === 'exhausted' && p.level !== 'exhausted') events.push({ type: 'limit_reached', ...ref });
    else if ((v.level === 'warn' || v.level === 'critical') && p.level === 'ok') events.push({ type: 'limit_warning', ...ref });
  }
  if (next.generator.running && !prev.generator.running) events.push({ type: 'generator_started' });
  if (!next.generator.running && prev.generator.running) events.push({ type: 'generator_stopped' });
  return events;
}
