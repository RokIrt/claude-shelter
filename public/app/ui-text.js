// Wording for the HUD: turns LimitViews and statuses into short, concrete labels.
import { formatCountdown, formatDuration, formatTokens } from '/src/shared/forecast.mjs';

export { formatCountdown, formatDuration, formatTokens };

export const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '--');

/** 'x1.5', 'x0.25', 'x2' */
export function multLabel(m) {
  const r = Math.round(m * 100) / 100;
  return `x${String(r)}`;
}

/** Tone names used by the stylesheet: good | warn | bad | dim | info. */
export const LEVEL_TONE = { ok: 'good', warn: 'warn', critical: 'crit', exhausted: 'bad' };

/** The word shown beside a bar, so the level never rests on colour alone. */
export function levelWord(limit) {
  if (!limit) return '--';
  if (limit.level === 'exhausted') return limit.scope === 'model' ? 'FIRE' : limit.scope === 'session' ? 'TRIPPED' : 'MELTDOWN';
  return { ok: 'OK', warn: 'WARN', critical: 'CRIT' }[limit.level] ?? String(limit.level).toUpperCase();
}

/** 'Session', 'Weekly', 'Fable' */
export function shortLabel(limit) {
  if (limit.scope === 'session') return 'Session';
  if (limit.scope === 'weekly') return 'Weekly';
  return limit.label.replace(/\s*weekly$/i, '');
}

/** What the allowance stands for in the shelter. */
export function metaphor(limit) {
  return limit.scope === 'session' ? 'switchboard' : limit.scope === 'weekly' ? 'reactor' : 'machine';
}

/**
 * The projection line of a meter: main text, an optional extra that is dropped when
 * the meter is narrow, and a tone.
 */
export function forecastShort(limit) {
  if (limit.level === 'exhausted') return { main: 'USED UP', extra: '', tone: 'bad' };
  if (limit.ratePctPerHour == null) return { main: 'NO FORECAST YET', short: 'NO FCST', extra: '', tone: 'dim' };
  if (limit.survives === true) return { main: 'REACHES RESET', short: '✓ LASTS', extra: '', tone: 'good' };
  if (limit.survives === false && limit.exhaustInMs != null) {
    return {
      main: `OUT IN ${formatCountdown(limit.exhaustInMs)}`,
      short: `OUT ${formatCountdown(limit.exhaustInMs)}`,
      extra: limit.shortfallMs != null ? `${formatCountdown(limit.shortfallMs)} SHORT` : '',
      tone: limit.level === 'ok' ? 'warn' : 'bad',
    };
  }
  if (limit.exhaustInMs != null) return { main: `LASTS ${formatCountdown(limit.exhaustInMs)}`, extra: '', tone: 'dim' };
  return { main: 'STEADY', extra: '', tone: 'good' };
}

/** Full-sentence projection for the inspector. */
export function exhaustText(limit) {
  if (limit.level === 'exhausted') return 'Allowance used up';
  if (limit.ratePctPerHour == null) return 'Unknown: not enough history yet';
  if (limit.survives === true) return 'Not before the reset';
  if (limit.exhaustInMs == null) return 'Not burning right now';
  const when = `in ${formatDuration(limit.exhaustInMs)}`;
  if (limit.survives === false && limit.shortfallMs != null) return `${when}, ${formatDuration(limit.shortfallMs)} before the reset`;
  return `${when} at this rate`;
}

/** Does it reach the reset? */
export function reachesText(limit) {
  if (limit.level === 'exhausted') return limit.resetInMs != null ? `No: already out, ${formatDuration(limit.resetInMs)} to go` : 'No: already out';
  if (limit.survives === true) return 'Yes';
  if (limit.survives === false) return limit.shortfallMs != null ? `No: ${formatDuration(limit.shortfallMs)} short` : 'No';
  return limit.resetInMs == null ? 'No reset time reported' : 'Unknown yet';
}

export function resetText(limit, now) {
  if (limit.resetInMs == null) return 'not reported';
  const at = limit.resetsAt != null ? clockLabel(limit.resetsAt, now) : '';
  return at ? `${formatCountdown(limit.resetInMs)} (${at})` : formatCountdown(limit.resetInMs);
}

/** 'Thu 14:05' or just '14:05' when it is today. */
export function clockLabel(at, now) {
  try {
    const d = new Date(at), n = new Date(now);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === n.toDateString()) return hm;
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
  } catch { return ''; }
}

export function burnText(limit, whatIf) {
  if (limit.ratePctPerHour == null) return 'not enough history yet';
  const r = limit.ratePctPerHour;
  const txt = `${r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2)} %/h`;
  return whatIf !== 1 ? `${txt} (preview ${multLabel(whatIf)})` : txt;
}

export const perMin = (n) => `${formatTokens(n)}/min`;

/** Group digits: 12345 -> '12,345'. */
export function num(n) {
  if (n == null || !Number.isFinite(n)) return '--';
  try { return Math.round(n).toLocaleString('en-US'); } catch { return String(Math.round(n)); }
}

/** Elapsed time that visibly ticks: '45s', '12m 05s', '1h 20m'. */
export const elapsed = (ms) => formatCountdown(Math.max(0, ms));
