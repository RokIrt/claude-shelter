// Environment: surface, rock, room shells and furniture, elevator, belts, pipes, cables.
//
// Everything here is redrawn every frame, so the expensive parts are baked once:
//   - rooms, the surface strip and shaft segments are rendered into offscreen
//     framebuffers (cached by size / kind / options) and pasted with row copies; only
//     the few animated pixels are drawn per frame on top;
//   - rock is a 256x256 tile built on first use and sampled by absolute coordinates.
// Painters draw base palette colours only; the world relights rooms afterwards.
import { C } from './palette.mjs';
import { Framebuffer, sprite, hash } from './fb.mjs';
import { drawText } from './font.mjs';
import {
  WALL_T, CEIL_T, FLOOR_T, DOOR_H, CAR_W, CAR_H,
  MACHINE_W, MACHINE_CX, SLOT_XS, STATION_W, BELT_Y, LOOP,
  CONTROL, LOUNGE, DOCK, POWER, SWITCHBOARD_W, SWITCHBOARD_H, GENERATOR_W, GENERATOR_H,
} from './geom.mjs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** Opaque, clipped row copy of an offscreen framebuffer onto fb at (x, y). */
function paste(fb, src, x, y) {
  const x0 = Math.max(x, fb.cx0), x1 = Math.min(x + src.w, fb.cx1);
  const y0 = Math.max(y, fb.cy0), y1 = Math.min(y + src.h, fb.cy1);
  if (x1 <= x0 || y1 <= y0) return;
  const n = x1 - x0;
  for (let yy = y0; yy < y1; yy++) {
    const so = (yy - y) * src.w + (x0 - x);
    fb.buf.set(src.buf.subarray(so, so + n), yy * fb.w + x0);
  }
}

/** Small bounded cache for baked layers. */
function cached(map, key, limit, build) {
  let v = map.get(key);
  if (!v) {
    if (map.size >= limit) map.clear();
    v = build();
    map.set(key, v);
  }
  return v;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Ordered-dither threshold 0..1 at a pixel. */
function bayer(x, y) { return (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16; }

// One step lighter / darker for the materials walls are made of (baked lamp light, shade).
const LIT = new Uint8Array(64), DIM = new Uint8Array(64);
for (let i = 0; i < 64; i++) { LIT[i] = i; DIM[i] = i; }
for (const [a, b] of [
  [C.ROCK_D, C.ROCK], [C.ROCK, C.WALL_D], [C.WALL_D, C.WALL], [C.WALL, C.WALL_L], [C.WALL_L, C.SAND],
  [C.INK, C.STEEL_DD], [C.STEEL_DD, C.STEEL_D], [C.STEEL_D, C.STEEL], [C.STEEL, C.STEEL_L],
  [C.SMOKE_D, C.SMOKE], [C.LEATHER, C.WOOD], [C.WOOD, C.CRATE],
]) LIT[a] = b;
for (const [a, b] of [
  [C.SAND, C.WALL_L], [C.WALL_L, C.WALL], [C.WALL, C.WALL_D], [C.WALL_D, C.ROCK], [C.ROCK, C.ROCK_D],
  [C.STEEL_L, C.STEEL], [C.STEEL, C.STEEL_D], [C.STEEL_D, C.STEEL_DD], [C.STEEL_DD, C.INK],
  [C.SMOKE, C.SMOKE_D], [C.WOOD, C.LEATHER], [C.CRATE, C.WOOD],
]) DIM[a] = b;

/**
 * Dithered elliptical wash that remaps existing pixels through `map` (LIT or DIM),
 * clipped to [x0,x1) x [y0,y1). Strength 1 gives a solid core out to ~1/4 of the radius.
 */
function wash(g, cx, cy, rx, ry, x0, y0, x1, y1, map = LIT, strength = 1) {
  const ya = Math.max(y0, cy - ry, 0), yb = Math.min(y1, cy + ry + 1, g.h);
  const xa = Math.max(x0, cx - rx, 0), xb = Math.min(x1, cx + rx + 1, g.w);
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry, d = dx * dx + dy * dy;
      if (d >= 1) continue;
      if ((1 - d) * 1.3 * strength > bayer(x, y)) { const o = y * g.w + x; g.buf[o] = map[g.buf[o]]; }
    }
  }
}

/** Diagonal yellow/black hazard stripes filling a rectangle. */
function hazard(g, x, y, w, h, a = C.HAZARD, b = C.INK) {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    g.px(x + xx, y + yy, (((x + xx + y + yy) >> 1) & 1) ? b : a);
  }
}

/** Rivet / bolt: light dot with a shadow pixel below-right. */
function rivet(g, x, y, hi, lo) { g.px(x, y, hi); g.px(x + 1, y + 1, lo); }

// ---------------------------------------------------------------------------
// Rock
// ---------------------------------------------------------------------------

const RT = 256, RM = RT - 1;   // rock tile size (power of two) and mask
let ROCK_TILE = null;

function buildRockTile() {
  const buf = new Uint8Array(RT * RT);
  // Strata: a band kind per (unwarped) row. 0 dark, 1 mid, 2 pale seam, 3 gritty seam.
  const band = new Uint8Array(RT), edge = new Uint8Array(RT);
  let yy = 0, i = 0, dark = true;
  while (yy < RT) {
    let th = 7 + Math.floor(hash(i, 101) * 16);
    if (RT - yy - th < 9) th = RT - yy;
    band.fill(dark ? 0 : 1, yy, yy + th);
    edge[yy] = 1;
    yy += th;
    if (yy < RT - 4 && hash(i, 102) < 0.45) {
      const st = hash(i, 103) < 0.6 ? 1 : 2;
      band.fill(hash(i, 104) < 0.55 ? 2 : 3, yy, yy + st);
      yy += st;
    }
    dark = !dark; i++;
  }
  const wave = new Int8Array(RT);
  for (let x = 0; x < RT; x++) {
    wave[x] = Math.round(3.4 * Math.sin(TAU * x / RT) + 2.2 * Math.sin(TAU * 3 * x / RT + 1.3) + 1.2 * Math.sin(TAU * 7 * x / RT + 0.4));
  }
  for (let y = 0; y < RT; y++) {
    for (let x = 0; x < RT; x++) {
      const sy = (y - wave[x]) & RM, b = band[sy];
      const n = hash(x, y, 1), s = hash(x >> 2, sy, 2);   // speck noise, strata-following streaks
      let c;
      if (b === 0) c = s < 0.13 ? C.ROCK : n < 0.035 ? C.ROCK : n > 0.985 ? C.INK : C.ROCK_D;
      else if (b === 1) c = s < 0.11 ? C.ROCK_D : s > 0.955 ? C.ROCK_L : n < 0.02 ? C.ROCK_L : n > 0.97 ? C.ROCK_D : C.ROCK;
      else if (b === 2) c = n < 0.3 ? C.ROCK : C.ROCK_L;
      else c = n < 0.35 ? C.DIRT : n < 0.55 ? C.ROCK : C.ROCK_L;
      if (edge[sy] && b === 1 && n < 0.4) c = C.ROCK_L;
      if (edge[(sy + 1) & RM] && b === 1 && n > 0.5) c = C.ROCK_D;
      buf[y * RT + x] = c;
    }
  }
  const put = (x, y, c) => { buf[((y & RM) * RT) + (x & RM)] = c; };
  // Pebbles: small lit lumps with a shadow under them.
  const PEB = [
    ['hl', 'ls'],
    ['.hl.', 'hlls', '.ss.'],
    ['.hhl.', 'hllls', 'lllss', '.sss.'],
    ['hl', 'l.'],
    ['.hl', 'hls', 'ls.'],
  ];
  const pk = { h: C.DIRT, l: C.ROCK_L, s: C.ROCK };
  for (let p = 0; p < 190; p++) {
    const px = Math.floor(hash(p, 201) * RT), py = Math.floor(hash(p, 202) * RT);
    const shape = PEB[Math.floor(hash(p, 203) * PEB.length)];
    for (let r = 0; r < shape.length; r++) for (let q = 0; q < shape[r].length; q++) {
      const ch = shape[r][q];
      if (ch !== '.') put(px + q, py + r, pk[ch]);
    }
    for (let q = 1; q < shape[0].length; q++) put(px + q, py + shape.length, C.ROCK_D);
  }
  // Hairline cracks.
  for (let k = 0; k < 14; k++) {
    let cx = Math.floor(hash(k, 301) * RT), cy = Math.floor(hash(k, 302) * RT);
    const len = 6 + Math.floor(hash(k, 303) * 12), dir = hash(k, 304) < 0.5 ? 1 : -1;
    for (let j = 0; j < len; j++) {
      put(cx, cy, C.INK);
      const r = hash(k, j, 305);
      if (r < 0.55) cx += dir; else if (r < 0.75) { cx += dir; cy++; } else cy++;
    }
  }
  return buf;
}

const rk = { s: C.SAND, d: C.DIRT, l: C.ROCK_L, m: C.ROCK, k: C.ROCK_D, i: C.INK, t: C.TEAL_D, T: C.TEAL, c: C.CYAN, g: C.STEEL_D, G: C.STEEL_DD, r: C.WALL_D, R: C.WALL, o: C.COPPER_D, O: C.COPPER };
const ROCK_FEATURES = [
  sprite([   // ammonite
    '..ddsss..',
    '.d.....s.',
    'd..dds..s',
    'd.d...s.d',
    'd.d.s.d.d',
    'd.d.dd..d',
    'd.d....d.',
    'd..dddd..',
    '.d.......',
  ], rk),
  sprite([   // bone
    'sd.....ds',
    '.sddddds.',
    'dd.....dd',
  ], rk),
  sprite([   // fish skeleton
    '....d.d.d...',
    'd..d.d.d.dds',
    '.dddddddds.d',
    'd..d.d.d.ddd',
    '....d.d.d...',
  ], rk),
  sprite([   // crystal pocket
    '...c...',
    '.t.Tt..',
    'tTtTT.t',
    'tTTTTtT',
    '.kkkkk.',
  ], rk),
  sprite([   // lost gear
    '..g.g..',
    '.gGGGg.',
    'gGg.gGg',
    '.G...G.',
    'gGg.gGg',
    '.gGGGg.',
    '..g.g..',
  ], rk),
  sprite([   // old root
    '...R....',
    '...r....',
    '..Rr....',
    '..r.r...',
    '.R..r...',
    '.r...R..',
    'r....r..',
    'r.....r.',
    '......r.',
  ], rk),
  sprite([   // boulder
    '...llll...',
    '.lddddll..',
    'lddllllmm.',
    'llllllmmm.',
    '.lllmmmmk.',
    '..kkkkkk..',
  ], rk),
  sprite([   // copper ore vein
    'o.........',
    '.Oo...o...',
    '..oOo.Oo..',
    '....oOo.o.',
    '.......o.O',
  ], rk),
  sprite([   // boulder (small)
    '.lll..',
    'lddlm.',
    'lllmmk',
    '.kkkk.',
  ], rk),
];
const FEAT_W = 72, FEAT_H = 52;   // coarse grid for features

/**
 * Underground rock / earth fill with strata and pebbles. Deterministic from position + seed.
 * The texture is anchored to the coordinates as passed (so separate rectangles with the
 * same seed join seamlessly and nothing shimmers between frames); a different seed shifts
 * the strata and rearranges the fossils, roots and boulders.
 */
export function drawRock(fb, x, y, w, h, seed = 0) {
  x |= 0; y |= 0; w |= 0; h |= 0; seed |= 0;
  const x0 = Math.max(x, fb.cx0), y0 = Math.max(y, fb.cy0);
  const x1 = Math.min(x + w, fb.cx1), y1 = Math.min(y + h, fb.cy1);
  if (x1 <= x0 || y1 <= y0) return;
  if (!ROCK_TILE) ROCK_TILE = buildRockTile();
  const tile = ROCK_TILE;
  const ox = seed ? Math.floor(hash(seed, 11) * RT) : 0, oy = seed ? Math.floor(hash(seed, 12) * RT) : 0;
  for (let yy = y0; yy < y1; yy++) {
    const trow = ((yy + oy) & RM) * RT;
    let xx = x0;
    while (xx < x1) {
      const tx = (xx + ox) & RM;
      const n = Math.min(RT - tx, x1 - xx);
      fb.buf.set(tile.subarray(trow + tx, trow + tx + n), yy * fb.w + xx);
      xx += n;
    }
  }
  // Sparse features on a coarse grid (not part of the tile, so they do not repeat).
  const sx0 = fb.cx0, sy0 = fb.cy0, sx1 = fb.cx1, sy1 = fb.cy1;
  fb.cx0 = x0; fb.cy0 = y0; fb.cx1 = x1; fb.cy1 = y1;
  for (let cj = Math.floor(y0 / FEAT_H); cj * FEAT_H < y1; cj++) {
    for (let ci = Math.floor(x0 / FEAT_W); ci * FEAT_W < x1; ci++) {
      if (hash(ci, cj, seed + 77) > 0.55) continue;
      const spr = ROCK_FEATURES[Math.floor(hash(ci, cj, seed + 78) * ROCK_FEATURES.length)];
      const fx = ci * FEAT_W + Math.floor(hash(ci, cj, seed + 79) * (FEAT_W - spr.w));
      const fy = cj * FEAT_H + Math.floor(hash(ci, cj, seed + 80) * (FEAT_H - spr.h));
      fb.blit(spr, fx, fy, { flipX: hash(ci, cj, seed + 81) < 0.5 });
    }
  }
  fb.cx0 = sx0; fb.cy0 = sy0; fb.cx1 = sx1; fb.cy1 = sy1;
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

const GROUND_H = 8;   // grass + topsoil thickness at the bottom of the surface strip
const surfaceCache = new Map();

function buildSurface(w, h, sx, sw, glow) {
  const g = new Framebuffer(w, h);
  const gy = h - GROUND_H;          // first ground row; walkers' feet line
  const emergency = glow > 0;
  // Sky: night gradient with an ordered-dither blend toward the horizon.
  const stops = emergency
    ? [[0, C.NIGHT_D], [0.3, C.NIGHT], [0.52, C.DUSK], [0.72, C.RED_D], [glow > 1 ? 0.9 : 1.0, C.RED], [1.6, C.RED_L]]
    : [[0, C.NIGHT_D], [0.42, C.NIGHT], [0.92, C.DUSK], [1.5, C.VIOLET_D]];
  for (let y = 0; y < gy; y++) {
    const k = y / Math.max(1, gy - 1);
    let si = 0;
    while (si + 2 < stops.length && k >= stops[si + 1][0]) si++;
    const a = stops[si], b = stops[si + 1];
    const f = (k - a[0]) / (b[0] - a[0]);
    for (let x = 0; x < w; x++) g.buf[y * w + x] = (f - 0.5) * 1.6 + 0.5 > bayer(x, y) ? b[1] : a[1];
  }
  // Stars (the twinkling ones are redrawn per frame).
  g.stars = [];
  const nStars = Math.round(w * gy / 110);
  for (let i = 0; i < nStars; i++) {
    const x = Math.floor(hash(i, 401, w) * w), y = Math.floor(hash(i, 402, w) * gy * 0.62);
    const r = hash(i, 403);
    const c = r < 0.55 ? C.STEEL : r < 0.85 ? C.STEEL_LL : C.WHITE;
    g.px(x, y, c);
    if (r > 0.7) g.stars.push([x, y, c, i]);
  }
  // Moon, on the side away from the entrance.
  const shaftCx = sx + (sw >> 1);
  const mx = shaftCx < w / 2 ? Math.round(w * 0.8) : Math.round(w * 0.2), my = Math.min(7, gy - 8);
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const d = dx * dx + dy * dy;
    if (d <= 50 && d > 20 && (1 - (d - 20) / 30) * 0.6 > bayer(mx + dx, my + dy)) g.px(mx + dx, my + dy, C.NIGHT);
  }
  g.disc(mx, my, 4, C.MOON);
  g.px(mx - 2, my - 1, C.STEEL_LL); g.px(mx + 1, my + 2, C.STEEL_LL); g.px(mx + 2, my - 2, C.STEEL_LL);
  g.px(mx - 1, my + 2, C.STEEL_LL); g.px(mx + 1, my - 1, C.CREAM);
  // Distant hills, then nearer dunes.
  const far = emergency ? C.INK : C.NIGHT_D, near = C.GREEN_DD;
  for (let x = 0; x < w; x++) {
    const hf = Math.round(4 + 2.6 * Math.sin(x * 0.043 + 1) + 1.6 * Math.sin(x * 0.107 + 2.2) + 0.8 * Math.sin(x * 0.31));
    if (hf > 0) g.vline(x, gy - hf, hf, far);
    const hn = Math.round(1.6 + 1.4 * Math.sin(x * 0.071 + 4) + 0.9 * Math.sin(x * 0.19 + 0.5));
    if (hn > 0) g.vline(x, gy - hn, hn, near);
  }
  // A few dead trees / posts on the skyline.
  const nTrees = Math.max(2, Math.round(w / 90));
  for (let i = 0; i < nTrees; i++) {
    const tx = Math.floor(hash(i, 411, w) * (w - 8)) + 4;
    if (Math.abs(tx - shaftCx) < sw + 14) continue;
    const th = 4 + Math.floor(hash(i, 412) * 3);
    g.vline(tx, gy - th - 1, th, C.INK);
    g.px(tx - 1, gy - th, C.INK); g.px(tx + 1, gy - th - 1, C.INK);
    if (hash(i, 413) < 0.6) { g.px(tx - 2, gy - th - 1, C.INK); g.px(tx + 2, gy - th - 2, C.INK); }
  }
  // Ground: grass line, topsoil fading into rock.
  for (let x = 0; x < w; x++) {
    const n = hash(x, 421);
    if (n < 0.16) g.px(x, gy - 1, n < 0.07 ? C.GRASS : C.GRASS_D);
    g.px(x, gy, n > 0.3 ? C.GRASS : C.GRASS_D);
    g.px(x, gy + 1, C.GRASS_D);
    g.px(x, gy + 2, hash(x, 422) < 0.55 ? C.GRASS_D : C.ROCK_L);
    for (let r = 3; r < GROUND_H; r++) {
      const m = hash(x, r, 423);
      const fade = (r - 3) / (GROUND_H - 3);
      g.px(x, gy + r, m < 0.07 ? C.DIRT : m < 0.07 + fade * 0.7 ? C.ROCK : C.ROCK_L);
    }
    if (hash(x, 424) < 0.05) { g.px(x, gy + 2, C.GRASS_D); g.px(x, gy + 3, C.WALL_D); if (hash(x, 425) < 0.5) g.px(x + 1, gy + 4, C.WALL_D); }
  }
  // Shaft collar through the topsoil.
  g.rect(sx - 2, gy, sw + 4, GROUND_H, C.STEEL_D);
  g.rect(sx, gy, sw, GROUND_H, C.STEEL_DD);
  g.vline(sx - 1, gy, GROUND_H, C.INK); g.vline(sx + sw, gy, GROUND_H, C.INK);
  // Entrance building (hatch house) over the shaft; the doorway fits a 14px resident.
  const bx = sx - 4, bw = sw + 8, bh = Math.max(8, Math.min(18, gy - 4)), by = gy - bh;
  // lattice antenna mast standing beside it (on the side with more room)
  const right = bx + bw + 6 < w || bx - 6 < 0;
  const ax = right ? bx + bw + 3 : bx - 4, at = Math.max(1, gy - 23);
  g.vline(ax - 1, at + 2, gy - at - 2, C.STEEL); g.vline(ax + 1, at + 2, gy - at - 2, C.STEEL_D);
  for (let yy = at + 3; yy < gy - 1; yy += 3) { g.px(ax, yy, C.STEEL_D); g.px(ax - 1, yy + 1, C.STEEL_L); }
  g.vline(ax, at + 1, 2, C.STEEL_L);
  g.hline(ax - 2, at + 4, 5, C.STEEL); g.hline(ax - 3, at + 8, 7, C.STEEL_D);
  g.hline(ax - 2, gy - 1, 5, C.STEEL_DD);
  g.line(ax + (right ? -2 : 2), at + 10, right ? bx + bw + 1 : bx - 2, by + 1, C.INK);       // feed cable
  g.rect(bx, by, bw, bh, C.STEEL);
  g.vline(bx, by, bh, C.STEEL_L);
  g.rect(bx + bw - 2, by, 2, bh, C.STEEL_D);
  g.rect(bx, gy - 2, bw, 2, C.STEEL_D);
  for (let px = bx + 6; px < bx + bw - 3; px += 7) g.vline(px, by + 1, bh - 3, C.STEEL_D);
  // roof slab with overhang
  g.rect(bx - 2, by - 2, bw + 4, 2, C.STEEL_D);
  g.hline(bx - 2, by - 2, bw + 4, C.STEEL_L);
  g.hline(bx - 1, by, bw + 2, C.INK);
  g.px(bx - 2, by - 1, C.STEEL); g.px(bx + bw + 1, by - 1, C.INK);
  // lit doorway
  const dw = 10, dh = Math.min(15, bh - 4), dx = shaftCx - (dw >> 1), dy = gy - dh;
  g.rect(dx - 1, dy - 1, dw + 2, dh + 1, C.INK);
  g.rect(dx, dy, dw, dh, C.AMBER_L);
  g.rect(dx, dy, dw, 2, C.CREAM);
  g.rect(dx, gy - 3, dw, 3, C.AMBER);
  g.vline(dx, dy, dh, C.AMBER); g.vline(dx + dw - 1, dy, dh, C.AMBER);
  g.vline(shaftCx, dy + 2, dh - 2, C.AMBER);            // lift gate seam
  g.px(shaftCx - 2, dy + 5, C.AMBER_D); g.px(shaftCx + 2, dy + 5, C.AMBER_D);
  // porch lamp and windows
  g.hline(shaftCx - 1, dy - 3, 3, C.STEEL_DD); g.px(shaftCx, dy - 2, C.CREAM);
  for (const wx of [bx + 3, bx + bw - 7]) {
    if (wx + 4 <= dx - 2 || wx >= dx + dw + 2) { g.rect(wx, by + 4, 4, 3, C.INK); g.rect(wx + 1, by + 5, 2, 1, C.AMBER_L); }
  }
  // light spilling onto the grass
  for (let x = dx - 5; x < dx + dw + 5; x++) {
    const d = Math.abs(x - shaftCx);
    if (d < 6) g.px(x, gy, C.AMBER); else if ((x & 1) === 0) g.px(x, gy, C.AMBER_D);
    if (d < 8 && ((x + 1) & 1) === 0) g.px(x, gy + 1, C.AMBER_D);
  }
  // roof vent and a small dish
  const vx = right ? bx + 3 : bx + bw - 7;
  g.rect(vx, by - 4, 4, 2, C.STEEL_D); g.hline(vx - 1, by - 5, 6, C.STEEL); g.px(vx - 1, by - 5, C.STEEL_L);
  const dx2 = right ? bx + bw - 6 : bx + 5;
  g.px(dx2, by - 3, C.STEEL_L); g.px(dx2 - 1, by - 4, C.STEEL_LL); g.px(dx2 + 1, by - 4, C.STEEL_LL);
  g.px(dx2 - 2, by - 5, C.STEEL_LL); g.px(dx2 + 1, by - 5, C.STEEL);
  g.mast = [ax, at];
  return g;
}

/**
 * Surface strip (SURFACE_H tall): night sky, horizon, ground, and a small entrance
 * building standing over the elevator shaft where residents arrive.
 * The ground line (where walkers' feet go) is at y + h - 8; below it is grass and topsoil.
 * @param {{shaftX:number, shaftW:number, emergency?:boolean, t?:number}} opts
 *   shaftX/shaftW: where the shaft top is (absolute x). emergency: red sky glow, siren mast flashing.
 */
export function drawSurface(fb, x, y, w, h, t, opts) {
  x |= 0; y |= 0; w |= 0; h |= 0;
  if (w <= 0 || h <= GROUND_H) return;
  t = t ?? (opts && opts.t) ?? 0;
  const sw = ((opts && opts.shaftW) ?? 32) | 0, sx = (((opts && opts.shaftX) ?? x + ((w - sw) >> 1)) | 0) - x;
  const emergency = !!(opts && opts.emergency);
  const glow = emergency ? 1 + (Math.floor(t * 1.5) & 1) : 0;
  const g = cached(surfaceCache, `${w}|${h}|${sx}|${sw}|${glow}`, 12, () => buildSurface(w, h, sx, sw, glow));
  paste(fb, g, x, y);
  const cx0 = fb.cx0, cy0 = fb.cy0, cx1 = fb.cx1, cy1 = fb.cy1;   // keep the flash inside the strip
  fb.cx0 = Math.max(cx0, x); fb.cy0 = Math.max(cy0, y); fb.cx1 = Math.min(cx1, x + w); fb.cy1 = Math.min(cy1, y + h);
  if (fb.cx1 > fb.cx0 && fb.cy1 > fb.cy0) surfaceAnim(fb, x, y, t, emergency, g);
  fb.cx0 = cx0; fb.cy0 = cy0; fb.cx1 = cx1; fb.cy1 = cy1;
}

function surfaceAnim(fb, x, y, t, emergency, g) {
  // twinkling stars
  for (const [px, py, c, i] of g.stars) {
    const ph = Math.floor(t * 1.7 + hash(i, 431) * 9);
    if (hash(i, ph, 432) < 0.3) fb.px(x + px, y + py, c === C.WHITE ? C.STEEL_L : C.STEEL_D);
  }
  // mast light: slow blink normally, fast red flash with a halo in an emergency
  const [ax, at] = g.mast;
  const mx = x + ax, my = y + at;
  if (emergency) {
    const on = Math.floor(t * 5) % 2 === 0;
    if (on) {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy <= 10 && ((mx + dx + my + dy) & 1) === 0) fb.px(mx + dx, my + dy, C.RED);
      }
      fb.rect(mx - 1, my - 1, 3, 3, C.RED_L); fb.px(mx, my, C.CREAM);
    } else { fb.px(mx, my, C.RED_D); }
  } else {
    const on = (t % 2.4) < 0.5;
    fb.px(mx, my, on ? C.RED_L : C.RED_D);
    if (on) { fb.px(mx - 1, my, C.RED); fb.px(mx + 1, my, C.RED); fb.px(mx, my - 1, C.RED); }
  }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Concrete shell: ceiling slab, side walls, floor slab. The interior is filled by the caller first. */
function shell(g, w, h, floorTop, floorEdge) {
  const fy = h - FLOOR_T;
  g.rect(0, 0, w, CEIL_T, C.STEEL_D);
  g.rect(0, 0, WALL_T, fy, C.STEEL_D);
  g.rect(w - WALL_T, 0, WALL_T, fy, C.STEEL_D);
  g.hline(WALL_T - 1, CEIL_T - 1, w - 2 * (WALL_T - 1), C.INK);
  g.vline(WALL_T - 1, CEIL_T - 1, fy - CEIL_T + 1, C.INK);
  g.vline(w - WALL_T, CEIL_T - 1, fy - CEIL_T + 1, C.INK);
  g.rect(0, fy, w, FLOOR_T, C.STEEL_D);
  g.hline(0, fy, w, floorTop);
  g.hline(0, fy + 1, w, floorEdge);
  // a little grit in the cut concrete
  for (let x = 0; x < w; x++) {
    if (hash(x, 501, w) < 0.12) g.px(x, 0, C.STEEL_DD);
    if (hash(x, 502, w) < 0.16) g.px(x, fy + 2 + (hash(x, 503) < 0.5 ? 0 : 1), C.STEEL_DD);
  }
  for (let y = 2; y < fy; y++) {
    if (hash(y, 504, w) < 0.12) g.px(0, y, C.STEEL_DD);
    if (hash(y, 505, w) < 0.12) g.px(w - 1, y, C.STEEL_DD);
  }
}

/** Doorway through a side wall: DOOR_H tall from the floor, with a lintel and threshold. */
function doorway(g, w, h, left, passage) {
  const fy = h - FLOOR_T, top = fy - DOOR_H;
  const x = left ? 0 : w - WALL_T;
  g.rect(x, top, WALL_T, DOOR_H, passage);
  // lintel cap, one pixel proud of the wall on the room side
  g.hline(left ? 0 : w - WALL_T - 1, top - 1, WALL_T + 1, C.STEEL);
  g.px(left ? WALL_T : w - WALL_T - 1, top - 2, C.INK);
  g.px(left ? WALL_T : w - WALL_T - 1, top, C.STEEL_D);
  // threshold plate
  g.hline(left ? 0 : w - WALL_T - 2, fy, WALL_T + 2, C.STEEL_LL);
}

function pendantLamp(g, cx, y, drop = 2) {
  g.vline(cx, y, drop, C.STEEL_DD);
  g.hline(cx - 2, y + drop, 5, C.STEEL_D);
  g.hline(cx - 3, y + drop + 1, 7, C.STEEL_D);
  g.px(cx - 3, y + drop + 1, C.STEEL); g.px(cx - 2, y + drop, C.STEEL);
  g.hline(cx - 2, y + drop + 2, 5, C.CREAM);
  g.px(cx - 2, y + drop + 2, C.AMBER_L); g.px(cx + 2, y + drop + 2, C.AMBER_L);
}

function bulkheadLamp(g, cx, y) {
  g.hline(cx - 4, y, 9, C.STEEL);
  g.px(cx - 4, y, C.STEEL_L);
  g.hline(cx - 3, y + 1, 7, C.CREAM);
  g.px(cx - 3, y + 1, C.AMBER_L); g.px(cx + 3, y + 1, C.AMBER_L);
  g.px(cx - 4, y + 1, C.STEEL_D); g.px(cx + 4, y + 1, C.STEEL_D);
}

/** Room name stencilled on the back wall. */
function stencil(g, x, y, label, c = C.CREAM, sh = C.WALL_D) { drawText(g, x, y, label, c, { shadow: sh }); }

function strHash(s) {
  let v = 7;
  for (let i = 0; i < s.length; i++) v = (Math.imul(v, 31) + s.charCodeAt(i)) | 0;
  return v;
}

/** Wooden crate or parcel. kind 0 braced crate, 1 slatted crate, 2 cream parcel, 3 dark crate. */
function crate(g, x, y, w, h, kind = 0) {
  const body = kind === 2 ? C.PACKAGE : kind === 3 ? C.WOOD : C.CRATE;
  const dark = kind === 2 ? C.TAN : kind === 3 ? C.LEATHER : C.WOOD;
  const lite = kind === 2 ? C.CREAM : kind === 3 ? C.CRATE : C.TAN;
  g.rect(x, y, w, h, body);
  if (kind === 0 || kind === 3) {
    g.line(x + 1, y + 2, x + w - 2, y + h - 2, dark);
    g.line(x + w - 2, y + 2, x + 1, y + h - 2, dark);
  } else if (kind === 1) {
    for (let yy = y + 3; yy < y + h - 1; yy += 2) g.hline(x + 1, yy, w - 2, dark);
  } else {
    g.vline(x + (w >> 1) - 1, y + 1, h - 2, dark);
    g.hline(x + 1, y + (h >> 1), w - 2, dark);
  }
  g.hline(x + 1, y + 1, w - 2, lite);
  g.vline(x + w - 2, y + 2, h - 3, dark);
  g.frame(x, y, w, h, C.ROCK_D);
}

const BARREL = sprite([
  '.bbbb.',
  'bhbbbd',
  'ssssss',
  'bhbbbd',
  'bhbbbd',
  'ssssss',
  'bhbbbd',
  'bhbbbd',
  '.dddd.',
], { b: C.TEAL_D, h: C.TEAL, d: C.INK, s: C.STEEL });

/** Clock / gauge hand from the centre, angle clockwise from 12 o'clock. */
function hand(fb, cx, cy, ang, len, c) {
  fb.line(cx, cy, cx + Math.round(Math.sin(ang) * len), cy - Math.round(Math.cos(ang) * len), c);
}

// --- machine bay ---------------------------------------------------------------------

/** Small wall fixtures that vary from bay to bay. Each fits in 12 x 9. */
function wallDecor(g, x, y, type) {
  if (type === 0) {            // vent grille
    g.rect(x, y, 12, 7, C.STEEL_D);
    g.hline(x, y, 12, C.STEEL); g.vline(x, y, 7, C.STEEL);
    g.hline(x + 2, y + 2, 8, C.INK); g.hline(x + 2, y + 4, 8, C.INK);
    g.hline(x + 1, y + 7, 12, C.WALL_D); g.vline(x + 12, y + 1, 7, C.WALL_D);
  } else if (type === 1) {     // pinned notice
    g.rect(x + 2, y, 8, 8, C.CREAM);
    g.hline(x + 3, y + 1, 6, C.RED);
    g.hline(x + 3, y + 3, 5, C.STEEL); g.hline(x + 3, y + 5, 6, C.STEEL); g.hline(x + 3, y + 6, 3, C.STEEL);
    g.px(x + 6, y, C.RED_D);
    g.hline(x + 3, y + 8, 8, C.WALL_D); g.vline(x + 10, y + 1, 8, C.WALL_D);
  } else if (type === 2) {     // pressure gauge on a stub pipe
    g.vline(x + 5, y + 6, 3, C.COPPER); g.vline(x + 6, y + 6, 3, C.COPPER_D);
    g.disc(x + 5, y + 3, 3, C.STEEL_D); g.disc(x + 5, y + 3, 2, C.CREAM);
    g.px(x + 5, y + 3, C.INK); g.px(x + 6, y + 2, C.INK); g.px(x + 7, y + 3, C.RED);
    g.px(x + 3, y + 1, C.STEEL_L);
  } else if (type === 3) {     // fuse box
    g.rect(x + 2, y, 8, 9, C.STEEL);
    g.hline(x + 2, y, 8, C.STEEL_L); g.vline(x + 9, y, 9, C.STEEL_D); g.hline(x + 2, y + 8, 8, C.STEEL_D);
    g.vline(x + 6, y + 2, 5, C.STEEL_D);
    g.px(x + 4, y + 2, C.GREEN_L); g.px(x + 4, y + 4, C.AMBER);
    g.hline(x + 7, y + 6, 2, C.HAZARD);
    g.hline(x + 3, y + 9, 8, C.WALL_D); g.vline(x + 10, y + 1, 9, C.WALL_D);
  } else {                     // stop valve on a pipe stub
    g.hline(x, y + 4, 12, C.COPPER_L); g.hline(x, y + 5, 12, C.COPPER); g.hline(x, y + 6, 12, C.COPPER_D);
    g.vline(x, y + 3, 5, C.BRASS); g.vline(x + 11, y + 3, 5, C.BRASS);
    g.vline(x + 5, y + 2, 2, C.STEEL_D);
    g.hline(x + 3, y + 1, 5, C.RED); g.px(x + 3, y + 1, C.RED_L); g.px(x + 7, y + 1, C.RED_D);
  }
}

/** Hooded hatch in a side wall where a belt passes through at BELT_Y. */
function beltHatch(g, w, left) {
  const m = (x) => (left ? x : w - 1 - x);
  const top = BELT_Y - 9;
  for (let x = 0; x < WALL_T + 4; x++) g.vline(m(x), top + 1, 8, C.INK);                 // tunnel + mouth
  g.vline(m(WALL_T), top + 1, 3, C.STEEL_DD); g.vline(m(WALL_T + 2), top + 1, 4, C.STEEL_DD);  // rubber flaps
  for (let x = WALL_T; x < WALL_T + 5; x++) { g.px(m(x), top - 1, C.STEEL_L); g.px(m(x), top, C.STEEL); }
  g.px(m(WALL_T + 5), top, C.STEEL_D);
  for (let y = top + 1; y < BELT_Y + 6; y++) {                                           // banded frame post
    g.px(m(WALL_T + 4), y, ((y >> 1) & 1) ? C.HAZARD : C.INK);
    g.px(m(WALL_T + 5), y, C.STEEL_D);
  }
  g.px(m(WALL_T + 2), top - 3, C.STEEL_D); g.px(m(WALL_T + 2), top - 2, C.GREEN_D);       // status lamp
}

function buildMachineRoom(g, w, h, o) {
  const fy = h - FLOOR_T, x0 = WALL_T, x1 = w - WALL_T, iw = x1 - x0;
  const dado = BELT_Y + 6;
  const mx0 = MACHINE_CX - (MACHINE_W >> 1), mx1 = mx0 + MACHINE_W;
  g.rect(x0, CEIL_T, iw, fy - CEIL_T, C.WALL);
  g.rect(x0, dado, iw, fy - dado, C.WALL_D);
  for (let px = x0 + 25; px < x1 - 4; px += 26) g.vline(px, CEIL_T + 3, dado - CEIL_T - 3, C.WALL_D);
  for (let px = x0 + 12; px < x1 - 4; px += 13) g.vline(px, dado + 3, fy - dado - 3, C.ROCK);
  const lamps = [30, w - 30];
  for (const lx of lamps) wash(g, lx, 3, 32, 48, x0, CEIL_T + 3, x1, fy);
  wash(g, MACHINE_CX, 34, 46, 40, mx0 - 2, CEIL_T + 3, mx1 + 2, fy, DIM, 0.55);          // bay behind the machine
  shell(g, w, h, C.STEEL_L, C.STEEL);
  // accent stripe under the ceiling, with flush strip lights let into it
  g.rect(x0, CEIL_T, iw, 2, o.accent ?? C.AMBER_D);
  g.hline(x0, CEIL_T + 2, iw, C.WALL_D);
  for (const lx of lamps) {
    g.hline(lx - 7, CEIL_T, 15, C.STEEL_D);
    g.hline(lx - 6, CEIL_T + 1, 13, C.CREAM);
    g.px(lx - 6, CEIL_T + 1, C.AMBER_L); g.px(lx + 6, CEIL_T + 1, C.AMBER_L);
    g.px(lx - 7, CEIL_T + 1, C.STEEL_DD); g.px(lx + 7, CEIL_T + 1, C.STEEL_DD);
    g.hline(lx - 5, CEIL_T + 2, 11, C.AMBER_L);
  }
  // panel rivets and the rail above the lower wall
  for (let px = x0 + 25; px < x1 - 4; px += 26) {
    rivet(g, px - 2, CEIL_T + 5, C.WALL_L, C.WALL_D); rivet(g, px + 2, CEIL_T + 5, C.WALL_L, C.WALL_D);
    rivet(g, px - 2, dado - 4, C.WALL_L, C.WALL_D); rivet(g, px + 2, dado - 4, C.WALL_L, C.WALL_D);
  }
  g.hline(x0, dado, iw, C.WALL);
  g.hline(x0, dado + 1, iw, C.ROCK);
  // fixtures on the side walls' back panels, different in every bay
  const slots = [[8, 14], [36, 15], [w - 48, 15], [w - 20, 14]];
  slots.forEach(([sx, sy], i) => {
    const r = hash(o.vseed, i, 811);
    if (r < 0.86) wallDecor(g, sx, sy, Math.floor(hash(o.vseed, i, 812) * 5));
  });
  beltHatch(g, w, true);
  beltHatch(g, w, false);
  // floor: machine plinth and workstation cell marks
  g.hline(mx0 - 2, fy, MACHINE_W + 4, C.STEEL); g.hline(mx0 - 2, fy + 1, MACHINE_W + 4, C.STEEL_D);
  for (let px = mx0 + 3; px < mx1; px += 9) g.px(px, fy, C.STEEL_L);
  for (let px = 17; px < w - 4; px += 16) if (px < mx0 - 3 || px > mx1 + 2) g.px(px, fy + 1, C.STEEL_D);
  for (const sx of SLOT_XS) {
    const a = sx - (STATION_W >> 1), b = sx + (STATION_W >> 1) - 1;
    g.hline(a, fy, 2, C.AMBER); g.hline(b - 1, fy, 2, C.AMBER);
    g.px(a, fy + 1, C.AMBER_D); g.px(b, fy + 1, C.AMBER_D);
  }
  stencil(g, 5, CEIL_T + 5, o.label);
}

function animMachineRoom(fb, x, y, w, h, t, o) {
  // hatch status lamps: steady green with an occasional blink
  const top = y + BELT_Y - 9;
  const a = hash(Math.floor(t * 2), 821) < 0.85, b = hash(Math.floor(t * 2), 822) < 0.85;
  fb.px(x + WALL_T + 2, top - 2, a ? C.GREEN_L : C.GREEN_D);
  fb.px(x + w - 1 - WALL_T - 2, top - 2, b ? C.GREEN_L : C.GREEN_D);
}

// --- control room -------------------------------------------------------------------

function buildControlRoom(g, w, h, o) {
  const fy = h - FLOOR_T, x0 = WALL_T, x1 = w - WALL_T, iw = x1 - x0, dado = fy - 15;
  const ccx = CONTROL.consoleCx, cl = ccx - 22;
  g.rect(x0, CEIL_T, iw, fy - CEIL_T, C.WALL);
  g.rect(x0, dado, iw, fy - dado, C.WALL_D);
  for (let px = x0 + 17; px < x1 - 3; px += 17) g.vline(px, CEIL_T, dado - CEIL_T, C.WALL_D);
  for (let px = x0 + 8; px < x1 - 3; px += 17) g.vline(px, dado + 2, fy - dado - 2, C.ROCK);
  const lamps = [44, ccx + 9];
  for (const lx of lamps) wash(g, lx, 7, 30, 46, x0, CEIL_T, x1, fy);
  shell(g, w, h, C.STEEL_L, C.STEEL);
  g.hline(x0, dado, iw, C.ROCK);
  for (let px = 13; px < w - 4; px += 16) g.px(px, fy + 1, C.STEEL_D);
  for (const lx of lamps) pendantLamp(g, lx, CEIL_T);
  stencil(g, 5, 5, o.label);

  // wall status board: a little cutaway map of the shelter
  const bx = 8, by = 13;
  g.hline(bx + 1, by + 20, 41, C.WALL_D); g.vline(bx + 41, by + 1, 20, C.WALL_D);
  g.rect(bx, by, 41, 20, C.STEEL_D);
  g.hline(bx, by, 41, C.STEEL_L); g.vline(bx, by + 1, 19, C.STEEL);
  g.hline(bx + 1, by + 19, 40, C.STEEL_DD); g.vline(bx + 40, by + 1, 19, C.STEEL_DD);
  g.rect(bx + 2, by + 2, 37, 16, C.GREEN_DD);
  const ox = bx + 2, oy = by + 2;
  g.hline(ox + 1, oy + 2, 35, C.GREEN_D);
  g.rect(ox + 17, oy, 3, 2, C.GREEN_D);
  g.vline(ox + 18, oy + 3, 12, C.GREEN_D);
  for (let f = 0; f < 3; f++) {
    g.frame(ox + 2, oy + 4 + f * 4, 15, 3, C.GREEN_D);
    g.frame(ox + 20, oy + 4 + f * 4, 15, 3, C.GREEN_D);
  }

  // instrument panel above the console: three dials
  const px0 = ccx - 18, py0 = 14;
  g.hline(px0 + 1, py0 + 17, 37, C.WALL_D);
  g.rect(px0, py0, 37, 17, C.STEEL_DD);
  g.hline(px0, py0, 37, C.STEEL); g.vline(px0, py0 + 1, 16, C.STEEL_D);
  g.hline(px0, py0 + 16, 37, C.INK); g.vline(px0 + 36, py0, 17, C.INK);
  for (const dx of [7, 18, 29]) {
    g.disc(px0 + dx, py0 + 7, 4, C.STEEL);
    g.px(px0 + dx - 3, py0 + 4, C.STEEL_L); g.px(px0 + dx - 2, py0 + 3, C.STEEL_L);
    g.disc(px0 + dx, py0 + 7, 3, C.CREAM);
    g.px(px0 + dx + 2, py0 + 5, C.RED); g.px(px0 + dx + 3, py0 + 7, C.RED);
    g.px(px0 + dx - 3, py0 + 7, C.STEEL); g.px(px0 + dx, py0 + 4, C.STEEL);
    g.hline(px0 + dx - 2, py0 + 13, 5, C.STEEL_D);
  }
  for (const [rx, ry] of [[1, 1], [35, 1], [1, 15], [35, 15]]) g.px(px0 + rx, py0 + ry, C.STEEL);
  // conduit from the panel down into the console, trunking up to the ceiling
  g.vline(px0 + 18, py0 + 17, 3, C.STEEL); g.vline(px0 + 19, py0 + 17, 3, C.STEEL_D);
  g.vline(px0 + 33, CEIL_T, py0 - CEIL_T, C.STEEL); g.vline(px0 + 34, CEIL_T, py0 - CEIL_T, C.STEEL_D);
  g.hline(px0 + 33, CEIL_T + 5, 2, C.STEEL_L);
  // signal cable sagging from the board to the panel
  const cb = [[bx + 41, by + 9], [bx + 42, by + 10], [px0 - 2, by + 10], [px0 - 1, by + 9]];
  g.px(cb[0][0], cb[0][1], C.INK); g.px(cb[1][0], cb[1][1], C.INK);
  g.hline(cb[1][0] + 1, by + 11, cb[2][0] - cb[1][0] - 1, C.INK);
  g.px(cb[2][0], cb[2][1], C.INK); g.px(cb[3][0], cb[3][1], C.INK);

  // foreman console
  const top = fy - 26, kx = cl + 8;
  g.rect(kx, top, 36, 12, C.STEEL);
  g.hline(kx, top, 36, C.STEEL_L); g.vline(kx, top + 1, 11, C.STEEL_L);
  g.vline(kx + 35, top, 12, C.STEEL_D);
  for (const sx of [kx + 2, kx + 14]) {
    g.rect(sx, top + 2, 11, 9, C.STEEL_DD);
    g.rect(sx + 1, top + 3, 9, 7, C.GREEN_DD);
    g.px(sx + 1, top + 3, C.STEEL_DD); g.px(sx + 9, top + 3, C.STEEL_DD);
    g.px(sx + 1, top + 9, C.STEEL_DD); g.px(sx + 9, top + 9, C.STEEL_DD);
  }
  g.rect(kx + 26, top + 2, 8, 9, C.STEEL_DD);
  for (let c = 0; c < 3; c++) g.px(kx + 27 + c * 2, top + 9, C.STEEL_L);
  const dy = top + 12;
  g.hline(cl, dy, 44, C.STEEL_LL);
  g.hline(cl, dy + 1, 44, C.STEEL_D);
  for (let k = cl + 2; k < cl + 30; k += 2) g.px(k, dy + 1, C.CREAM);
  g.px(cl + 33, dy + 1, C.RED_L); g.px(cl + 36, dy + 1, C.AMBER_L); g.px(cl + 39, dy + 1, C.GREEN_L);
  g.hline(cl, dy + 2, 44, C.STEEL);
  g.hline(cl + 1, dy + 3, 43, C.INK);
  g.rect(cl + 4, dy + 4, 40, 10, C.STEEL_D);
  g.vline(cl + 4, dy + 4, 10, C.STEEL); g.vline(cl + 43, dy + 4, 10, C.STEEL_DD);
  g.hline(cl + 4, fy - 1, 40, C.INK);
  g.rect(cl + 7, dy + 5, 17, 7, C.STEEL); g.rect(cl + 8, dy + 6, 15, 5, C.INK);
  g.disc(cl + 11, dy + 8, 2, C.STEEL_L); g.disc(cl + 19, dy + 8, 2, C.STEEL_L);
  g.hline(cl + 13, dy + 10, 5, C.WALL);
  for (let vy = dy + 6; vy <= dy + 10; vy += 2) g.hline(cl + 28, vy, 13, C.STEEL_DD);
  g.vline(cl + 26, dy + 5, 8, C.STEEL_DD);
  g.rect(cl, dy + 4, 2, 10, C.STEEL_D); g.vline(cl, dy + 4, 10, C.STEEL);

  // spare swivel chair by the left wall
  const sx = 5, sy = fy - 13;
  g.rect(sx + 1, sy, 2, 7, C.RED_D); g.vline(sx + 1, sy, 6, C.RED);
  g.hline(sx + 1, sy + 6, 8, C.RED); g.hline(sx + 1, sy + 7, 8, C.RED_D);
  g.px(sx + 8, sy + 6, C.RED_L);
  g.hline(sx + 5, sy + 3, 3, C.STEEL_D); g.vline(sx + 7, sy + 4, 2, C.STEEL_D);
  g.vline(sx + 4, sy + 8, 3, C.STEEL_L); g.vline(sx + 5, sy + 8, 3, C.STEEL);
  g.hline(sx + 1, sy + 11, 8, C.STEEL);
  g.px(sx + 1, sy + 12, C.INK); g.px(sx + 4, sy + 12, C.INK); g.px(sx + 8, sy + 12, C.INK);
}

function animControlRoom(fb, x, y, w, h, t, o) {
  const fy = y + h - FLOOR_T, ccx = x + CONTROL.consoleCx, cl = ccx - 22, top = fy - 26, kx = cl + 8;
  // CRT 1: a scrolling listing with a blinking cursor
  const s1x = kx + 3, sy = top + 3, scroll = Math.floor(t * 2.5);
  for (let r = 0; r < 3; r++) {
    const line = scroll + r;
    const ind = Math.floor(hash(line, 701) * 3), len = 2 + Math.floor(hash(line, 702) * 5);
    fb.hline(s1x + 1 + ind, sy + 1 + r * 2, Math.min(len, 7 - ind), r === 2 ? C.GREEN_L : C.GREEN);
    if (r === 2 && (Math.floor(t * 4) & 1)) fb.px(s1x + 1 + ind + Math.min(len, 7 - ind), sy + 5, C.MINT);
  }
  // CRT 2: oscilloscope trace
  const s2x = kx + 15;
  fb.hline(s2x + 1, sy + 3, 7, C.GREEN_D);
  for (let i = 0; i < 9; i++) {
    const v = Math.round(3 + 2.3 * Math.sin(i * 0.95 - t * 5) * Math.sin(t * 0.7 + 1));
    if ((i > 0 && i < 8) || (v > 0 && v < 6)) fb.px(s2x + i, sy + v, C.GREEN_L);
  }
  // lamp field
  const LAMPS = [C.RED_L, C.AMBER_L, C.GREEN_L, C.GREEN_L, C.AMBER_L, C.GREEN_L, C.CYAN, C.GREEN_L, C.RED_L];
  const DARK = [C.RED_D, C.AMBER_D, C.GREEN_D, C.GREEN_D, C.AMBER_D, C.GREEN_D, C.TEAL_D, C.GREEN_D, C.RED_D];
  for (let i = 0; i < 9; i++) {
    const on = hash(i, Math.floor(t * (1.5 + (i % 3)) + i * 0.37), 703) < 0.6;
    fb.px(kx + 27 + (i % 3) * 2, top + 3 + Math.floor(i / 3) * 2, on ? LAMPS[i] : DARK[i]);
  }
  // tape reels turning in opposite directions
  const dy = top + 12, step = Math.floor(t * 6) & 3;
  const SP = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  fb.px(cl + 11, dy + 8, C.INK); fb.px(cl + 19, dy + 8, C.INK);
  fb.px(cl + 11 + SP[step][0], dy + 8 + SP[step][1], C.STEEL_D);
  fb.px(cl + 19 + SP[3 - step][0], dy + 8 + SP[3 - step][1], C.STEEL_D);
  // dial needles
  const px0 = ccx - 18, py0 = y + 14;
  [7, 18, 29].forEach((dx, i) => {
    const v = 0.35 * Math.sin(t * (0.7 + i * 0.23) + i * 2.1) + 0.1 * Math.sin(t * 6.1 + i) + (i === 2 ? 0.25 : -0.1);
    hand(fb, px0 + dx, py0 + 7, v * 2.2, 2.6, C.INK);
  });
  // status board: room lights and the lift blip
  const ox = x + 10, oy = y + 15;
  for (let f = 0; f < 3; f++) for (let s = 0; s < 2; s++) for (let k = 0; k < 4; k++) {
    const id = f * 8 + s * 4 + k;
    const r = hash(id, Math.floor(t * 0.6 + hash(id, 711) * 7), 712);
    let c = r < 0.55 ? C.GREEN_L : r < 0.78 ? C.GREEN : r < 0.92 ? C.AMBER_L : C.RED_L;
    if (c === C.RED_L && (Math.floor(t * 4) & 1)) c = C.RED_D;
    fb.px(ox + (s ? 22 : 4) + k * 3, oy + 5 + f * 4, c);
  }
  const tri = Math.abs(((t * 0.18) % 2 + 2) % 2 - 1);
  fb.px(ox + 18, oy + 4 + Math.round(tri * 10), C.MINT);
}

// --- lounge ----------------------------------------------------------------------------

function buildLounge(g, w, h, o) {
  const fy = h - FLOOR_T, x0 = WALL_T, x1 = w - WALL_T, iw = x1 - x0, dado = fy - 16;
  const scx = LOUNGE.sofaCx, lampX = 62, cmx = 84;
  g.rect(x0, CEIL_T, iw, fy - CEIL_T, C.WALL_L);
  for (let px = x0 + 3; px < x1; px += 6) g.vline(px, CEIL_T, dado - CEIL_T, C.WALL);       // pinstripe wallpaper
  g.rect(x0, dado, iw, fy - dado, C.WALL);                                                    // wood panelling
  for (let px = x0 + 7; px < x1; px += 8) g.vline(px, dado + 2, fy - dado - 2, C.WALL_D);
  wash(g, lampX, 8, 38, 46, x0, CEIL_T, x1, fy);
  shell(g, w, h, C.WOOD, C.LEATHER);
  g.hline(x0, dado, iw, C.WOOD); g.hline(x0, dado + 1, iw, C.WALL_D);                         // chair rail
  for (let px = 9; px < w; px += 13) g.px(px, fy, C.LEATHER);                                 // floorboard joints
  pendantLamp(g, lampX, CEIL_T, 3);
  stencil(g, 5, 5, o.label, C.CREAM, C.WALL);

  // poster above the sofa: sunrise over green hills
  const px0 = scx - 14, py0 = 14;
  g.rect(px0 + 1, py0 + 1, 14, 17, C.WALL);
  g.rect(px0, py0, 14, 17, C.CREAM);
  g.rect(px0 + 1, py0 + 1, 12, 3, C.TEAL_D);
  g.rect(px0 + 1, py0 + 4, 12, 7, C.TEAL);
  g.disc(px0 + 7, py0 + 8, 3, C.ORANGE); g.disc(px0 + 7, py0 + 8, 1, C.YELLOW);
  g.px(px0 + 3, py0 + 3, C.CYAN); g.px(px0 + 10, py0 + 2, C.CYAN);
  for (let i = 0; i < 12; i++) {
    const hh = 2 + Math.round(1.2 * Math.sin(i * 0.7 + 0.6));
    g.vline(px0 + 1 + i, py0 + 11 - hh, hh, C.GREEN_D);
    g.px(px0 + 1 + i, py0 + 11 - hh, C.GREEN);
  }
  g.hline(px0 + 2, py0 + 12, 10, C.RED);
  g.hline(px0 + 3, py0 + 14, 8, C.STEEL);
  g.px(px0 + 6, py0, C.RED_D);

  // wall clock (hands are animated)
  const kx = scx + 11, ky = 21;
  g.disc(kx + 1, ky + 1, 5, C.WALL);
  g.disc(kx, ky, 5, C.STEEL_D);
  g.disc(kx, ky, 4, C.CREAM);
  g.px(kx, ky - 4, C.STEEL); g.px(kx, ky + 4, C.STEEL); g.px(kx - 4, ky, C.STEEL); g.px(kx + 4, ky, C.STEEL);
  g.px(kx - 3, ky - 4, C.STEEL); g.px(kx - 4, ky - 3, C.STEEL);

  // bookshelf above the coffee corner
  const sl = cmx - 12, sy = 24;
  g.hline(sl, sy, 27, C.WOOD); g.hline(sl, sy + 1, 27, C.WALL);
  g.px(sl + 2, sy + 2, C.LEATHER); g.px(sl + 24, sy + 2, C.LEATHER);
  const books = [[2, 6, C.RED, C.RED_L], [1, 5, C.CREAM, C.WHITE], [2, 7, C.BLUE, C.BLUE_L], [2, 5, C.GREEN_D, C.GREEN], [1, 6, C.AMBER, C.AMBER_L], [2, 6, C.VIOLET, C.VIOLET_L], [1, 4, C.TEAL, C.CYAN], [2, 6, C.RED_D, C.RED]];
  let bxp = sl + 2;
  for (const [bw, bh, c, hi] of books) { g.rect(bxp, sy - bh, bw, bh, c); g.px(bxp, sy - bh, hi); bxp += bw; }
  g.rect(sl + 20, sy - 2, 3, 2, C.COPPER); g.px(sl + 21, sy - 3, C.GREEN); g.vline(sl + 21, sy - 5, 2, C.GREEN_D); g.px(sl + 20, sy - 4, C.GREEN); g.px(sl + 22, sy - 5, C.GREEN);

  // potted plant in the corner
  const pl = 4;
  g.hline(pl, fy - 6, 6, C.COPPER_L);
  g.rect(pl, fy - 5, 6, 4, C.COPPER); g.hline(pl + 1, fy - 1, 4, C.COPPER_D);
  g.vline(pl + 5, fy - 5, 4, C.COPPER_D);
  const bx = pl + 3, by = fy - 7;
  for (const [tx, ty] of [[-4, -8], [-2, -13], [1, -16], [4, -12], [6, -7]]) {
    g.line(bx, by, bx + tx, by + ty, C.GREEN_D);
    g.line(bx - 1, by, bx + tx - 1, by + ty + 1, C.GREEN);
    g.px(bx + tx, by + ty, C.GREEN_L);
  }

  // sofa
  const l = scx - 20, top = fy - 13;
  g.rect(l + 2, top + 1, 36, 7, C.TEAL_D);
  g.hline(l + 3, top, 34, C.TEAL);
  g.rect(l + 3, top + 7, 34, 4, C.TEAL_D);
  g.hline(l + 3, top + 7, 34, C.TEAL);
  for (const sxm of [l + 14, l + 26]) { g.vline(sxm, top + 2, 5, C.INK); g.vline(sxm, top + 8, 3, C.INK); }
  for (const bxm of [l + 8, l + 20, l + 32]) g.px(bxm, top + 3, C.TEAL);
  for (const ax of [l, l + 37]) { g.rect(ax, top + 4, 3, 8, C.TEAL_D); g.hline(ax, top + 3, 3, C.TEAL); }
  g.vline(l, top + 4, 7, C.TEAL); g.vline(l + 39, top + 4, 8, C.INK);
  g.hline(l + 1, top + 11, 38, C.INK);
  g.hline(l + 3, fy - 1, 34, C.WALL_D);
  g.hline(l + 1, fy - 1, 2, C.WOOD); g.hline(l + 37, fy - 1, 2, C.WOOD);
  // rug under it
  g.hline(l - 3, fy, 52, C.RED); g.hline(l - 3, fy + 1, 52, C.RED_D);
  for (let rx = l - 1; rx < l + 48; rx += 4) g.px(rx, fy, C.AMBER);
  g.px(l - 4, fy, C.CREAM); g.px(l + 49, fy, C.CREAM);

  // coffee corner: counter, machine, mugs
  const cl = cmx - 12, ct = fy - 14;
  g.rect(cl, ct + 2, 27, 12, C.WOOD);
  g.hline(cl - 1, ct, 29, C.TAN); g.hline(cl - 1, ct + 1, 29, C.LEATHER);
  g.vline(cl, ct + 2, 12, C.CRATE); g.vline(cl + 26, ct + 2, 12, C.LEATHER);
  g.vline(cl + 9, ct + 3, 10, C.LEATHER); g.vline(cl + 18, ct + 3, 10, C.LEATHER);
  g.px(cl + 7, ct + 6, C.BRASS); g.px(cl + 11, ct + 6, C.BRASS); g.px(cl + 20, ct + 6, C.BRASS);
  g.hline(cl, fy - 1, 27, C.WALL_D);
  const mx = cmx - 5, my = ct - 12;
  g.rect(mx, my + 1, 11, 11, C.STEEL);
  g.hline(mx + 1, my, 9, C.STEEL_L);
  g.vline(mx, my + 1, 11, C.STEEL_L); g.vline(mx + 10, my + 1, 11, C.STEEL_D);
  g.rect(mx + 6, my + 2, 3, 2, C.GLASS); g.px(mx + 6, my + 2, C.GLASS_L);
  g.px(mx + 2, my + 2, C.RED);
  g.hline(mx + 1, my + 4, 9, C.STEEL_DD);
  g.rect(mx + 1, my + 5, 9, 5, C.INK);
  g.px(mx + 4, my + 5, C.STEEL_D);
  g.rect(mx + 2, my + 6, 5, 4, C.GLASS); g.rect(mx + 3, my + 7, 3, 3, C.WALL_D); g.px(mx + 2, my + 6, C.GLASS_L);
  g.vline(mx + 8, my + 7, 2, C.STEEL_D);
  g.hline(mx + 1, my + 10, 9, C.STEEL_D);
  g.rect(cl + 20, ct - 2, 2, 2, C.CREAM); g.px(cl + 22, ct - 2, C.CREAM);
  g.rect(cl + 24, ct - 2, 2, 2, C.RED_L); g.px(cl + 23, ct - 2, C.RED_L);
  g.rect(cl + 1, ct - 5, 4, 5, C.COPPER); g.hline(cl + 1, ct - 6, 4, C.STEEL_L); g.px(cl + 1, ct - 5, C.COPPER_L); g.vline(cl + 4, ct - 5, 5, C.COPPER_D);
}

function animLounge(fb, x, y, w, h, t, o) {
  const fy = y + h - FLOOR_T, scx = x + LOUNGE.sofaCx, cmx = x + 84;
  // clock: red second hand ticks, minute hand creeps
  const kx = scx + 11, ky = y + 21;
  hand(fb, kx, ky, TAU * 0.86, 2, C.INK);
  hand(fb, kx, ky, TAU * (0.2 + t / 3600), 3, C.INK);
  hand(fb, kx, ky, TAU * (Math.floor(t) % 60) / 60, 3, C.RED);
  fb.px(kx, ky, C.INK);
  // coffee machine: ready lamp and steam
  const my = fy - 26;
  fb.px(cmx - 3, my + 2, (t % 3) < 2.6 ? C.RED_L : C.RED_D);
  for (let i = 0; i < 4; i++) {
    const p = (((t * 0.5 + i * 0.25) % 1) + 1) % 1;
    const sx = cmx - 1 + Math.round(Math.sin(p * 5 + i * 1.9 + Math.floor(t * 0.5 + i * 0.25)) * 1.3);
    fb.px(sx, my - 1 - Math.round(p * 7), p < 0.3 ? C.WHITE : p < 0.65 ? C.STEEL_LL : C.TAN);
  }
}

// --- loading dock ----------------------------------------------------------------------

function buildDock(g, w, h, o) {
  const fy = h - FLOOR_T, x0 = WALL_T, x1 = w - WALL_T, iw = x1 - x0;
  const hc = DOCK.hatchCx, cc = DOCK.chuteCx, by = DOCK.beltY, lampX = 60;
  // block wall
  g.rect(x0, CEIL_T, iw, fy - CEIL_T, C.WALL_D);
  for (let yy = CEIL_T + 7, r = 0; yy < fy; yy += 8, r++) {
    g.hline(x0, yy, iw, C.ROCK);
    for (let px = x0 + (r & 1 ? 8 : 0); px < x1; px += 16) g.vline(px, yy - 7, 7, C.ROCK);
  }
  g.rect(hc - 5, CEIL_T + 4, 11, by - CEIL_T - 4, C.ROCK);          // drop channel under the hatch
  wash(g, lampX, 4, 38, 46, x0, CEIL_T, x1, fy);
  shell(g, w, h, C.STEEL_L, C.STEEL);
  for (let px = 11; px < w - 4; px += 16) g.px(px, fy + 1, C.STEEL_D);
  bulkheadLamp(g, lampX, CEIL_T);
  stencil(g, hc + 16, 6, o.label);

  // ceiling freight hatch with open leaves and guide rails down to the belt
  g.rect(hc - 7, 0, 15, CEIL_T + 2, C.INK);
  hazard(g, hc - 7, CEIL_T + 2, 15, 2);
  g.rect(hc - 9, CEIL_T, 2, 4, C.STEEL); g.vline(hc - 9, CEIL_T, 4, C.STEEL_L);
  g.rect(hc + 8, CEIL_T, 2, 4, C.STEEL); g.vline(hc + 9, CEIL_T, 4, C.STEEL_D);
  g.rect(hc - 11, CEIL_T + 2, 2, 9, C.STEEL_D); g.vline(hc - 11, CEIL_T + 2, 9, C.STEEL);
  g.rect(hc + 10, CEIL_T + 2, 2, 9, C.STEEL_D); g.vline(hc + 10, CEIL_T + 2, 9, C.STEEL);
  g.vline(hc - 6, CEIL_T + 4, by - CEIL_T - 4, C.STEEL_D); g.vline(hc + 6, CEIL_T + 4, by - CEIL_T - 4, C.STEEL_D);
  for (let yy = CEIL_T + 9; yy < by - 2; yy += 8) { g.px(hc - 6, yy, C.STEEL_L); g.px(hc + 6, yy, C.STEEL_L); }
  g.hline(hc + 13, CEIL_T, 3, C.STEEL_D); g.rect(hc + 13, CEIL_T + 1, 3, 2, C.AMBER_D);   // warning beacon

  // wall chute toward the machines, with its duct rising to the ceiling
  g.rect(cc - 4, CEIL_T, 9, by - 15 - CEIL_T, C.STEEL_D);
  g.vline(cc - 4, CEIL_T, by - 15 - CEIL_T, C.STEEL); g.vline(cc + 4, CEIL_T, by - 15 - CEIL_T, C.STEEL_DD);
  for (let yy = CEIL_T + 8; yy < by - 18; yy += 9) { g.hline(cc - 4, yy, 9, C.STEEL_DD); g.hline(cc - 4, yy - 1, 8, C.STEEL); }
  g.rect(cc - 2, by - 24, 5, 7, C.INK);                                                    // arrow lights panel
  g.rect(cc - 9, by - 15, 19, 15, C.STEEL_D);
  g.hline(cc - 9, by - 15, 19, C.STEEL_L); g.vline(cc - 9, by - 14, 14, C.STEEL);
  g.vline(cc + 9, by - 14, 14, C.STEEL_DD);
  g.rect(cc - 7, by - 13, 15, 13, C.INK);
  g.vline(cc - 7, by - 13, 13, C.STEEL_DD);
  for (let k = 0; k < 5; k++) g.vline(cc - 6 + k * 3, by - 13, k % 2 ? 4 : 5, C.STEEL_D);     // rubber strips
  hazard(g, cc - 9, by - 6, 2, 6); hazard(g, cc + 8, by - 6, 2, 6);

  // shelf of stacked crates between them
  const sl = 42, sy = by - 14;
  g.hline(sl, sy, 29, C.STEEL); g.hline(sl, sy + 1, 29, C.STEEL_DD);
  for (const bxp of [sl + 2, sl + 26]) { g.px(bxp, sy + 2, C.STEEL_D); g.px(bxp + 1, sy + 2, C.STEEL_D); g.px(bxp, sy + 3, C.STEEL_D); }
  crate(g, sl + 1, sy - 8, 8, 8, 0); crate(g, sl + 10, sy - 8, 9, 8, 1); crate(g, sl + 20, sy - 8, 8, 8, 3);
  crate(g, sl + 5, sy - 15, 8, 7, 2); crate(g, sl + 15, sy - 16, 8, 8, 0);

  // on the floor, low enough to sit under the belt
  g.blit(BARREL, 8, fy - 9); g.blit(BARREL, 15, fy - 9, { remap: { [C.TEAL_D]: C.RED_D, [C.TEAL]: C.RED } });
  crate(g, 44, fy - 9, 10, 9, 3); crate(g, 55, fy - 7, 8, 7, 0); crate(g, 64, fy - 6, 7, 6, 2);
  g.hline(86, fy - 1, 14, C.WOOD); g.px(87, fy - 1, C.ROCK_D); g.px(93, fy - 1, C.ROCK_D); g.px(98, fy - 1, C.ROCK_D);   // pallet
  crate(g, 87, fy - 8, 7, 7, 1); crate(g, 94, fy - 6, 6, 5, 2);
}

function animDock(fb, x, y, w, h, t, o) {
  const hc = x + DOCK.hatchCx, cc = x + DOCK.chuteCx, by = y + DOCK.beltY;
  // hatch beacon
  if (((t * 1.2) % 1 + 1) % 1 < 0.5) { fb.rect(hc + 13, y + CEIL_T + 1, 3, 2, C.AMBER_L); fb.px(hc + 14, y + CEIL_T + 1, C.CREAM); }
  // chute arrows chasing downward
  const step = ((Math.floor(t * 4) % 4) + 4) % 4;
  for (let k = 0; k < 3; k++) {
    const c = k === step ? C.GREEN_L : C.GREEN_DD, yy = by - 24 + k * 2;
    fb.px(cc - 1, yy, c); fb.px(cc, yy + 1, c); fb.px(cc + 1, yy, c);
  }
}

// --- power room ------------------------------------------------------------------------

const WARN_SIGN = sprite([
  '......k......',
  '.....kyk.....',
  '.....kyk.....',
  '....kyyyk....',
  '....kykyk....',
  '...kyykyyk...',
  '...kykkkyk...',
  '..kyyykyyyk..',
  '..kyykyyyyk..',
  '.kyyyyyyyyyk.',
  'kkkkkkkkkkkkk',
], { k: C.INK, y: C.HAZARD });

function buildPowerRoom(g, w, h, o) {
  const fy = h - FLOOR_T, x0 = WALL_T, x1 = w - WALL_T, iw = x1 - x0;
  const sbx = POWER.switchboardCx, gnx = POWER.generatorCx;
  const gapX = (sbx + (SWITCHBOARD_W >> 1) + gnx - (GENERATOR_W >> 1)) >> 1;
  const ty = 11;                                                   // cable tray
  g.rect(x0, CEIL_T, iw, fy - CEIL_T, C.STEEL_D);
  for (let yy = 22; yy < fy; yy += 13) g.hline(x0, yy, iw, C.STEEL_DD);
  for (let px = x0 + 20; px < x1; px += 27) g.vline(px, CEIL_T, fy - CEIL_T, C.STEEL_DD);
  wash(g, gapX, 20, 42, 40, x0, CEIL_T, x1, fy);
  shell(g, w, h, C.STEEL_L, C.STEEL);
  hazard(g, 0, fy + 1, w, 2);
  stencil(g, 5, 4, o.label, C.CREAM, C.STEEL_DD);

  // cable tray on hangers, with its cables
  for (const hx of [36, 60, 84]) g.vline(hx, CEIL_T, ty - CEIL_T, C.STEEL_DD);
  g.hline(x0, ty, iw, C.STEEL_L);
  g.hline(x0, ty + 1, iw, C.COPPER); g.hline(x0, ty + 2, iw, C.RED_D);
  g.hline(x0, ty + 3, iw, C.STEEL);
  for (let px = x0 + 2; px < x1; px += 5) g.vline(px, ty + 1, 2, C.STEEL_D);
  // drops: to the switchboard, to the generator, and conduits to the floor
  const sbTop = fy - SWITCHBOARD_H, gnTop = fy - GENERATOR_H;
  g.vline(sbx - 1, ty + 4, sbTop - ty - 4, C.STEEL_L); g.vline(sbx, ty + 4, sbTop - ty - 4, C.STEEL); g.vline(sbx + 1, ty + 4, sbTop - ty - 4, C.STEEL_DD);
  g.hline(sbx - 2, sbTop - 2, 5, C.STEEL_L);
  g.vline(gnx - 12, ty + 4, gnTop - ty - 4, C.STEEL); g.vline(gnx - 11, ty + 4, gnTop - ty - 4, C.STEEL_DD);
  g.vline(gnx + 15, ty + 4, gnTop - ty - 4, C.COPPER);
  for (let yy = ty + 7; yy < gnTop - 2; yy += 6) g.px(gnx + 15, yy, C.BRASS);
  for (const [cxp, a, b] of [[gapX - 3, C.STEEL_L, C.STEEL_D], [gapX + 1, C.STEEL, C.STEEL_DD], [5, C.STEEL_L, C.STEEL_D], [w - 6, C.STEEL, C.STEEL_DD]]) {
    g.vline(cxp, ty + 4, fy - ty - 4, a); g.vline(cxp + 1, ty + 4, fy - ty - 4, b);
    for (let yy = ty + 9; yy < fy - 3; yy += 12) g.hline(cxp - 1, yy, 4, C.STEEL_DD);
  }
  // junction box between the two units
  g.rect(gapX - 4, 36, 8, 8, C.STEEL); g.frame(gapX - 4, 36, 8, 8, C.INK);
  g.hline(gapX - 3, 37, 6, C.STEEL_L); g.px(gapX + 1, 41, C.STEEL_DD); g.px(gapX + 2, 41, C.STEEL_DD);
  // fuse box on the left wall
  g.rect(3, 26, 8, 10, C.STEEL); g.frame(3, 26, 8, 10, C.INK);
  g.hline(4, 27, 6, C.STEEL_L); g.vline(7, 29, 5, C.STEEL_D); g.px(9, 31, C.BRASS);
  // fire extinguisher on the right wall
  const ex = w - 9;
  g.hline(ex - 1, 43, 5, C.STEEL_DD);
  g.rect(ex, 46, 3, 8, C.RED); g.vline(ex, 46, 7, C.RED_L); g.vline(ex + 2, 47, 7, C.RED_D);
  g.px(ex + 1, 45, C.STEEL_L); g.px(ex + 1, 44, C.STEEL); g.px(ex + 2, 44, C.INK); g.px(ex + 3, 45, C.INK); g.px(ex + 3, 46, C.INK);
  g.hline(ex, 49, 3, C.CREAM);
  // warning signs above the generator bay
  g.blit(WARN_SIGN, gnx - 17, 17);
  g.rect(gnx - 1, 19, 25, 7, C.RED); g.frame(gnx - 1, 19, 25, 7, C.RED_D);
  drawText(g, gnx, 20, 'DANGER', C.CREAM);
}

function animPowerRoom(fb, x, y, w, h, t, o) {
  const sbx = POWER.switchboardCx, gnx = POWER.generatorCx;
  const gapX = x + ((sbx + (SWITCHBOARD_W >> 1) + gnx - (GENERATOR_W >> 1)) >> 1);
  // bare bulb swaying a little on its cord
  const sway = Math.round(Math.sin(t * 1.3) * 0.9);
  fb.vline(gapX, y + CEIL_T, 9, C.INK);
  fb.line(gapX, y + CEIL_T + 9, gapX + sway, y + 17, C.INK);
  fb.rect(gapX + sway - 1, y + 18, 3, 3, C.CREAM);
  fb.px(gapX + sway, y + 17, C.STEEL_L);
  fb.px(gapX + sway - 1, y + 20, C.AMBER_L); fb.px(gapX + sway + 1, y + 20, C.AMBER_L);
  fb.px(gapX + sway, y + 21, C.AMBER);
  // indicator LEDs
  fb.px(gapX - 2, y + 39, (Math.floor(t * 1.5) & 1) ? C.GREEN_L : C.GREEN_D);
  fb.px(x + 5, y + 30, C.GREEN_L);
  fb.px(x + 5, y + 32, hash(Math.floor(t * 3), 731) < 0.3 ? C.AMBER_L : C.AMBER_D);
}

// --- reactor hall ----------------------------------------------------------------------

const TROLLEY_DX = 58;   // crane trolley, left of the core

function reactorLayout(w) {
  const cx = w >> 1, pil = [], lamps = [];
  for (let d = 40; cx + d + 4 <= w - WALL_T - 8; d += 72) { pil.push(cx - d, cx + d); }
  for (let d = 76; cx + d + 30 <= w - WALL_T; d += 72) { lamps.push(cx - d, cx + d); }
  return { cx, pil, lamps, trolley: cx - TROLLEY_DX };
}

function buildReactorHall(g, w, h, o) {
  const fy = h - FLOOR_T, x0 = WALL_T, x1 = w - WALL_T, iw = x1 - x0;
  const { cx, pil, lamps, trolley } = reactorLayout(w);
  const railY = 6, band = fy - 18;
  // board-formed concrete
  g.rect(x0, CEIL_T, iw, fy - CEIL_T, C.STEEL_D);
  for (let yy = 23; yy < band; yy += 12) g.hline(x0, yy, iw, C.STEEL_DD);
  for (let px = cx - 36 - 36; px > x0 + 6; px -= 36) g.vline(px, railY + 4, band - railY - 4, C.STEEL_DD);
  for (let px = cx + 36 + 36; px < x1 - 6; px += 36) g.vline(px, railY + 4, band - railY - 4, C.STEEL_DD);
  for (let px = x0 + 9; px < x1 - 4; px += 18) for (let yy = 17; yy < band - 4; yy += 12) {
    if (Math.abs(px - cx) > 38) { g.px(px, yy, C.STEEL_DD); g.px(px + 1, yy + 1, C.STEEL); }
  }
  g.rect(x0, band, iw, fy - band, C.STEEL_DD);                           // painted lower band
  g.hline(x0, band, iw, C.AMBER_D);
  g.rect(x0, CEIL_T, iw, railY + 4 - CEIL_T, C.STEEL_DD);                // gloom above the crane rail
  g.rect(cx - 34, railY + 4, 68, fy - railY - 4, C.STEEL_DD);            // recessed bay for the core
  g.vline(cx - 35, railY + 4, fy - railY - 4, C.INK); g.vline(cx + 34, railY + 4, fy - railY - 4, C.STEEL);
  for (const lx of lamps) wash(g, lx, railY + 7, 34, 54, x0, railY + 4, x1, fy);
  shell(g, w, h, C.STEEL_L, C.STEEL);
  // floor: grating over a hazard-striped kerb
  for (let px = 0; px < w; px++) {
    g.px(px, fy, px % 3 === 2 ? C.STEEL_D : C.STEEL_L);
    g.px(px, fy + 1, ((px >> 2) & 1) ? C.HAZARD : C.INK);
  }
  // wall-mounted pipe brackets
  for (const yy of [31, 49]) for (let px = x0 + 14; px < x1 - 8; px += 24) {
    if (Math.abs(px - cx) < 46 || pil.some((p) => Math.abs(p - px) < 8)) continue;
    g.hline(px - 1, yy, 3, C.STEEL); g.px(px - 1, yy, C.STEEL_L); g.px(px, yy + 1, C.INK); g.px(px + 1, yy + 1, C.INK);
  }
  // pilasters with corbels under the rail and hazard-banded feet
  for (const p of pil) {
    g.vline(p + 4, railY + 5, fy - railY - 5, C.INK);
    g.rect(p - 3, railY + 4, 7, fy - railY - 4, C.STEEL);
    g.vline(p - 3, railY + 4, fy - railY - 4, C.STEEL_L); g.vline(p + 3, railY + 4, fy - railY - 4, C.STEEL_D);
    g.rect(p - 4, railY + 4, 9, 2, C.STEEL); g.hline(p - 4, railY + 4, 9, C.STEEL_L); g.px(p + 4, railY + 5, C.STEEL_D);
    hazard(g, p - 3, fy - 8, 7, 8);
    g.hline(p - 3, fy - 9, 7, C.INK);
  }
  // crane rail (I-beam) on hangers
  for (let px = x0 + 10; px < x1 - 4; px += 36) { g.vline(px, CEIL_T, railY - CEIL_T, C.STEEL_D); g.vline(px + 1, CEIL_T, railY - CEIL_T, C.INK); }
  g.hline(x0, railY, iw, C.STEEL_L);
  g.hline(x0, railY + 1, iw, C.STEEL);
  g.hline(x0, railY + 2, iw, C.STEEL_D);
  g.hline(x0, railY + 3, iw, C.INK);
  for (let px = x0 + 4; px < x1; px += 8) { g.px(px, railY + 1, C.STEEL_LL); g.px(px + 4, railY + 2, C.STEEL_DD); }
  hazard(g, x0, railY, 3, 3, C.HAZARD, C.INK); hazard(g, x1 - 3, railY, 3, 3, C.HAZARD, C.INK);
  // floodlights slung under the rail
  for (const lx of lamps) {
    g.rect(lx - 3, railY + 4, 7, 2, C.STEEL_D); g.hline(lx - 3, railY + 4, 7, C.STEEL);
    g.hline(lx - 2, railY + 6, 5, C.CREAM); g.px(lx - 2, railY + 6, C.AMBER_L); g.px(lx + 2, railY + 6, C.AMBER_L);
  }
  // crane trolley and hoist (chain and hook are animated)
  const tx = trolley;
  g.rect(tx - 7, railY - 3, 14, 3, C.AMBER); g.hline(tx - 7, railY - 3, 14, C.AMBER_L); g.hline(tx - 6, railY - 1, 13, C.AMBER_D);
  g.px(tx - 5, railY, C.INK); g.px(tx + 4, railY, C.INK);
  g.rect(tx - 6, railY + 1, 2, 4, C.AMBER_D); g.rect(tx + 4, railY + 1, 2, 4, C.AMBER_D);
  g.rect(tx - 3, railY + 4, 6, 3, C.STEEL); g.hline(tx - 3, railY + 4, 6, C.STEEL_L); g.hline(tx - 2, railY + 7, 4, C.INK);
  // access ladder on the right wall
  const lx0 = w - 13;
  g.vline(lx0, railY + 5, fy - railY - 5, C.STEEL); g.vline(lx0 + 4, railY + 5, fy - railY - 5, C.STEEL_DD);
  for (let yy = railY + 7; yy < fy; yy += 3) g.hline(lx0 + 1, yy, 3, C.STEEL_D);
  stencil(g, 6, railY + 7, o.label, C.CREAM, C.INK);
}

function animReactorHall(fb, x, y, w, h, t, o) {
  const tx = x + (w >> 1) - TROLLEY_DX, railY = y + 6;
  const sway = Math.round(Math.sin(t * 1.1) * 1.2);
  for (let k = 0; k < 9; k++) fb.px(tx + (k > 5 ? sway : 0), railY + 8 + k, k & 1 ? C.STEEL_D : C.STEEL_L);
  const hx = tx + sway, hy = railY + 17;
  fb.rect(hx - 1, hy, 3, 2, C.AMBER); fb.px(hx - 1, hy, C.AMBER_L);
  fb.px(hx, hy + 2, C.STEEL_LL); fb.px(hx, hy + 3, C.STEEL_LL); fb.px(hx - 1, hy + 4, C.STEEL_L); fb.px(hx - 2, hy + 3, C.STEEL_L);
  // trolley beacon
  fb.px(tx, railY - 4, (Math.floor(t * 2) & 1) ? C.AMBER_L : C.AMBER_D);
}

// --- room cache and entry point -------------------------------------------------------

const BUILDERS = {
  machine: buildMachineRoom, control: buildControlRoom, lounge: buildLounge,
  dock: buildDock, power: buildPowerRoom, reactor: buildReactorHall,
};
const ANIMATORS = {
  machine: animMachineRoom, control: animControlRoom, lounge: animLounge,
  dock: animDock, power: animPowerRoom, reactor: animReactorHall,
};
const PASSAGE = { machine: C.WALL_D, control: C.WALL_D, lounge: C.WALL, dock: C.ROCK, power: C.STEEL_DD, reactor: C.STEEL_DD };

const roomCache = new Map();

function roomLayer(w, h, kind, opts) {
  const label = String(opts.label ?? kind);
  const seed = (opts.seed ?? 0) | 0;
  const key = `${kind}|${w}|${h}|${opts.accent}|${opts.doorL ? 1 : 0}${opts.doorR ? 1 : 0}|${label}|${seed}`;
  return cached(roomCache, key, 64, () => {
    const g = new Framebuffer(w, h);
    const o = { accent: opts.accent, doorL: !!opts.doorL, doorR: !!opts.doorR, label, seed, vseed: (seed * 131 + strHash(label)) | 0 };
    const build = BUILDERS[kind];
    if (build) build(g, w, h, o);
    else {
      // unknown kind: a plain lit room, so the world never crashes on a new room type
      const fy = h - FLOOR_T;
      g.rect(WALL_T, CEIL_T, w - 2 * WALL_T, fy - CEIL_T, C.WALL);
      g.rect(WALL_T, fy - 15, w - 2 * WALL_T, 15, C.WALL_D);
      wash(g, w >> 1, 6, 34, 46, WALL_T, CEIL_T, w - WALL_T, fy);
      shell(g, w, h, C.STEEL_L, C.STEEL);
      pendantLamp(g, w >> 1, CEIL_T);
      stencil(g, 5, 5, label);
    }
    if (o.doorL) doorway(g, w, h, true, PASSAGE[kind] ?? C.WALL_D);
    if (o.doorR) doorway(g, w, h, false, PASSAGE[kind] ?? C.WALL_D);
    return g;
  });
}

/**
 * A room: side walls, ceiling, floor slab, back wall and all fixed furniture and
 * decoration for its kind, plus small ambient animation (blinking console lamps,
 * coffee steam, swaying lamp). Does NOT draw machines, reactor, switchboard,
 * generator, residents, belts, items or effects: the world layers those on top.
 *
 * @param {'control'|'lounge'|'dock'|'power'|'machine'|'reactor'} kind
 *   control  foreman console with green monitors at CONTROL.consoleCx, wall map/status board
 *   lounge   sofa at LOUNGE.sofaCx, coffee machine, plant, poster, wall clock
 *   dock     ceiling freight hatch at DOCK.hatchCx, stacked crates, wall chute at DOCK.chuteCx
 *   power    bare utility room: cable trays, conduit to the floor, hazard stripes (switchboard
 *            and generator are drawn by the world at POWER.switchboardCx / POWER.generatorCx)
 *   machine  factory bay: back wall panels, an accent stripe in opts.accent, wall hatches on
 *            both side walls where the belts enter at BELT_Y, floor markings for workstation cells
 *   reactor  tall hall (h = REACTOR_H): heavy concrete, gantry, floor grating, hazard edging
 * @param {{accent?:number, doorL?:boolean, doorR?:boolean, label?:string, seed?:number}} opts
 *   doorL/doorR: cut a doorway (DOOR_H tall, from the floor) through that side wall.
 *   label: short room name stencilled on the back wall (e.g. 'FABLE', 'CONTROL').
 */
export function drawRoom(fb, x, y, w, h, kind, t, opts = {}) {
  x |= 0; y |= 0; w |= 0; h |= 0;
  if (w <= 0 || h <= 0) return;
  opts = opts || {};
  const layer = roomLayer(w, h, kind, opts);
  paste(fb, layer, x, y);
  const anim = ANIMATORS[kind];
  if (anim) {
    // ambient animation never leaves the room rectangle
    const cx0 = fb.cx0, cy0 = fb.cy0, cx1 = fb.cx1, cy1 = fb.cy1;
    fb.cx0 = Math.max(cx0, x); fb.cy0 = Math.max(cy0, y); fb.cx1 = Math.min(cx1, x + w); fb.cy1 = Math.min(cy1, y + h);
    if (fb.cx1 > fb.cx0 && fb.cy1 > fb.cy0) anim(fb, x, y, w, h, t || 0, opts);
    fb.cx0 = cx0; fb.cy0 = cy0; fb.cx1 = cx1; fb.cy1 = cy1;
  }
}

// ---------------------------------------------------------------------------
// Elevator
// ---------------------------------------------------------------------------

const shaftCache = new Map();

function buildShaft(w, h) {
  const g = new Framebuffer(w, h);
  g.rect(0, 0, w, h, C.STEEL_DD);
  const inset = Math.max(0, ((w - CAR_W) >> 1) - 3);
  const lx = inset, rx = w - inset - 2;          // rail columns (2px each)
  // recessed back between the rails
  g.rect(lx + 2, 0, rx - lx - 2, h, C.INK);
  for (let y = 0; y < h; y++) for (let x = lx + 2; x < rx; x++) {
    if (hash(x, y, 601) < 0.05) g.px(x, y, C.STEEL_DD);
  }
  // cross-braces every 16 rows, anchored to the top of the segment
  const bx0 = lx + 2, bx1 = rx - 1;
  for (let y = 0; y < h; y += 16) {
    g.line(bx0, y + 1, bx1, y + 15, C.STEEL_DD);
    g.line(bx1, y + 1, bx0, y + 15, C.STEEL_DD);
    g.hline(bx0, y, bx1 - bx0 + 1, C.STEEL_D);
    g.px(bx0, y, C.STEEL); g.px(bx1, y, C.STEEL);
    g.px((bx0 + bx1) >> 1, y + 8, C.STEEL_D);
  }
  // hoist cables
  const cx = w >> 1;
  for (let y = 0; y < h; y++) {
    g.px(cx - 2, y, y % 3 === 0 ? C.STEEL : C.STEEL_D);
    g.px(cx + 1, y, y % 3 === 1 ? C.STEEL : C.STEEL_D);
  }
  // guide rails with brackets
  g.vline(lx, 0, h, C.STEEL); g.vline(lx + 1, 0, h, C.STEEL_D);
  g.vline(rx, 0, h, C.STEEL); g.vline(rx + 1, 0, h, C.STEEL_D);
  for (let y = 7; y < h; y += 16) { g.px(lx, y, C.STEEL_L); g.px(rx, y, C.STEEL_L); g.px(lx + 1, y + 1, C.INK); g.px(rx + 1, y + 1, C.INK); }
  // sill ledge at the foot of the segment
  if (h > FLOOR_T + 8) {
    const sy = h - FLOOR_T;
    g.rect(0, sy, w, FLOOR_T, C.STEEL_D);
    g.hline(0, sy, w, C.STEEL);
    g.hline(0, sy + FLOOR_T - 1, w, C.INK);
    g.rect(cx - 3, sy, 6, FLOOR_T - 1, C.INK);
    g.px(cx - 2, sy + 1, C.STEEL_D); g.px(cx + 1, sy + 2, C.STEEL_D);
    for (let x = 1; x < w; x += 4) if (x < cx - 4 || x > cx + 3) g.px(x, sy + 1, C.STEEL_DD);
  }
  return g;
}

/**
 * Elevator shaft interior: dark back, guide rails, cross-braces, cables. One sill ledge is
 * drawn across the bottom FLOOR_T rows of the rectangle (a segment cannot know where other
 * floors are): call it once per floor to get a sill at every level.
 */
export function drawShaft(fb, x, y, w, h, t) {
  x |= 0; y |= 0; w |= 0; h |= 0;
  if (w <= 0 || h <= 0) return;
  const g = cached(shaftCache, `${w}|${h}`, 24, () => buildShaft(w, h));
  paste(fb, g, x, y);
  // position lamps on the left rail, chasing slowly upward
  const inset = Math.max(0, ((w - CAR_W) >> 1) - 3);
  const step = Math.floor((t || 0) * 2);
  for (let ly = 15, k = 0; ly < h - FLOOR_T; ly += 16, k++) {
    const on = (((k + step) % 4) + 4) % 4 === 0;
    fb.px(x + inset + 2, y + ly, on ? C.AMBER_L : C.AMBER_D);
  }
}

/**
 * Elevator car, CAR_W x CAR_H, anchored bottom-centre at (cx, floorY).
 * @param {{door:number}} car  door: 0 closed .. 1 fully open (sliding doors)
 * Residents inside are drawn by the world between drawElevatorCar and drawElevatorDoors.
 * The car's floor plate is the two rows just below floorY (level with a room's floor
 * surface), so a rider's feet rest on it exactly as they do on a room floor.
 */
export function drawElevatorCar(fb, cx, floorY, t, car) {
  const x = Math.round(cx - CAR_W / 2), y = Math.round(floorY - CAR_H);
  const W = CAR_W, H = CAR_H;
  // crosshead and cable hitch
  fb.hline(x + 7, y, 6, C.STEEL_D);
  fb.hline(x + 9, y, 2, C.STEEL_L);
  fb.hline(x + 1, y + 1, W - 2, C.STEEL_L);
  fb.hline(x, y + 2, W, C.STEEL);
  fb.hline(x, y + 3, W, C.STEEL_D);
  fb.px(x, y + 2, C.INK); fb.px(x + W - 1, y + 2, C.INK);
  fb.px(x, y + 3, C.INK); fb.px(x + W - 1, y + 3, C.INK);
  // side posts
  fb.vline(x, y + 4, H - 4, C.INK); fb.vline(x + 1, y + 4, H - 4, C.STEEL);
  fb.vline(x + W - 2, y + 4, H - 4, C.STEEL_D); fb.vline(x + W - 1, y + 4, H - 4, C.INK);
  // lit interior
  const ix = x + 2, iw = W - 4;
  fb.rect(ix, y + 4, iw, H - 4, C.TAN);
  fb.hline(ix, y + 4, iw, C.CREAM);
  fb.px(ix, y + 4, C.AMBER_L); fb.px(ix + iw - 1, y + 4, C.AMBER_L);
  fb.dither(ix, y + 5, iw, 2, C.CREAM, (ix + y) & 1);
  fb.rect(ix, y + 17, iw, H - 17, C.SAND);
  fb.hline(ix, y + 16, iw, C.LEATHER);                   // handrail
  fb.hline(ix, y + 17, iw, C.WALL_L);
  fb.vline(ix + (iw >> 1), y + 18, H - 18, C.WALL_L);    // panel seam
  fb.vline(ix, y + 6, H - 6, C.SAND); fb.vline(ix + iw - 1, y + 6, H - 6, C.WALL_L);
  // call lamp on the crosshead
  const moving = car && car.door > 0.02;
  fb.hline(x + 9, y + 2, 2, moving ? C.GREEN_L : (Math.floor((t || 0) * 3) & 1) ? C.AMBER_L : C.AMBER);
  // floor plate
  fb.hline(x, floorY | 0, W, C.STEEL_L);
  fb.hline(x, (floorY | 0) + 1, W, C.STEEL_DD);
  fb.px(x, floorY | 0, C.STEEL); fb.px(x + W - 1, floorY | 0, C.STEEL);
}

/** The car's sliding doors, drawn over any residents inside. door: 0 closed .. 1 open. */
export function drawElevatorDoors(fb, cx, floorY, t, car) {
  const x = Math.round(cx - CAR_W / 2), y = Math.round(floorY - CAR_H);
  const door = Math.max(0, Math.min(1, (car && car.door) || 0));
  const full = (CAR_W - 4) >> 1;
  const half = Math.round(full * (1 - door));
  if (half <= 0) return;
  const top = y + 5, hh = CAR_H - 5;
  for (const side of [0, 1]) {
    const lx = side === 0 ? x + 2 : x + CAR_W - 2 - half;       // leaf's left column
    fb.rect(lx, top, half, hh, C.STEEL_L);
    fb.hline(lx, top, half, C.STEEL_LL);
    fb.hline(lx, top + hh - 3, half, C.STEEL);                   // kick plate line
    fb.hline(lx, top + hh - 1, half, C.STEEL);
    // meeting edge
    const inner = side === 0 ? lx + half - 1 : lx;
    fb.vline(inner, top, hh, side === 0 ? C.STEEL : C.STEEL_LL);
    // window, fixed to the leaf near its meeting edge
    if (half >= 5) {
      const wx = side === 0 ? inner - 3 : inner + 2;
      fb.rect(wx, top + 3, 2, 6, C.GLASS);
      fb.px(wx, top + 3, C.GLASS_L); fb.px(wx, top + 4, C.GLASS_L);
      fb.frame(wx - 1, top + 2, 4, 8, C.STEEL);
    }
  }
  if (door < 0.02) fb.vline(x + (CAR_W >> 1) - 1, top, hh, C.STEEL_D);
}

// ---------------------------------------------------------------------------
// Belts, pipes, cables
// ---------------------------------------------------------------------------

/**
 * Conveyor belt segment along the back wall. (x, y) is the left end of the belt's top
 * surface; the belt is 3px thick with rollers and brackets below it (6 rows in all).
 * @param {number} phase accumulated movement in pixels (tread marks slide by it); positive = rightward
 */
export function drawBelt(fb, x, y, len, phase) {
  x |= 0; y |= 0; len |= 0;
  if (len <= 0) return;
  const p = Math.floor(phase || 0);
  fb.hline(x, y, len, C.STEEL_D);
  fb.hline(x, y + 1, len, C.STEEL_DD);
  fb.hline(x, y + 2, len, C.INK);
  for (let i = (((p % 4) + 4) % 4); i < len; i += 4) fb.px(x + i, y, C.STEEL_L);
  for (let i = ((((-p) % 6) + 6) % 6); i < len; i += 6) fb.px(x + i, y + 2, C.STEEL_D);
  // rollers under the belt; their highlight flips as the belt advances
  const spin = (p >> 1) & 1;
  for (let i = 3; i + 2 <= len - 2; i += 6) {
    fb.rect(x + i, y + 3, 2, 2, C.STEEL);
    fb.px(x + i + spin, y + 3, C.STEEL_L);
    fb.px(x + i + 1 - spin, y + 4, C.STEEL_D);
  }
  // wall brackets
  for (let i = 9; i + 2 <= len - 6; i += 24) {
    fb.vline(x + i - 1, y + 3, 3, C.INK);
    fb.hline(x + i - 2, y + 5, 3, C.STEEL_D);
    fb.px(x + i - 2, y + 3, C.STEEL_DD);
  }
  // end drums
  fb.px(x, y, C.STEEL); fb.px(x, y + 1, C.STEEL_D);
  fb.px(x + len - 1, y, C.STEEL); fb.px(x + len - 1, y + 1, C.STEEL_D);
}

const STEEL_FL = [C.STEEL_LL, C.STEEL_L, C.STEEL, C.STEEL_D];
const PIPES = {
  cache: { hi: C.GLASS, mid: C.TEAL_D, lo: C.GLASS, glint: C.GLASS_L, fl: STEEL_FL },
  coolant: { hi: C.BLUE_L, mid: C.BLUE, lo: C.BLUE_D, glint: C.SKY, fl: STEEL_FL },
  steam: { hi: C.COPPER_L, mid: C.COPPER, lo: C.COPPER_D, glint: C.CREAM, fl: [C.CREAM, C.BRASS, C.AMBER_D, C.WALL_D] },
};

/**
 * Pipe along a polyline of axis-aligned points [[x,y], ...], 3px thick (centred on the
 * points) with flanges at corners. kind: 'cache' (teal glass recycling pipe), 'coolant'
 * (blue), 'steam' (copper).
 */
export function drawPipe(fb, points, kind = 'cache') {
  if (!points || points.length === 0) return;
  const p = PIPES[kind] ?? PIPES.cache;
  const n = points.length;
  for (let i = 0; i + 1 < n; i++) {
    const ax = points[i][0] | 0, ay = points[i][1] | 0, bx = points[i + 1][0] | 0, by = points[i + 1][1] | 0;
    if (ay === by) {
      const xa = Math.min(ax, bx), len = Math.abs(bx - ax) + 1;
      fb.hline(xa, ay - 1, len, p.hi); fb.hline(xa, ay, len, p.mid); fb.hline(xa, ay + 1, len, p.lo);
      for (let k = 5; k < len - 3; k += 9) fb.px(xa + k, ay - 1, p.glint);
      for (let k = 16; k < len - 8; k += 24) { fb.vline(xa + k, ay - 1, 3, p.fl[2]); fb.px(xa + k, ay - 1, p.fl[1]); }
    } else if (ax === bx) {
      const ya = Math.min(ay, by), len = Math.abs(by - ay) + 1;
      fb.vline(ax - 1, ya, len, p.hi); fb.vline(ax, ya, len, p.mid); fb.vline(ax + 1, ya, len, p.lo);
      for (let k = 4; k < len - 3; k += 9) fb.px(ax - 1, ya + k, p.glint);
      for (let k = 16; k < len - 8; k += 24) { fb.hline(ax - 1, ya + k, 3, p.fl[2]); fb.px(ax - 1, ya + k, p.fl[1]); }
    } else {
      fb.line(ax, ay, bx, by, p.mid);
    }
  }
  // elbow flanges at the corners
  for (let i = 1; i + 1 < n; i++) {
    const cx = points[i][0] | 0, cy = points[i][1] | 0;
    fb.rect(cx - 1, cy - 2, 3, 5, p.fl[3]); fb.rect(cx - 2, cy - 1, 5, 3, p.fl[3]);
    fb.rect(cx - 1, cy - 1, 3, 3, p.fl[2]);
    fb.px(cx - 1, cy - 1, p.fl[0]); fb.px(cx, cy - 1, p.fl[1]); fb.px(cx - 1, cy, p.fl[1]);
    fb.px(cx + 1, cy + 1, p.fl[3]);
  }
  // end collars, across the pipe
  for (const [i, j] of n > 1 ? [[0, 1], [n - 1, n - 2]] : []) {
    const ex = points[i][0] | 0, ey = points[i][1] | 0;
    if ((points[j][1] | 0) === ey) { fb.vline(ex, ey - 2, 5, p.fl[2]); fb.px(ex, ey - 2, p.fl[0]); fb.px(ex, ey + 2, p.fl[3]); }
    else { fb.hline(ex - 2, ey, 5, p.fl[2]); fb.px(ex - 2, ey, p.fl[0]); fb.px(ex + 2, ey, p.fl[3]); }
  }
}

/**
 * Power cable along a polyline of axis-aligned points, 1px with occasional clips.
 * @param {boolean} live  false draws it dead / dark (unpowered section)
 */
export function drawCable(fb, points, live = true) {
  if (!points || points.length === 0) return;
  const c = live ? C.AMBER_D : C.STEEL_D, clip = live ? C.BRASS : C.STEEL, joint = live ? C.COPPER_L : C.STEEL;
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    let x = points[i][0] | 0, y = points[i][1] | 0;
    const bx = points[i + 1][0] | 0, by = points[i + 1][1] | 0;
    if (x !== bx && y !== by) { fb.line(x, y, bx, by, c); continue; }
    const sx = Math.sign(bx - x), sy = Math.sign(by - y);
    const len = Math.abs(bx - x) + Math.abs(by - y);
    for (let k = 0; k < len; k++, run++) {
      fb.px(x, y, run % 12 === 6 ? clip : c);
      x += sx; y += sy;
    }
    fb.px(bx, by, i + 2 < points.length ? joint : c);
  }
}
