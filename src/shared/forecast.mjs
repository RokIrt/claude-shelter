// Burn-rate estimation and allowance forecasting. Pure, isomorphic, no I/O.
import { WARN_PCT, CRITICAL_PCT, EXHAUSTED_PCT } from './contract.mjs';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/**
 * How far back the burn rate looks. A session window is short, so only the last hour
 * matters; weekly windows average over a day so one busy hour does not predict doom.
 */
export const LOOKBACK_MS = Object.freeze({ session: 60 * MIN, weekly: 24 * HOUR, model: 24 * HOUR });

/** A forecast becomes an "approaching" warning when exhaustion is this close. */
export const NEAR_MS = Object.freeze({ session: 45 * MIN, weekly: 12 * HOUR, model: 12 * HOUR });

/**
 * Estimate the burn rate of one allowance window, in percent per hour.
 * @param {{at:number, percent:number}[]} samples readings from the CURRENT window only
 *   (the caller drops readings from before the last reset); any order.
 * @param {number} now epoch ms
 * @param {{scope?:'session'|'weekly'|'model', lookbackMs?:number, minSpanMs?:number}} [opts]
 * @returns {number|null} percent per hour (>= 0), or null when there is not enough history
 *   (fewer than two readings, or readings spanning less than minSpanMs, default 10 minutes).
 */
export function estimateRate(samples, now, opts = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const lookback = opts.lookbackMs ?? LOOKBACK_MS[opts.scope ?? 'weekly'] ?? LOOKBACK_MS.weekly;
  const minSpan = opts.minSpanMs ?? 10 * MIN;
  const pts = samples
    .filter((s) => s && Number.isFinite(s.at) && Number.isFinite(s.percent) && s.at <= now && s.at >= now - lookback)
    .sort((a, b) => a.at - b.at);
  if (pts.length < 2) return null;
  const span = pts[pts.length - 1].at - pts[0].at;
  if (span < minSpan) return null;
  // Readings are whole percents, so a least-squares slope is steadier than end points.
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.at; sy += p.percent; }
  const mx = sx / pts.length, my = sy / pts.length;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.at - mx) * (p.percent - my); den += (p.at - mx) * (p.at - mx); }
  if (den === 0) return null;
  // Spread the slope over the whole lookback when the readings stop short of now:
  // usage that ended a while ago should count as a lower rate, not the peak rate.
  const slopePerMs = num / den;
  const idle = Math.max(0, now - pts[pts.length - 1].at);
  const rate = slopePerMs * HOUR * (span / (span + idle));
  return Math.max(0, Math.round(rate * 1000) / 1000);
}

/** 'in 2 hours' style durations: '45 seconds', '25 minutes', '2 hours', '3 days'. */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  ms = Math.max(0, ms);
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms < 90_000) return ms < 45_000 ? plural(Math.max(1, Math.round(ms / 1000)), 'second') : '1 minute';
  if (ms < 90 * MIN) return plural(Math.round(ms / MIN), 'minute');
  if (ms < 36 * HOUR) return plural(Math.round(ms / HOUR), 'hour');
  return plural(Math.round(ms / DAY), 'day');
}

/** Compact countdown: '2d 4h', '1h 20m', '12m 05s', '45s'. */
export function formatCountdown(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Compact token counts: 950, 12.3k, 4.1M, 2.0B. */
export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return (n / 1e3).toFixed(a < 1e4 ? 1 : 0) + 'k';
  if (a < 1e9) return (n / 1e6).toFixed(a < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(1) + 'B';
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Project one allowance row forward.
 * @param {import('./contract.mjs').LimitRow} row
 * @param {number} now
 * @param {number} whatIf usage-rate multiplier (1 = actual)
 * @param {boolean} stale
 * @returns {import('./contract.mjs').LimitView}
 */
export function projectLimit(row, now, whatIf = 1, stale = false) {
  const percent = Number(row.percent) || 0;
  const resetsAt = Number.isFinite(row.resetsAt) ? row.resetsAt : null;
  const resetInMs = resetsAt == null ? null : Math.max(0, resetsAt - now);
  const rate = row.ratePctPerHour == null ? null : Math.max(0, row.ratePctPerHour * whatIf);
  const exhausted = percent >= EXHAUSTED_PCT;

  let exhaustInMs = null, survives = null, shortfallMs = null;
  if (exhausted) {
    exhaustInMs = 0; survives = false; shortfallMs = resetInMs;
  } else if (rate != null) {
    if (rate <= 0) {
      survives = true;
    } else {
      exhaustInMs = ((EXHAUSTED_PCT - percent) / rate) * HOUR;
      if (resetInMs != null) {
        survives = exhaustInMs >= resetInMs;
        shortfallMs = survives ? null : resetInMs - exhaustInMs;
      }
    }
  }

  const near = NEAR_MS[row.scope] ?? NEAR_MS.model;
  let level = exhausted ? 'exhausted' : percent >= CRITICAL_PCT ? 'critical' : percent >= WARN_PCT ? 'warn' : 'ok';
  if (!exhausted && survives === false && exhaustInMs != null) {
    if (exhaustInMs <= near / 4 && level !== 'critical') level = 'critical';
    else if (exhaustInMs <= near && level === 'ok') level = 'warn';
  }

  const view = {
    id: row.id, scope: row.scope, modelKey: row.modelKey ?? null, label: row.label,
    percent, resetsAt, resetInMs, ratePctPerHour: rate,
    exhaustInMs, survives, shortfallMs, spareAtResetPct: null, level, forecast: '', stale: !!stale,
  };
  if (survives === true && resetInMs != null && rate != null) {
    view.spareAtResetPct = Math.max(0, Math.round(100 - Math.min(100, percent + (rate * resetInMs) / HOUR)));
  }
  view.forecast = forecastSentence(view);
  return view;
}

function subject(v) {
  if (v.scope === 'model') return `${v.label.replace(/\s*weekly$/i, '')} machine`;
  if (v.scope === 'session') return 'Switchboard';
  return 'Central power';
}

/** One concrete sentence about where this allowance is heading. */
export function forecastSentence(v) {
  const who = subject(v);
  const reset = v.resetInMs == null ? '' : ` Reset in ${formatDuration(v.resetInMs)}.`;
  if (v.level === 'exhausted') {
    if (v.scope === 'model') return `${who} is down: allowance used up.${reset}`;
    if (v.scope === 'session') return `Switchboard tripped: session allowance used up.${reset}`;
    return `Reactor meltdown: weekly allowance used up.${reset}`;
  }
  if (v.ratePctPerHour == null) return 'Not enough history to forecast yet.';
  if (v.ratePctPerHour <= 0) return `${who} is holding steady: no recent usage.`;
  if (v.survives === false) {
    if (v.scope === 'model') return `${who} projected to overheat in ${formatDuration(v.exhaustInMs)}`;
    if (v.scope === 'session') return `Switchboard projected to trip in ${formatDuration(v.exhaustInMs)}`;
    return `Central power will run out ${formatDuration(v.shortfallMs)} before reset`;
  }
  if (v.survives === true && v.resetInMs != null) {
    const spare = v.spareAtResetPct ?? Math.max(0, Math.round(100 - Math.min(100, v.percent + (v.ratePctPerHour * v.resetInMs) / HOUR)));
    if (v.scope === 'model') return `${who} should reach its reset with about ${spare}% to spare`;
    if (v.scope === 'session') return `Session power should last until reset, with about ${spare}% to spare`;
    return `Central power should reach the weekly reset with about ${spare}% to spare`;
  }
  return `${who} would last about ${formatDuration(v.exhaustInMs)} at this rate`;
}

/**
 * Heat 0..1 of an allowance: from how full it is, raised when the forecast says it
 * will run out before its reset (so a what-if preview visibly changes heat).
 * @param {import('./contract.mjs').LimitView} v
 */
export function heatOf(v) {
  if (!v) return 0;
  if (v.level === 'exhausted') return 1;
  const p = clamp01((v.percent - 45) / 55);
  const pctHeat = p * p * (3 - 2 * p);
  let fcHeat = 0;
  if (v.survives === false && v.exhaustInMs != null) {
    // Far-off trouble is only a little warmth; it climbs as exhaustion comes within reach.
    const near = NEAR_MS[v.scope] ?? NEAR_MS.model;
    const closeness = clamp01(1 - v.exhaustInMs / (4 * near));
    fcHeat = closeness > 0 ? 0.3 + 0.65 * closeness : 0.12;
  }
  const floor = v.level === 'critical' ? 0.82 : v.level === 'warn' ? 0.62 : 0;
  return clamp01(Math.max(pctHeat, fcHeat, floor));
}
