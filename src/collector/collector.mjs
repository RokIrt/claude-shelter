// The live telemetry source: local Claude Code data in, Snapshot out.
import { SNAPSHOT_VERSION } from '../shared/contract.mjs';
import { BUILTIN_MODELS, modelDef, zeroRate, zeroTokens } from '../shared/models.mjs';
import { AgentTracker } from './agents.mjs';
import { LimitsTracker } from './limits.mjs';
import { SampleStore } from './samples.mjs';
import { pathVariants } from './sessions.mjs';
import { createCliProbe, ensureProbeDir } from './usage.mjs';

/**
 * Machines for a snapshot: the built-ins, then configured extras, then any other model
 * an agent runs on or the plan meters, with the listed agents' throughput summed in.
 * @returns {import('../shared/contract.mjs').ModelInfo[]}
 */
export function buildModels(agents, rows, extraModels = []) {
  const keys = new Set([...BUILTIN_MODELS, ...extraModels].map((m) => m.key));
  const seen = new Set();
  // An agent whose model is not known yet ('unknown') gets no machine of its own.
  for (const a of agents) if (a.modelKey && a.modelKey !== 'unknown') seen.add(a.modelKey);
  for (const r of rows) if (r.modelKey) seen.add(r.modelKey);
  for (const key of [...seen].sort()) keys.add(key);

  const models = new Map();
  for (const key of keys) {
    models.set(key, { ...modelDef(key, extraModels), tokens: zeroTokens(), rate: zeroRate(), activeAgents: 0 });
  }
  for (const a of agents) {
    const m = models.get(a.modelKey);
    if (!m) continue;
    for (const k of Object.keys(m.tokens)) m.tokens[k] += a.tokens[k] ?? 0;
    for (const k of Object.keys(m.rate)) m.rate[k] += a.rate[k] ?? 0;
    if (a.status === 'working') m.activeAgents += 1;
  }
  return [...models.values()];
}

/**
 * @param {object} opts
 * @param {string} opts.configDir      Claude Code config dir (~/.claude)
 * @param {string} opts.dataDir        where usage history is kept
 * @param {()=>number} [opts.now]      clock
 * @param {()=>Promise<object>} [opts.probe]  resolves with a raw usage_report; default runs the CLI
 * @param {number} [opts.usageIntervalMs]
 * @param {object[]} [opts.extraModels]
 * @param {(pid:number)=>boolean} [opts.isAlive]
 * @param {(msg:string)=>void} [opts.warn]
 */
export function createCollector(opts) {
  const {
    configDir, dataDir, now = Date.now, usageIntervalMs = 60_000, extraModels = [],
    isAlive, warn = () => {},
  } = opts;

  // The default probe is a short-lived Claude Code process: keep it out of the agent list.
  // (It inherits our environment, CLAUDE_CONFIG_DIR included, so it reads the same account.)
  const cli = opts.probe ? null : createCliProbe();
  const probe = opts.probe ?? cli.run;
  if (cli) {
    // Create it now so its real path (temp dirs can be symlinks) is known for the exclusion.
    try {
      ensureProbeDir(cli.cwd);
    } catch { /* the probe reports this itself when it runs */ }
  }

  const tracker = new AgentTracker({
    configDir, extraModels, isAlive,
    excludeCwds: cli ? pathVariants(cli.cwd) : [],
    excludePids: () => (cli?.pid() != null ? [cli.pid()] : []),
  });
  const store = new SampleStore({ dir: dataDir }).load();
  const limits = new LimitsTracker({ probe, store, intervalMs: usageIntervalMs, now, extraModels, warn });

  let latest = null;
  let timer = null;
  let running = false;

  /** Re-read what changed on disk and build a fresh Snapshot. Cheap: call it every second. */
  function tick() {
    const at = now();
    const agents = tracker.update(at);
    const view = limits.view(at);
    latest = {
      v: SNAPSHOT_VERSION,
      at,
      source: 'live',
      scenario: null,
      limits: view,
      agents,
      models: buildModels(agents, view.rows, extraModels),
    };
    return latest;
  }

  function schedule() {
    if (!running) return;
    // Chained, not setInterval: the next probe is timed from the end of the last one.
    timer = setTimeout(() => limits.poll().then(schedule), usageIntervalMs);
  }

  return {
    tick,
    /** The most recent Snapshot (built now if there is none yet). */
    snapshot: () => latest ?? tick(),
    /** Probe the plan allowances once, now. Never overlaps a probe already running. */
    pollUsage: () => limits.poll(),
    /** Start probing the plan allowances: once now, then every usageIntervalMs. */
    start() {
      if (running) return;
      running = true;
      limits.poll().then(schedule);
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
      cli?.kill();
    },
    probeDir: cli?.cwd ?? null,
  };
}
