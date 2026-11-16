// 3x5 pixel font in a 4x6 cell. Lowercase renders as uppercase (all-caps retro look).
// FROZEN: shared by every painter and the world.

const G = {
  ' ': [0, 0, 0, 0, 0], 'A': [2, 5, 7, 5, 5], 'B': [6, 5, 6, 5, 6], 'C': [3, 4, 4, 4, 3],
  'D': [6, 5, 5, 5, 6], 'E': [7, 4, 6, 4, 7], 'F': [7, 4, 6, 4, 4], 'G': [3, 4, 5, 5, 3],
  'H': [5, 5, 7, 5, 5], 'I': [7, 2, 2, 2, 7], 'J': [1, 1, 1, 5, 2], 'K': [5, 5, 6, 5, 5],
  'L': [4, 4, 4, 4, 7], 'M': [5, 7, 7, 5, 5], 'N': [6, 5, 5, 5, 5], 'O': [2, 5, 5, 5, 2],
  'P': [6, 5, 6, 4, 4], 'Q': [2, 5, 5, 6, 3], 'R': [6, 5, 6, 5, 5], 'S': [3, 4, 2, 1, 6],
  'T': [7, 2, 2, 2, 2], 'U': [5, 5, 5, 5, 7], 'V': [5, 5, 5, 5, 2], 'W': [5, 5, 7, 7, 5],
  'X': [5, 5, 2, 5, 5], 'Y': [5, 5, 2, 2, 2], 'Z': [7, 1, 2, 4, 7],
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [6, 1, 2, 4, 7], '3': [6, 1, 2, 1, 6],
  '4': [5, 5, 7, 1, 1], '5': [7, 4, 6, 1, 6], '6': [3, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2],
  '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 6],
  '.': [0, 0, 0, 0, 2], ',': [0, 0, 0, 2, 4], ':': [0, 2, 0, 2, 0], ';': [0, 2, 0, 2, 4],
  '!': [2, 2, 2, 0, 2], '?': [6, 1, 2, 0, 2], '-': [0, 0, 7, 0, 0], '+': [0, 2, 7, 2, 0],
  '=': [0, 7, 0, 7, 0], '/': [1, 1, 2, 4, 4], '\\': [4, 4, 2, 1, 1], '%': [5, 1, 2, 4, 5],
  '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '[': [3, 2, 2, 2, 3], ']': [6, 2, 2, 2, 6],
  '<': [1, 2, 4, 2, 1], '>': [4, 2, 1, 2, 4], "'": [2, 2, 0, 0, 0], '"': [5, 5, 0, 0, 0],
  '#': [5, 7, 5, 7, 5], '*': [5, 2, 7, 2, 5], '_': [0, 0, 0, 0, 7], '|': [2, 2, 2, 2, 2],
  '~': [0, 3, 6, 0, 0], '^': [2, 5, 0, 0, 0], '&': [2, 5, 2, 5, 3], '@': [7, 5, 5, 4, 7],
  '$': [3, 6, 2, 3, 6], '°': [2, 5, 2, 0, 0],
};

export const FONT_W = 4;   // advance per character
export const FONT_H = 6;   // line height (glyphs are 5 tall)

/** Pixel width of a string at scale 1 (no trailing gap). */
export function textWidth(str) {
  const n = String(str).length;
  return n === 0 ? 0 : n * FONT_W - 1;
}

/**
 * Draw text with its top-left at (x, y).
 * opts.align: 'left' (default) | 'center' | 'right' relative to x.
 * opts.shadow: colour index for a 1px drop shadow (omit for none).
 * opts.bg: colour index for a filled backing plate with 1px padding (omit for none).
 */
export function drawText(fb, x, y, str, c, opts) {
  str = String(str).toUpperCase();
  const w = textWidth(str);
  x |= 0; y |= 0;
  if (opts && opts.align === 'center') x -= w >> 1;
  else if (opts && opts.align === 'right') x -= w;
  if (opts && opts.bg !== undefined) fb.rect(x - 1, y - 1, w + 2, 7, opts.bg);
  const passes = opts && opts.shadow !== undefined ? [[1, 1, opts.shadow], [0, 0, c]] : [[0, 0, c]];
  for (const [ox, oy, col] of passes) {
    let cx = x + ox;
    for (const ch of str) {
      const g = G[ch] || G['?'];
      for (let r = 0; r < 5; r++) {
        const bits = g[r];
        if (bits & 4) fb.px(cx, y + oy + r, col);
        if (bits & 2) fb.px(cx + 1, y + oy + r, col);
        if (bits & 1) fb.px(cx + 2, y + oy + r, col);
      }
      cx += FONT_W;
    }
  }
  return w;
}
