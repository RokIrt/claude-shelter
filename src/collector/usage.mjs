// Plan allowances, read by asking the Claude Code CLI itself: `claude -p "/usage"`.
// The call spends no tokens. Parsing and mapping are pure; only createCliProbe runs a process.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelDef, modelKeyOf } from '../shared/models.mjs';

export const PROBE_ARGS = Object.freeze([
  '-p', '/usage', '--output-format', 'stream-json', '--verbose',
  // Without this every probe would leave a transcript behind.
  '--no-session-persistence',
]);
export const PROBE_TIMEOUT_MS = 30_000;
/** How long a probe gets to exit after SIGTERM before it is killed outright. */
export const PROBE_GRACE_MS = 3_000;
const MAX_OUTPUT = 4 << 20;

/** The probe runs in its own directory so its short-lived session can be told apart. */
export const defaultProbeDir = () => path.join(os.tmpdir(), 'token-shelter-probe');

/**
 * Pull the usage_report object out of the CLI's stream-json output.
 * @param {string} text JSONL
 * @returns {object} the raw usage_report
 */
export function parseUsageOutput(text) {
  let failure = null;
  for (const line of String(text).split('\n')) {
    if (!line.includes('usage_report') && !line.includes('"is_error"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.usage_report && typeof entry.usage_report === 'object') return entry.usage_report;
    if (entry?.type === 'result' && entry.is_error === true && typeof entry.result === 'string') failure = entry.result;
  }
  const error = new Error(failure ? `claude reported: ${oneLine(failure)}` : 'no usage report in the CLI output');
  error.reported = failure != null;
  throw error;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 160);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * resets_at -> epoch ms on the nearest whole minute. Resets fall on whole minutes, but the
 * reported time jitters by up to a second between rows and calls ('10:00:00.816' for one
 * row, '09:59:59.816' for another in the same report), which would make a clock flicker.
 */
export function parseResetTime(value) {
  let ms = null;
  if (typeof value === 'string' && value) ms = Date.parse(value);
  else if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  return Number.isFinite(ms) ? Math.round(ms / 60_000) * 60_000 : null;
}

const SCOPE_ORDER = { session: 0, weekly: 1, model: 2 };

/**
 * Map a raw usage_report to contract rows. Rows the shelter has no meter for (unknown
 * kinds, scoped rows without a model, rows without a number) are dropped.
 * A report without rate_limits (API key, no plan) is a valid reading with no rows.
 * @returns {{rows: import('../shared/contract.mjs').LimitRow[],
 *            extra: import('../shared/contract.mjs').Limits['extra']}}
 */
export function mapUsageReport(report, extraModels = []) {
  const limits = report?.rate_limits;
  if (!limits || typeof limits !== 'object') return { rows: [], extra: null };

  const byId = new Map();
  for (const raw of Array.isArray(limits.limits) ? limits.limits : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) continue;
    let head;
    if (raw.kind === 'session') {
      head = { id: 'session', scope: 'session', modelKey: null, label: 'Session' };
    } else if (raw.kind === 'weekly_all') {
      head = { id: 'weekly', scope: 'weekly', modelKey: null, label: 'Weekly (all models)' };
    } else if (raw.kind === 'weekly_scoped') {
      const name = raw.scope?.model?.display_name;
      if (typeof name !== 'string' || !name.trim()) continue;
      const modelKey = modelKeyOf(name, extraModels);
      head = { id: `model:${modelKey}`, scope: 'model', modelKey, label: `${modelDef(modelKey, extraModels).label} weekly` };
    } else {
      continue;
    }
    const row = {
      ...head,
      percent: Math.max(0, raw.percent),
      resetsAt: parseResetTime(raw.resets_at),
      ratePctPerHour: null,
      severity: typeof raw.severity === 'string' ? raw.severity : null,
      active: typeof raw.is_active === 'boolean' ? raw.is_active : null,
    };
    // Two rows for one meter should not happen; if they do, show the fuller one.
    const other = byId.get(row.id);
    if (!other || row.percent > other.percent) byId.set(row.id, row);
  }
  const rows = [...byId.values()].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);

  const x = limits.extra_usage;
  const extra = x && typeof x === 'object'
    ? {
      enabled: x.is_enabled === true,
      utilization: numOrNull(x.utilization),
      usedCredits: numOrNull(x.used_credits),
      monthlyLimit: numOrNull(x.monthly_limit),
      currency: typeof x.currency === 'string' ? x.currency : null,
    }
    : null;
  return { rows, extra };
}

/**
 * Make sure the probe directory is ours. The CLI reads project settings from its working
 * directory, and the OS temp dir is shared, so a directory someone else prepared is refused.
 */
export function ensureProbeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`usage probe directory ${dir} is not a directory`);
  if (typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) throw new Error(`usage probe directory ${dir} belongs to another user`);
    if (st.mode & 0o022) fs.chmodSync(dir, 0o700);
  }
}

/**
 * The real probe: runs the CLI and resolves with the raw usage_report.
 * @param {{command?:string, cwd?:string, timeoutMs?:number, graceMs?:number, env?:object, spawn?:Function}} [opts]
 * @returns {{run:()=>Promise<object>, kill:()=>void, pid:()=>number|null, cwd:string}}
 */
export function createCliProbe(opts = {}) {
  const {
    command = 'claude', cwd = defaultProbeDir(), timeoutMs = PROBE_TIMEOUT_MS, graceMs = PROBE_GRACE_MS,
    env = process.env, spawn = nodeSpawn,
  } = opts;
  let child = null;

  // Ask first: a CLI that is killed outright leaves its sessions/<pid>.json behind.
  const stop = (proc) => {
    proc.kill('SIGTERM');
    const hard = setTimeout(() => proc.kill('SIGKILL'), graceMs);
    proc.once('close', () => clearTimeout(hard));
  };

  const run = () => new Promise((resolve, reject) => {
    if (child) return reject(new Error('usage probe already running'));
    let proc;
    try {
      ensureProbeDir(cwd);
      proc = spawn(command, PROBE_ARGS, {
        cwd,
        // Auto-memory would create a projects/<slug>/memory directory for the probe dir.
        env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }
    child = proc;
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(proc);
    }, timeoutMs);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child === proc) child = null;
      fn(value);
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    proc.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
    proc.on('error', (e) => {
      settle(reject, e.code === 'ENOENT' ? new Error(`"${command}" was not found on PATH`) : e);
    });
    proc.on('close', (code, signal) => {
      if (timedOut) return settle(reject, new Error(`usage probe timed out after ${Math.round(timeoutMs / 1000)} s`));
      try {
        settle(resolve, parseUsageOutput(out));
      } catch (e) {
        // The CLI's own explanation (e.g. not logged in) beats a bare exit code.
        const why = code ? `claude exited with code ${code}` : signal ? `claude was stopped by ${signal}` : null;
        const detail = oneLine(err);
        settle(reject, why && !e.reported ? new Error(detail ? `${why}: ${detail}` : why) : e);
      }
    });
  });

  return {
    run,
    /** Stop a probe that is running (shutdown). */
    kill: () => { if (child) stop(child); },
    pid: () => child?.pid ?? null,
    cwd,
  };
}
