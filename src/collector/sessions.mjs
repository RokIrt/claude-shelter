// Live Claude Code sessions (<configDir>/sessions/<pid>.json) and where their transcripts are.
import fs from 'node:fs';
import path from 'node:path';

/** True when a process with this pid exists (EPERM: it exists but is not ours to signal). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Ids end up in file paths, so nothing with a separator or a leading dot is accepted. */
export const isSafeId = (id) => typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(id);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Every spelling a directory can be reported under (as given, resolved, symlinks resolved). */
export function pathVariants(dir) {
  const out = new Set();
  if (!dir) return out;
  out.add(dir);
  out.add(path.resolve(dir));
  try {
    out.add(fs.realpathSync(dir));
  } catch { /* not there (yet) */ }
  return out;
}

export class SessionReader {
  /**
   * @param {{configDir:string, isAlive?:(pid:number)=>boolean,
   *          excludeCwds?:Iterable<string>, excludePids?:()=>Iterable<number>}} opts
   *   excludeCwds / excludePids hide the collector's own usage probe, which is a
   *   short-lived Claude Code process and would otherwise show up as an agent.
   */
  constructor({ configDir, isAlive = pidAlive, excludeCwds = [], excludePids = () => [] }) {
    this.dir = path.join(configDir, 'sessions');
    this.isAlive = isAlive;
    this.excludeCwds = new Set(excludeCwds);
    this.excludePids = excludePids;
    this.cache = new Map();   // file name -> last version that parsed
  }

  /**
   * @returns {{pid:number, sessionId:string, cwd:string|null, name:string|null, status:string|null,
   *            startedAt:number|null, updatedAt:number|null, statusUpdatedAt:number|null}[]}
   */
  read() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    const files = names.filter((n) => /^\d+\.json$/.test(n));
    const present = new Set(files);
    for (const name of this.cache.keys()) if (!present.has(name)) this.cache.delete(name);

    const skipPids = new Set(this.excludePids());
    const bySession = new Map();
    for (const name of files) {
      let raw = null;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      } catch { /* caught mid-write, or gone: fall back to what was read last time */ }
      if (raw && typeof raw === 'object') this.cache.set(name, raw);
      else raw = this.cache.get(name);
      if (!raw || !isSafeId(raw.sessionId)) continue;

      const pid = Number.isInteger(raw.pid) ? raw.pid : Number(name.slice(0, -5));
      const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : null;
      if (skipPids.has(pid) || (cwd && this.excludeCwds.has(cwd))) continue;
      if (!this.isAlive(pid)) continue;

      const session = {
        pid,
        sessionId: raw.sessionId,
        cwd,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
        status: typeof raw.status === 'string' ? raw.status : null,
        startedAt: num(raw.startedAt),
        updatedAt: num(raw.updatedAt),
        statusUpdatedAt: num(raw.statusUpdatedAt),
      };
      // One session id can briefly have two processes (resume): keep the most recent.
      const other = bySession.get(session.sessionId);
      const age = (s) => s.updatedAt ?? s.startedAt ?? 0;
      if (!other || age(session) >= age(other)) bySession.set(session.sessionId, session);
    }
    return [...bySession.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.pid - b.pid);
  }
}

/**
 * Locate <configDir>/projects/<slug>/<sessionId>.jsonl. The slug is normally the
 * working directory with every non-alphanumeric character replaced by '-', but a
 * session can change directory, so fall back to looking in every project.
 * @returns {string|null}
 */
export function findTranscript(configDir, sessionId, cwd) {
  if (!isSafeId(sessionId)) return null;
  const projects = path.join(configDir, 'projects');
  const file = `${sessionId}.jsonl`;
  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cwd) {
    const guess = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), file);
    if (isFile(guess)) return guess;
  }
  let slugs;
  try {
    slugs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const slug of slugs) {
    const candidate = path.join(projects, slug, file);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        best = candidate;
        bestMtime = st.mtimeMs;
      }
    } catch { /* not in this project */ }
  }
  return best;
}
