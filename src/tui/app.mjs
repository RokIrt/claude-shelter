// The terminal app: argument parsing, data sources (live server or simulation), and the
// interactive loop (alternate screen, raw keys, flicker-free redraw, clean exit).
import { derive } from '../shared/derive.mjs';
import { SCENARIOS, SCENARIO_INFO, scenarioSnapshot } from '../shared/scenarios.mjs';
import { SNAPSHOT_VERSION } from '../shared/contract.mjs';
import { renderCompact, visibleWidth } from './render.mjs';
import { renderNotice } from './screens.mjs';
import { clean, wrap } from './ansi.mjs';

export const DEFAULT_URL = 'http://127.0.0.1:4780';
const POLL_MS = 1000;
const FETCH_TIMEOUT_MS = 2500;
const FRAME_MS = 250;
/** After this long without a good reading the shelter view gives way to the notice. */
const LOST_MS = 4000;
/** what-if steps for + and -. */
export const WHAT_IF_STEPS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10]);

export const USAGE = `Token Shelter terminal view

Usage:
  shelter-tui [--url <base>] [options]     live: polls <base>/api/snapshot every second
  shelter-tui --sim [scenario] [options]   simulation, no server needed (default: tour)

Options:
  --url <base>        server address (default ${DEFAULT_URL})
  --sim [scenario]    one of: ${SCENARIOS.join(', ')}
  --what-if <mult>    preview forecasts at <mult> times the current usage rate
  --no-color          plain text (also when NO_COLOR is set)
  --truecolor         24-bit colour instead of the 256-colour palette
  --once              print one frame and exit (for pipes and scripts)
  --cols <n>          force the width  (default: terminal width, else 80)
  --rows <n>          force the height (default: terminal height, else 24)
  --at <seconds>      simulation time to start from (default 0)
  -h, --help          this help

Keys: q quit   + / - what-if   0 reset what-if   s next scenario (sim)   ? help`;

export class UsageError extends Error {}

/** Parse command-line arguments. Throws UsageError on bad input. */
export function parseArgs(argv, env = {}) {
  const o = { url: null, sim: null, whatIf: 1, color: env.NO_COLOR ? false : env.COLORTERM && /truecolor|24bit/i.test(env.COLORTERM) ? 'truecolor' : true, once: false, cols: null, rows: null, at: 0, help: false };
  const num = (flag, v, min) => {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isFinite(n) || n < min) throw new UsageError(`${flag} needs a number${min > 0 ? ' above 0' : ''}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => inline ?? argv[++i];
    const optional = () => inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : undefined);
    switch (flag) {
      case '--url': {
        const v = value();
        if (!v) throw new UsageError('--url needs an address, e.g. http://127.0.0.1:4780');
        let u;
        try { u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`); } catch { throw new UsageError(`--url: not an address: ${v}`); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError('--url must be an http(s) address');
        o.url = u.origin + u.pathname.replace(/\/+$/, '');
        break;
      }
      case '--sim': {
        const v = optional() ?? 'tour';
        if (!SCENARIOS.includes(v)) throw new UsageError(`unknown scenario "${v}"; try one of: ${SCENARIOS.join(', ')}`);
        o.sim = v;
        break;
      }
      case '--what-if': case '--whatif': o.whatIf = num(flag, value(), 0); if (o.whatIf <= 0) throw new UsageError('--what-if needs a number above 0'); break;
      case '--no-color': case '--no-colour': o.color = false; break;
      case '--color': case '--colour': o.color = true; break;
      case '--truecolor': o.color = 'truecolor'; break;
      case '--once': o.once = true; break;
      case '--cols': o.cols = Math.floor(num(flag, value(), 1)); break;
      case '--rows': o.rows = Math.floor(num(flag, value(), 1)); break;
      case '--at': o.at = num(flag, value(), 0); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new UsageError(`unknown option ${a}`);
    }
  }
  if (o.url && o.sim) throw new UsageError('choose either --url or --sim, not both');
  if (!o.sim && !o.url) o.url = DEFAULT_URL;
  return o;
}

/** Next what-if step up (dir 1) or down (dir -1) from the current multiplier. */
export function stepWhatIf(cur, dir) {
  if (dir > 0) return WHAT_IF_STEPS.find((s) => s > cur + 1e-9) ?? WHAT_IF_STEPS[WHAT_IF_STEPS.length - 1];
  return [...WHAT_IF_STEPS].reverse().find((s) => s < cur - 1e-9) ?? WHAT_IF_STEPS[0];
}

// ───────────────────────────── data sources ─────────────────────────────

/**
 * One request for the current snapshot.
 * @returns {Promise<{ok:true, snapshot:object} | {ok:false, notice:object}>}
 */
export async function fetchSnapshot(base, { timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch, signal = null } = {}) {
  let res;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    res = await fetchImpl(`${base}/api/snapshot`, { headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? null;
    const detail = err?.name === 'TimeoutError' ? 'no answer within a few seconds' : code === 'ECONNREFUSED' ? 'connection refused' : code ? String(code) : clean(err?.message);
    return { ok: false, notice: { kind: 'unreachable', url: base, detail } };
  }
  let text = '';
  try { text = await res.text(); } catch { /* treated as empty */ }
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.parse(text)?.error ?? ''; } catch { detail = text.split('\n')[0]; }
    return { ok: false, notice: { kind: 'refused', url: base, status: res.status, detail: clean(detail).slice(0, 80) } };
  }
  let body;
  try { body = JSON.parse(text); } catch {
    return { ok: false, notice: { kind: 'invalid', url: base, detail: 'the reply was not JSON. Is something else listening on that port?' } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, notice: { kind: 'invalid', url: base, detail: 'not a snapshot object' } };
  if (body.v !== SNAPSHOT_VERSION) return { ok: false, notice: { kind: 'version', url: base, version: body.v === undefined ? 'none' : body.v } };
  return { ok: true, snapshot: body };
}

/** Polls the server once a second; keeps the last good snapshot. */
export function liveSource(base, { pollMs = POLL_MS, fetchImpl } = {}) {
  let snapshot = null, lastOk = 0, notice = { kind: 'connecting', url: base }, attempt = 0, timer = null, stopped = false;
  const quit = new AbortController();     // stop() cancels a request still in flight
  const poll = async () => {
    attempt++;
    const r = await fetchSnapshot(base, { fetchImpl, signal: quit.signal });
    if (stopped) return;
    if (r.ok) { snapshot = r.snapshot; lastOk = Date.now(); notice = null; attempt = 0; }
    else notice = { ...r.notice, attempt };
    timer = setTimeout(poll, pollMs);
  };
  return {
    kind: 'live',
    url: base,
    start() { poll(); },
    stop() { stopped = true; clearTimeout(timer); quit.abort(); },
    /** first(): one request, for --once. */
    async first() { await poll(); clearTimeout(timer); },
    current(now) {
      if (snapshot && (!notice || now - lastOk < LOST_MS)) return { snapshot, now };
      return { notice: notice ?? { kind: 'connecting', url: base } };
    },
  };
}

/** A simulation scenario whose clock starts at `atSec` and runs in real time. */
export function simSource(name, atSec = 0) {
  let scenario = name, origin = Date.now() - atSec * 1000;
  return {
    kind: 'sim',
    get scenario() { return scenario; },
    start() {}, stop() {}, async first() {},
    next(dir = 1) {
      const i = SCENARIOS.indexOf(scenario);
      scenario = SCENARIOS[(i + dir + SCENARIOS.length) % SCENARIOS.length];
      origin = Date.now();
      return scenario;
    },
    current(now) {
      return { snapshot: scenarioSnapshot(scenario, (now - origin) / 1000, now), now };
    },
  };
}

// ───────────────────────────── one frame ─────────────────────────────

/**
 * One frame of whatever the source has right now. Never throws.
 * @returns {{lines:string[], ok:boolean}} ok: the shelter itself is on screen (not a notice)
 */
export function frameLines(source, { now, cols, rows, color, frame, whatIf, once = false }) {
  const opts = { cols, rows, color, frame };
  try {
    const cur = source.current(now);
    if (cur.notice) return { lines: renderNotice({ ...cur.notice, once }, opts), ok: false };
    const state = derive(cur.snapshot, { now: cur.now, whatIf });
    return { lines: renderCompact(state, { ...opts, whatIf }), ok: true };
  } catch (err) {
    const where = source.kind === 'live' ? source.url : 'the simulation';
    return { lines: renderNotice({ kind: 'invalid', url: where, detail: clean(err?.message).slice(0, 120), once }, opts), ok: false };
  }
}

// ───────────────────────────── the CLI ─────────────────────────────

const HELP_LINE = 'q quit  +/- what-if  0 reset  s scenario  ? close help';

const termSize = (o, out) => ({
  cols: o.cols ?? (out.columns > 0 ? out.columns : Number(process.env.COLUMNS) || 80),
  rows: o.rows ?? (out.rows > 0 ? out.rows : Number(process.env.LINES) || 24),
});

/**
 * Run the app. Resolves with the exit code for --once (or a non-TTY stdout); the
 * interactive loop resolves when the user quits.
 */
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, env = process.env } = {}) {
  let o;
  try { o = parseArgs(argv, env); } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`shelter-tui: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (o.help) { stdout.write(USAGE + '\n'); return 0; }

  const source = o.sim ? simSource(o.sim, o.at) : liveSource(o.url);
  if (o.once || !stdout.isTTY) {
    await source.first();
    const { cols, rows } = termSize(o, stdout);
    const now = Date.now();
    const { lines, ok } = frameLines(source, { now, cols, rows, color: o.color, frame: 0, whatIf: o.whatIf, once: true });
    stdout.write(lines.join('\n') + '\n');
    return ok ? 0 : 1;
  }
  return interactive(o, source, { stdout, stdin });
}

function interactive(o, source, { stdout, stdin }) {
  return new Promise((resolve) => {
    let frame = 0, whatIf = o.whatIf, toast = null, help = false, last = '', timer = null, done = false;
    const raw = !!stdin.isTTY && typeof stdin.setRawMode === 'function';

    const restore = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      source.stop();
      try { if (raw) stdin.setRawMode(false); } catch { /* already closed */ }
      stdin.pause?.();
      stdout.write('\x1b[?2026l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    };
    const quit = (code = 0) => {
      restore();
      for (const [ev, fn] of handlers) process.off(ev, fn);
      stdout.off?.('resize', onResize);
      stdin.off?.('data', onKey);
      resolve(code);
    };
    const handlers = [
      ['SIGINT', () => { quit(130); process.exit(130); }],
      ['SIGTERM', () => { quit(143); process.exit(143); }],
      ['SIGHUP', () => { quit(129); process.exit(129); }],
      ['exit', () => restore()],
      ['uncaughtException', (err) => { restore(); process.stderr.write(`shelter-tui crashed: ${err?.stack ?? err}\n`); process.exit(1); }],
      ['unhandledRejection', (err) => { restore(); process.stderr.write(`shelter-tui crashed: ${err?.stack ?? err}\n`); process.exit(1); }],
    ];
    for (const [ev, fn] of handlers) process.on(ev, fn);

    const say = (text) => { toast = { text, until: Date.now() + 2500 }; draw(); };

    function draw() {
      if (done) return;
      const { cols, rows } = termSize(o, stdout);
      const now = Date.now();
      if (toast && now > toast.until) toast = null;
      const footer = help ? wrap(HELP_LINE, cols) : toast ? wrap(toast.text, cols) : [];
      const keep = footer.slice(0, Math.max(0, rows - 1));
      const { lines } = frameLines(source, { now, cols, rows: rows - keep.length, color: o.color, frame, whatIf });
      if (keep.length) lines.push(...keep.map((l) => (o.color ? `\x1b[0;7m${l}\x1b[0m` : l)));
      // Cursor home per line, clear only what the new line does not cover, then clear
      // anything left below. One write per frame, inside a synchronized-update bracket.
      let out = '\x1b[?2026h';
      lines.forEach((l, i) => {
        out += `\x1b[${i + 1};1H${l}`;
        if (visibleWidth(l) < cols) out += '\x1b[0m\x1b[K';
      });
      if (lines.length < rows) out += `\x1b[${lines.length + 1};1H\x1b[0m\x1b[J`;
      out += '\x1b[?2026l';
      if (out !== last) { stdout.write(out); last = out; }
    }

    // The terminal reflows old content on resize, so start from a clean screen.
    function onResize() {
      if (done) return;
      stdout.write('\x1b[2J');
      last = '';
      draw();
    }

    function onKey(buf) {
      const s = buf.toString('utf8');
      if (s.startsWith('\x1b')) return;                 // arrows and other escape sequences
      for (const ch of s) {
        if (ch === 'q' || ch === 'Q' || ch === '\x03' || ch === '\x04') { quit(0); return; }
        if (ch === '+' || ch === '=') { whatIf = stepWhatIf(whatIf, 1); say(`what-if: usage x${whatIf}`); }
        else if (ch === '-' || ch === '_') { whatIf = stepWhatIf(whatIf, -1); say(`what-if: usage x${whatIf}`); }
        else if (ch === '0') { whatIf = 1; say('what-if off: actual usage'); }
        else if (ch === 's' || ch === 'S') {
          if (source.kind === 'sim') {
            const name = source.next(ch === 'S' ? -1 : 1);
            say(`scenario: ${SCENARIO_INFO[name]?.label ?? name}`);
          } else say('scenarios need --sim mode');
        } else if (ch === '?' || ch === 'h') { help = !help; draw(); }
      }
    }

    stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J');
    if (raw) stdin.setRawMode(true);
    if (stdin.isTTY) { stdin.on('data', onKey); stdin.resume(); }
    stdout.on('resize', onResize);
    source.start();
    draw();
    timer = setInterval(() => { frame++; draw(); }, FRAME_MS);
  });
}
