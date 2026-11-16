// The terminal view of the shelter: a text cutaway that fits a narrow pane.
//
//   renderCompact(state, {cols, rows, color, frame, whatIf}) -> string[]
//
// Pure and deterministic: no I/O, no clock (state.now is the only time), no mutable
// module state. Never returns more than `rows` lines or a line wider than `cols` cells.
//
// How it lays out: build(plan) draws the whole view for a given level of detail, and
// choosePlan() starts from the bare minimum (power mode, the key percentages, the top
// alert) and switches detail on in order of importance for as long as the result still
// fits the height. Widths are handled per row by trying wordings from long to short.
import { C, LIGHT } from '../gfx/palette.mjs';
import { formatCountdown, formatTokens, heatOf } from '../shared/forecast.mjs';
import { SCENARIO_INFO } from '../shared/scenarios.mjs';
import { stripAnsi, visibleWidth, clean, sp, rowWidth, clip, fitRow, cut, cell, wrap, underlay, relight, emit } from './ansi.mjs';

export { stripAnsi, visibleWidth };

/** The view never grows wider than this; a wider terminal just leaves the rest empty. */
export const MAX_COLS = 100;

/** One-cell resident glyph per role. */
export const ROLE_GLYPH = Object.freeze({ foreman: '@', programmer: 'p', researcher: 'r', reviewer: 'v', operator: 'o' });

const K = {
  title: C.AMBER_L, frame: C.STEEL_L, label: C.BRASS, dim: C.STEEL_L, faint: C.STEEL, track: C.STEEL_D,
  ok: C.GREEN_L, warn: C.YELLOW, hot: C.ORANGE, bad: C.RED_L, info: C.CYAN, whatIf: C.PINK,
};
const ACTIVITY = { code: 'coding', shell: 'shell', research: 'research', web: 'browsing', review: 'reviewing', plan: 'planning', delegate: 'delegating', think: 'thinking', idle: 'idle' };
const STATUS_RANK = { fire: 5, emergency: 4, pitstop: 4, hot: 3, running: 2, idle: 1 };

const toInt = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.floor(Number(v)) : d);
const arr = (v) => (Array.isArray(v) ? v : []);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pct = (v) => `${clamp(Math.round(Number(v) || 0), 0, 999)}%`;
const tight = (s) => s.replace(/ /g, '');
/** Small deterministic hash for flicker patterns. */
const hash2 = (a, b) => { let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };

/**
 * Draw the shelter as text.
 * @param {import('../shared/contract.mjs').ShelterState} state
 * @param {{cols?:number, rows?:number, color?:boolean|'256'|'truecolor', frame?:number, whatIf?:number}} [opts]
 *   color: true or '256' = ANSI 256-colour escapes (default), 'truecolor' = 24-bit escapes,
 *   false = plain text with status words. frame: animation frame counter (about 4 per second).
 * @returns {string[]} one string per terminal row
 */
export function renderCompact(state, opts = {}) {
  const o = opts ?? {};
  const cols = toInt(o.cols, 80), rows = toInt(o.rows, 24);
  if (cols < 1 || rows < 1) return [];
  const ctx = makeCtx(state, o, Math.min(cols, MAX_COLS), rows);
  const out = rows < 5 ? tinyRows(ctx) : build(ctx, choosePlan(ctx));
  return out.slice(0, rows).map((r) => emit(clip(r, ctx.cols), ctx.mode));
}

// ───────────────────────────── context ─────────────────────────────

function makeCtx(state, o, cols, rows) {
  const s = state && typeof state === 'object' ? state : {};
  const color = o.color ?? true;
  const mode = color === false ? false : color === 'truecolor' ? 'truecolor' : '256';
  const machines = arr(s.machines).filter((m) => m && typeof m === 'object');
  const residents = arr(s.residents).filter((r) => r && typeof r === 'object');
  const accent = new Map(), label = new Map();
  for (const m of machines) {
    const a = m.style?.accent;
    accent.set(m.modelKey, Number.isInteger(a) && a >= 0 && a < 64 ? a : C.STEEL_LL);
    label.set(m.modelKey, clean(m.label) || clean(m.modelKey) || '?');
  }
  const power = s.power === 'pitstop' || s.power === 'emergency' ? s.power : 'normal';
  const w = Number(o.whatIf ?? s.whatIf);
  const order = machines.map((m, i) => i).sort((a, b) => rankOf(machines[b]) - rankOf(machines[a]) || a - b);
  return {
    s, cols, rows, mode, color: mode !== false,
    frame: Math.abs(toInt(o.frame, 0)),
    whatIf: Number.isFinite(w) && w > 0 ? w : 1,
    now: Number.isFinite(s.now) ? s.now : 0,
    machines, residents, order,
    power,
    light: power === 'pitstop' ? LIGHT.AMBER : power === 'emergency' ? LIGHT.EMERGENCY : LIGHT.NORMAL,
    session: s.switchboard?.limit ?? null,
    weekly: s.reactor?.limit ?? null,
    gen: s.generator && s.generator.present ? s.generator : null,
    alerts: arr(s.alerts).filter((a) => a && a.text),
    accentOf: (key) => accent.get(key) ?? C.STEEL_LL,
    labelOf: (key) => label.get(key) ?? (clean(key) || '?'),
    control: residents.filter((r) => r.place === 'control'),
    lounge: residents.filter((r) => r.place === 'lounge'),
    exits: residents.filter((r) => r.place === 'exit'),
    crewOf: (key) => residents.filter((r) => r.place === 'machine' && r.modelKey === key),
    pad: cols >= 44 ? 1 : 0,
    shaft: cols >= 54,
    nameCol: clamp(Math.max(0, ...residents.map((r) => (clean(r.name) || clean(r.agentType) || 'agent').length)), 12, 30),
    crewW: Math.max(0, ...machines.map((m) => {
      const crew = residents.filter((r) => r.place === 'machine' && r.modelKey === m.modelKey);
      return crew.length ? crew.length + (crew.some((r) => r.blocked) ? 1 : 0) : 0;
    })),
  };
}

function rankOf(m) {
  return (STATUS_RANK[m.status] ?? 0) * 1000 + clamp(Number(m.heat) || 0, 0, 1) * 500 + clamp(Number(m.limit?.percent) || 0, 0, 400);
}

// ───────────────────────────── choosing the level of detail ─────────────────────────────

const BASE_PLAN = Object.freeze({
  machines: 1,      // machine rows (the rest collapse into "+N more")
  alertRows: 1,     // rows given to alerts
  frame: false,     // shelter walls (and the elevator shaft when there is width for it)
  gen: false,       // backup generator row
  crew: 0,          // 0 none, 1 one row of glyphs (lounge, and the console if anyone is there), 2 a line per resident
  meterFc: false,   // forecast sentence under the session and weekly meters
  tele: 0,          // 0 none, 1 one line, 2 ruled block
  seps: false,      // floor slabs with room names
  crewCap: 1,       // resident lines per room when crew is 2
  resCap: 0,        // resident lines under each machine
  machFc: false,    // forecast sentence under each machine
  legend: false, nominal: false, surface: false,
});

function choosePlan(ctx) {
  let plan = { ...BASE_PLAN };
  const fits = (p) => build(ctx, p).length <= ctx.rows;
  const tryOn = (patch) => { const next = { ...plan, ...patch }; if (!fits(next)) return false; plan = next; return true; };
  const tryMax = (key, max) => { for (let v = max; v > plan[key]; v--) if (tryOn({ [key]: v })) return true; return false; };

  tryMax('machines', ctx.machines.length);
  tryMax('alertRows', alertRows(ctx, Infinity, 1).length);          // the top alert in full
  tryOn({ frame: true });
  if (ctx.gen) tryOn({ gen: true });
  tryOn({ crew: 1 });
  tryOn({ meterFc: true });
  tryMax('alertRows', alertRows(ctx, Infinity).length);             // every alert
  // Then, as room allows, in the reverse of the order they are given up when space runs
  // short: per-machine extras, then resident detail, then raw telemetry.
  if (plan.frame) tryOn({ seps: true });
  tryOn({ machFc: true });
  const most = (lists) => Math.min(60, Math.max(0, ...lists.map((l) => l.length)));
  if (plan.seps && plan.crew === 1 && tryOn({ crew: 2 })) tryMax('crewCap', most([ctx.control, [...ctx.lounge, ...ctx.exits]]));
  tryMax('resCap', most(ctx.machines.map((m) => ctx.crewOf(m.modelKey))));
  tryOn({ tele: 1 });
  if (plan.tele) tryOn({ tele: 2 });
  if (plan.crew) tryOn({ legend: true });
  if (!ctx.alerts.length) tryOn({ nominal: true });
  if (plan.frame) tryOn({ surface: true });
  return plan;
}

function geometry(ctx, plan) {
  const pad = plan.frame ? ctx.pad : 0;
  const shaft = plan.frame && ctx.shaft;
  const W = Math.max(1, plan.frame ? ctx.cols - 2 - 2 * pad - (shaft ? 2 : 0) : ctx.cols);
  const names = ['Session', 'Weekly', ...(plan.gen ? ['Backup'] : []), ...ctx.machines.map((m) => ctx.labelOf(m.modelKey))];
  let nw = Math.min(Math.max(...names.map((n) => n.length)), W >= 40 ? 9 : 7);
  let bw = W >= 90 ? 24 : W >= 72 ? 18 : W >= 60 ? 14 : W >= 50 ? 12 : W >= 42 ? 10 : W >= 38 ? 7 : 5;
  let glyph = true;
  const fixed = () => nw + 1 + (glyph ? 4 : 0) + (bw ? bw + 1 : 0) + 4;
  while (fixed() > W && bw > 3) bw--;
  if (fixed() > W) nw = Math.max(3, nw - (fixed() - W));
  if (fixed() > W) glyph = false;
  if (fixed() > W) bw = 0;
  return { frame: plan.frame, pad, shaft, W, nw, bw, glyph, fixed: fixed(), tier: W >= 76 ? 0 : W >= 44 ? 1 : 2 };
}

// ───────────────────────────── the whole view ─────────────────────────────

function build(ctx, plan) {
  const g = geometry(ctx, plan);
  const out = [headerRow(ctx)];
  if (plan.surface) out.push(surfaceRow(ctx, g));
  out.push(...assemble(ctx, g, bodyRows(ctx, plan, g)));
  out.push(...alertRows(ctx, plan.alertRows));
  if (plan.nominal && !ctx.alerts.length) out.push([sp(ctx.pad ? ' ' : ''), sp('ok', K.ok, { b: true }), sp(' All systems nominal', K.dim)]);
  if (plan.tele) out.push(...telemetryRows(ctx, plan.tele));
  if (plan.legend) out.push(...legendRows(ctx));
  return out;
}

/** Under five rows there is no room for a cutaway: a status line, the top alert, the meters. */
function tinyRows(ctx) {
  const g = geometry(ctx, BASE_PLAN);
  const out = [summaryRow(ctx)];
  out.push(...alertRows(ctx, 1));
  out.push(sessionRow(ctx, g).c, weeklyRow(ctx, g).c);
  return out.map((r) => relight(r, 0));
}

/** The shelter's rooms, top to bottom, as row descriptors for assemble(). */
function bodyRows(ctx, plan, g) {
  const out = [];
  const row = (c, bg = null) => out.push({ k: 'row', c, bg });
  const slab = (title) => { if (plan.seps) out.push({ k: 'sep', title }); };
  let topTitle = null;

  if (plan.crew === 2) {
    // Working agents stand at their machines; the console is only listed if someone is there.
    if (ctx.control.length) {
      topTitle = 'CONTROL ROOM';
      roomLines(ctx, g, ctx.control, plan.crewCap, 'nobody at the console').forEach((c) => row(c));
      slab('LOUNGE');
    } else topTitle = 'LOUNGE';
    roomLines(ctx, g, [...ctx.lounge, ...ctx.exits], plan.crewCap, 'empty').forEach((c) => row(c));
    slab('MACHINES');
  } else if (plan.crew === 1) {
    row(crewRow(ctx, g));
    slab('MACHINES');
  } else if (plan.seps) {
    topTitle = 'MACHINES';
  }
  out.unshift({ k: 'top', title: topTitle });

  const n = ctx.machines.length;
  if (n === 0) row([sp('no machines yet', K.dim)]);
  const budget = Math.min(n, Math.max(1, plan.machines));
  const keep = budget >= n ? n : budget > 1 ? budget - 1 : 1;
  const shown = new Set(ctx.order.slice(0, keep));
  ctx.machines.forEach((m, i) => {
    if (!shown.has(i)) return;
    const r = machineRow(ctx, g, m);
    row(r.c, r.bg);
    if (plan.machFc && m.limit) row(forecastRow(ctx, g, m.limit));
    if (plan.resCap > 0) {
      const crew = ctx.crewOf(m.modelKey);
      const k = Math.min(crew.length, plan.resCap);
      for (let j = 0; j < k; j++) {
        const last = j === k - 1;
        row(residentLine(ctx, g.W, crew[j], last ? '  └ ' : '  ├ ', false, last && crew.length > k ? `+${crew.length - k} more` : null));
      }
    }
  });
  if (keep < n && budget > 1) {
    const rest = ctx.machines.filter((m, i) => !shown.has(i));
    const top = Math.max(...rest.map((m) => Number(m.limit?.percent) || 0));
    row([sp(cut(`+${rest.length} more machine${rest.length === 1 ? '' : 's'}, hottest ${pct(top)}`, g.W), K.dim)]);
  }

  slab('POWER ROOM');
  const ses = sessionRow(ctx, g);
  row(ses.c, ses.bg);
  if (plan.meterFc && ctx.session) row(forecastRow(ctx, g, ctx.session));
  if (plan.gen && ctx.gen) row(generatorRow(ctx, g));

  if (plan.seps) out.push({ k: 'rsep', title: 'REACTOR' });
  const wk = weeklyRow(ctx, g);
  out.push({ k: plan.seps ? 'rrow' : 'row', c: wk.c, bg: wk.bg });
  if (plan.meterFc && ctx.weekly) out.push({ k: plan.seps ? 'rrow' : 'row', c: forecastRow(ctx, g, ctx.weekly), bg: null });
  out.push({ k: 'bot' });
  return out;
}

/** Put walls, floor slabs and the elevator shaft around the room rows; light the rooms. */
function assemble(ctx, g, body) {
  // A row's own background (fire glow, alarm flash) is light of its own: laid on after the room is relit.
  const lit = (d) => underlay(relight(fitRow(d.c, g.W), ctx.light), d.bg);
  if (!g.frame) return body.filter((d) => d.k === 'row' || d.k === 'rrow').map(lit);

  const wallFg = ctx.power === 'pitstop' ? C.AMBER : ctx.power === 'emergency' ? (ctx.frame % 4 < 2 ? C.RED : C.RED_L) : K.frame;
  const wall = (t) => sp(t, wallFg, { em: true });
  const inner = ctx.cols - 2 - (g.shaft ? 2 : 0);
  const titled = (ch, title) => {
    if (!title || inner < title.length + 6) return [wall(ch.repeat(Math.max(0, inner)))];
    return [wall(ch + ' '), sp(title, ctx.power === 'normal' ? K.label : wallFg, { b: true, em: true }), wall(' ' + ch.repeat(inner - title.length - 3))];
  };
  const padS = (bg) => (g.pad ? [sp(' ', null, { bg })] : []);
  const lanes = body.filter((d) => d.k === 'row' || d.k === 'sep').length;
  const car = carOf(ctx, lanes);
  const hasHall = body.some((d) => d.k === 'rsep');
  let lane = 0;
  const carCell = () => (lane++ === car.at ? car.span : sp(' '));

  return body.map((d) => {
    switch (d.k) {
      case 'top': return [wall(g.shaft ? '╔═╤' : '╔'), ...titled('═', d.title), wall('╗')];
      case 'sep': return g.shaft
        ? [wall('║'), carCell(), wall('├'), ...titled('─', d.title), wall('╢')]
        : [wall('╟'), ...titled('─', d.title), wall('╢')];
      case 'rsep': return [wall(g.shaft ? '╠═╧' : '╠'), ...titled('═', d.title), wall('╣')];
      case 'bot': return [wall(g.shaft ? (hasHall ? '╚══' : '╚═╧') : '╚'), wall('═'.repeat(Math.max(0, inner))), wall('╝')];
      case 'rrow': return [wall('║'), ...(g.shaft ? [sp('  ', null, { bg: d.bg })] : []), ...padS(d.bg), ...lit(d), ...padS(d.bg), wall('║')];
      default: return [wall('║'), ...(g.shaft ? [carCell(), wall('│')] : []), ...padS(d.bg), ...lit(d), ...padS(d.bg), wall('║')];
    }
  });
}

/** Where the elevator car is. Someone clocking out rides it up; otherwise it idles up and down. */
function carOf(ctx, lanes) {
  if (lanes < 1) return { at: -1, span: sp(' ') };
  const leaving = ctx.exits[0];
  if (leaving) {
    const step = Math.floor(ctx.frame / 2) % lanes;
    return { at: lanes - 1 - step, span: sp(ROLE_GLYPH[leaving.role] ?? 'o', ctx.accentOf(leaving.modelKey), { b: true, em: true }) };
  }
  const span = Math.max(1, 2 * (lanes - 1));
  const p = Math.floor(ctx.frame / 3) % span;
  return { at: p < lanes ? p : span - p, span: sp('▓', C.STEEL_L) };
}

// ───────────────────────────── header ─────────────────────────────

function sourceTexts(ctx) {
  const s = ctx.s;
  if (s.source === 'simulation') {
    const name = clean(s.scenario);
    const label = clean(SCENARIO_INFO[s.scenario]?.label) || name;
    return name ? [`SIM: ${label}`, `SIM: ${name}`, 'SIM', ''] : ['SIM', 'SIM', 'SIM', ''];
  }
  const t = s.telemetry;
  if (t && t.known === false) return ['LIVE (no readings)', 'LIVE (no data)', 'LIVE', ''];
  if (t && t.stale) return ['LIVE (stale)', 'LIVE (stale)', 'LIVE', ''];
  return ['LIVE', 'LIVE', 'LIVE', ''];
}

function powerTexts(ctx) {
  const backup = ctx.gen?.running;
  if (ctx.power === 'pitstop') return backup ? ['PIT STOP - ON BACKUP', 'PIT STOP +GEN', 'PIT STOP'] : ['PIT STOP', 'PIT STOP', 'PIT STOP'];
  if (ctx.power === 'emergency') return backup ? ['EMERGENCY POWER - ON BACKUP', 'EMERGENCY +GEN', 'EMERGENCY'] : ['EMERGENCY POWER', 'EMERGENCY', 'EMERGENCY'];
  return ['POWER NORMAL', 'NORMAL', 'NORMAL'];
}

function powerBadge(ctx, text) {
  if (!ctx.color) return [sp(`[${text}]`)];
  const blink = ctx.frame % 4 < 2;
  if (ctx.power === 'pitstop') return [sp(` ${text} `, C.INK, { bg: blink ? C.AMBER : C.AMBER_L, b: true })];
  if (ctx.power === 'emergency') return [sp(` ${text} `, C.WHITE, { bg: blink ? C.RED : C.RED_D, b: true })];
  return [sp(` ${text} `, K.ok)];
}

const whatIfText = (ctx) => `x${+ctx.whatIf.toFixed(2)}`;

function headerRow(ctx) {
  const src = sourceTexts(ctx), pow = powerTexts(ctx);
  const wi = ctx.whatIf === 1 ? ['', ''] : [`what-if ${whatIfText(ctx)}`, whatIfText(ctx)];
  const live = ctx.s.source !== 'simulation';
  //             title            source  what-if  power
  const tries = [
    ['TOKEN SHELTER', src[0], wi[0], pow[0]], ['TOKEN SHELTER', src[1], wi[0], pow[0]], ['TOKEN SHELTER', src[1], wi[1], pow[0]],
    ['TOKEN SHELTER', src[1], wi[1], pow[1]], ['TOKEN SHELTER', src[2], wi[1], pow[1]], ['TOKEN SHELTER', src[2], wi[1], pow[2]],
    ['SHELTER', src[2], wi[1], pow[2]], ['', src[2], wi[1], pow[2]], ['', '', wi[1], pow[2]], ['', '', '', pow[2]],
  ];
  for (const [title, source, what, power] of tries) {
    const left = [];
    const add = (t, fg, o) => { if (!t) return; if (left.length) left.push(sp(left.length > 1 || ctx.cols >= 44 ? '  ' : ' ')); left.push(sp(t, fg, o)); };
    add(title, K.title, { b: true });
    add(source, live ? K.ok : K.info);
    add(what, K.whatIf, { b: true });
    const lead = ctx.pad && left.length ? [sp(' ')] : [];
    const badge = powerBadge(ctx, power);
    const gap = ctx.cols - rowWidth(lead) - rowWidth(left) - rowWidth(badge);
    if (gap >= (left.length ? 1 : 0)) return [...lead, ...left, sp(' '.repeat(gap)), ...badge];
  }
  return clip(powerBadge(ctx, pow[2]), ctx.cols);
}

/** One line with everything that matters, for panes only a few rows tall. */
function summaryRow(ctx) {
  const pow = powerTexts(ctx);
  const hot = ctx.machines[ctx.order[0]];
  const bits = [];
  if (ctx.session) bits.push(['S', ctx.session]);
  if (ctx.weekly) bits.push(['W', ctx.weekly]);
  if (hot?.limit) bits.push([ctx.labelOf(hot.modelKey), hot.limit]);
  for (const title of ['TOKEN SHELTER', 'SHELTER', '']) {
    for (const short of [false, true]) {
      const row = title ? [sp(title, K.title, { b: true }), sp(' ')] : [];
      row.push(...powerBadge(ctx, pow[short ? 2 : 1]));
      for (const [name, v] of bits) row.push(sp(' '), sp(`${short ? name.slice(0, 1) : name}${short || name.length === 1 ? '' : ' '}`, K.dim), sp(pct(v.percent), levelFg(v), { b: true }));
      if (ctx.whatIf !== 1) row.push(sp(' '), sp(whatIfText(ctx), K.whatIf));
      if (rowWidth(row) <= ctx.cols) return row;
    }
  }
  return clip(powerBadge(ctx, pow[2]), ctx.cols);
}

/** The ground above the shelter, with the entrance hut over the shaft. */
function surfaceRow(ctx, g) {
  const row = [sp(g.shaft ? '▄█▄' : '▄', C.STEEL_L)];
  let ground = '';
  for (let x = rowWidth(row); x < ctx.cols; x++) ground += hash2(x, 7) % 9 === 0 ? '▂' : '▁';
  row.push(sp(ground, C.GRASS));
  return row;
}

// ───────────────────────────── gauges ─────────────────────────────

const heatFg = (h) => (h >= 0.82 ? K.bad : h >= 0.62 ? K.hot : h >= 0.3 ? K.warn : K.ok);
const levelFg = (v) => (!v ? K.dim : v.level === 'exhausted' ? K.bad : v.level === 'critical' ? K.hot : v.level === 'warn' ? K.warn : K.ok);

/** A usage bar of w cells. kind: 'solid' | 'unpowered' | 'fire'. */
function bar(ctx, w, percent, fg, kind, seed) {
  if (w <= 0) return [];
  if (kind === 'fire') {
    const flame = [K.bad, K.hot, K.warn];
    const out = [];
    for (let i = 0; i < w; i++) {
      const h = hash2(ctx.frame * 31 + i, seed);
      out.push(sp('▓▒▓░'[h % 4], flame[(h >>> 4) % 3], { bg: C.RED_D, em: true }));
    }
    return out;
  }
  const p = clamp(Number(percent) || 0, 0, 100);
  let halves = Math.round((p / 100) * w * 2);
  if (p > 0 && halves === 0) halves = 1;
  if (p < 100 && halves === w * 2) halves = w * 2 - 1;
  const full = halves >> 1, half = halves & 1;
  const fill = kind === 'unpowered' ? '▒' : '█';
  return [
    sp(fill.repeat(full) + (half ? '▌' : ''), fg),
    sp('░'.repeat(w - full - half), K.track),
  ];
}

const join = (sep, ...parts) => {
  const out = [];
  for (const p of parts) { if (!p) continue; if (out.length) out.push(sp(sep)); out.push(p); }
  return out;
};

/**
 * Wordings for the right-hand side of a gauge row, richest first: index 0 for wide
 * panes, 1 for medium, 2 for narrow, then fallbacks. `keep` is the last wording worth
 * giving up resident glyphs for.
 * @param word status word {long, short, fg, plain} or null
 */
function limitTails(ctx, v, word) {
  const strong = word && !word.plain;
  const wl = word ? sp(word.long, word.fg ?? null, { b: strong, em: strong, bg: word.bg }) : null;
  const ws = strong ? sp(word.short ?? word.long, word.fg, { b: true, em: true, bg: word.bg }) : null;
  if (!v) return { list: [join(' ', wl), join(' ', wl), join(' ', ws)], keep: 2 };
  const cd = v.resetInMs != null ? formatCountdown(v.resetInMs) : null;
  const R = (lab, t) => (t ? sp(lab + t, K.dim) : null);
  if (v.level === 'exhausted') {
    return { list: [join('  ', wl, R('resets ', cd)), join(' ', wl, R('rst ', cd)), join(' ', wl, R('rst ', cd && tight(cd))), join(' ', wl, R('', cd && tight(cd))), join(' ', ws)], keep: 3 };
  }
  if (word && word.unpowered) {
    return { list: [join('  ', wl, R('resets ', cd)), join(' ', wl, R('rst ', cd)), join(' ', wl), join(' ', ws)], keep: 3 };
  }
  const wLate = wl;
  if (v.survives === false && v.exhaustInMs != null) {
    const ex = formatCountdown(v.exhaustInMs);
    const X = (lab, t) => sp(lab + t, v.level === 'ok' ? K.warn : K.hot, { b: v.level !== 'ok', em: true });
    return {
      list: [
        join('  ', wl, R('resets ', cd), X('runs out in ', ex)), join(' ', wl, R('rst ', cd), X('out ', ex)),
        join(' ', wLate, X('out ', ex)), join(' ', wLate, X('out ', tight(ex))), join(' ', ws, X('out ', tight(ex))),
        // Without colour the status word says more than the countdown (the forecast line repeats it).
        ...(ctx.color || !ws ? [join(' ', X('out ', tight(ex))), join(' ', ws)] : [join(' ', ws), join(' ', X('out ', tight(ex)))]),
      ],
      keep: 4,
    };
  }
  let fcA = null, fcB = null;
  if (v.ratePctPerHour == null) fcA = sp('no forecast yet', K.dim);
  else if (v.survives === true) { fcA = sp('lasts to reset', K.ok); fcB = word ? null : sp('ok', K.ok); }
  else if (v.exhaustInMs != null) { fcA = sp(`lasts ${formatCountdown(v.exhaustInMs)}`, K.dim); }
  return {
    list: [
      join('  ', wl, R('resets ', cd), fcA), join(' ', wl, R('rst ', cd), fcB),
      join(' ', wLate, R('rst ', cd && tight(cd))), join(' ', ws ?? R('', cd && tight(cd))),
    ],
    keep: 2,
  };
}

function pickTail(tails, tier, avail, reserve) {
  const { list, keep } = tails;
  const from = Math.min(tier, list.length - 1);
  let i1 = -1, i2 = -1;
  for (let i = from; i < list.length; i++) {
    const w = rowWidth(list[i]);
    if (w === 0) continue;
    if (i2 < 0 && w <= avail) i2 = i;
    if (i1 < 0 && w <= avail - reserve) i1 = i;
  }
  if (i1 >= 0 && (i1 <= Math.max(keep, from) || i1 === i2)) return list[i1];
  return i2 >= 0 ? list[i2] : [];
}

/**
 * One gauge row: name, animated glyph, usage bar, percent, then status / countdown /
 * forecast and (for machines) the residents standing at it, right-aligned.
 */
function gaugeRow(ctx, g, r) {
  const row = [sp(cell(r.name, g.nw), r.nameFg ?? null, { b: true })];
  if (g.glyph) row.push(sp(' '), ...r.glyph);
  const area = (g.bw ? g.bw + 1 : 0) + 4;
  if (r.missing) {
    const text = area >= r.missing.length ? r.missing : '--';
    const dashes = area - text.length - 1;
    row.push(sp(' '), sp(dashes > 0 ? '─'.repeat(dashes) + ' ' : ' '.repeat(Math.max(0, area - text.length)), K.track), sp(text, K.dim));
  } else {
    if (g.bw) row.push(sp(' '), ...bar(ctx, g.bw, r.percent, r.barFg, r.barKind ?? 'solid', r.seed ?? 0));
    row.push(sp(' '), sp(cell(pct(r.percent), 4, 'r'), r.pctFg ?? null, { b: true, em: true }));
  }
  const rest = g.W - rowWidth(row);
  if (rest < 2) return row;
  const avail = rest - 1;
  const crew = arr(r.crew);
  const blocked = crew.some((c) => c.blocked);
  // Machine rows all reserve room for the largest crew, so they pick the same wording.
  const fullW = r.crewW ?? (crew.length ? crew.length + (blocked ? 1 : 0) : 0);
  const want = Math.min(fullW, g.W < 40 ? 3 : g.W < 56 ? 5 : g.W < 76 ? 8 : 12);
  const tail = pickTail(r.tails, g.tier, avail, want ? want + 1 : 0);
  const tw = rowWidth(tail);
  const strip = crewStrip(ctx, crew, blocked, Math.min(20, avail - tw - (tw ? 1 : 0)));
  row.push(sp(' '), ...tail, sp(' '.repeat(avail - tw - rowWidth(strip))), ...strip);
  return row;
}

/** Residents at a machine as glyphs; '!' after them when the machine cannot run. */
function crewStrip(ctx, crew, blocked, maxW) {
  if (!crew.length || maxW < 1) return [];
  const mark = blocked ? [sp('!', K.bad, { b: true, em: true })] : [];
  const fullW = crew.length + mark.length;
  const glyph = (r) => sp(ROLE_GLYPH[r.role] ?? 'o', ctx.accentOf(r.modelKey), { b: true });
  if (fullW <= maxW) return [...crew.map(glyph), ...mark];
  const k = maxW - 1 - mark.length;
  if (k < 1) return [];
  return [...crew.slice(0, k).map(glyph), sp('+', K.dim), ...mark];
}

// ───────────────────────────── machines ─────────────────────────────

const PISTONS = ['▂▅█', '▅█▅', '█▅▂', '▅▂▅'];
const PISTONS_HOT = ['▅▇█', '▇█▅', '█▅▇'];
const FLAMES = ['^*^', '*^*', '^^*', '*^^'];

function machineGlyph(ctx, m, accent) {
  const f = ctx.frame;
  switch (m.status) {
    case 'running': {
      const speed = Number(m.speed) || 0;
      const step = speed >= 0.66 ? f : speed >= 0.4 ? Math.floor(f / 2) : Math.floor(f / 3);
      return [sp(PISTONS[step % 4], accent)];
    }
    case 'hot': return [sp(PISTONS_HOT[f % 3], K.hot, { b: true })];
    case 'fire': {
      const flame = [K.bad, K.warn, K.hot];
      return [...FLAMES[f % 4]].map((ch, i) => sp(ch, flame[(f + i) % 3], { bg: C.RED_D, b: true, em: true }));
    }
    case 'pitstop': return [sp(f % 4 < 2 ? '▁.▁' : '▁▁▁', C.AMBER, { em: true })];
    case 'emergency': return [sp(f % 2 ? '▁!▁' : '▁▁▁', K.bad, { em: true })];
    default: return [sp('▁▁▁', K.faint)];
  }
}

const MACHINE_WORD = {
  fire: { long: 'FIRE', fg: K.bad },
  hot: { long: 'HOT', fg: K.hot },
  pitstop: { long: 'PIT STOP', short: 'PIT', fg: C.AMBER_L, unpowered: true },
  emergency: { long: 'EMERGENCY', short: 'EMRG', fg: K.bad, unpowered: true },
};

function machineRow(ctx, g, m) {
  const accent = ctx.accentOf(m.modelKey);
  const v = m.limit ?? null;
  let word = MACHINE_WORD[m.status] ?? null;
  // Without colour the status has to be spelled out even when nothing is wrong.
  if (!word && !ctx.color) word = { long: m.status === 'running' ? 'run ' : 'idle', plain: true };
  let tails = limitTails(ctx, v, word);
  if (!v && !(word && !word.plain)) {
    const out = Number(m.rate?.output) || 0;
    const lead = word ? word.long.trim() + '  ' : '';
    tails = out > 0
      ? { list: [[sp(`${lead}${formatTokens(out)} out/min`, K.dim)], [sp(`${lead}${formatTokens(out)}/min`, K.dim)], [sp(`${formatTokens(out)}/m`, K.dim)]], keep: 0 }
      : { list: [[sp(word ? word.long.trim() : 'quiet', K.dim)]], keep: 0 };
  }
  const unpowered = m.status === 'pitstop' || m.status === 'emergency';
  const fire = m.status === 'fire';
  return {
    c: gaugeRow(ctx, g, {
      name: ctx.labelOf(m.modelKey), nameFg: accent, glyph: machineGlyph(ctx, m, accent),
      percent: v?.percent, missing: v ? null : 'shared',
      barFg: heatFg(Number(m.heat) || 0), barKind: fire ? 'fire' : unpowered ? 'unpowered' : 'solid', seed: hash2(ctx.machines.indexOf(m), 3),
      pctFg: v ? levelFg(v) : null,
      tails, crew: ctx.crewOf(m.modelKey), crewW: ctx.crewW,
    }),
    bg: fire ? (ctx.frame % 2 ? C.RED_D : (LIGHT.DARK << 6) | C.RED_D) : null,
  };
}

// ───────────────────────────── power room and reactor ─────────────────────────────

function sessionRow(ctx, g) {
  const v = ctx.session;
  const st = ctx.s.switchboard?.status ?? 'ok';
  const f = ctx.frame;
  let glyph, word = null;
  if (st === 'tripped') {
    glyph = [sp(['╞/╡', '╞/╡', '*/╡', '╞/*'][f % 4], C.AMBER_L, { b: true, em: true })];
    word = { long: 'TRIPPED', fg: C.INK, bg: f % 4 < 2 ? C.AMBER : C.AMBER_L };
  } else if (st === 'warn') {
    glyph = [sp(f % 4 === 3 ? '╞─╡' : '╞═╡', K.warn, { b: true })];
    word = { long: 'STRAIN', fg: K.warn };
  } else {
    glyph = [sp('╞═╡', v ? K.ok : K.faint)];
    if (!ctx.color && v) word = { long: 'ok  ', plain: true };
  }
  return {
    c: gaugeRow(ctx, g, {
      name: 'Session', glyph, percent: v?.percent, missing: v ? null : 'no data',
      barFg: heatFg(heatOf(v)), barKind: 'solid', pctFg: levelFg(v), tails: limitTails(ctx, v, word),
    }),
    bg: null,
  };
}

function weeklyRow(ctx, g) {
  const v = ctx.weekly;
  const st = ctx.s.reactor?.status ?? 'ok';
  const f = ctx.frame;
  const heat = Number(ctx.s.reactor?.heat) || 0;
  let glyph, word = null;
  if (st === 'meltdown') {
    glyph = [sp(['>█<', ')▓(', '>▒<', ')█('][f % 4], f % 2 ? K.warn : K.bad, { b: true, em: true })];
    word = { long: 'MELTDOWN', fg: K.bad };
  } else if (st === 'critical') {
    glyph = [sp(`(${'▓█'[f % 2]})`, K.bad, { b: true })];
    word = { long: 'CRITICAL', short: 'CRIT', fg: K.bad };
  } else if (st === 'hot') {
    glyph = [sp(`(${'▒▓█▓'[f % 4]})`, K.hot, { b: true })];
    word = { long: 'HOT', fg: K.hot };
  } else {
    glyph = [sp(`(${'░▒▓▒'[Math.floor(f / 2) % 4]})`, v ? K.info : K.faint)];
    if (!ctx.color && v) word = { long: 'ok  ', plain: true };
  }
  return {
    c: gaugeRow(ctx, g, {
      name: 'Weekly', glyph, percent: v?.percent, missing: v ? null : 'no data',
      barFg: heatFg(Math.max(heat, heatOf(v))), barKind: 'solid', pctFg: levelFg(v), tails: limitTails(ctx, v, word),
    }),
    bg: st === 'meltdown' && f % 2 ? C.RED_D : null,
  };
}

function generatorRow(ctx, g) {
  const gen = ctx.gen;
  const f = ctx.frame;
  const used = gen.utilization == null ? null : clamp(gen.utilization, 0, 1) * 100;
  // Credit amounts arrive in minor units of the currency (cents for USD).
  const money = (minor) => (gen.currency === 'USD' ? `$${(minor / 100).toFixed(2)}` : `${(minor / 100).toFixed(2)}${gen.currency ? ' ' + gen.currency : ''}`);
  const credits = gen.usedCredits != null && gen.monthlyLimit != null ? `${money(gen.usedCredits)} of ${money(gen.monthlyLimit)}` : null;
  const state = gen.running
    ? sp('RUNNING', C.AMBER_L, { b: true, em: true })
    : sp('standby', K.dim);
  const tails = { list: [join('  ', state, credits ? sp(credits, K.dim) : null), [state], [state], [gen.running ? sp('RUN', C.AMBER_L, { b: true, em: true }) : sp('stby', K.dim)]], keep: 3 };
  return gaugeRow(ctx, g, {
    name: 'Backup', nameFg: C.BRASS,
    glyph: [sp(gen.running ? `(${'|/-\\'[f % 4]})` : '(.)', gen.running ? C.AMBER_L : K.faint, { b: gen.running, em: gen.running })],
    percent: used, missing: used == null ? 'no data' : null,
    barFg: used != null && used >= 80 ? K.hot : C.BRASS, barKind: 'solid', pctFg: null, tails,
  });
}

/** The forecast for one allowance, shortened to fit one line. */
function shortForecast(v) {
  const reset = v.resetInMs != null ? formatCountdown(v.resetInMs) : null;
  if (v.level === 'exhausted') return reset ? `used up, resets in ${reset}` : 'used up';
  if (v.ratePctPerHour == null) return 'no forecast yet';
  if (v.ratePctPerHour <= 0) return 'steady, no recent use';
  if (v.survives === false && v.exhaustInMs != null) {
    if (v.scope === 'weekly' && v.shortfallMs != null) return `runs out ${formatCountdown(v.shortfallMs)} before reset`;
    return `${v.scope === 'session' ? 'trips' : v.scope === 'model' ? 'overheats' : 'runs out'} in ${formatCountdown(v.exhaustInMs)}`;
  }
  if (v.survives === true && v.resetInMs != null) {
    const atReset = Math.min(100, v.percent + (v.ratePctPerHour * v.resetInMs) / 3_600_000);
    return `lasts to reset, ~${Math.max(0, Math.round(100 - atReset))}% spare`;
  }
  return v.exhaustInMs != null ? `lasts about ${formatCountdown(v.exhaustInMs)}` : 'no forecast yet';
}

function forecastRow(ctx, g, v) {
  const indent = g.W >= 40 ? 3 : 1;
  const room = g.W - indent;
  const full = clean(v.forecast);
  const text = full && full.length <= room ? full : cut(shortForecast(v), room);
  const fg = v.level === 'exhausted' ? K.bad : v.survives === false ? K.warn : K.dim;
  return [sp(' '.repeat(indent)), sp(text, fg, { em: v.level === 'exhausted' })];
}

// ───────────────────────────── residents ─────────────────────────────

const ageText = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function activityOf(ctx, r) {
  if (r.blocked) return sp('BLOCKED', K.bad, { b: true, em: true });
  if (r.status === 'done') return sp('clocking out', K.dim);
  if (r.status === 'waiting' || r.stale) {
    const idle = Number.isFinite(r.lastActiveAt) ? ` ${ageText(ctx.now - r.lastActiveAt)}` : '';
    return sp(`${r.mood === 'sleepy' ? 'asleep' : 'waiting'}${idle}`, K.dim);
  }
  return sp(ACTIVITY[r.activity] ?? (clean(r.activity) || 'working'));
}

/** A resident glyph for the one-row crew view: '!' when blocked, 'z' when asleep. */
function crewGlyph(ctx, r) {
  const g = sp(ROLE_GLYPH[r.role] ?? 'o', ctx.accentOf(r.modelKey), { b: r.status === 'working' });
  if (r.blocked) return [g, sp('!', K.bad, { b: true, em: true })];
  if ((r.status === 'waiting' || r.stale) && r.mood === 'sleepy') return [g, sp('z', K.dim)];
  return [g];
}

/** The lounge (and the console, if anyone is at it) on one row. */
function crewRow(ctx, g) {
  const W = g.W;
  const names = W >= 40 ? ['Control', 'Lounge', 'exit'] : W >= 28 ? ['Ctrl', 'Lnge', 'out'] : ['C', 'L', 'x'];
  const groups = [...(ctx.control.length ? [[names[0], ctx.control]] : []), [names[1], ctx.lounge]];
  if (ctx.exits.length) groups.push([names[2], ctx.exits]);
  const make = (gap, between) => {
    const row = [];
    groups.forEach(([name, list], i) => {
      if (i) row.push(sp(between));
      row.push(sp(name, K.label), sp(' '));
      if (!list.length) row.push(sp('-', K.faint));
      list.forEach((r, j) => { if (j && gap) row.push(sp(gap)); row.push(...crewGlyph(ctx, r)); });
    });
    return row;
  };
  for (const [gap, between] of [[' ', '   '], [' ', '  '], ['', '  '], ['', ' ']]) {
    const row = make(gap, between);
    if (rowWidth(row) <= W) return row;
  }
  // Too many to draw: counts instead.
  return clip(join('  ', ...groups.map(([name, list]) => sp(`${name} ${list.length}`, K.label))), W);
}

/**
 * One resident on a line: glyph, name, what it is doing, and as the pane widens its
 * model, tool, output rate, age and task.
 */
function residentLine(ctx, W, r, prefix, showModel, more) {
  const head = [sp(prefix, K.faint), sp(ROLE_GLYPH[r.role] ?? 'o', ctx.accentOf(r.modelKey), { b: true }), r.blocked ? sp('!', K.bad, { b: true, em: true }) : sp(' '), sp(' ')];
  const gap = W >= 58 ? 2 : 1;
  const name = clean(r.name) || clean(r.agentType) || 'agent';
  const task = clean(r.task);
  const out = Number(r.rate?.output) || 0;
  const fields = [];   // [span, width]
  if (W >= 30) fields.push([activityOf(ctx, r), 12]);
  if (showModel && W >= 44) fields.push([sp(ctx.labelOf(r.modelKey), ctx.accentOf(r.modelKey)), 7]);
  if (W >= 58 && W < 90) fields.push([sp(clean(r.tool) || '-', K.dim), 9]);
  if (W >= 68) fields.push([sp(out > 0 ? `${formatTokens(out)}/m` : '-', K.dim), 7]);
  // The widest panes trade the tool and age columns for the task.
  if (W >= 78 && W < 90 && Number.isFinite(r.startedAt)) fields.push([sp(ageText(ctx.now - r.startedAt), K.dim), 4]);
  const tail = more ? [sp(' '.repeat(gap)), sp(more, K.dim)] : [];
  let free = W - rowWidth(head) - rowWidth(tail);
  while (fields.length && free - fields.reduce((a, [, w]) => a + w + gap, 0) < 8) fields.pop();
  free -= fields.reduce((a, [, w]) => a + w + gap, 0);
  // Wide panes get a name column sized to the longest name, the same in every room
  // (machine lines sit 4 cells further in, under their machine), and the task after it.
  const fixedName = W >= 90 ? ctx.nameCol + 4 - prefix.length : null;
  const nameW = Math.max(0, fixedName != null ? Math.min(free, fixedName) : free);
  const wantTask = fixedName != null && task && task !== name;
  const row = [...head, sp(cell(name, nameW))];
  for (const [span, w] of fields) row.push(sp(' '.repeat(gap)), { ...span, t: cell(span.t, w) });
  if (wantTask && free - nameW > gap + 8) row.push(sp(' '.repeat(gap)), sp(cell(task, free - nameW - gap), K.dim));
  row.push(...tail);
  return row;
}

/** A room's residents, one per line, at most `cap` lines. */
function roomLines(ctx, g, list, cap, emptyText) {
  if (!list.length) return [[sp(' '), sp(emptyText, K.faint)]];
  const k = Math.max(1, Math.min(list.length, cap));
  return list.slice(0, k).map((r, i) => residentLine(ctx, g.W, r, '', true, i === k - 1 && list.length > k ? `+${list.length - k} more` : null));
}

// ───────────────────────────── alerts, telemetry, legend ─────────────────────────────

/**
 * Alerts, most severe first, wrapped to the width. Whole alerts only, as many as fit in
 * `budget` rows; the top alert is cut short rather than dropped. `only` limits how many
 * alerts are considered.
 */
function alertRows(ctx, budget, only = Infinity) {
  const out = [];
  const lead = ctx.pad ? ' ' : '';
  const width = Math.max(4, ctx.cols - lead.length - 3);
  const list = ctx.alerts.slice(0, only);
  let shown = 0;
  for (const a of list) {
    const fg = a.level === 'critical' ? K.bad : a.level === 'warn' ? K.warn : K.info;
    const mark = a.level === 'critical' ? '!!' : a.level === 'warn' ? '! ' : 'i ';
    let lines = wrap(clean(a.text), width);
    if (!lines.length) continue;
    if (out.length + lines.length > budget) {
      if (shown > 0 || budget < 1) break;
      lines = lines.slice(0, budget);
      lines[lines.length - 1] = cut(lines[lines.length - 1] + ' ..', width);
    }
    lines.forEach((t, i) => out.push([sp(lead), sp(i ? '  ' : mark, fg, { b: true }), sp(' '), sp(t, a.level === 'info' ? K.dim : fg, { b: a.level === 'critical' })]));
    shown++;
  }
  const hidden = list.length - shown;
  if (hidden > 0 && out.length && only === Infinity) {
    const last = out[out.length - 1];
    const note = ` (+${hidden} more)`;
    if (rowWidth(last) + note.length <= ctx.cols) last.push(sp(note, K.dim));
  }
  return out;
}

const firstFit = (cands, w) => cands.find((c) => c.length <= w) ?? cut(cands[cands.length - 1], w);

/** Raw token throughput and totals. Telemetry, not allowance: drawn apart and labelled. */
function telemetryRows(ctx, level) {
  const r = ctx.s.rate ?? {}, t = ctx.s.tokens ?? {};
  const f = (n) => formatTokens(Number(n) || 0);
  const W = ctx.cols - (ctx.pad ? 1 : 0);
  const lead = ctx.pad ? ' ' : '';
  if (level < 2) {
    const body = firstFit([
      `tokens/min: ${f(r.output)} out  ${f(r.input)} in  ${f(r.cacheRead)} cache read   totals: ${f(t.output)} out  ${f(t.input)} in  ${f(t.cacheRead)} cache read  ${f(t.cacheWrite)} cache write`,
      `${f(r.output)} out/min  ${f(r.input)} in/min  ${f(r.cacheRead)} cache/min   total ${f(t.output)} out  ${f(t.input)} in`,
      `${f(r.output)} out/min  ${f(r.cacheRead)} cache/min  total ${f(t.output)} out`,
      `${f(r.output)} out/min  total ${f(t.output)} out`,
      `${f(r.output)} out/m tot ${f(t.output)}`,
      `${f(r.output)}/m`,
    ], W - 11);
    const label = W - 11 >= body.length ? 'TELEMETRY' : 'TELEM';
    return [[sp(lead), sp(label, K.faint, { b: true }), sp(label === 'TELEMETRY' ? '  ' : ' '), sp(cut(body, Math.max(0, W - label.length - 1)), K.dim)]];
  }
  const title = firstFit(['TELEMETRY: raw tokens, not allowance', 'TELEMETRY (raw tokens)', 'TELEMETRY'], Math.max(1, W - 6));
  const rule = W - title.length - 4;
  const num = (n) => f(n).padStart(6);
  const perMin = firstFit([
    `per min ${num(r.output)} out ${num(r.input)} in ${num(r.cacheRead)} cache read`,
    `per min ${num(r.output)} out ${num(r.input)} in ${num(r.cacheRead)} cache`,
    `per min ${num(r.output)} out ${num(r.cacheRead)} cache`,
  ], W);
  const total = firstFit([
    `total   ${num(t.output)} out ${num(t.input)} in ${num(t.cacheRead)} cache read ${num(t.cacheWrite)} cache write`,
    `total   ${num(t.output)} out ${num(t.input)} in ${num(t.cacheRead)} cache read`,
    `total   ${num(t.output)} out ${num(t.input)} in ${num(t.cacheRead)} cache`,
    `total   ${num(t.output)} out ${num(t.cacheRead)} cache`,
  ], W);
  return [
    [sp(lead), sp('── ', K.faint), sp(title, K.faint, { b: true }), sp(rule > 0 ? ' ' + '─'.repeat(rule) : '', K.faint)],
    [sp(lead), sp(perMin, K.dim)],
    [sp(lead), sp(total, K.dim)],
  ];
}

/** What the resident glyphs mean, on one line (or two when the pane is narrow). */
function legendRows(ctx) {
  const lead = ctx.pad ? ' ' : '';
  const W = ctx.cols - lead.length;
  const long = [['@', 'foreman'], ['p', 'programmer'], ['r', 'researcher'], ['v', 'reviewer'], ['o', 'operator'], ['!', 'blocked'], ['z', 'asleep']];
  const short = [['@', 'boss'], ['p', 'code'], ['r', 'research'], ['v', 'review'], ['o', 'other'], ['!', 'blocked']];
  for (const items of [long, short]) {
    const lines = [[]];
    let w = 0;
    for (const [g, name] of items) {
      const need = g.length + 1 + name.length + (w ? 2 : 0);
      if (w && w + need > W) { lines.push([]); w = 0; }
      const cur = lines[lines.length - 1];
      if (w) cur.push(sp('  '));
      cur.push(sp(g, g === '!' ? K.bad : null, { b: true }), sp(' ' + name, K.faint));
      w += g.length + 1 + name.length + (w ? 2 : 0);
    }
    if (lines.length <= 2 && lines.every((l) => rowWidth(l) <= W)) return lines.map((l) => [sp(lead), ...l]);
  }
  return [];
}
