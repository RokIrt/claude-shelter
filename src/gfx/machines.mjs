// Model machines: five designs drawn by code into the indexed framebuffer.
//
// How it is put together: every design has a static body that is painted once at module
// load into an offscreen 88x48 sprite, with all lamps and screens baked in their OFF
// state. Each frame the body is blitted and the moving / glowing parts are drawn over it.
// Work motion reads only m.phase, blinking and breathing read only t, and an unpowered
// machine reads neither t nor heat, so it is perfectly still and has no lit pixel.
// The burnt (fire) look is the same picture passed through a scorch table and a soot mask.
import { C, BASE_HEX } from './palette.mjs';
import { drawText } from './font.mjs';
import { Framebuffer, sprite, hash } from './fb.mjs';
import { MACHINE_W, MACHINE_H } from './geom.mjs';

/**
 * @typedef {Object} MachineLook
 * @property {number} heat     0..1. 0 = cool; >= 0.6 visibly hot (warning lamps blink, fans
 *                             race, vents glow); 1 = at the limit.
 * @property {'idle'|'running'|'hot'|'fire'|'pitstop'|'emergency'} status
 *   idle      powered, nothing to do: slow breathing lights only
 *   running   normal operation
 *   hot       approaching its limit: still running, warning lamps, heat shimmer
 *   fire      limit reached: machine stopped and scorched (the world adds flames/sparks)
 *   pitstop   session power tripped: unpowered, screens off
 *   emergency shelter on emergency power: unpowered
 * @property {boolean} powered true when status is idle | running | hot
 * @property {number} phase    accumulated animation phase in cycles (the world integrates
 *                             throughput into it). Drive all work motion (pistons, reels,
 *                             conveyors, arms, cards) from phase, never from t * speed.
 * @property {number} speed    0..1 current work rate (for things like fan blur or glow strength)
 * @property {{accent:number, accent2:number, variant:number}} [style]  only for 'generic':
 *                             palette indices and a shape variant 0..3
 */

/**
 * Where the world attaches effects, relative to (cx, floorY). One entry per design.
 * fire: flame base; smoke: where smoke rises from; sparks: electrical arc points;
 * lamp: warning beacon position (centre of the 7x6 beacon; each machine has a mount there).
 */
export const MACHINE_ANCHORS = {
  fable:   { fire: [0, -23], smoke: [0, -44], sparks: [[-37, -30], [30, -9]], lamp: [-34, -40] },
  opus:    { fire: [0, -24], smoke: [0, -46], sparks: [[-30, -24], [27, -12]], lamp: [-20, -46] },
  sonnet:  { fire: [0, -26], smoke: [0, -44], sparks: [[-12, -36], [22, -13]], lamp: [-39, -45] },
  haiku:   { fire: [0, -28], smoke: [0, -38], sparks: [[-27, -24], [19, -12]], lamp: [20, -34] },
  generic: { fire: [0, -22], smoke: [0, -40], sparks: [[-27, -24], [24, -10]], lamp: [-26, -36] },
};

// =====================================================================================
// Shared kit
// =====================================================================================

const W = MACHINE_W, H = MACHINE_H;
const INK = C.INK;
const TAU = Math.PI * 2;
const FLIPX = { flipX: true };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v) => v - Math.floor(v);
/** 0..1..0 triangle wave with period 1. */
const tri = (v) => { const f = fract(v); return f < 0.5 ? f * 2 : 2 - f * 2; };
const smooth = (v) => v * v * (3 - 2 * v);

/** Outlined panel: INK border, mid fill, optional top/left highlight and bottom/right shade. */
function box(g, x, y, w, h, mid, hi, sh) {
  g.rect(x, y, w, h, INK);
  g.rect(x + 1, y + 1, w - 2, h - 2, mid);
  if (sh !== undefined) { g.hline(x + 1, y + h - 2, w - 2, sh); g.vline(x + w - 2, y + 1, h - 2, sh); }
  if (hi !== undefined) { g.hline(x + 1, y + 1, w - 2, hi); g.vline(x + 1, y + 1, h - 2, hi); }
}

/** rect mirrored about the machine's vertical centre line when left is false. */
function mrect(g, left, x, y, w, h, c) { g.rect(left ? x : W - x - w, y, w, h, c); }

/** Diagonal two-colour warning tape. */
function hazardStrip(g, x, y, w, h, a, b, shift = 0) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) g.px(x + i, y + j, ((i + j + shift) >> 1) & 1 ? a : b);
}

/** Belt hatch on a box edge: opaque dark mouth at y 14..21, lintel at 13, sill at 22. */
function hatch(g, left, hi, mid) {
  mrect(g, left, 0, 12, 10, 12, INK);
  mrect(g, left, 0, 13, 8, 1, hi);
  mrect(g, left, 0, 14, 8, 8, C.STEEL_DD);
  for (let i = 0; i < 4; i++) mrect(g, left, 1 + i * 2, 15, 1, 7, INK);
  mrect(g, left, 0, 22, 8, 1, mid);
  mrect(g, left, 8, 13, 1, 10, mid);
  mrect(g, left, 8, 13, 1, 1, hi);
}

/** Pipe flange collar on a box edge at y 6..9 (the cache loop bolts on here). */
function flange(g, left) {
  mrect(g, left, 0, 5, 3, 6, INK);
  mrect(g, left, 0, 6, 2, 1, C.STEEL_LL);
  mrect(g, left, 0, 7, 2, 2, C.STEEL_L);
  mrect(g, left, 0, 9, 2, 1, C.STEEL);
}

// --- cooling fan: 9x9 housing, 7x7 two-blade rotor in four poses -----------------------
const FAN_KEY = { b: C.STEEL_L, h: C.WHITE };
const FAN_H = sprite(['.......', '.b...b.', 'bb...bb', 'bbbhbbb', 'bb...bb', '.b...b.', '.......'], FAN_KEY);
const FAN_V = sprite(['..bbb..', '.bbbbb.', '...b...', '...h...', '...b...', '.bbbbb.', '..bbb..'], FAN_KEY);
const FAN_D = sprite(['..bb...', '.bbb...', 'bbbb...', '..bhb..', '...bbbb', '...bbb.', '...bb..'], FAN_KEY);
const FAN_STILL = { [C.WHITE]: C.STEEL_LL };

function fanHousing(g, x, y) {
  g.disc(x + 4, y + 4, 4, INK);
  g.disc(x + 4, y + 4, 3, C.STEEL_DD);
}

// Fan frames per second for heat tiers 0..3. Constants, so a tier change never scrambles the pose.
const FAN_RATE = [10, 16, 22, 30];

function fan(fb, x, y, S) {
  const f = (S.run ? Math.floor(S.t * FAN_RATE[S.tier]) : Math.floor(S.phase * 8)) & 3;
  if (S.run && S.tier >= 2) fb.dither(x + 2, y + 2, 5, 5, C.STEEL, f & 1);
  fb.blit(f === 0 ? FAN_H : f === 2 ? FAN_V : FAN_D, x + 1, y + 1, f === 3 ? (S.lit ? FLIPX : FAN_FLIP_STILL) : (S.lit ? undefined : FAN_STILL_OPT));
}
const FAN_STILL_OPT = { remap: FAN_STILL };
const FAN_FLIP_STILL = { flipX: true, remap: FAN_STILL };

// --- temperature gauge: 9x9 dial, needle sweeps left (cool) to right (red) -------------
function gaugeFace(g, x, y) {
  g.disc(x + 4, y + 4, 4, INK);
  g.disc(x + 4, y + 4, 3, C.CREAM);
  g.px(x + 1, y + 3, C.GREEN); g.px(x + 2, y + 2, C.GREEN); g.px(x + 3, y + 1, C.GREEN);
  g.px(x + 4, y + 1, C.AMBER);
  g.px(x + 5, y + 1, C.RED); g.px(x + 6, y + 2, C.RED); g.px(x + 7, y + 3, C.RED);
  g.hline(x + 2, y + 6, 5, C.TAN); g.hline(x + 3, y + 7, 3, C.TAN);
}

function gauge(fb, x, y, S) {
  let v = S.gauge;
  if (S.tier > 0) v += (hash(Math.floor(S.t * 9), 3) - 0.5) * 0.12;      // nervous needle
  const a = Math.PI * (0.9 - 0.8 * clamp01(v));
  fb.line(x + 4, y + 5, x + 4 + Math.round(Math.cos(a) * 3), y + 5 - Math.round(Math.sin(a) * 3), INK);
  if (S.tier > 0 && (Math.floor(S.t * 4) & 1)) { fb.px(x + 5, y + 1, C.RED_L); fb.px(x + 6, y + 2, C.RED_L); fb.px(x + 7, y + 3, C.RED_L); }
}

// --- vent grille: n slats; the gaps between them glow with heat -------------------------
function ventBody(g, x, y, w, n, slat = C.STEEL, slatHi = C.STEEL_L) {
  g.rect(x, y, w, n * 2 + 1, INK);
  for (let i = 0; i < n; i++) { g.hline(x + 1, y + 1 + i * 2, w - 2, slat); g.px(x + 1, y + 1 + i * 2, slatHi); }
}

const VENT_A = [0, C.RED_D, C.RED, C.ORANGE];
const VENT_B = [0, C.RED, C.ORANGE, C.YELLOW];

function ventGlow(fb, x, y, w, n, S) {
  if (S.tier <= 0) return;
  const k = Math.floor(S.t * 7);
  for (let i = 0; i <= n; i++) {
    const yy = y + i * 2;
    if (i > 0 && i < n) fb.hline(x + 1, yy, w - 2, VENT_A[S.tier]);
    else if (S.tier < 3) continue;
    for (let xx = x + 1; xx < x + w - 1; xx++) {
      if (hash(xx, yy, k) < 0.2 + S.tier * 0.1) fb.px(xx, yy, i > 0 && i < n ? VENT_B[S.tier] : C.RED);
    }
  }
}

/** Warning tape lighting up: marching bright stripes, faster the hotter it gets. */
const WARN_RATE = [0, 3, 5, 8];
function warnStrip(fb, x, y, w, h, S) {
  if (S.tier <= 0) return;
  const k = Math.floor(S.t * WARN_RATE[S.tier]);
  hazardStrip(fb, x, y, w, h, k & 1 ? C.HAZARD : C.ORANGE, S.tier >= 3 && (k & 2) ? C.RED : INK, -k - x - y);
}

// --- scorching ---------------------------------------------------------------------------
// BURN maps every colour to its scorched version; applied once everywhere on a burnt
// machine, and again (up to plain ink) where the soot mask says the fire was fiercest.
const BURN = (() => {
  const b = new Uint8Array(64);
  for (let i = 0; i < 64; i++) b[i] = INK;
  b[C.BLACK] = 0;
  const set = (from, to) => { b[C[from]] = C[to]; };
  set('ROCK', 'ROCK_D'); set('ROCK_L', 'ROCK'); set('DIRT', 'ROCK'); set('SAND', 'ROCK_L');
  set('STEEL_D', 'STEEL_DD'); set('STEEL', 'SMOKE_D'); set('STEEL_L', 'STEEL_D'); set('STEEL_LL', 'SMOKE'); set('WHITE', 'SMOKE_L');
  set('WALL_D', 'ROCK_D'); set('WALL', 'WALL_D'); set('WALL_L', 'WALL');
  set('AMBER_D', 'WALL_D'); set('AMBER', 'AMBER_D'); set('AMBER_L', 'WALL_L'); set('CREAM', 'SAND');
  set('RED_D', 'ROCK_D'); set('RED', 'RED_D'); set('RED_L', 'RED_D'); set('ORANGE', 'AMBER_D'); set('YELLOW', 'AMBER_D');
  set('GREEN_D', 'GREEN_DD'); set('GREEN', 'GREEN_D'); set('GREEN_L', 'GRASS_D'); set('MINT', 'GRASS');
  set('TEAL_D', 'STEEL_DD'); set('TEAL', 'TEAL_D'); set('CYAN', 'TEAL_D'); set('CYAN_L', 'GLASS');
  set('BLUE_D', 'NIGHT_D'); set('BLUE', 'BLUE_D'); set('BLUE_L', 'NIGHT'); set('SKY', 'GLASS');
  set('VIOLET_D', 'NIGHT_D'); set('VIOLET', 'VIOLET_D'); set('VIOLET_L', 'DUSK'); set('PINK', 'DUSK');
  set('COPPER_D', 'ROCK'); set('COPPER', 'COPPER_D'); set('COPPER_L', 'LEATHER'); set('BRASS', 'WALL');
  set('TAN', 'LEATHER'); set('LEATHER', 'WALL_D'); set('WOOD', 'WALL');
  set('SMOKE', 'SMOKE_D'); set('SMOKE_L', 'SMOKE');
  set('GLASS', 'STEEL_D'); set('GLASS_L', 'GLASS');
  set('NIGHT', 'NIGHT_D'); set('DUSK', 'NIGHT_D'); set('MOON', 'SMOKE_L');
  set('GRASS_D', 'GREEN_DD'); set('GRASS', 'GRASS_D');
  set('CRATE', 'WALL'); set('PACKAGE', 'SAND'); set('HAZARD', 'AMBER_D'); set('MAGENTA', 'VIOLET_D');
  return b;
})();

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Soot levels 0..3 per pixel around a burn centre (machine-local); soot climbs upward. */
function sootMask(fx, fy, rx, ry) {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x - fx) / rx, dy = (y - fy) / (y < fy ? ry * 1.7 : ry);
    const v = 1 - Math.sqrt(dx * dx + dy * dy) + (hash(x >> 2, y >> 1, 7) - 0.5) * 0.35;
    const lv = Math.floor(v * 2.6 + (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16);
    m[y * W + x] = lv < 0 ? 0 : lv > 3 ? 3 : lv;
  }
  return m;
}

const SCRATCH = new Framebuffer(W, H);
const SCRATCH_SPR = { w: W, h: H, data: SCRATCH.buf };

function burn(soot) {
  const b = SCRATCH.buf;
  for (let i = 0; i < b.length; i++) {
    let c = b[i];
    if (!c) continue;
    c = BURN[c];
    const s = soot[i];
    if (s === 3) c = INK; else if (s === 2) c = BURN[BURN[c]]; else if (s === 1) c = BURN[c];
    b[i] = c;
  }
}

const toSprite = (g) => ({ w: g.w, h: g.h, data: g.buf });

/** Blit options for an unpowered body: bright paper, dial faces and brass glints are dulled
 *  so nothing reads as a lit lamp once the world relights the room amber or red. */
const UNLIT = { remap: { [C.CREAM]: C.TAN, [C.AMBER_L]: C.BRASS, [C.WHITE]: C.STEEL_LL } };
const PAPER = [C.TAN, C.CREAM], PAPER2 = [C.SAND, C.PACKAGE];

// =====================================================================================
// FABLE: experimental glass-domed computer
// =====================================================================================

const DOME_X = 24, DOME_Y = 1, DOME_R = 20, DOME_STRAIGHT = 5;   // bell jar: x 24..63, y 1..25
const COIL_X = [33, 54];
const ORB_X = 43, ORB_Y = 15;                                     // orb is 10 wide: discs at 43 and 44

/** Half-width of the bell jar (shrunk by inset) at machine-local row y, or -1 outside. */
function domeHalf(y, inset) {
  const r = DOME_R - inset, i = y - DOME_Y - inset;
  if (i < 0 || y > DOME_Y + DOME_R + DOME_STRAIGHT - 1) return -1;
  if (i >= r) return r;
  const dy = r - i - 0.5;
  return Math.round(Math.sqrt(r * r - dy * dy));
}

function domeFill(g, inset, c, y0 = 0, y1 = H) {
  for (let y = Math.max(y0, DOME_Y); y < Math.min(y1, DOME_Y + DOME_R + DOME_STRAIGHT); y++) {
    const hw = domeHalf(y, inset);
    if (hw > 0) g.rect(DOME_X + DOME_R - hw, y, hw * 2, 1, c);
  }
}

function disc2(g, x, y, r, c) { g.disc(x, y, r, c); g.disc(x + 1, y, r, c); }
function plus(g, x, y, c) { g.px(x, y, c); g.px(x - 1, y, c); g.px(x + 1, y, c); g.px(x, y - 1, c); g.px(x, y + 1, c); }

function buildFable() {
  const g = new Framebuffer(W, H);
  const V0 = C.VIOLET_D, V1 = C.VIOLET, V2 = C.VIOLET_L;

  // plinth with the (unlit) warning tape
  g.rect(2, 44, 84, 4, INK);
  hazardStrip(g, 3, 45, 82, 2, C.AMBER_D, C.STEEL_DD);

  // console base: sloped desk (y 30..33) over the front face (y 35..43)
  g.rect(0, 29, 88, 16, INK);
  g.rect(1, 30, 86, 14, V1);
  g.hline(1, 30, 86, V2);
  g.hline(1, 34, 86, V0);
  g.hline(1, 43, 86, V0);
  g.vline(86, 31, 13, V0);
  g.vline(1, 31, 12, V2);
  for (let i = 0; i < 9; i++) { g.rect(31 + i * 3, 31, 2, 1, C.CREAM); g.rect(32 + i * 3, 33, 2, 1, C.STEEL_LL); }
  for (const lx of [20, 23, 26, 61, 64, 67]) g.px(lx, 32, C.STEEL_DD);

  gaugeFace(g, 4, 35);
  ventBody(g, 15, 36, 16, 3);
  box(g, 33, 35, 22, 9, C.NIGHT_D);                     // CRT: screen x 34..53, y 36..42
  g.px(34, 36, C.GLASS);
  for (let i = 0; i < 8; i++) g.rect(57 + (i & 3) * 3, 36 + (i >> 2) * 4, 2, 2, C.STEEL_DD);   // lamp block
  fanHousing(g, 73, 35);

  // side turrets carrying the belt hatches and the loop flanges
  for (const left of [true, false]) {
    mrect(g, left, 0, 11, 14, 19, INK);
    mrect(g, left, 1, 12, 12, 17, V1);
    g.hline(left ? 1 : 75, 12, 12, V2);
    g.vline(left ? 1 : 75, 12, 17, V2);
    g.vline(left ? 12 : 86, 13, 16, V0);
    mrect(g, left, 0, 11, 1, 1, 0); mrect(g, left, 13, 11, 1, 1, 0);
    hatch(g, left, C.STEEL_LL, C.STEEL);
    mrect(g, left, 3, 25, 6, 3, V0);                    // little service plate under the hatch
    mrect(g, left, 4, 26, 4, 1, C.BRASS);
    flange(g, left);
    mrect(g, left, 3, 6, 4, 5, INK);                    // glass elbow from the flange down into the turret
    mrect(g, left, 3, 7, 3, 1, C.TEAL);
    mrect(g, left, 3, 8, 1, 1, C.TEAL_D);
    mrect(g, left, 4, 8, 2, 3, C.TEAL_D);
    mrect(g, left, left ? 4 : 5, 8, 1, 3, C.TEAL);
  }
  // aerial on the right turret (the beacon sits on the left one)
  g.vline(77, 5, 6, INK); g.px(77, 4, C.STEEL_DD); g.px(76, 10, INK); g.px(78, 10, INK);

  // cables sagging from the turrets to the dome collar
  for (const left of [true, false]) {
    const pts = [[14, 17], [16, 21], [18, 24], [20, 26], [21, 27]];
    for (const [px, py] of pts) { mrect(g, left, px - 1, py - 1, 3, 3, INK); }
    for (const [px, py] of pts) { mrect(g, left, px, py, 1, 1, C.COPPER); mrect(g, left, px, py - 0, 1, 1, C.COPPER); }
    g.line(left ? 14 : 73, 17, left ? 18 : 69, 24, C.COPPER_D);
    g.line(left ? 18 : 69, 24, left ? 21 : 66, 27, C.COPPER_D);
  }

  // the bell jar
  domeFill(g, 0, INK);
  domeFill(g, 1, C.GLASS);
  domeFill(g, 2, C.NIGHT_D);
  // glass rim: lit on the upper left, sunk into shadow lower right
  for (let y = DOME_Y; y < DOME_Y + DOME_R + DOME_STRAIGHT; y++) {
    const hw = domeHalf(y, 1);
    if (hw <= 0) continue;
    const xl = DOME_X + DOME_R - hw, xr = DOME_X + DOME_R + hw - 1;
    if (y < 14) g.px(xl, y, C.GLASS_L);
    if (y > 12) g.px(xr, y, C.TEAL_D);
  }
  g.rect(26, 24, 36, 2, C.STEEL_D); g.hline(26, 24, 36, C.STEEL);          // floor plate inside the dome
  // brass collar the dome sits in
  g.rect(21, 26, 46, 3, INK);
  g.hline(22, 26, 44, C.AMBER_L); g.hline(22, 27, 44, C.BRASS); g.hline(22, 28, 44, C.AMBER_D);
  for (let i = 0; i < 7; i++) g.px(25 + i * 6, 27, C.AMBER_D);

  // coils (copper when dark; they glow violet when powered)
  for (const cx of COIL_X) {
    g.rect(cx - 3, 22, 7, 2, C.BRASS); g.hline(cx - 3, 23, 7, C.AMBER_D);
    g.rect(cx - 1, 11, 3, 11, C.STEEL_D);
    for (let i = 0; i < 5; i++) g.hline(cx - 2, 12 + i * 2, 5, C.COPPER_D);
    plus(g, cx, 9, C.STEEL);
  }
  // thought core on its pedestal
  g.rect(ORB_X - 2, 22, 6, 2, C.BRASS); g.hline(ORB_X - 2, 23, 6, C.AMBER_D);
  g.rect(ORB_X, 19, 2, 3, C.STEEL);
  disc2(g, ORB_X, ORB_Y, 4, C.TEAL_D);
  g.px(ORB_X - 1, ORB_Y - 2, C.GLASS); g.px(ORB_X - 2, ORB_Y - 1, C.GLASS);
  return g;
}

/** Glass reflections, drawn over whatever glows inside the dome. */
function buildFableGlass() {
  const g = new Framebuffer(W, H);
  for (let y = 5; y <= 13; y++) {
    const hw = domeHalf(y, 4);
    if (hw <= 0) continue;
    const xl = DOME_X + DOME_R - hw;
    g.px(xl, y, y < 8 ? C.WHITE : C.GLASS_L);
    if (y >= 6 && y <= 9) g.px(xl + 1, y, C.GLASS_L);
  }
  for (let y = 17; y <= 22; y++) g.px(DOME_X + DOME_R + domeHalf(y, 4) - 1, y, C.GLASS);
  return g;
}

const FABLE_BODY = toSprite(buildFable());
const FABLE_GLASS = toSprite(buildFableGlass());
const FABLE_GLASS_DARK = { remap: { [C.WHITE]: C.GLASS, [C.GLASS_L]: C.GLASS } };
const FABLE_SOOT = sootMask(44, 22, 26, 13);
const TWINKLE = [C.CYAN_L, C.PINK, C.WHITE, C.VIOLET_L];
const TWINKLE_DIM = [C.TEAL, C.VIOLET, C.VIOLET_L, C.VIOLET];
const ORBIT_ROT = [0, TAU / 6, -TAU / 6];

function drawFable(fb, x, y, S) {
  fb.blit(FABLE_BODY, x, y, S.lit ? undefined : UNLIT);
  const ph = S.phase, t = S.t;

  if (S.lit) {
    const b = S.breath, run = S.run;
    // coils: a bright band climbs each coil while it works
    for (let k = 0; k < 2; k++) {
      const cx = x + COIL_X[k];
      const band = fract(ph * 2 + k * 0.5) * 7 - 1;
      for (let i = 0; i < 5; i++) {
        let c;
        if (run) { const d = Math.abs(i - band); c = d < 0.6 ? C.PINK : d < 1.6 ? C.VIOLET_L : C.VIOLET; }
        else c = b > 0.55 ? C.VIOLET : C.VIOLET_D;
        fb.hline(cx - 2, y + 20 - i * 2, 5, c);
      }
      plus(fb, cx, y + 9, run ? C.CYAN : b > 0.5 ? C.TEAL : C.TEAL_D);
      if (run) fb.px(cx, y + 9, hash(Math.floor(ph * 16), k) < 0.5 ? C.WHITE : C.CYAN_L);
    }
    // electrons on the far side of their orbits
    if (run) fableOrbits(fb, x, y, ph, false);
    // the core
    const ox = x + ORB_X, oy = y + ORB_Y;
    if (run) {
      const beat = tri(ph * 2);
      disc2(fb, ox, oy, 4, C.TEAL);
      disc2(fb, ox, oy, 3, C.CYAN);
      disc2(fb, ox, oy, beat > 0.5 ? 2 : 1, C.CYAN_L);
      if (beat > 0.75) { fb.px(ox, oy, C.WHITE); fb.px(ox + 1, oy, C.WHITE); }
    } else {
      disc2(fb, ox, oy, 4, b > 0.7 ? C.TEAL : C.TEAL_D);
      disc2(fb, ox, oy, b > 0.4 ? 3 : 2, C.TEAL);
      if (b > 0.6) disc2(fb, ox, oy, 1, C.CYAN);
    }
    if (run) {
      fableOrbits(fb, x, y, ph, true);
      // arcs jumping from the coil tips to the core
      const slot = Math.floor(ph * 9);
      for (let k = 0; k < 2; k++) {
        if (hash(slot, k, 9) > 0.38 + (S.tier > 0 ? -0.2 : 0)) continue;
        const sx = COIL_X[k] + (k ? -2 : 2), ex = k ? ORB_X + 6 : ORB_X - 5;
        const mx = (sx + ex) >> 1, my = 10 + Math.floor(hash(slot, k, 4) * 4);
        fb.line(x + sx, y + 9, x + mx, y + my, C.CYAN_L);
        fb.line(x + mx, y + my, x + ex, y + 13, C.WHITE);
      }
      // thought patterns: sparks that pop up and fade in the crown of the dome
      for (let i = 0; i < 7; i++) {
        const s = ph * 3 + i * 0.37, slot2 = Math.floor(s), f = s - slot2;
        const yy = 4 + Math.floor(hash(i, slot2, 3) * 6);
        const hw = domeHalf(yy, 4);
        const xx = DOME_X + DOME_R - hw + Math.floor(hash(i, slot2, 5) * hw * 2);
        const ci = (i + slot2) & 3;
        if (f < 0.2 || f > 0.7) { if (f < 0.85) fb.px(x + xx, y + yy, TWINKLE_DIM[ci]); continue; }
        fb.px(x + xx, y + yy, TWINKLE[ci]);
        if (f > 0.35 && f < 0.55 && (i & 1)) plus(fb, x + xx, y + yy, TWINKLE_DIM[ci]), fb.px(x + xx, y + yy, C.WHITE);
      }
    }

    // console screen: a thought trace when working, a flat line with a slow cursor when idle
    fb.rect(x + 34, y + 36, 20, 7, C.TEAL_D);
    if (run) {
      for (let i = 0; i < 20; i++) {
        const v = Math.sin(i * 0.75 + ph * TAU) * Math.sin(i * 0.21 + ph * TAU * 0.25 + 1);
        const yy = 39 + Math.round(v * 2.7);
        fb.px(x + 34 + i, y + yy, Math.abs(v) > 0.6 ? C.CYAN_L : C.CYAN);
      }
    } else {
      fb.hline(x + 35, y + 39, 18, C.TEAL);
      if (b > 0.5) fb.px(x + 36 + Math.floor(fract(t * 0.125) * 16), y + 39, C.CYAN);
    }
    // lamp block and desk lamps
    const k5 = Math.floor(t * 5);
    for (let i = 0; i < 8; i++) {
      const on = run ? hash(i, k5, 2) < 0.55 : i === 0 && b > 0.5;
      const c = i < 4 ? (on ? C.CYAN : C.TEAL_D) : (on ? C.PINK : C.VIOLET_D);
      fb.rect(x + 57 + (i & 3) * 3, y + 36 + (i >> 2) * 4, 2, 2, c);
    }
    fb.px(x + 20, y + 32, C.GREEN_L);
    fb.px(x + 23, y + 32, run ? C.GREEN_L : C.GREEN_D);
    fb.px(x + 26, y + 32, run && (k5 & 1) ? C.CYAN_L : C.TEAL);
    fb.px(x + 61, y + 32, run && hash(k5, 61) < 0.5 ? C.PINK : C.VIOLET_D);
    fb.px(x + 64, y + 32, run && hash(k5, 64) < 0.5 ? C.PINK : C.VIOLET_D);
    fb.px(x + 67, y + 32, S.tier > 0 ? (k5 & 1 ? C.RED_L : C.RED_D) : C.VIOLET_D);
    fb.px(x + 77, y + 4, run ? (Math.floor(t * 2) & 1 ? C.PINK : C.VIOLET) : b > 0.5 ? C.VIOLET_L : C.VIOLET);
    ventGlow(fb, x + 15, y + 36, 16, 3, S);
    warnStrip(fb, x + 3, y + 45, 82, 2, S);
  }
  gauge(fb, x + 4, y + 35, S);
  fan(fb, x + 73, y + 35, S);
  fb.blit(FABLE_GLASS, x, y, S.lit ? undefined : FABLE_GLASS_DARK);
}

function fableOrbits(fb, x, y, ph, front) {
  for (let k = 0; k < 3; k++) {
    const a = (ph * 0.75 + k / 3) * TAU;
    if ((Math.sin(a) > 0) !== front) continue;
    const cr = Math.cos(ORBIT_ROT[k]), sr = Math.sin(ORBIT_ROT[k]);
    for (let j = 2; j >= 0; j--) {
      const aa = a - j * 0.3, ex = Math.cos(aa) * 8, ey = Math.sin(aa) * 2.6;
      const px = Math.round(ORB_X + 0.5 + ex * cr - ey * sr), py = Math.round(ORB_Y + ex * sr + ey * cr);
      fb.px(x + px, y + py, j === 0 ? (front ? C.WHITE : C.VIOLET_L) : j === 1 ? (front ? C.PINK : C.VIOLET) : C.VIOLET);
    }
  }
}

function wreckFable(g) {
  // the dome has burst at the crown and cracked down one side; soot hangs inside it
  for (let y = 3; y < 20; y++) {
    const hw = domeHalf(y, 3);
    for (let xx = DOME_X + DOME_R - hw; xx < DOME_X + DOME_R + hw; xx++) {
      if (((xx + y) & 1) === 0 && hash(xx >> 1, y >> 1, 5) < 0.75 - y * 0.03 && g.get(xx, y) === INK) g.px(xx, y, C.SMOKE_D);
    }
  }
  const hole = [[38, 1, 11], [39, 2, 9], [41, 3, 6], [42, 4, 3]];
  for (const [hx, hy, hw] of hole) g.rect(hx, hy, hw, 1, 0);
  g.px(37, 2, INK); g.px(38, 3, INK); g.px(40, 4, INK); g.px(41, 5, INK); g.px(45, 5, INK); g.px(47, 4, INK); g.px(48, 3, INK); g.px(49, 2, INK);
  const crack = [[36, 4], [34, 7], [35, 10], [32, 13], [33, 16], [30, 19]];
  for (let i = 0; i + 1 < crack.length; i++) g.line(crack[i][0], crack[i][1], crack[i + 1][0], crack[i + 1][1], C.STEEL);
  g.line(35, 10, 38, 12, C.STEEL); g.line(52, 6, 55, 10, C.STEEL); g.line(55, 10, 54, 13, C.STEEL);
}

// =====================================================================================
// More kit: mirrored boxes, fat cables, thick limbs
// =====================================================================================

/** box() at a position mirrored about the centre line when left is false (light stays top-left). */
function mbox(g, left, x, y, w, h, mid, hi, sh) { box(g, left ? x : W - x - w, y, w, h, mid, hi, sh); }

/** Fat rubber cable (4px with outline) along a quadratic curve p0 -> p2 bent toward p1. */
function fatCable(g, x0, y0, x1, y1, x2, y2, core, hi) {
  const n = Math.ceil((Math.abs(x2 - x0) + Math.abs(y2 - y0)) * 1.5) + 2;
  const P = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
    P.push([Math.round(a * x0 + b * x1 + c * x2), Math.round(a * y0 + b * y1 + c * y2)]);
  }
  for (const [px, py] of P) g.rect(px - 1, py - 1, 4, 4, INK);
  for (const [px, py] of P) g.rect(px, py, 2, 2, core);
  for (const [px, py] of P) g.px(px, py, hi);
}

/** Call fn(x, y) for every pixel of a Bresenham line. */
function walk(x0, y0, x1, y1, fn) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// =====================================================================================
// OPUS: massive industrial mainframe
// =====================================================================================

const OP_REELS = [33, 54], OP_REEL_Y = 17;
const OP_PIST_X = 12, OP_PIST_TOP = 14, OP_PIST_STROKE = 6;     // crosshead 7x5, top y 14..20
const OP_CROWN = [37, 41, 45, 49];
const OP_ON = [], OP_OFF = [];
for (let i = 0; i < 13; i++) {
  const red = i % 4 === 3, green = i % 5 === 1;
  OP_ON.push(red ? C.RED_L : green ? C.GREEN_L : C.AMBER_L);
  OP_OFF.push(red ? C.RED_D : green ? C.GREEN_DD : C.AMBER_D);
}

function buildOpus() {
  const g = new Framebuffer(W, H);
  // plinth with the (unlit) warning tape
  g.rect(1, 43, 86, 5, INK);
  g.hline(2, 44, 84, C.STEEL_D);
  hazardStrip(g, 2, 45, 84, 2, C.AMBER_D, C.STEEL_DD);
  for (let i = 0; i < 8; i++) g.px(5 + i * 11, 44, C.COPPER);

  for (const left of [true, false]) {
    // wing: belt hatch, loop flange, power junction box
    mbox(g, left, 0, 10, 11, 34, C.STEEL_D, C.STEEL, C.STEEL_DD);
    hatch(g, left, C.STEEL_LL, C.STEEL);
    mbox(g, left, 2, 27, 7, 7, C.COPPER, C.COPPER_L, C.COPPER_D);
    mrect(g, left, 5, 28, 1, 2, INK); mrect(g, left, 4, 30, 2, 1, INK); mrect(g, left, 4, 31, 1, 1, INK);   // bolt sign
    for (const ry of [36, 40]) { mrect(g, left, 2, ry, 1, 1, C.STEEL_L); mrect(g, left, 7, ry, 1, 1, C.STEEL_L); }
    flange(g, left);
    // copper elbow from the flange down into the wing roof
    mrect(g, left, 2, 5, 6, 5, INK); mrect(g, left, 3, 9, 5, 2, INK);
    mrect(g, left, 2, 6, 5, 1, C.COPPER_L); mrect(g, left, 2, 7, 5, 1, C.COPPER); mrect(g, left, 2, 8, 2, 1, C.COPPER_D);
    mrect(g, left, 4, 8, 1, 2, C.COPPER_L); mrect(g, left, 5, 8, 1, 2, C.COPPER); mrect(g, left, 6, 8, 1, 2, C.COPPER_D);
    // piston bay, gland and cylinder
    mrect(g, left, 11, 9, 9, 19, C.STEEL_DD);
    mrect(g, left, 11, 9, 1, 19, C.STEEL_D); mrect(g, left, 19, 9, 1, 19, C.STEEL_D);
    mrect(g, left, 12, 9, 7, 1, INK);
    mbox(g, left, 12, 30, 7, 13, C.STEEL_D, C.STEEL, C.STEEL_DD);
    for (const by of [33, 38]) { mrect(g, left, 13, by, 5, 2, C.COPPER_D); mrect(g, left, 13, by, 5, 1, C.COPPER); }
    mbox(g, left, 11, 26, 9, 5, C.BRASS, C.AMBER_L, C.AMBER_D);
  }
  // thick power cables slung from the cornice onto the wing roofs
  fatCable(g, 18, 7, 13, 14, 8, 11, C.STEEL_DD, C.STEEL_D);
  fatCable(g, W - 20, 7, W - 15, 14, W - 10, 11, C.STEEL_DD, C.STEEL_D);

  // cabinet
  box(g, 20, 8, 48, 36, C.STEEL_D, C.STEEL, C.STEEL_DD);
  g.hline(21, 9, 46, C.STEEL_DD);
  for (const [rx, ry] of [[22, 11], [65, 11], [22, 41], [65, 41]]) g.px(rx, ry, C.STEEL_L);
  // crown and copper cornice
  g.rect(33, 1, 22, 5, INK);
  g.rect(34, 2, 20, 3, C.STEEL_D);
  g.hline(34, 2, 20, C.STEEL);
  for (const lx of OP_CROWN) g.rect(lx, 3, 2, 1, C.AMBER_D);
  g.rect(16, 5, 56, 4, INK);
  g.hline(17, 6, 54, C.COPPER_L);
  g.hline(17, 7, 54, C.COPPER);
  for (let i = 0; i < 11; i++) g.px(19 + i * 5, 7, C.COPPER_D);

  // tape window: reels are drawn per frame; the read head and guide rollers are fixed
  g.rect(23, 10, 42, 16, INK);
  g.rect(24, 11, 40, 14, C.STEEL_DD);
  g.hline(23, 26, 42, C.STEEL);
  g.rect(41, 18, 6, 5, INK); g.rect(42, 19, 4, 3, C.STEEL); g.hline(42, 19, 4, C.STEEL_L);
  for (const rx of [39, 48]) { g.disc(rx, 22, 1, INK); g.px(rx, 22, C.STEEL_L); }

  // blinkenlights panel
  g.rect(23, 27, 42, 7, INK);
  g.rect(24, 28, 40, 5, C.STEEL_DD);
  for (let i = 0; i < 26; i++) { const col = i % 13; g.rect(25 + col * 3, 29 + (i >= 13 ? 2 : 0), 2, 1, OP_OFF[col]); }

  // lower deck: gauge, vents, fan
  gaugeFace(g, 23, 34);
  ventBody(g, 34, 35, 20, 3);
  fanHousing(g, 57, 34);
  return g;
}

function reel(fb, cx, cy, pack, ang, lit) {
  fb.disc(cx, cy, 6, INK);
  fb.disc(cx, cy, 5, C.STEEL_DD);
  if (pack > 1) { fb.disc(cx, cy, pack, C.LEATHER); fb.ring(cx, cy, pack, C.COPPER_D); }
  fb.ring(cx, cy, 5, C.STEEL);
  fb.px(cx - 3, cy - 4, C.STEEL_L); fb.px(cx - 4, cy - 3, C.STEEL_L);
  for (let s = 0; s < 3; s++) {
    const a = ang + s * TAU / 3, ca = Math.cos(a), sa = Math.sin(a);
    for (let r = 2; r <= 5; r++) fb.px(cx + Math.round(ca * r), cy + Math.round(sa * r), C.STEEL_L);
  }
  fb.disc(cx, cy, 1, lit ? C.STEEL_LL : C.STEEL_L);
  fb.px(cx, cy, INK);
}

const OPUS_BODY = toSprite(buildOpus());
const OPUS_SOOT = sootMask(44, 22, 24, 11);

function drawOpus(fb, x, y, S) {
  fb.blit(OPUS_BODY, x, y, S.lit ? undefined : UNLIT);
  const ph = S.phase, t = S.t, lit = S.lit, run = S.run, b = S.breath;

  // pistons, pumping in turn
  for (let k = 0; k < 2; k++) {
    const bx = x + (k ? W - OP_PIST_X - 7 : OP_PIST_X);
    const u = 0.5 - 0.5 * Math.cos((ph + k * 0.5) * TAU);          // 0 top .. 1 bottom
    const hy = y + OP_PIST_TOP + Math.round(u * OP_PIST_STROKE);
    const r0 = hy + 5, r1 = y + 26;
    if (r1 > r0) { fb.rect(bx + 2, r0, 3, r1 - r0, C.STEEL_L); fb.vline(bx + 2, r0, r1 - r0, C.STEEL_LL); fb.vline(bx + 4, r0, r1 - r0, C.STEEL); }
    fb.rect(bx, hy, 7, 5, INK);
    fb.rect(bx + 1, hy + 1, 5, 3, C.COPPER);
    fb.hline(bx + 1, hy + 1, 5, C.COPPER_L);
    fb.hline(bx + 1, hy + 3, 5, C.COPPER_D);
    fb.px(bx + 3, hy + 2, C.COPPER_D);
  }

  // tape reels: the tape walks from the left reel to the right one and back, slowly
  const tl = 2 + Math.round(3 * tri(ph / 24)), tr = 7 - tl;
  const ang = ph * TAU * 0.45;
  fb.line(x + OP_REELS[0] + tl, y + OP_REEL_Y, x + 39, y + 23, C.LEATHER);
  fb.hline(x + 39, y + 23, 10, C.LEATHER);
  fb.line(x + 48, y + 23, x + OP_REELS[1] - tr, y + OP_REEL_Y, C.LEATHER);
  reel(fb, x + OP_REELS[0], y + OP_REEL_Y, tl, ang, lit);
  reel(fb, x + OP_REELS[1], y + OP_REEL_Y, tr, ang + 1, lit);
  fb.px(x + 25, y + 12, lit ? C.STEEL_L : C.STEEL); fb.px(x + 26, y + 12, C.STEEL); fb.px(x + 25, y + 13, C.STEEL);

  if (lit) {
    const k6 = Math.floor(t * 6);
    // read head lamp
    fb.px(x + 43, y + 20, run ? (hash(k6, 5) < 0.6 ? C.RED_L : C.AMBER_L) : C.RED_D);
    // blinkenlights: busy random blinking when running, a slow breathing pattern when idle
    for (let i = 0; i < 26; i++) {
      const col = i % 13, row = i >= 13 ? 1 : 0;
      const on = run ? hash(i, k6 >> (i & 1), 11) < 0.45 : ((col + row) % 3 === 0 && b > 0.45);
      if (on) fb.rect(x + 25 + col * 3, y + 29 + row * 2, 2, 1, OP_ON[col]);
    }
    // crown lamps: a chase that follows the work, red when hot
    const chase = Math.floor(ph * 4) & 3;
    for (let i = 0; i < 4; i++) {
      let c;
      if (S.tier > 0) c = (Math.floor(t * 4) + i) & 1 ? C.RED_L : C.RED;
      else if (run) c = i === chase ? C.AMBER_L : C.AMBER;
      else c = b > 0.5 ? C.AMBER : C.AMBER_D;
      fb.rect(x + OP_CROWN[i], y + 3, 2, 1, c);
    }
    ventGlow(fb, x + 34, y + 35, 20, 3, S);
    warnStrip(fb, x + 2, y + 45, 84, 2, S);
  }
  gauge(fb, x + 23, y + 34, S);
  fan(fb, x + 57, y + 34, S);
}

function wreckOpus(g) {
  // the tape window has cracked and spilled loops of tape
  g.line(27, 12, 31, 16, C.STEEL); g.line(31, 16, 29, 20, C.STEEL); g.line(58, 12, 61, 15, C.STEEL);
  const loops = [[30, 24, 33, 31], [35, 24, 34, 34], [50, 24, 53, 30], [56, 24, 55, 33]];
  for (const [x0, y0, x1, y1] of loops) g.line(x0, y0, x1, y1, C.ROCK);
  g.line(33, 31, 36, 32, C.ROCK); g.line(53, 30, 51, 33, C.ROCK);
}

// =====================================================================================
// SONNET: mechanical assembly line
// =====================================================================================

const SN_SLOT0 = 8, SN_PITCH = 12, SN_MOVE = 0.35;      // indexing conveyor: slots at 8 + 12 s
const SN_ARMS = [32, 56], SN_SHOULDER_Y = 7, SN_L1 = 7, SN_L2 = 6, SN_LAG = 0.07;
const SN_HIT = [0.53, 0.53 + SN_LAG];                   // when each arm's mark lands on the doc
const SN_CELL0 = 14, SN_CELL1 = 74;                     // open work cell, x 14..73

function buildSonnet() {
  const g = new Framebuffer(W, H);
  const B0 = C.BLUE_D, B1 = C.BLUE, B2 = C.BLUE_L;
  // feet
  for (const fx of [2, 22, 58, 78]) { g.rect(fx, 44, 8, 4, INK); g.rect(fx + 1, 45, 6, 2, C.STEEL); g.hline(fx + 1, 45, 6, C.STEEL_L); }
  // work cell backdrop
  g.rect(SN_CELL0, 5, SN_CELL1 - SN_CELL0, 17, C.NIGHT);
  for (let i = 0; i < 10; i++) g.vline(SN_CELL0 + 3 + i * 6, 7, 15, C.BLUE_D);
  g.hline(SN_CELL0, 6, SN_CELL1 - SN_CELL0, C.NIGHT_D);
  // base cabinet under the conveyor
  box(g, 13, 24, 62, 21, B1, B2, B0);
  g.rect(14, 25, 60, 2, C.STEEL_DD);                       // roller channel
  hazardStrip(g, 14, 27, 60, 2, C.HAZARD, INK);
  g.hline(14, 29, 60, B0);
  gaugeFace(g, 16, 31);
  box(g, 27, 31, 19, 9, C.NIGHT_D);                         // counter screen: inner x 28..44, y 32..38
  ventBody(g, 48, 32, 12, 3);
  fanHousing(g, 62, 31);
  for (let i = 0; i < 9; i++) { g.rect(27 + i * 4, 41, 4, 3, INK); g.rect(28 + i * 4, 42, 2, 1, i % 3 === 2 ? C.AMBER_D : C.BLUE_D); }
  // conveyor deck through the middle
  g.hline(8, 22, 72, C.STEEL_D);
  g.hline(8, 23, 72, C.STEEL_DD);
  g.hline(8, 24, 72, INK);

  for (const left of [true, false]) {
    // side housing with the belt hatch, the gantry post rising from it
    mbox(g, left, 0, 6, 14, 39, B1, B2, B0);
    mrect(g, left, 10, 1, 4, 13, INK);
    for (let j = 0; j < 11; j++) mrect(g, left, 11, 2 + j, 2, 1, (j >> 1) & 1 ? INK : C.HAZARD);
    hatch(g, left, C.STEEL_LL, C.STEEL);
    mrect(g, left, 8, 12, 6, 2, INK);
    mrect(g, left, 8, 14, 6, 8, C.STEEL_DD);                // tunnel into the work cell
    mrect(g, left, 8, 22, 6, 1, C.STEEL_D);
    mrect(g, left, 8, 23, 6, 1, C.STEEL_DD);
    mrect(g, left, 0, 24, 14, 1, INK);
    flange(g, left);
    // chevrons and rivets on the lower housing
    hazardStrip(g, left ? 1 : W - 13, 38, 12, 4, C.HAZARD, INK, left ? 0 : 1);
    mrect(g, left, 1, 37, 12, 1, INK); mrect(g, left, 1, 42, 12, 1, INK);
    for (const ry of [27, 34]) { mrect(g, left, 2, ry, 1, 1, B2); mrect(g, left, 11, ry, 1, 1, B0); }
  }
  // left housing: red emergency stop; right housing: air tank for the arms
  g.rect(3, 27, 7, 7, INK); g.rect(4, 28, 5, 5, C.HAZARD); g.disc(6, 30, 1, C.RED); g.px(7, 31, C.RED_D);
  g.rect(W - 10, 26, 7, 9, INK); g.rect(W - 9, 27, 5, 7, C.STEEL); g.vline(W - 9, 27, 7, C.STEEL_L); g.vline(W - 5, 27, 7, C.STEEL_D);
  g.hline(W - 9, 29, 5, C.RED); g.hline(W - 9, 32, 5, C.RED);
  // gantry beam with the two arm trolleys
  g.rect(10, 1, 68, 5, INK);
  g.hline(11, 2, 66, B2); g.hline(11, 3, 66, B1); g.hline(11, 4, 66, B0);
  for (let i = 0; i < 11; i++) g.px(14 + i * 6, 3, C.STEEL_L);
  for (const ax of SN_ARMS) { g.rect(ax - 3, 4, 7, 3, INK); g.hline(ax - 2, 5, 5, C.STEEL); g.px(ax - 2, 5, C.STEEL_L); }
  return g;
}

const SONNET_BODY = toSprite(buildSonnet());
const SONNET_SOOT = sootMask(44, 20, 26, 11);

/** Arm k's gripper target at cycle position u: [x, y, closed]. */
function snTarget(k, u) {
  const sx = SN_ARMS[k], side = k ? 1 : -1;
  const Rx = sx + side * 10, Ry = 13, Dx = sx, Dy = 14, Ux = sx + side, Uy = 10;
  if (u < SN_MOVE) { const e = Math.sin(u / SN_MOVE * Math.PI); return [Rx - side * Math.round(e), Ry - Math.round(e), 0]; }
  if (u < 0.5) { const e = smooth((u - SN_MOVE) / (0.5 - SN_MOVE)); return [Rx + (Dx - Rx) * e, Ry + (Dy - Ry) * e, 0]; }
  if (u < 0.64) return [Dx, Dy, 1];
  if (u < 0.76) { const e = smooth((u - 0.64) / 0.12); return [Dx + (Ux - Dx) * e, Dy + (Uy - Dy) * e, 1]; }
  const e = smooth((u - 0.76) / 0.24);
  return [Ux + (Rx - Ux) * e, Uy + (Ry - Uy) * e, 0];
}

function drawArm(fb, x, y, k, u) {
  const sx = SN_ARMS[k], sy = SN_SHOULDER_Y, side = k ? 1 : -1;
  let [tx, ty, closed] = snTarget(k, u);
  tx = Math.round(tx); ty = Math.round(ty);
  // two-link IK, elbow bent outward
  let dx = tx - sx, dy = ty - sy, d = Math.hypot(dx, dy);
  const maxd = SN_L1 + SN_L2 - 0.2;
  if (d > maxd) { dx *= maxd / d; dy *= maxd / d; d = maxd; }
  const a = Math.atan2(dy, dx);
  const cb = (SN_L1 * SN_L1 + d * d - SN_L2 * SN_L2) / (2 * SN_L1 * Math.max(d, 0.001));
  const bend = Math.acos(cb < -1 ? -1 : cb > 1 ? 1 : cb);
  const ea = a - side * bend;
  const ex = Math.round(sx + Math.cos(ea) * SN_L1), ey = Math.round(sy + Math.sin(ea) * SN_L1);
  const X = (v) => x + v, Y = (v) => y + v;
  const out = (px, py) => fb.rect(px - 1, py - 1, 4, 4, INK);
  const core = (px, py) => { fb.rect(px, py, 2, 2, C.AMBER); fb.px(px, py, C.HAZARD); };
  walk(X(sx), Y(sy), X(ex), Y(ey), out); walk(X(ex), Y(ey), X(tx), Y(ty - 1), out);
  walk(X(sx), Y(sy), X(ex), Y(ey), core); walk(X(ex), Y(ey), X(tx), Y(ty - 1), core);
  // joints
  fb.disc(X(sx) + 1, Y(sy), 1, INK); fb.px(X(sx) + 1, Y(sy), C.STEEL_L);
  fb.rect(X(ex), Y(ey), 2, 2, C.STEEL); fb.px(X(ex), Y(ey), C.STEEL_LL);
  // gripper head and fingers
  fb.rect(X(tx) - 2, Y(ty) - 1, 6, 3, INK);
  fb.rect(X(tx) - 1, Y(ty), 4, 1, C.STEEL_L);
  const o = closed ? 0 : 1;
  fb.vline(X(tx) - 1 - o, Y(ty) + 1, 2, INK);
  fb.vline(X(tx) + 2 + o, Y(ty) + 1, 2, INK);
}

function drawDoc(fb, x0, y0, stamped, wrapped, lit) {
  const paper = PAPER[lit], paper2 = PAPER2[lit];
  fb.rect(x0, y0, 6, 6, INK);
  if (wrapped) {
    fb.rect(x0 + 1, y0 + 1, 4, 4, paper2);
    fb.hline(x0 + 1, y0 + 1, 4, paper);
    fb.vline(x0 + 3, y0 + 1, 4, C.LEATHER);
    fb.hline(x0 + 1, y0 + 3, 4, C.LEATHER);
    return;
  }
  fb.rect(x0 + 1, y0 + 1, 4, 4, paper);
  fb.px(x0 + 4, y0 + 1, paper2);
  fb.hline(x0 + 1, y0 + 2, 3, C.STEEL_L);
  fb.hline(x0 + 1, y0 + 4, 2, C.STEEL_L);
  if (stamped) fb.rect(x0 + 3, y0 + 3, 2, 2, C.RED);
}

function drawSonnet(fb, x, y, S) {
  fb.blit(SONNET_BODY, x, y, S.lit ? undefined : UNLIT);
  const ph = S.phase, N = Math.floor(ph), u = ph - N, lit = S.lit, run = S.run, t = S.t, b = S.breath;
  const mv = u < SN_MOVE ? smooth(u / SN_MOVE) : 1;
  const travel = Math.floor((N % 4096 + mv) * SN_PITCH);
  // belt treads and rollers
  const off = ((travel % 4) + 4) % 4;
  for (let i = off; i < SN_CELL1 - SN_CELL0; i += 4) fb.px(x + SN_CELL0 + i, y + 22, C.STEEL_L);
  const spin = (travel >> 1) & 1;
  for (let i = 0; i < 10; i++) { const rx = x + 16 + i * 6; fb.rect(rx, y + 25, 2, 2, C.STEEL); fb.px(rx + spin, y + 25, C.STEEL_L); fb.px(rx + 1 - spin, y + 26, C.STEEL_D); }

  // documents, clipped to the work cell so they slide out of the tunnels
  const c0 = fb.cx0, c2 = fb.cx1;
  fb.cx0 = Math.max(c0, x + SN_CELL0); fb.cx1 = Math.min(c2, x + SN_CELL1);
  for (let s = -1; s <= 6; s++) {
    const cx = SN_SLOT0 + SN_PITCH * (s + mv);
    const q = s + 1;
    const stamped = mv < 1 ? s >= 2 : q > 2 || (q === 2 && u >= SN_HIT[0]);
    const wrapped = mv < 1 ? s >= 4 : q > 4 || (q === 4 && u >= SN_HIT[1]);
    drawDoc(fb, x + Math.round(cx) - 3, y + 16, stamped, wrapped, lit ? 1 : 0);
  }
  fb.cx0 = c0; fb.cx1 = c2;

  // the two arms (the right one a beat behind)
  for (let k = 0; k < 2; k++) {
    let ua = u - k * SN_LAG; if (ua < 0) ua += 1;
    drawArm(fb, x, y, k, ua);
    if (run && ua >= 0.5 && ua < 0.56) {                       // contact flash
      const fx = x + SN_ARMS[k], fy = y + 16;
      fb.px(fx - 3, fy, C.YELLOW); fb.px(fx + 4, fy, C.YELLOW); fb.px(fx - 4, fy - 1, C.CREAM); fb.px(fx + 5, fy - 1, C.CREAM);
    }
  }

  if (lit) {
    // piece counter
    fb.rect(x + 28, y + 32, 17, 7, C.NIGHT_D);
    const n = String(((N % 1000) + 1000) % 1000).padStart(3, '0');
    drawText(fb, x + 31, y + 33, n, run ? C.SKY : C.BLUE_L);
    if (!run && b > 0.5) fb.hline(x + 31, y + 38, 11, C.BLUE);
    // status lamps: a chase that follows the work cycle
    const chase = Math.floor(ph * 9) % 9;
    for (let i = 0; i < 9; i++) {
      const amber = i % 3 === 2;
      const on = run ? (i === chase || hash(i, Math.floor(t * 4), 21) < 0.25) : b > 0.5 && i % 3 === 0;
      if (on) fb.rect(x + 28 + i * 4, y + 42, 2, 1, amber ? C.AMBER_L : C.SKY);
    }
    if (S.tier > 0 && (Math.floor(t * 4) & 1)) { fb.disc(x + 6, y + 30, 1, C.RED_L); fb.px(x + 5, y + 29, C.PINK); }
    ventGlow(fb, x + 48, y + 32, 12, 3, S);
    warnStrip(fb, x + 14, y + 27, 60, 2, S);
  }
  gauge(fb, x + 16, y + 31, S);
  fan(fb, x + 62, y + 31, S);
}

function wreckSonnet(g) {
  // a jammed, charred pile of paper where the conveyor stopped
  for (const [px, py] of [[38, 21], [41, 20], [44, 21], [47, 20], [50, 21]]) { g.rect(px - 2, py - 1, 5, 2, INK); g.hline(px - 1, py - 1, 3, C.SMOKE_D); }
  g.line(20, 26, 26, 29, C.SMOKE_D);
}

// =====================================================================================
// HAIKU: compact sorting machine
// =====================================================================================

const HK_FLAP_X = 24, HK_FLAP_Y = 21, HK_BIN_X = 21;
const CARD_INK = [C.RED, C.BLUE, C.AMBER, C.VIOLET];
const CARD_INK_D = [C.RED_D, C.BLUE_D, C.AMBER_D, C.VIOLET_D];
const BIN_TAB = [C.RED, C.BLUE, C.AMBER, C.VIOLET];
// 5x7 card symbols (row bits, MSB = left column)
const GLYPH = [
  [0b01110, 0b11111, 0b11011, 0b10001, 0b11011, 0b11111, 0b01110],   // ring
  [0b00100, 0b01110, 0b11111, 0b11111, 0b11111, 0b01110, 0b00100],   // diamond
  [0b11111, 0b11111, 0b11011, 0b11011, 0b11011, 0b11111, 0b11111],   // block
  [0b00100, 0b00100, 0b01110, 0b01110, 0b11111, 0b11111, 0b00000],   // peak
];
const HK_ON = [C.MINT, C.GREEN_L, C.MINT, C.AMBER_L, C.GREEN_L, C.MINT, C.GREEN_L, C.AMBER_L];

function buildHaiku() {
  const g = new Framebuffer(W, H);
  const G0 = C.GREEN_DD, G1 = C.GREEN_D, G2 = C.GREEN, G3 = C.GREEN_L, G4 = C.MINT;
  for (const left of [true, false]) {
    // stilt under the hatch
    mrect(g, left, 3, 23, 3, 22, INK); mrect(g, left, 4, 23, 1, 22, C.STEEL);
    mrect(g, left, 1, 44, 7, 4, INK); mrect(g, left, 2, 45, 5, 1, C.STEEL_L); mrect(g, left, 2, 46, 5, 1, C.STEEL);
    hatch(g, left, G4, G2);
    // a tube that slopes from the hatch down into the body
    for (let i = 0; i < 10; i++) {
      const cx = 10 + i, top = 12 + Math.round((i + 1) * 0.65);
      mrect(g, left, cx, top, 1, 12, INK);
      mrect(g, left, cx, top + 1, 1, 10, G2);
      mrect(g, left, cx, top + 1, 1, 1, G4);
      mrect(g, left, cx, top + 2, 1, 1, G3);
      mrect(g, left, cx, top + 9, 1, 2, G1);
    }
    for (const bx of [12, 16]) { const top = 12 + Math.round((bx - 9) * 0.65); mrect(g, left, bx, top + 1, 1, 10, C.STEEL); mrect(g, left, bx, top + 1, 1, 1, C.STEEL_L); }
    flange(g, left);
    // small steel elbow from the flange into the hatch roof
    mrect(g, left, 2, 5, 6, 5, INK); mrect(g, left, 3, 9, 5, 3, INK);
    mrect(g, left, 2, 6, 5, 1, C.STEEL_L); mrect(g, left, 2, 7, 5, 1, C.STEEL); mrect(g, left, 2, 8, 2, 1, C.STEEL_D);
    mrect(g, left, 4, 8, 1, 3, C.STEEL_L); mrect(g, left, 5, 8, 1, 3, C.STEEL); mrect(g, left, 6, 8, 1, 3, C.STEEL_D);
  }
  // body: a rounded green cabinet on two little feet
  for (const fx of [22, 58]) { g.rect(fx, 44, 8, 4, INK); g.rect(fx + 1, 45, 6, 2, C.STEEL); g.hline(fx + 1, 45, 6, C.STEEL_L); }
  g.rect(18, 17, 52, 28, INK);
  g.rect(19, 18, 50, 26, G2);
  g.hline(20, 18, 48, G4);
  g.vline(19, 19, 24, G3);
  g.vline(68, 19, 25, G1);
  g.hline(19, 43, 50, G1);
  g.px(18, 17, 0); g.px(19, 17, 0); g.px(18, 18, 0); g.px(69, 17, 0); g.px(68, 17, 0); g.px(69, 18, 0);
  g.px(19, 18, INK); g.px(68, 18, INK);
  // where the tubes plug in
  for (const left of [true, false]) { mrect(g, left, 17, 19, 3, 13, INK); mrect(g, left, 18, 20, 1, 11, C.STEEL); mrect(g, left, 18, 20, 1, 1, C.STEEL_L); }
  // split-flap window
  g.rect(22, 20, 43, 11, INK);
  for (let k = 0; k < 5; k++) g.rect(HK_FLAP_X + k * 8, HK_FLAP_Y, 7, 9, G0);
  g.hline(22, 31, 43, G3);
  // sorting bins on top
  for (let k = 0; k < 4; k++) {
    const bx = HK_BIN_X + k * 10;
    g.rect(bx, 10, 8, 8, INK);
    g.rect(bx + 1, 10, 6, 6, G0);
    g.rect(bx + 1, 14, 6, 2, G3);
    g.hline(bx + 1, 14, 6, G4);
    g.rect(bx + 3, 15, 2, 1, BIN_TAB[k]);
  }
  // lamps, vent, gauge, fan, warning tape
  gaugeFace(g, 21, 32);
  g.rect(31, 31, 26, 6, INK);
  g.rect(32, 32, 24, 4, G0);
  for (let i = 0; i < 16; i++) g.rect(32 + (i & 7) * 3, 32 + (i >> 3) * 2, 2, 1, G1);
  ventBody(g, 31, 37, 26, 2, G1, G2);
  fanHousing(g, 59, 32);
  hazardStrip(g, 20, 42, 48, 2, C.AMBER_D, G1);
  return g;
}

const HAIKU_BODY = toSprite(buildHaiku());
const HAIKU_SOOT = sootMask(44, 26, 22, 11);

/** Card rows r0..r1 (0..8, row 4 is the hinge) of a card at their own rows. */
function cardRows(fb, x0, y0, cat, r0, r1, paper) {
  const gl = GLYPH[cat], ink = CARD_INK[cat];
  for (let r = r0; r <= r1; r++) {
    if (r === 4) continue;
    fb.hline(x0, y0 + r, 7, paper);
    if (r >= 1 && r <= 7) { const bits = gl[r - 1]; for (let c = 0; c < 5; c++) if (bits & (16 >> c)) fb.px(x0 + 1 + c, y0 + r, ink); }
  }
}

/** A flap caught mid-fall: the given source rows squeezed onto consecutive rows, shaded. */
function flapRows(fb, x0, y0, cat, rows, dy, shade) {
  const gl = GLYPH[cat], ink = CARD_INK_D[cat];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    fb.hline(x0, y0 + dy + i, 7, shade);
    if (r >= 1 && r <= 7) { const bits = gl[r - 1]; for (let c = 0; c < 5; c++) if (bits & (16 >> c)) fb.px(x0 + 1 + c, y0 + dy + i, ink); }
  }
}

const hkCat = (n, k) => Math.floor(hash(n, k, 41) * 4);
const FLAP_TOP = [1, 3], FLAP_BOT = [5, 7];

function drawHaiku(fb, x, y, S) {
  fb.blit(HAIKU_BODY, x, y, S.lit ? undefined : UNLIT);
  const ph = S.phase, lit = S.lit, run = S.run, t = S.t, b = S.breath;
  // split-flap sorter: each window flips three times per cycle, staggered
  const paper = PAPER[lit ? 1 : 0], shade = lit ? C.TAN : C.SAND;
  for (let k = 0; k < 5; k++) {
    const s = ph * 3 + k * 0.29, n = Math.floor(s), f = s - n;
    const x0 = x + HK_FLAP_X + k * 8, y0 = y + HK_FLAP_Y;
    const cNew = hkCat(n, k), cOld = hkCat(n - 1, k);
    if (f >= 0.42) { cardRows(fb, x0, y0, cNew, 0, 8, paper); continue; }
    cardRows(fb, x0, y0, cNew, 0, 3, paper);
    cardRows(fb, x0, y0, cOld, 5, 8, paper);
    if (f < 0.14) flapRows(fb, x0, y0, cOld, FLAP_TOP, 2, shade);
    else if (f < 0.28) { fb.hline(x0, y0 + 4, 7, paper); fb.hline(x0, y0 + 5, 7, shade); }
    else flapRows(fb, x0, y0, cNew, FLAP_BOT, 5, shade);
  }
  // bins filling up with sorted cards
  for (let k = 0; k < 4; k++) {
    const h = Math.floor(ph * 0.75 + k * 1.37) % 5;
    const bx = x + HK_BIN_X + k * 10;
    for (let j = 0; j < h; j++) { fb.hline(bx + 1, y + 13 - j, 6, j & 1 ? PAPER2[lit ? 1 : 0] : paper); fb.px(bx + 1 + ((j + k) % 5), y + 13 - j, BIN_TAB[k]); }
  }
  // a card in flight from the window to its bin
  if (run) {
    const s = ph * 3, e = Math.floor(s), f = s - e;
    if (f < 0.6) {
      const bin = hkCat(e, 9), p = f / 0.6;
      const fx = 44 + (HK_BIN_X + 3 + bin * 10 - 44) * p, fy = 19 + (8 - 19) * p - Math.sin(p * Math.PI) * 6;
      fb.rect(x + Math.round(fx) - 1, y + Math.round(fy), 3, 1, C.CREAM);
      fb.px(x + Math.round(fx), y + Math.round(fy) + 1, C.TAN);
    }
  }
  if (lit) {
    // two rows of indicator lights
    const k8 = Math.floor(t * 8);
    for (let i = 0; i < 16; i++) {
      const col = i & 7;
      const on = run ? hash(i, k8 >> (i % 3 === 0 ? 1 : 0), 31) < 0.5 : i < 8 && (col & 1) === 0 && b > 0.4;
      if (on) fb.rect(x + 32 + col * 3, y + 32 + (i >> 3) * 2, 2, 1, run ? HK_ON[col] : C.GREEN_L);
    }
    ventGlow(fb, x + 31, y + 37, 26, 2, S);
    warnStrip(fb, x + 20, y + 42, 48, 2, S);
  }
  gauge(fb, x + 21, y + 32, S);
  fan(fb, x + 59, y + 32, S);
}

function wreckHaiku(g) {
  // charred cards blown out of the bins
  for (const [px, py] of [[24, 8], [33, 7], [47, 8], [55, 9], [40, 6]]) { g.hline(px, py, 3, C.SMOKE_D); g.px(px + 1, py + 1, INK); }
}

// =====================================================================================
// GENERIC: configurable cabinet for any other model
// =====================================================================================

// [dark, mid, light] shading ramp for every base colour (very dark colours are lifted so
// the cabinet never vanishes into its own outline, index 0 is never returned).
const RAMP = (() => {
  const T = {
    BLACK: ['NIGHT_D', 'STEEL_DD', 'STEEL_D'], INK: ['NIGHT_D', 'STEEL_DD', 'STEEL_D'],
    ROCK_D: ['INK', 'ROCK', 'ROCK_L'], ROCK: ['ROCK_D', 'ROCK', 'ROCK_L'], ROCK_L: ['ROCK', 'ROCK_L', 'DIRT'],
    DIRT: ['ROCK_L', 'DIRT', 'SAND'], SAND: ['DIRT', 'SAND', 'TAN'],
    STEEL_DD: ['NIGHT_D', 'STEEL_DD', 'STEEL_D'], STEEL_D: ['STEEL_DD', 'STEEL_D', 'STEEL'], STEEL: ['STEEL_D', 'STEEL', 'STEEL_L'],
    STEEL_L: ['STEEL', 'STEEL_L', 'STEEL_LL'], STEEL_LL: ['STEEL_L', 'STEEL_LL', 'WHITE'], WHITE: ['STEEL_LL', 'WHITE', 'WHITE'],
    WALL_D: ['ROCK_D', 'WALL_D', 'WALL'], WALL: ['WALL_D', 'WALL', 'WALL_L'], WALL_L: ['WALL', 'WALL_L', 'WOOD'],
    AMBER_D: ['COPPER_D', 'AMBER_D', 'AMBER'], AMBER: ['AMBER_D', 'AMBER', 'AMBER_L'], AMBER_L: ['AMBER', 'AMBER_L', 'CREAM'],
    CREAM: ['PACKAGE', 'CREAM', 'WHITE'],
    RED_D: ['ROCK_D', 'RED_D', 'RED'], RED: ['RED_D', 'RED', 'RED_L'], RED_L: ['RED', 'RED_L', 'ORANGE'],
    ORANGE: ['RED', 'ORANGE', 'YELLOW'], YELLOW: ['AMBER', 'YELLOW', 'CREAM'],
    GREEN_DD: ['NIGHT_D', 'GREEN_DD', 'GREEN_D'], GREEN_D: ['GREEN_DD', 'GREEN_D', 'GREEN'], GREEN: ['GREEN_D', 'GREEN', 'GREEN_L'],
    GREEN_L: ['GREEN', 'GREEN_L', 'MINT'], MINT: ['GREEN_L', 'MINT', 'WHITE'],
    TEAL_D: ['NIGHT_D', 'TEAL_D', 'TEAL'], TEAL: ['TEAL_D', 'TEAL', 'CYAN'], CYAN: ['TEAL', 'CYAN', 'CYAN_L'], CYAN_L: ['CYAN', 'CYAN_L', 'WHITE'],
    BLUE_D: ['NIGHT_D', 'BLUE_D', 'BLUE'], BLUE: ['BLUE_D', 'BLUE', 'BLUE_L'], BLUE_L: ['BLUE', 'BLUE_L', 'SKY'], SKY: ['BLUE_L', 'SKY', 'WHITE'],
    VIOLET_D: ['NIGHT_D', 'VIOLET_D', 'VIOLET'], VIOLET: ['VIOLET_D', 'VIOLET', 'VIOLET_L'], VIOLET_L: ['VIOLET', 'VIOLET_L', 'PINK'], PINK: ['VIOLET_L', 'PINK', 'WHITE'],
    COPPER_D: ['ROCK_D', 'COPPER_D', 'COPPER'], COPPER: ['COPPER_D', 'COPPER', 'COPPER_L'], COPPER_L: ['COPPER', 'COPPER_L', 'AMBER_L'], BRASS: ['AMBER_D', 'BRASS', 'AMBER_L'],
    TAN: ['WOOD', 'TAN', 'PACKAGE'], LEATHER: ['WALL_D', 'LEATHER', 'COPPER'], WOOD: ['WALL', 'WOOD', 'TAN'],
    SMOKE_D: ['STEEL_DD', 'SMOKE_D', 'SMOKE'], SMOKE: ['SMOKE_D', 'SMOKE', 'SMOKE_L'], SMOKE_L: ['SMOKE', 'SMOKE_L', 'STEEL_LL'],
    GLASS: ['TEAL_D', 'GLASS', 'GLASS_L'], GLASS_L: ['GLASS', 'GLASS_L', 'CYAN_L'],
    NIGHT_D: ['INK', 'NIGHT', 'DUSK'], NIGHT: ['NIGHT_D', 'NIGHT', 'BLUE'], DUSK: ['NIGHT', 'DUSK', 'VIOLET'], MOON: ['PACKAGE', 'MOON', 'WHITE'],
    GRASS_D: ['GREEN_DD', 'GRASS_D', 'GRASS'], GRASS: ['GRASS_D', 'GRASS', 'GREEN'],
    CRATE: ['WOOD', 'CRATE', 'TAN'], PACKAGE: ['TAN', 'PACKAGE', 'CREAM'], HAZARD: ['AMBER', 'HAZARD', 'YELLOW'], MAGENTA: ['VIOLET', 'MAGENTA', 'PINK'],
  };
  const r = [];
  for (const [name, idx] of Object.entries(C)) r[idx] = (T[name] ?? ['STEEL_D', 'STEEL', 'STEEL_L']).map((n) => C[n]);
  return r;
})();

/** Perceived brightness 0..255 of a base colour. */
const LUM = BASE_HEX.map((h) => 0.299 * parseInt(h.slice(1, 3), 16) + 0.587 * parseInt(h.slice(3, 5), 16) + 0.114 * parseInt(h.slice(5, 7), 16));
/** Indicator colours for an accent: [off, glow, on]. Accents too dark to glow fall back to amber. */
function lampsFor(c) {
  const [d, m, l] = RAMP[c];
  if (LUM[l] < 90) return [C.AMBER_D, C.AMBER, C.AMBER_L];
  return [LUM[d] < 20 ? C.STEEL_D : d, LUM[m] >= 110 ? m : l, LUM[m] >= 110 ? (l === m ? C.WHITE : l) : l];
}

const LAMPS = RAMP.map((_, i) => lampsFor(i));

function genericStyle(st) {
  if (!st) return [C.STEEL, C.AMBER, 0];
  const a = (st.accent | 0) & 63, a2 = (st.accent2 | 0) & 63;
  const v = (((st.variant | 0) % 4) + 4) % 4;
  return [a, a2, v];
}

function buildGeneric(a, a2, v) {
  const g = new Framebuffer(W, H);
  const [A0, A1, A2] = RAMP[a], [T0, T1, T2] = RAMP[a2];
  const [L0] = LAMPS[a2];
  // plinth
  g.rect(1, 43, 86, 5, INK);
  g.hline(2, 44, 84, C.STEEL);
  hazardStrip(g, 2, 45, 84, 2, C.AMBER_D, C.STEEL_DD);
  for (const left of [true, false]) {
    mbox(g, left, 0, 10, 13, 34, C.STEEL_D, C.STEEL, C.STEEL_DD);
    hatch(g, left, C.STEEL_LL, C.STEEL);
    mrect(g, left, 1, 26, 11, 2, T1); mrect(g, left, 1, 26, 11, 1, T2);
    for (const ry of [31, 39]) { mrect(g, left, 2, ry, 1, 1, C.STEEL_L); mrect(g, left, 10, ry, 1, 1, C.STEEL_L); }
    mbox(g, left, 3, 32, 7, 6, C.STEEL, C.STEEL_L, C.STEEL_D);
    mrect(g, left, 5, 34, 3, 1, INK);
    flange(g, left);
    mrect(g, left, 2, 5, 6, 5, INK); mrect(g, left, 3, 9, 5, 2, INK);
    mrect(g, left, 2, 6, 5, 1, C.STEEL_L); mrect(g, left, 2, 7, 5, 1, C.STEEL); mrect(g, left, 2, 8, 2, 1, C.STEEL_D);
    mrect(g, left, 4, 8, 1, 2, C.STEEL_L); mrect(g, left, 5, 8, 1, 2, C.STEEL); mrect(g, left, 6, 8, 1, 2, C.STEEL_D);
  }
  // cabinet in the accent colour, a steel cap and an accent2 trim band
  box(g, 12, 17, 64, 27, A1, A2, A0);
  g.rect(10, 15, 68, 3, INK);
  g.hline(11, 16, 66, C.STEEL_L);
  g.rect(13, 31, 62, 2, T1); g.hline(13, 31, 62, T2);
  g.hline(13, 33, 62, A0);
  // screen, lamp row, knobs, work meter
  box(g, 16, 19, 22, 10, C.NIGHT_D);
  g.px(17, 20, C.GLASS);
  for (let i = 0; i < 8; i++) { g.rect(40 + i * 4, 19, 4, 4, INK); g.rect(41 + i * 4, 20, 2, 2, L0); }
  for (const kx of [44, 52]) { g.disc(kx, 26, 2, INK); g.disc(kx, 26, 1, C.STEEL_L); g.px(kx, 25, C.STEEL_LL); }
  g.rect(58, 24, 15, 5, INK); g.rect(59, 25, 13, 3, A0); g.hline(60, 26, 11, INK);
  // lower deck: gauge, vents, access hatch, fan
  gaugeFace(g, 15, 34);
  ventBody(g, 26, 35, 24, 3);
  box(g, 52, 34, 10, 9, A1, A2, A0); g.rect(55, 38, 4, 1, INK);
  fanHousing(g, 64, 34);

  // top unit: the variant
  if (v === 0) {                 // transmitter with a lattice mast and two whips
    box(g, 30, 9, 28, 7, A1, A2, A0);
    for (let i = 0; i < 10; i++) { g.px(33 + i * 2, 11, INK); g.px(33 + i * 2, 12, INK); }
    g.rect(32, 13, 4, 1, T1);
    for (let j = 0; j < 7; j++) {
      const hw = 1 + (j >> 1);
      g.px(44 - hw, 3 + j, INK); g.px(44 + hw, 3 + j, INK);
      if (j & 1) g.hline(45 - hw, 3 + j, hw * 2 - 1, C.STEEL_L);
      else if (hw > 1) { g.px(44, 3 + j, C.STEEL); }
    }
    g.disc(44, 1, 1, INK); g.px(44, 1, L0);
    g.line(33, 8, 30, 1, C.STEEL_L); g.px(30, 0, INK); g.px(33, 8, INK);
    g.line(55, 8, 57, 3, C.STEEL_L); g.px(57, 2, INK); g.px(55, 8, INK);
  } else if (v === 1) {          // pressure tank with a sight glass
    g.disc(27, 8, 5, INK); g.disc(60, 8, 5, INK); g.rect(27, 3, 34, 11, INK);
    g.disc(27, 8, 4, A1); g.disc(60, 8, 4, A1); g.rect(27, 4, 34, 9, A1);
    g.hline(25, 5, 37, A2); g.px(24, 6, A2); g.hline(25, 11, 38, A0); g.hline(27, 12, 34, A0);
    for (const bx of [33, 54]) { g.vline(bx, 4, 9, C.STEEL); g.vline(bx + 1, 4, 9, C.STEEL_D); g.px(bx, 4, C.STEEL_L); }
    g.rect(38, 6, 12, 5, INK); g.rect(39, 7, 10, 3, C.GLASS);
    g.rect(29, 13, 5, 2, INK); g.rect(55, 13, 5, 2, INK);
    g.vline(47, 1, 2, INK); g.hline(45, 0, 5, C.STEEL_L); g.px(45, 0, INK); g.px(49, 0, INK);
  } else if (v === 2) {          // louvred exhaust hood with turbine stacks
    g.rect(24, 7, 40, 9, INK);
    g.rect(25, 8, 38, 7, A1); g.hline(25, 8, 38, A2);
    ventBody(g, 27, 8, 34, 3);
    for (const sx of [29, 54]) { g.rect(sx, 3, 5, 5, INK); g.rect(sx + 1, 3, 3, 4, C.STEEL); g.vline(sx + 1, 3, 4, C.STEEL_L); g.vline(sx + 3, 3, 4, C.STEEL_D); }
  } else {                       // dish on a turntable
    g.rect(38, 11, 13, 5, INK); g.rect(39, 12, 11, 3, C.STEEL); g.hline(39, 12, 11, C.STEEL_L); g.hline(39, 14, 11, C.STEEL_D);
    g.rect(42, 8, 5, 4, INK); g.rect(43, 9, 3, 2, C.STEEL); g.px(43, 9, C.STEEL_L);
  }
  return g;
}

const GEN_CACHE = new Map();
const GENERIC_SOOT = sootMask(44, 22, 24, 11);

function drawGeneric(fb, x, y, S) {
  const [a, a2, v] = genericStyle(S.style);
  const key = a | (a2 << 6) | (v << 12);
  let spr = GEN_CACHE.get(key);
  if (!spr) {
    if (GEN_CACHE.size >= 48) GEN_CACHE.clear();
    spr = toSprite(buildGeneric(a, a2, v));
    GEN_CACHE.set(key, spr);
  }
  fb.blit(spr, x, y);
  const ph = S.phase, lit = S.lit, run = S.run, t = S.t, b = S.breath;
  const [L0, L1, L2] = LAMPS[a2];
  const [T0, T1] = RAMP[a2];

  // top unit motion
  if (v === 0) {
    fb.px(x + 44, y + 1, lit ? (run ? (Math.floor(t * 2) & 1 ? L2 : L1) : b > 0.5 ? L1 : L0) : L0);
    if (run) {
      const r = 3 + (Math.floor(ph * 3) % 3) * 2;
      for (const sd of [-1, 1]) { fb.px(x + 44 + sd * r, y + 1, L1); fb.px(x + 44 + sd * (r - 1), y, L1); fb.px(x + 44 + sd * (r - 1), y + 2, L1); }
    }
  } else if (v === 1) {
    const lvl = 1 + Math.round(1 + Math.sin(ph * TAU));
    fb.rect(x + 39, y + 10 - lvl, 10, lvl, lit ? T1 : T0);
    if (lit) fb.hline(x + 39, y + 10 - lvl, 10, L1);
    if (run) { const bx = 40 + Math.floor(hash(Math.floor(ph * 4), 3) * 8); fb.px(x + bx, y + 9 - Math.floor(fract(ph * 4) * lvl), L2); }
  } else if (v === 2) {
    const f = Math.floor(ph * 6) & 1;
    for (const sx of [29, 54]) {
      fb.rect(x + sx - 1, y, 7, 4, INK);
      for (let i = 0; i < 5; i++) fb.vline(x + sx + i, y + 1, 2, (i + f) & 1 ? C.STEEL_L : C.STEEL);
      fb.hline(x + sx, y, 5, INK);
    }
    if (lit) ventGlow(fb, x + 27, y + 8, 34, 3, S);
  } else {
    drawDish(fb, x, y, 0.42 * Math.sin(ph * TAU * 0.25), lit ? (run && (Math.floor(t * 3) & 1) ? L2 : L1) : L0);
  }

  if (lit) {
    // screen: scrolling text while working, a prompt with a slow cursor when idle
    fb.rect(x + 17, y + 20, 20, 8, C.NIGHT_D);
    if (run) {
      const sc = Math.floor(ph * 4);
      for (let r = 0; r < 4; r++) {
        const len = 4 + Math.floor(hash(sc + r, 7) * 14);
        fb.hline(x + 18, y + 21 + r * 2, len, r === 3 ? L2 : L1);
        if (hash(sc + r, 8) < 0.4) fb.hline(x + 18 + len + 1, y + 21 + r * 2, 2, L0);
      }
      if (Math.floor(t * 3) & 1) fb.px(x + 35, y + 27, L2);
    } else {
      fb.hline(x + 18, y + 21, 3, L1);
      if (b > 0.5) fb.rect(x + 22, y + 21, 2, 1, L2);
    }
    // lamp row
    const chase = Math.floor(ph * 8) & 7, k5 = Math.floor(t * 5);
    for (let i = 0; i < 8; i++) {
      const on = run ? i === chase || hash(i, k5, 51) < 0.3 : b > 0.5 && (i & 1) === 0;
      if (on) { fb.rect(x + 41 + i * 4, y + 20, 2, 2, L1); fb.px(x + 41 + i * 4, y + 20, L2); }
    }
    // work meter
    const bar = run ? 2 + Math.floor((0.5 + 0.5 * Math.sin(ph * TAU * 2)) * 9) : 1;
    fb.hline(x + 60, y + 26, bar, S.tier > 0 ? C.RED_L : L1);
    ventGlow(fb, x + 26, y + 35, 24, 3, S);
    warnStrip(fb, x + 2, y + 45, 84, 2, S);
  }
  gauge(fb, x + 15, y + 34, S);
  fan(fb, x + 64, y + 34, S);
}

/** Parabolic dish tilted by ang (radians) about its pivot at local (44, 9). */
function drawDish(fb, x, y, ang, knob) {
  const ca = Math.cos(ang), sa = Math.sin(ang), px0 = x + 44, py0 = y + 9;
  const P = (u, d) => [Math.round(px0 + u * ca + d * sa), Math.round(py0 + u * sa - d * ca)];
  for (let pass = 0; pass < 2; pass++) {
    for (let u = -8; u <= 8; u += 0.5) {
      const d = 1 + (u * u) / 13;
      for (const dd of [0, 0.8]) {
        const [qx, qy] = P(u, d - dd);
        if (pass === 0) fb.rect(qx - 1, qy - 1, 3, 3, INK);
        else fb.px(qx, qy, dd ? C.STEEL : u < 0 ? C.STEEL_LL : C.STEEL_L);
      }
    }
  }
  const [hx, hy] = P(0, 6);
  walk(px0, py0 - 1, hx, hy, (qx, qy) => fb.px(qx, qy, C.STEEL_D));
  fb.rect(hx - 1, hy - 1, 3, 3, INK); fb.px(hx, hy, knob);
}

function wreckGeneric(g) {
  g.line(19, 21, 24, 25, C.STEEL); g.line(24, 25, 22, 28, C.STEEL); g.line(24, 25, 30, 23, C.STEEL);
}

// =====================================================================================
// Dispatch
// =====================================================================================

const DESIGNS = {
  fable: { draw: drawFable, soot: FABLE_SOOT, wreck: wreckFable },
  opus: { draw: drawOpus, soot: OPUS_SOOT, wreck: wreckOpus },
  sonnet: { draw: drawSonnet, soot: SONNET_SOOT, wreck: wreckSonnet },
  haiku: { draw: drawHaiku, soot: HAIKU_SOOT, wreck: wreckHaiku },
  generic: { draw: drawGeneric, soot: GENERIC_SOOT, wreck: wreckGeneric },
};

/**
 * Draw one model machine, 88x48, anchored bottom-centre at (cx, floorY).
 * @param {import('./fb.mjs').Framebuffer} fb
 * @param {number} cx
 * @param {number} floorY
 * @param {'fable'|'opus'|'sonnet'|'haiku'|'generic'} design
 * @param {number} t   seconds, monotonically increasing (blinks, idle breathing)
 * @param {MachineLook} m
 */
export function drawMachine(fb, cx, floorY, design, t, m) {
  const x = Math.round(cx - W / 2), y = Math.round(floorY - H);
  const d = DESIGNS[design] ?? DESIGNS.generic;
  const status = m.status;
  const lit = status === 'idle' || status === 'running' || status === 'hot';
  const run = status === 'running' || status === 'hot';
  const heat = clamp01(+m.heat || 0);
  const phase = +m.phase || 0;
  const hot = run && (status === 'hot' || heat >= 0.6);
  const S = {
    lit, run,
    tier: hot ? (heat >= 0.87 ? 3 : heat >= 0.73 ? 2 : 1) : 0,     // heat tells: 0 none .. 3 at the limit
    t: lit ? +t || 0 : 0,
    phase,
    breath: lit ? 0.5 + 0.5 * Math.sin((+t || 0) * 1.6) : 0,
    gauge: lit ? heat : status === 'fire' ? 1 : 0,
    heat: lit ? heat : 0,
    speed: lit ? clamp01(+m.speed || 0) : 0,
    style: m.style ?? null,
  };

  // never paint outside the 88x48 box, whatever clip the world already has
  const c0 = fb.cx0, c1 = fb.cy0, c2 = fb.cx1, c3 = fb.cy1;
  fb.cx0 = Math.max(c0, x); fb.cy0 = Math.max(c1, y); fb.cx1 = Math.min(c2, x + W); fb.cy1 = Math.min(c3, y + H);
  if (status === 'fire') {
    SCRATCH.buf.fill(0);
    d.draw(SCRATCH, 0, 0, S);
    burn(d.soot);
    d.wreck(SCRATCH, S);
    fb.blit(SCRATCH_SPR, x, y);
  } else {
    d.draw(fb, x, y, S);
  }
  fb.cx0 = c0; fb.cy0 = c1; fb.cx1 = c2; fb.cy1 = c3;
}
