// Where things live, and the optional shelter.config.json. Node only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4780;
export const DEFAULT_USAGE_INTERVAL_SEC = 60;
/** The usage probe starts a CLI process; never let a config make it hammer the plan API. */
export const MIN_USAGE_INTERVAL_SEC = 15;
export const CONFIG_FILE = 'shelter.config.json';

const DESIGNS = new Set(['fable', 'opus', 'sonnet', 'haiku', 'generic']);

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

/** Where the collector keeps its own state: $SHELTER_DATA_DIR, else <project>/.data. */
export function dataDirOf(projectRoot, env = process.env) {
  return env.SHELTER_DATA_DIR ? path.resolve(env.SHELTER_DATA_DIR) : path.join(projectRoot, '.data');
}

/** A TCP port from a string or number, or null when it is not one. */
export function parsePort(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function cleanModel(m, warn) {
  if (!m || typeof m !== 'object') return null;
  const key = typeof m.key === 'string' ? m.key.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) {
    warn(`extraModels: ignoring an entry with a missing or invalid "key"`);
    return null;
  }
  const out = { key, design: DESIGNS.has(m.design) ? m.design : 'generic' };
  if (typeof m.label === 'string' && m.label.trim()) out.label = m.label.trim().slice(0, 24);
  if (typeof m.match === 'string' && m.match) {
    try {
      new RegExp(m.match, 'i');
      out.match = m.match;
    } catch {
      warn(`extraModels: "${key}" has an invalid "match" pattern; matching on the key only`);
    }
  }
  if (m.style && typeof m.style === 'object') {
    const style = {};
    for (const k of ['accent', 'accent2']) {
      if (Number.isInteger(m.style[k]) && m.style[k] >= 0 && m.style[k] <= 63) style[k] = m.style[k];
    }
    if (Number.isInteger(m.style.variant) && m.style.variant >= 0) style.variant = m.style.variant;
    out.style = style;
  }
  return out;
}

/**
 * Validate a parsed config object. Unknown keys are ignored, bad values fall back to defaults.
 * @returns {{port:number|null, usageIntervalSec:number, extraModels:object[]}}
 */
export function normalizeConfig(raw, warn = () => {}) {
  const cfg = { port: null, usageIntervalSec: DEFAULT_USAGE_INTERVAL_SEC, extraModels: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cfg;

  if (raw.port != null) {
    cfg.port = parsePort(raw.port);
    if (cfg.port == null) warn(`"port" must be 1..65535; using the default`);
  }
  if (raw.usageIntervalSec != null) {
    const n = Number(raw.usageIntervalSec);
    if (Number.isFinite(n) && n > 0) cfg.usageIntervalSec = Math.max(MIN_USAGE_INTERVAL_SEC, n);
    else warn(`"usageIntervalSec" must be a positive number; using ${DEFAULT_USAGE_INTERVAL_SEC}`);
  }
  if (Array.isArray(raw.extraModels)) {
    const seen = new Set();
    for (const m of raw.extraModels) {
      const clean = cleanModel(m, warn);
      if (clean && !seen.has(clean.key)) {
        seen.add(clean.key);
        cfg.extraModels.push(clean);
      }
    }
  }
  return cfg;
}

/** Read <projectRoot>/shelter.config.json. A missing file is fine; a broken one is reported and ignored. */
export function loadConfig(projectRoot, warn = (msg) => console.warn(`[shelter] ${CONFIG_FILE}: ${msg}`)) {
  let text;
  try {
    text = fs.readFileSync(path.join(projectRoot, CONFIG_FILE), 'utf8');
  } catch {
    return normalizeConfig(null);
  }
  try {
    return normalizeConfig(JSON.parse(text), warn);
  } catch (e) {
    warn(`not valid JSON (${e.message}); using defaults`);
    return normalizeConfig(null);
  }
}
