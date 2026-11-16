// History of allowance readings, kept on disk so burn-rate forecasts survive restarts.
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3_600_000;
export const KEEP_MS = 8 * 24 * HOUR;
export const SAMPLES_FILE = 'usage-samples.json';

/**
 * @typedef {{at:number, percent:number, resetsAt:number|null}} Sample
 */

/**
 * Did the allowance window roll over between two consecutive readings?
 * Yes when the reset time jumped ahead by more than an hour (its sub-second digits
 * wobble between calls, so small moves mean nothing) and either the percentage fell
 * or the old reset time has already passed (the collector was off across the reset).
 * Without reset times, a falling percentage is the only sign there is.
 * @param {Sample|undefined} prev
 * @param {Sample} next
 */
export function isReset(prev, next) {
  if (!prev) return false;
  const dropped = next.percent < prev.percent;
  if (prev.resetsAt == null || next.resetsAt == null) return dropped;
  return next.resetsAt - prev.resetsAt > HOUR && (dropped || prev.resetsAt <= next.at);
}

const isSample = (s) => s && Number.isFinite(s.at) && Number.isFinite(s.percent)
  && (s.resetsAt === null || Number.isFinite(s.resetsAt));

export class SampleStore {
  /** @param {{dir:string, keepMs?:number}} opts */
  constructor({ dir, keepMs = KEEP_MS }) {
    this.dir = dir;
    this.file = path.join(dir, SAMPLES_FILE);
    this.keepMs = keepMs;
    /** @type {Map<string, {windowStart:number, samples:Sample[]}>} */
    this.rows = new Map();
  }

  /** Read the file. Missing or damaged data just means starting without history. */
  load() {
    this.rows = new Map();
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return this;
    }
    if (!data || data.v !== 1 || !data.rows || typeof data.rows !== 'object') return this;
    for (const [id, row] of Object.entries(data.rows)) {
      if (!row || !Array.isArray(row.samples)) continue;
      const samples = row.samples
        .map((s) => (Array.isArray(s) ? { at: s[0], percent: s[1], resetsAt: s[2] ?? null } : null))
        .filter(isSample)
        .sort((a, b) => a.at - b.at);
      if (!samples.length) continue;
      const windowStart = Number.isFinite(row.windowStart) ? row.windowStart : samples[0].at;
      this.rows.set(id, { windowStart, samples });
    }
    return this;
  }

  /**
   * Add a reading for one row. Starts a fresh window when it shows a reset.
   * @param {string} id row id
   * @param {Sample} sample
   */
  record(id, sample) {
    if (!isSample(sample)) return;
    let row = this.rows.get(id);
    if (!row) {
      row = { windowStart: sample.at, samples: [] };
      this.rows.set(id, row);
    }
    const prev = row.samples[row.samples.length - 1];
    if (prev && sample.at <= prev.at) return;   // the clock went backwards; keep history ordered
    if (isReset(prev, sample)) row.windowStart = sample.at;
    row.samples.push({ at: sample.at, percent: sample.percent, resetsAt: sample.resetsAt });
    const oldest = sample.at - this.keepMs;
    if (row.samples[0].at < oldest) row.samples = row.samples.filter((s) => s.at >= oldest);
  }

  /** Readings of the row's current window only: the ones a forecast may use. */
  window(id) {
    const row = this.rows.get(id);
    return row ? row.samples.filter((s) => s.at >= row.windowStart) : [];
  }

  /** Forget rows the plan stopped reporting long ago. */
  prune(now) {
    for (const [id, row] of this.rows) {
      const last = row.samples[row.samples.length - 1];
      if (!last || last.at < now - this.keepMs) this.rows.delete(id);
    }
  }

  /** Write the file atomically (temp file, then rename). */
  save() {
    // A directory we create ourselves is marked as not for version control.
    const created = fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (created) fs.writeFileSync(path.join(this.dir, '.gitignore'), '*\n');
    const rows = {};
    for (const [id, row] of this.rows) {
      rows[id] = { windowStart: row.windowStart, samples: row.samples.map((s) => [s.at, s.percent, s.resetsAt]) };
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, rows }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
