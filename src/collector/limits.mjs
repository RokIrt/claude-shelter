// Keeps the latest plan-allowance reading, its staleness, and the burn rate of each row.
import { estimateRate as defaultEstimateRate } from '../shared/forecast.mjs';
import { mapUsageReport } from './usage.mjs';

/** A reading older than this many probe intervals is reported as stale. */
export const STALE_AFTER_INTERVALS = 3;

/**
 * Readings with no rows in a row before they replace rows we already had. The CLI sometimes
 * answers with an empty limits list (observed: every other probe for a stretch, cause unknown);
 * such a reading is no news: the last rows stay, aging toward stale as usual. A run this long
 * is a real change (the plan no longer reports limits).
 */
export const EMPTY_READINGS_TO_ACCEPT = 5;

export class LimitsTracker {
  /**
   * @param {{probe:()=>Promise<object>, store:import('./samples.mjs').SampleStore,
   *          intervalMs:number, now?:()=>number, extraModels?:object[],
   *          estimateRate?:Function, warn?:(msg:string)=>void}} opts
   *   probe resolves with a raw usage_report, or rejects.
   */
  constructor({ probe, store, intervalMs, now = Date.now, extraModels = [], estimateRate = defaultEstimateRate, warn = () => {} }) {
    this.probe = probe;
    this.store = store;
    this.intervalMs = intervalMs;
    this.now = now;
    this.extraModels = extraModels;
    this.estimateRate = estimateRate;
    this.warn = warn;
    this.at = null;        // last successful reading
    this.rows = [];
    this.extra = null;
    this.failed = false;   // the most recent probe failed
    this.error = null;
    this.inFlight = null;
    this.saveFailed = false;
    this.emptyStreak = 0;  // consecutive readings with no rows while we still show rows
  }

  /** Run one probe. A call made while one is running joins it instead of starting another. */
  poll() {
    this.inFlight ??= this.#poll().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #poll() {
    try {
      const report = await this.probe();
      const { rows, extra } = mapUsageReport(report, this.extraModels);
      if (rows.length === 0 && this.rows.length > 0 && ++this.emptyStreak < EMPTY_READINGS_TO_ACCEPT) {
        this.failed = false;   // the CLI answered; it just had nothing new to say
        this.error = null;
        return;
      }
      this.emptyStreak = 0;
      const at = this.now();
      for (const row of rows) this.store.record(row.id, { at, percent: row.percent, resetsAt: row.resetsAt });
      this.store.prune(at);
      try {
        this.store.save();
        this.saveFailed = false;
      } catch (e) {
        // History is a nicety; a read-only disk must not cost us the reading itself.
        if (!this.saveFailed) this.warn(`could not save usage history: ${e.message}`);
        this.saveFailed = true;
      }
      this.rows = rows;
      this.extra = extra;
      this.at = at;
      this.failed = false;
      this.error = null;
    } catch (e) {
      // Keep showing the last good rows; they are flagged stale, never zeroed.
      this.failed = true;
      this.error = String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 200) || 'usage probe failed';
    }
    this.#refreshRates();
  }

  #refreshRates() {
    const now = this.now();
    for (const row of this.rows) {
      let rate = null;
      try {
        rate = this.estimateRate(this.store.window(row.id), now, { scope: row.scope });
      } catch { /* no forecast is better than no reading */ }
      row.ratePctPerHour = Number.isFinite(rate) ? rate : null;
    }
  }

  /** @returns {import('../shared/contract.mjs').Limits} */
  view(now = this.now()) {
    return {
      at: this.at,
      stale: this.failed || (this.at != null && now - this.at > STALE_AFTER_INTERVALS * this.intervalMs),
      error: this.error,
      rows: this.rows.map((row) => ({ ...row })),
      extra: this.extra ? { ...this.extra } : null,
    };
  }
}
