// Text primitives for the terminal view: styled spans, width-safe fitting, ANSI output.
// Pure: no I/O, no clock, no mutable module state.
//
// A row is an array of spans {t, fg, bg, b, em}. `t` only ever holds characters that are
// one terminal cell wide (printable ASCII, box drawing, block elements), so a span's
// width is its string length. Rows are fitted as plain text first and turned into
// escape sequences last (emit), so nothing ever truncates a string with escapes in it.
import { PALETTE_RGB } from '../gfx/palette.mjs';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

/** Remove ANSI escape sequences (CSI, OSC, DCS and two-byte escapes). */
export function stripAnsi(s) {
  return String(s ?? '').replace(ANSI_RE, '');
}

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1faff], [0x20000, 0x3fffd],
];
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]];
const inRanges = (c, ranges) => ranges.some(([a, b]) => c >= a && c <= b);

/**
 * Number of terminal cells a string occupies, ignoring ANSI escapes. Wide (East Asian,
 * emoji) code points count 2 and combining marks 0, so a stray wide character shows up
 * as an over-wide line in tests instead of slipping through.
 */
export function visibleWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    if (inRanges(c, ZERO)) continue;
    w += inRanges(c, WIDE) ? 2 : 1;
  }
  return w;
}

const PUNCT = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '•': '*', '·': '.', '→': '->', '×': 'x', ' ': ' ' };

/**
 * Make external text (names, tasks, alert sentences, error messages) safe to lay out:
 * escape sequences and control bytes removed, accents folded to ASCII, anything else
 * that is not printable ASCII replaced by '?'. The result is one cell per character.
 */
export function clean(text) {
  if (text == null) return '';
  const s = stripAnsi(String(text)).replace(/[‘’“”–—•·→× ]/g, (c) => PUNCT[c]);
  let out = '';
  for (const ch of s.normalize('NFKD')) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) out += ' ';
    else if (c < 0x20 || c === 0x7f) continue;
    else if (c <= 0x7e) out += ch;
    else if (inRanges(c, ZERO) || (c >= 0x80 && c < 0xa0)) continue;
    else out += '?';
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

// ───────────────────────────── spans and rows ─────────────────────────────

/** A styled run of text. fg / bg are palette bytes (see paint()), or null for the terminal default. */
export function sp(t, fg = null, o) {
  return o ? { t: String(t), fg, bg: o.bg ?? null, b: !!o.b, em: !!o.em } : { t: String(t), fg, bg: null, b: false, em: false };
}

/** Width of a row in cells. */
export function rowWidth(row) {
  let w = 0;
  for (const s of row) w += s.t.length;
  return w;
}

/** Cut a row to at most w cells. */
export function clip(row, w) {
  if (w <= 0) return [];
  const out = [];
  let left = w;
  for (const s of row) {
    if (left <= 0) break;
    if (s.t.length <= left) { out.push(s); left -= s.t.length; }
    else { out.push({ ...s, t: s.t.slice(0, left) }); left = 0; }
  }
  return out;
}

/** Cut or pad (with spaces on the right) a row to exactly w cells. */
export function fitRow(row, w) {
  const cur = rowWidth(row);
  if (cur === w) return row;
  if (cur > w) return clip(row, w);
  return [...row, sp(' '.repeat(w - cur))];
}

/** Plain text cut to w cells; a cut is marked with '..' when there is room for it. */
export function cut(text, w) {
  const s = String(text);
  if (w <= 0) return '';
  if (s.length <= w) return s;
  if (w <= 3) return s.slice(0, w);
  return s.slice(0, w - 2).replace(/\s+$/, '') + '..';
}

/** Plain text cut or padded to exactly w cells. align: 'l' | 'r'. */
export function cell(text, w, align = 'l') {
  if (w <= 0) return '';
  const s = cut(text, w);
  return align === 'r' ? s.padStart(w) : s.padEnd(w);
}

/** Greedy word wrap of plain text to lines of at most w cells (long words are split). */
export function wrap(text, w) {
  const width = Math.max(1, w);
  const lines = [];
  let line = '';
  for (let word of String(text).split(' ').filter(Boolean)) {
    while (word.length > width) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Lay background `bg` under every span of a row that has none of its own. */
export function underlay(row, bg) {
  if (bg == null) return row;
  return row.map((s) => (s.bg == null ? { ...s, bg } : s));
}

/**
 * Relight a row the way the pixel world relights a room: bars, glyphs and backgrounds
 * move to the palette's light mode (1 amber, 2 emergency red, 3 dark). Emissive spans
 * keep their colour, and so does text: relit text drops below 3:1 contrast on a dark
 * terminal, and the readings have to stay readable when things go wrong.
 */
export function relight(row, mode) {
  if (!mode) return row;
  const shift = (c) => (c == null ? c : (mode << 6) | (c & 63));
  return row.map((s) => {
    if (s.em) return s;
    if (/[A-Za-z0-9%]/.test(s.t)) return s.bg == null ? s : { ...s, bg: shift(s.bg) };
    return { ...s, fg: shift(s.fg), bg: shift(s.bg) };
  });
}

// ───────────────────────────── colour output ─────────────────────────────

function rgbToXterm(r, g, b) {
  const lv = [0, 95, 135, 175, 215, 255];
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const ri = q(r), gi = q(g), bi = q(b);
  const cube = (r - lv[ri]) ** 2 + (g - lv[gi]) ** 2 + (b - lv[bi]) ** 2;
  const avg = (r + g + b) / 3;
  const gidx = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + 10 * gidx;
  const gray = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return gray < cube ? 232 + gidx : 16 + 36 * ri + 6 * gi + bi;
}

/** xterm-256 index of every palette byte (64 base colours x 4 light modes). */
const XTERM = Object.freeze(Array.from({ length: 256 }, (_, i) => rgbToXterm(PALETTE_RGB[i * 3], PALETTE_RGB[i * 3 + 1], PALETTE_RGB[i * 3 + 2])));

function paint(code, c, mode) {
  if (mode === 'truecolor') return `${code};2;${PALETTE_RGB[c * 3]};${PALETTE_RGB[c * 3 + 1]};${PALETTE_RGB[c * 3 + 2]}`;
  return `${code};5;${XTERM[c]}`;
}

/**
 * Turn a row into a string. mode: false (plain text), '256' or 'truecolor'.
 * Coloured rows always end with a reset.
 */
export function emit(row, mode) {
  if (!mode) {
    let out = '';
    for (const s of row) out += s.t;
    return out;
  }
  let out = '', cur = '';
  for (const s of row) {
    if (!s.t) continue;
    let sgr = '';
    if (s.b) sgr += ';1';
    if (s.fg != null) sgr += ';' + paint(38, s.fg & 255, mode);
    if (s.bg != null) sgr += ';' + paint(48, s.bg & 255, mode);
    if (sgr !== cur) { out += `\x1b[0${sgr}m`; cur = sgr; }
    out += s.t;
  }
  return cur ? out + '\x1b[0m' : out;
}
