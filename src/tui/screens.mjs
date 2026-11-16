// Full-pane notices for the terminal view: the server cannot be reached, refused the
// request, speaks another snapshot version, or sent something unreadable.
// Pure, like render.mjs: never more than `rows` lines or wider than `cols` cells.
import { C } from '../gfx/palette.mjs';
import { clean, sp, rowWidth, clip, fitRow, wrap, emit } from './ansi.mjs';
import { MAX_COLS } from './render.mjs';

const SPIN = ['|', '/', '-', '\\'];

/**
 * @typedef {Object} Notice
 * @property {'connecting'|'unreachable'|'refused'|'version'|'invalid'} kind
 * @property {string} url              server base URL
 * @property {number} [status]         HTTP status (refused)
 * @property {*} [version]             the snapshot version the server sent (version)
 * @property {string} [detail]         error text
 * @property {number} [attempt]        how many tries so far
 * @property {boolean} [once]          a single render that will not retry
 */

/** Paragraphs for a notice: [text, colour, indent], '' for a blank line. */
function paragraphs(n) {
  const url = clean(n.url) || 'the server';
  const detail = clean(n.detail);
  const tries = n.attempt > 1 ? ` (attempt ${n.attempt})` : '';
  // A one-shot render (--once) does not retry, so it does not promise to.
  const retry = (text) => (n.once ? [] : ['', [`${text}${tries}`, C.STEEL_L, 0]]);
  const start = [
    '',
    ['Start it in the project folder:', C.CREAM, 0],
    ['npm start', C.AMBER_L, 2],
    ['or watch a simulation instead:', C.CREAM, 0],
    ['npm run tui -- --sim tour', C.AMBER_L, 2],
  ];
  switch (n.kind) {
    case 'connecting':
      return [[`Connecting to the shelter server at ${url}`, C.CREAM, 0]];
    case 'refused':
      return [
        [`Reached ${url}, but it refused the request (HTTP ${n.status ?? '?'}${detail ? `: ${detail}` : ''}).`, C.ORANGE, 0],
        '',
        ['Is something else listening on that port? The Token Shelter server only answers requests from this machine.', C.CREAM, 0],
        ...start.slice(0, 3),
        ...retry('Retrying quietly'),
      ];
    case 'version':
      return [
        [`Versions differ: the server sends snapshot version ${clean(String(n.version ?? '?')) || '?'}, this terminal view reads version 1.`, C.ORANGE, 0],
        '',
        ['Update the project (or restart the server) so both sides match.', C.CREAM, 0],
        ...retry('Checking again quietly'),
      ];
    case 'invalid':
      return [
        [`The server at ${url} sent a snapshot this view could not read${detail ? `: ${detail}` : '.'}`, C.ORANGE, 0],
        ...retry('Retrying quietly'),
      ];
    default:
      return [
        [`Cannot reach the shelter server at ${url}.`, C.ORANGE, 0],
        ...(detail ? [[`(${detail})`, C.STEEL_L, 0]] : []),
        ...start,
        ...retry('Retrying quietly'),
      ];
  }
}

const BADGE = { connecting: 'CONNECTING', unreachable: 'NO SIGNAL', refused: 'REFUSED', version: 'VERSION', invalid: 'BAD DATA' };

/**
 * Draw a notice.
 * @param {Notice} notice
 * @param {{cols?:number, rows?:number, color?:boolean|'256'|'truecolor', frame?:number}} [opts]
 * @returns {string[]}
 */
export function renderNotice(notice, opts = {}) {
  const n = notice && typeof notice === 'object' ? notice : { kind: 'unreachable' };
  const cols = Math.min(MAX_COLS, Math.floor(Number(opts.cols) || 80));
  const rows = Math.floor(Number(opts.rows) || 24);
  if (!(cols >= 1) || !(rows >= 1)) return [];
  const color = opts.color ?? true;
  const mode = color === false ? false : color === 'truecolor' ? 'truecolor' : '256';
  const frame = Math.abs(Math.floor(Number(opts.frame) || 0));
  const kind = BADGE[n.kind] ? n.kind : 'unreachable';
  const badgeText = BADGE[kind];
  const badge = mode ? sp(` ${badgeText} `, C.INK, { bg: kind === 'connecting' ? C.CYAN : C.AMBER, b: true }) : sp(`[${badgeText}]`);

  const pad = cols >= 44 ? 1 : 0;
  let header = [];
  for (const title of ['TOKEN SHELTER  LIVE', 'TOKEN SHELTER', 'SHELTER', '']) {
    const left = title ? [sp(' '.repeat(pad)), sp(title, C.AMBER_L, { b: true })] : [];
    const gap = cols - rowWidth(left) - badge.t.length;
    if (gap >= (title ? 1 : 0)) { header = [...left, sp(' '.repeat(gap)), badge]; break; }
  }
  if (!header.length) header = clip([badge], cols);

  const build = (framed, blanks) => {
    const inner = Math.max(1, framed ? cols - 2 - 2 * pad : cols - pad);
    const body = [];
    for (const p of paragraphs(n)) {
      if (p === '') { if (blanks) body.push([]); continue; }
      const [text, fg, indent] = p;
      for (const line of wrap(text, Math.max(1, inner - indent))) body.push([sp(' '.repeat(indent)), sp(line, fg, { b: fg === C.AMBER_L })]);
    }
    if (!n.once) {
      const last = body[body.length - 1];
      if (last && rowWidth(last) + 2 <= inner) last.push(sp(' ' + SPIN[frame % 4], C.STEEL_L));
    }
    if (!framed) return [header, ...body.map((r) => [sp(' '.repeat(pad)), ...r])];
    const wall = (t) => sp(t, C.STEEL_L);
    const side = [sp(' '.repeat(pad))];
    return [
      header,
      [wall('╔' + '═'.repeat(cols - 2) + '╗')],
      ...body.map((r) => [wall('║'), ...side, ...fitRow(r, inner), ...side, wall('║')]),
      [wall('╚' + '═'.repeat(cols - 2) + '╝')],
    ];
  };
  let out = cols >= 20 ? build(true, true) : null;
  if (!out || out.length > rows) out = build(false, true);
  if (out.length > rows) out = build(false, false);
  return out.slice(0, rows).map((r) => emit(clip(r, cols), mode));
}
