// Power plant: central reactor, session switchboard, backup generator.
// Names, signatures and sizes are the contract.
//
// How the art is built: every static body is painted once at module load into an
// offscreen Framebuffer with primitives ("baked") and blitted as a sprite; only the
// moving / glowing bits (plasma, needles, wheels, lamps, pipes that shake) are drawn
// per frame. Light comes from the top-left; outlines are C.INK; index 0 is transparent
// in sprites, so nothing here ever paints C.BLACK.
import { C } from './palette.mjs';
import { Framebuffer, hash } from './fb.mjs';
import { drawText } from './font.mjs';
import { drawSteam } from './fx.mjs';
import { SWITCHBOARD_W, SWITCHBOARD_H, GENERATOR_W, GENERATOR_H, FLOOR_T, WALL_T } from './geom.mjs';

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const frac = (v) => v - Math.floor(v);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];

// Material ramps: [highlight, light, mid, dark, deep]
const M_STEEL = [C.STEEL_LL, C.STEEL_L, C.STEEL, C.STEEL_D, C.STEEL_DD];
const M_COPPER = [C.COPPER_L, C.COPPER_L, C.COPPER, C.COPPER_D, C.COPPER_D];
const M_GREEN = [C.GREEN_L, C.GREEN_L, C.GREEN, C.GREEN_D, C.GREEN_DD];
const M_TAN = [C.PACKAGE, C.PACKAGE, C.TAN, C.SAND, C.DIRT];
const M_OLIVE = [C.GRASS, C.GRASS, C.GRASS_D, C.GREEN_DD, C.GREEN_DD];
const M_NAVY = [C.BLUE_L, C.BLUE, C.BLUE_D, C.NIGHT, C.NIGHT_D];
const M_HAZ = [C.CREAM, C.YELLOW, C.HAZARD, C.AMBER, C.AMBER_D];
const M_RED = [C.RED_L, C.RED_L, C.RED, C.RED_D, C.RED_D];

/** Paint into an offscreen buffer once and wrap it as a sprite for fb.blit. */
function bake(w, h, paint) {
  const f = new Framebuffer(w, h);
  paint(f);
  return { w, h, data: f.buf };
}

// Cylinder shading across its width: 0 = lit edge of the round .. 1 = far side.
const cyl = (u) => (u < 0.12 ? 2 : u < 0.24 ? 1 : u < 0.36 ? 0 : u < 0.48 ? 1 : u < 0.74 ? 2 : u < 0.9 ? 3 : 4);

/** Upright cylinder body (no outline), shaded by column. */
function vcyl(f, x, y, w, h, m) {
  for (let i = 0; i < w; i++) f.rect(x + i, y, 1, h, m[cyl((i + 0.5) / w)]);
}
/** Lying cylinder body (no outline), shaded by row. */
function hcyl(f, x, y, w, h, m) {
  for (let i = 0; i < h; i++) f.rect(x, y + i, w, 1, m[cyl((i + 0.5) / h)]);
}
/** Outlined bevelled box: lit top and left, shaded bottom and right. */
function box(f, x, y, w, h, m) {
  f.rect(x, y, w, h, C.INK);
  f.rect(x + 1, y + 1, w - 2, h - 2, m[2]);
  f.rect(x + 1, y + 1, w - 2, 1, m[1]);
  f.rect(x + 1, y + 1, 1, h - 2, m[1]);
  f.rect(x + 1, y + h - 2, w - 2, 1, m[3]);
  f.rect(x + w - 2, y + 1, 1, h - 2, m[3]);
}
/** Outlined round face with a lit upper-left rim and a shaded lower-right rim. */
function wheel(f, cx, cy, r, m) {
  f.disc(cx, cy, r, C.INK);
  f.disc(cx, cy, r - 1, m[2]);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > (r - 1) * (r - 1) + (r - 1) || d2 < (r - 2) * (r - 2) + (r - 2)) continue;
      if (dx + dy < -r * 0.5) f.px(cx + dx, cy + dy, m[1]);
      else if (dx + dy > r * 0.5) f.px(cx + dx, cy + dy, m[3]);
    }
  }
}
/** Small round dial face (ink ring, cream face). Needles are drawn live. */
function dialFace(f, cx, cy, r) {
  f.disc(cx, cy, r, C.INK);
  f.disc(cx, cy, r - 1, C.CREAM);
  f.px(cx + r - 2, cy - r + 2, C.RED);                // red zone at the top-right
  if (r > 3) f.px(cx + r - 1, cy - 1, C.RED);
}
/** Rounded dome on top of an upright tank: rows of ink with a shaded interior. */
function domeTop(f, x, y, w, rows, m) {
  for (let j = 0; j < rows; j++) {
    const k = (rows - j - 0.5) / rows;                // 1 at the top row .. 0 at the bottom
    const inset = Math.round((w / 2 - 2) * (1 - Math.sqrt(1 - k * k)));
    f.rect(x + inset, y + j, w - inset * 2, 1, C.INK);
    if (j > 0) for (let i = inset + 1; i < w - inset - 1; i++) f.px(x + i, y + j, m[cyl((i + 0.5) / w)]);
  }
}

// --- live helpers (draw straight into the frame) ---

/** Gauge needle: v 0..1 sweeps from lower-left over the top to lower-right. */
function needle(fb, cx, cy, r, v, c) {
  const a = Math.PI * (1.25 - 1.5 * clamp01(v));
  fb.line(cx, cy, cx + Math.round(Math.cos(a) * r), cy - Math.round(Math.sin(a) * r), c);
}
/** n spokes turning with `turns` (in revolutions); the first one gets a bright tip. */
function spokes(fb, cx, cy, r, turns, n, c, tip) {
  for (let i = n - 1; i >= 0; i--) {
    const a = (turns + i / n) * TAU;
    const ex = cx + Math.round(Math.cos(a) * r), ey = cy + Math.round(Math.sin(a) * r);
    fb.line(cx, cy, ex, ey, c);
    if (i === 0 && tip !== undefined) fb.px(ex, ey, tip);
  }
}

const PIPE_COOL = [C.SKY, C.BLUE_L, C.BLUE, C.BLUE_D];
const PIPE_STEAM = [C.CREAM, C.COPPER_L, C.COPPER, C.COPPER_D];

/** Horizontal 5px pipe centred on row y, from x0 to x1 inclusive. flow: dash offset or null. */
function hpipe(fb, x0, x1, y, m, flow) {
  if (x1 < x0) { const s = x0; x0 = x1; x1 = s; }
  const len = x1 - x0 + 1;
  fb.rect(x0, y - 2, len, 5, C.INK);
  fb.rect(x0, y - 1, len, 1, m[1]);
  fb.rect(x0, y, len, 1, m[2]);
  fb.rect(x0, y + 1, len, 1, m[3]);
  if (flow !== null) {
    for (let x = x0 + ((((flow - x0) % 8) + 8) % 8); x < x1; x += 8) fb.rect(x, y, 2, 1, m[0]);
  }
}
/** Vertical 5px pipe centred on column x, from y0 to y1 inclusive. */
function vpipe(fb, x, y0, y1, m, flow) {
  if (y1 < y0) { const s = y0; y0 = y1; y1 = s; }
  const len = y1 - y0 + 1;
  fb.rect(x - 2, y0, 5, len, C.INK);
  fb.rect(x - 1, y0, 1, len, m[1]);
  fb.rect(x, y0, 1, len, m[2]);
  fb.rect(x + 1, y0, 1, len, m[3]);
  if (flow !== null) {
    for (let y = y0 + ((((flow - y0) % 8) + 8) % 8); y < y1; y += 8) fb.rect(x, y, 1, 2, m[0]);
  }
}
/** Bolted steel collar around a horizontal pipe at column x (3px wide). */
function hcollar(fb, x, y) {
  fb.rect(x - 1, y - 3, 3, 7, C.INK);
  fb.px(x, y - 2, C.STEEL_LL); fb.px(x, y - 1, C.STEEL_L); fb.px(x, y, C.STEEL);
  fb.px(x, y + 1, C.STEEL_D); fb.px(x, y + 2, C.STEEL_D);
}
/** Bolted steel collar around a vertical pipe at row y (3px tall). */
function vcollar(fb, x, y) {
  fb.rect(x - 3, y - 1, 7, 3, C.INK);
  fb.px(x - 2, y, C.STEEL_LL); fb.px(x - 1, y, C.STEEL_L); fb.px(x, y, C.STEEL);
  fb.px(x + 1, y, C.STEEL_D); fb.px(x + 2, y, C.STEEL_D);
}
/** Elbow block where a horizontal and a vertical pipe meet. */
function elbow(fb, x, y, m) {
  fb.rect(x - 3, y - 3, 7, 7, C.INK);
  fb.rect(x - 2, y - 2, 5, 5, m[2]);
  fb.rect(x - 2, y - 2, 4, 1, m[1]); fb.rect(x - 2, y - 2, 1, 4, m[1]);
  fb.rect(x - 1, y + 2, 4, 1, m[3]); fb.rect(x + 2, y - 1, 1, 4, m[3]);
  fb.px(x, y, C.INK);
}

// ---------------------------------------------------------------------------------------
// Reactor core
// ---------------------------------------------------------------------------------------

/**
 * Where the world attaches effects in the reactor hall, relative to the hall's
 * centre x and its floor line. fire: flame bases; smoke: smoke origins; lamps: beacons.
 *
 * fire[0]  the breach across the head of the vessel (the big eruption);
 * fire[1..] the burst coolant / condensate joints on the two side pylons.
 * smoke[0] the exhaust cap on top of the core; smoke[1..] the pylon tops.
 * lamps    beacon centres: they sit on the two lamp posts either side of the core
 *          (fx drawBeacon puts its base plate at cy+2; the post top is at cy+3).
 * These are identical in the 448 and 232 layouts.
 */
export const REACTOR_ANCHORS = {
  coreW: 56, coreH: 62,
  fire: [[0, -40], [-30, -29], [30, -29]],
  smoke: [[0, -62], [-24, -46], [24, -46]],
  lamps: [[-38, -58], [38, -58]],
};

const CORE_W = 56, CORE_H = 62;
const PAD = 14;                        // the lamp arms stick out past the 56px core box
const VX = 28, VY = 31, VR = 10;       // viewport centre / glass radius, core-local

const UP_H = 69;                       // overhead pipe run: centre height above the floor
const MID_H = 26;                      // waist-level pipe run
const RISER_DX = 13;                   // where the two risers leave the dome

// Dome silhouette: half-width of each row, core-local y 3..11.
const DOME_Y0 = 3, DOME_HW = [];
for (let y = 3; y <= 11; y++) DOME_HW.push(Math.round(20 * Math.sqrt(1 - Math.pow((12 - y) / 9.6, 2))));

function paintArms(f) {
  const X = PAD;
  // lamp arms: beam out of the pylon, post, seat plate, diagonal brace
  for (const s of [-1, 1]) {
    const pc = X + 28 + s * 38;                        // post centre column
    const b0 = s < 0 ? pc - 2 : X + 54, b1 = s < 0 ? X + 2 : pc + 2;
    f.rect(b0, 18, b1 - b0 + 1, 4, C.INK);
    f.rect(b0 + 1, 19, b1 - b0 - 1, 1, C.STEEL_L);
    f.rect(b0 + 1, 20, b1 - b0 - 1, 1, C.STEEL_D);
    for (let k = 0; k < 8; k++) {                      // brace
      const bx = s < 0 ? pc + 2 + k : pc - 2 - k;
      f.rect(bx - 1, 21 + k, 3, 2, C.INK);
    }
    for (let k = 0; k < 8; k++) f.px(s < 0 ? pc + 2 + k : pc - 2 - k, 21 + k, C.STEEL);
    f.rect(pc - 2, 8, 5, 13, C.INK);
    f.rect(pc - 1, 9, 1, 11, C.STEEL_L); f.rect(pc, 9, 1, 11, C.STEEL); f.rect(pc + 1, 9, 1, 11, C.STEEL_D);
    f.rect(pc - 3, 7, 7, 2, C.INK); f.rect(pc - 2, 7, 5, 1, C.STEEL_L);
    for (let y = 11; y < 19; y += 3) f.px(pc, y, C.STEEL_DD);   // rivets
  }
}

function paintCore(f, melt) {
  const X = PAD;
  // -- side pylons (coolant jackets) with louvred vents
  for (const xi of [2, 49]) {
    f.rect(X + xi - 1, 16, 8, 36, C.INK);
    f.rect(X + xi, 17, 6, 34, C.STEEL_D);
    f.rect(X + xi, 17, 6, 1, C.STEEL_L);
    f.rect(X + xi, 18, 1, 33, C.STEEL);
    f.rect(X + xi + 5, 18, 1, 33, C.STEEL_DD);
    for (let k = 0; k < 4; k++) {
      f.rect(X + xi + 1, 20 + k * 3, 4, 1, C.STEEL_L);
      f.rect(X + xi + 1, 21 + k * 3, 4, 1, C.STEEL);
      f.rect(X + xi + 1, 22 + k * 3, 4, 1, C.INK);
    }
    f.px(X + xi + 1, 42, C.STEEL_DD); f.px(X + xi + 4, 42, C.STEEL_DD);
    f.px(X + xi + 1, 46, C.STEEL_DD); f.px(X + xi + 4, 46, C.STEEL_DD);
  }
  // collars where the waist pipes enter the pylons
  for (const cxl of [-1, 57]) {
    const y = CORE_H - MID_H;
    f.rect(X + cxl - 1, y - 3, 3, 7, C.INK);
    f.px(X + cxl, y - 2, C.STEEL_LL); f.px(X + cxl, y - 1, C.STEEL_L); f.px(X + cxl, y, C.STEEL);
    f.px(X + cxl, y + 1, C.STEEL_D); f.px(X + cxl, y + 2, C.STEEL_D);
  }
  // -- plinth with hazard stripes (the readout window is drawn live)
  f.rect(X + 3, 51, 51, 11, C.INK);
  f.rect(X + 4, 52, 49, 9, C.STEEL_D);
  f.rect(X + 4, 52, 49, 1, C.STEEL_L);
  f.rect(X + 4, 60, 49, 1, C.STEEL_DD);
  for (const hx of [6, 40]) {
    for (let y = 54; y < 59; y++) for (let x = hx; x < hx + 11; x++) f.px(X + x, y, ((x + y) % 6) < 3 ? C.HAZARD : C.INK);
    f.frame(X + hx - 1, 53, 13, 7, C.INK);
  }
  f.rect(X + 18, 52, 21, 9, C.INK);
  // -- pressure vessel body
  f.rect(X + 8, 12, 41, 39, C.INK);
  vcyl(f, X + 9, 13, 39, 37, M_STEEL);
  f.rect(X + 21, 15, 1, 33, C.STEEL_D);               // plate seams
  f.rect(X + 38, 15, 1, 33, C.STEEL_DD);
  // -- dome
  for (let i = 0; i < DOME_HW.length; i++) {
    const y = DOME_Y0 + i, hw = DOME_HW[i];
    f.rect(X + 28 - hw, y, hw * 2 + 1, 1, C.INK);
    if (i === 0) continue;
    for (let x = 28 - hw + 1; x <= 28 + hw - 1; x++) {
      const b = -((x - 28) / 20) * 0.75 + ((12 - y) / 9) * 0.45;
      f.px(X + x, y, b > 0.62 ? C.STEEL_LL : b > 0.3 ? C.STEEL_L : b > -0.2 ? C.STEEL : b > -0.5 ? C.STEEL_D : C.STEEL_DD);
    }
  }
  f.px(X + 19, 8, C.STEEL_DD); f.px(X + 28, 6, C.STEEL_D); f.px(X + 37, 8, C.STEEL_DD);   // dome rivets
  // exhaust cap
  f.rect(X + 23, 0, 11, 3, C.INK);
  f.rect(X + 24, 1, 9, 1, C.STEEL_L);
  for (let x = 25; x < 33; x += 2) f.px(X + x, 1, C.STEEL_D);
  // riser collars on the dome shoulders
  for (const rx of [28 - RISER_DX, 28 + RISER_DX]) {
    f.rect(X + rx - 3, 3, 7, 4, C.INK);
    f.px(X + rx - 2, 4, C.STEEL_LL); f.px(X + rx - 1, 4, C.STEEL_L); f.px(X + rx, 4, C.STEEL);
    f.px(X + rx + 1, 4, C.STEEL_D); f.px(X + rx + 2, 4, C.STEEL_D);
    f.rect(X + rx - 2, 5, 5, 1, C.STEEL_D);
  }
  // -- copper flange bands
  for (const fy of [12, 48]) {
    f.rect(X + 7, fy - 1 + 1, 43, 3, C.INK);
    f.rect(X + 8, fy, 41, 1, C.COPPER_L);
    f.rect(X + 8, fy + 1, 41, 1, C.COPPER);
    f.rect(X + 8, fy + 2, 41, 1, C.COPPER_D);
    f.rect(X + 7, fy - 1, 43, 1, C.INK); f.rect(X + 7, fy + 3, 43, 1, C.INK);
    f.rect(X + 30, fy, 19, 1, C.COPPER); f.rect(X + 40, fy + 1, 9, 1, C.COPPER_D);
    for (let x = 10; x < 48; x += 4) { f.px(X + x, fy + 1, C.COPPER_D); f.px(X + x, fy, C.CREAM); }
  }
  // corner rivets
  for (const [rx, ry] of [[11, 18], [45, 18], [11, 44], [45, 44]]) { f.px(X + rx, ry, C.STEEL_DD); f.px(X + rx - 1, ry - 1, C.STEEL_LL); }
  // -- viewport: brass rim with bolts around the glass (plasma drawn live)
  f.disc(X + VX, VY, VR + 4, C.INK);
  f.disc(X + VX, VY, VR + 3, C.BRASS);
  for (let dy = -VR - 3; dy <= VR + 3; dy++) {
    for (let dx = -VR - 3; dx <= VR + 3; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > (VR + 3) * (VR + 3) + VR + 3 || d2 <= (VR + 1) * (VR + 1) + VR + 1) continue;
      if (dx + dy < -7) f.px(X + VX + dx, VY + dy, C.AMBER_L);
      else if (dx + dy > 7) f.px(X + VX + dx, VY + dy, C.AMBER_D);
    }
  }
  f.disc(X + VX, VY, VR + 1, C.INK);
  f.disc(X + VX, VY, VR, C.TEAL_D);
  for (let k = 0; k < 8; k++) {
    const a = (k + 0.5) * (TAU / 8);
    const bx = X + VX + Math.round(Math.cos(a) * (VR + 2.5)), by = VY + Math.round(Math.sin(a) * (VR + 2.5));
    f.px(bx, by, C.COPPER_D);
  }
  if (melt) damageCore(f);
}

// Meltdown: soot, a gash across the head of the vessel (where the fire comes out),
// cracks running down to the plinth, a torn flange. Shapes carry it: under emergency
// lighting hue is gone, so damage is ink against mid-tone metal.
const SOOT = { [C.STEEL_LL]: C.STEEL, [C.STEEL_L]: C.STEEL_D, [C.STEEL]: C.STEEL_D, [C.STEEL_D]: C.STEEL_DD, [C.COPPER_L]: C.COPPER_D, [C.COPPER]: C.COPPER_D, [C.CREAM]: C.COPPER, [C.BRASS]: C.AMBER_D, [C.AMBER_L]: C.BRASS };
function damageCore(f) {
  const X = PAD;
  for (let y = 0; y < 34; y++) {
    const p = y < 20 ? 0.95 : 0.95 * (1 - (y - 20) / 14);
    for (let x = 8; x < 49; x++) {
      const c = f.get(X + x, y);
      if (SOOT[c] !== undefined && hash(x, y, 5) < p) f.px(X + x, y, SOOT[c]);
    }
  }
  const crack = (pts, glow) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      if (glow) f.line(X + x0 + 1, y0, X + x1 + 1, y1, C.RED_D);
      f.line(X + x0, y0, X + x1, y1, C.INK);
    }
  };
  // the breach: a jagged gash right across the vessel head
  const gash = [[9, 22], [12, 20], [15, 23], [18, 21], [21, 24], [24, 21], [27, 23], [30, 20], [33, 23], [36, 21], [39, 24], [42, 21], [45, 23], [47, 21]];
  for (let i = 0; i + 1 < gash.length; i++) {
    f.line(X + gash[i][0], gash[i][1] - 1, X + gash[i + 1][0], gash[i + 1][1] - 1, C.INK);
    f.line(X + gash[i][0], gash[i][1], X + gash[i + 1][0], gash[i + 1][1], C.RED_D);
    f.line(X + gash[i][0], gash[i][1] + 1, X + gash[i + 1][0], gash[i + 1][1] + 1, C.INK);
  }
  crack([[39, 40], [42, 43], [40, 46], [43, 49], [42, 52], [45, 55], [44, 58]], true);
  crack([[16, 25], [12, 27], [13, 31], [10, 34], [11, 38]], false);
  crack([[41, 26], [45, 29], [44, 33], [47, 36]], false);
  crack([[20, 44], [17, 47], [19, 50], [16, 53], [17, 57]], true);
  crack([[24, 4], [26, 8], [23, 11], [26, 15], [24, 19]], true);
  // torn lower flange, a dropped rim bolt, buckled exhaust cap
  f.rect(X + 31, 48, 4, 3, C.INK); f.px(X + 32, 49, C.RED_D);
  f.rect(X + 23, 0, 11, 3, 0);
  for (let k = 0; k < 11; k++) { f.px(X + 24 + k, k < 5 ? 2 : 1, C.INK); f.px(X + 24 + k, k < 5 ? 1 : 0, C.INK); }
}

// The lamp arms carry the beacons at fixed anchors, so they never shake with the core.
const ARMS_SPR = bake(CORE_W + PAD * 2, CORE_H, paintArms);
const CORE_SPR = bake(CORE_W + PAD * 2, CORE_H, (f) => paintCore(f, false));
const CORE_MELT_SPR = bake(CORE_W + PAD * 2, CORE_H, (f) => paintCore(f, true));

// Per-status look. ramp: plasma bands from the heart outward.
const LOOKS = {
  ok: { ramp: [C.CYAN_L, C.CYAN, C.TEAL, C.TEAL_D], halo: C.TEAL, text: C.GREEN_L, lcd: C.GREEN_DD },
  hot: { ramp: [C.CREAM, C.AMBER_L, C.AMBER, C.AMBER_D], halo: C.AMBER, text: C.AMBER_L, lcd: C.WALL_D },
  critical: { ramp: [C.CREAM, C.YELLOW, C.ORANGE, C.RED], halo: C.ORANGE, text: C.RED_L, lcd: C.RED_D },
  meltdown: { ramp: [C.RED, C.RED_D, C.ROCK_D, C.INK], halo: C.RED_D, text: C.RED, lcd: C.INK },
};

/** Everything the hall painters need to know about this frame. */
function scene(t, r) {
  const status = LOOKS[r && r.status] ? r.status : 'ok';
  const heat = clamp01(+(r && r.heat) || 0);
  const phase = status === 'meltdown' ? 0.13 : +(r && r.phase) || 0;   // a dead plant stands still
  const speed = clamp01(+(r && r.speed) || 0);
  const dead = status === 'meltdown';
  const level = status === 'critical' ? 2 : status === 'hot' ? 1 : 0;
  const tick = Math.floor(t * (level === 2 ? 20 : 13));
  const pct = r && r.percent !== null && r.percent !== undefined && Number.isFinite(+r.percent)
    ? `${Math.max(0, Math.min(999, Math.round(+r.percent)))}%` : '--';
  return {
    t, status, heat, phase, speed, dead, level, tick, pct, look: LOOKS[status],
    flow: dead ? null : Math.floor(phase * 8),
    // -1 / 0 / +1 pixel of rattle for the part called `id`
    shake(id) {
      if (level === 0) return 0;
      const h = hash(tick, id, 7);
      const p = level === 2 ? 0.7 : 0.16 + 0.3 * heat;
      return h < p ? (h < p / 2 ? -1 : 1) : 0;
    },
  };
}

function drawCore(fb, cx, floorY, S) {
  const { t, status, heat, look, dead } = S;
  // flue hood hanging from the ceiling over the exhaust cap
  for (let j = 0; j < 8; j++) {
    const hw = 4 + (j >> 1) + (j === 7 ? 1 : 0), y = floorY - 74 + j;
    fb.rect(cx - hw, y, hw * 2 + 1, 1, C.INK);
    if (j < 7) { fb.rect(cx - hw + 1, y, hw * 2 - 1, 1, C.STEEL_D); fb.px(cx - hw + 1, y, C.STEEL_L); fb.px(cx - hw + 2, y, C.STEEL); fb.px(cx + hw - 1, y, C.STEEL_DD); }
  }
  const ox = cx - 28 + (S.level === 2 ? S.shake(900) : 0), oy = floorY - CORE_H;
  fb.blit(ARMS_SPR, cx - 28 - PAD, oy);
  fb.blit(dead ? CORE_MELT_SPR : CORE_SPR, ox - PAD, oy);
  const vx = ox + VX, vy = oy + VY;

  // ---- plasma behind the glass
  if (!dead) {
    const rate = status === 'ok' ? 1.1 + heat * 1.5 : status === 'hot' ? 3.2 : 7.5;
    let pulse = Math.sin(t * rate) * (0.7 + 0.5 * heat);
    if (status === 'critical') pulse += (hash(S.tick, 3) - 0.5) * 1.6;
    const size = 0.6 + heat * 2.4 + pulse;
    const ramp = look.ramp;
    for (let dy = -VR; dy <= VR; dy++) {
      for (let dx = -VR; dx <= VR; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > VR * VR + VR) continue;
        const e = Math.sqrt(d2) - size + (bayer(vx + dx, vy + dy) - 7.5) * 0.11;
        fb.px(vx + dx, vy + dy, e < 1.8 ? ramp[0] : e < 4.2 ? ramp[1] : e < 6.9 ? ramp[2] : ramp[3]);
      }
    }
    // three sparks orbiting the heart on tilted ellipses, driven by phase
    for (let i = 0; i < 3; i++) {
      const tilt = 0.35 + i * (Math.PI / 3);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      for (let k = 2; k >= 0; k--) {
        let a = (S.phase * (1 + i * 0.13) + i / 3) * TAU - k * 0.32;
        if (status === 'critical') a += (hash(S.tick, i, 9) - 0.5) * 0.9;
        const ex = Math.cos(a) * 8.2, ey = Math.sin(a) * 2.9;
        const x = Math.round(ex * ct - ey * st), y = Math.round(ex * st + ey * ct);
        if (x * x + y * y > VR * VR) continue;
        fb.px(vx + x, vy + y, k === 0 ? C.WHITE : k === 1 ? ramp[0] : ramp[1]);
      }
    }
    // light spilling over the rim onto the vessel
    const R = VR + 5.5 + heat * 3 + pulse * 0.6;
    const Ri = Math.ceil(R);
    for (let dy = -Ri; dy <= Ri; dy++) {
      for (let dx = -Ri; dx <= Ri; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < VR + 4.6 || d > R) continue;
        if (bayer(vx + dx, vy + dy) >= (1 - (d - VR - 4.6) / (R - VR - 4.6)) * (4 + 4 * heat)) continue;
        if (Math.abs(dx) > 19 || dy < -16 || dy > 16) continue;   // stay on the vessel plates
        fb.px(vx + dx, vy + dy, look.halo);
      }
    }
  } else {
    // dead core: a cold cracked lump with a few dull embers, behind shattered glass
    for (let dy = -VR; dy <= VR; dy++) {
      for (let dx = -VR; dx <= VR; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > VR * VR + VR) continue;
        const d = Math.sqrt(d2) + (hash(dx, dy, 3) - 0.5) * 2.2;
        let c = d < 5.4 ? (hash(dx >> 1, dy >> 1, 8) < 0.3 ? C.INK : C.RED_D) : d < 7 ? C.INK : C.ROCK_D;
        if (c === C.RED_D && hash(dx, dy, 4) < 0.16 && Math.sin(t * 1.3 + hash(dx, dy, 6) * 6.28) > 0.2) c = C.RED;
        fb.px(vx + dx, vy + dy, c);
      }
    }
    for (const [x0, y0, x1, y1] of GLASS_CRACKS) fb.line(vx + x0, vy + y0, vx + x1, vy + y1, C.STEEL_L);
    for (const [x, y] of GLASS_HOLE) fb.px(vx + x, vy + y, C.INK);
  }
  if (!dead) {                                        // glint on the glass
    fb.px(vx - 6, vy - 5, C.WHITE); fb.px(vx - 5, vy - 6, C.WHITE); fb.px(vx - 4, vy - 7, C.WHITE);
    fb.px(vx - 7, vy - 3, C.GLASS_L); fb.px(vx + 6, vy + 6, C.GLASS_L);
  }

  // ---- louvred vents on the pylons
  for (let side = 0; side < 2; side++) {
    const lx = ox + (side ? 50 : 3);
    for (let k = 0; k < 4; k++) {
      const y = oy + 20 + k * 3;
      if (S.level === 1) {
        fb.rect(lx, y + 2, 4, 1, hash(S.tick >> 2, k, side) < 0.3 ? C.AMBER : C.AMBER_D);
      } else if (S.level === 2) {                      // slats swung open, core light pouring out
        const hotc = hash(S.tick, k * 2 + side, 11) < 0.4 ? C.YELLOW : C.ORANGE;
        fb.rect(lx, y, 4, 1, C.STEEL_LL);
        fb.rect(lx, y + 1, 4, 1, hotc);
        fb.rect(lx, y + 2, 4, 1, C.RED);
      } else if (dead) {                               // blown out: bent and missing slats
        const miss = hash(k, side, 13) < 0.5;
        fb.rect(lx, y, 4, 3, C.INK);
        if (!miss) { fb.px(lx + (side ? 0 : 2), y + 1, C.STEEL_D); fb.px(lx + 1, y + (side ? 1 : 0), C.STEEL_D); fb.px(lx + (side ? 2 : 0), y, C.STEEL); }
        else fb.px(lx + 1 + side, y + 1, C.RED_D);
      }
    }
    if (S.level === 2) drawSteam(fb, lx + 2, oy + 17, 9, t, 0.6, 31 + side);
  }

  // ---- weekly-percent readout in the plinth
  fb.rect(ox + 19, oy + 53, 19, 7, look.lcd);
  const blink = S.level === 2 ? Math.floor(t * 4) % 2 === 0 : dead ? hash(Math.floor(t * 9), 5) > 0.25 : true;
  drawText(fb, ox + 28 + 1, oy + 54, S.pct, blink ? look.text : dead ? C.RED_D : C.RED, { align: 'center' });
}

const GLASS_CRACKS = [
  [-3, -2, -9, -4], [-3, -2, -6, -8], [-3, -2, 1, -9], [-3, -2, 4, -3], [4, -3, 9, -4], [-3, -2, -5, 4],
  [-5, 4, -8, 6], [-5, 4, -2, 9], [-3, -2, 2, 3], [2, 3, 7, 6], [2, 3, 1, 8],
];
const GLASS_HOLE = [[-4, -3], [-3, -3], [-4, -2], [-2, -2], [-3, -1], [-3, -2], [-2, -3], [-5, -2]];

// ---------------------------------------------------------------------------------------
// Hall machinery. Each module is a baked body plus a live overlay; modules are laid
// out from the core outward on each side for as long as the hall width allows.
//   w, h   size (stands on the floor)
//   gap    clear floor between it and its inner neighbour
//   up     x offset (from the module's left edge) of its overhead-pipe nozzle, or -1
//   mid    x offset of the point where the waist pipe ends on / behind it, or -1
// ---------------------------------------------------------------------------------------

// ---- coolant pump -----------------------------------------------------------------------
const PUMP_SPR = bake(30, 23, (f) => {
  box(f, 0, 19, 30, 4, M_STEEL);                       // skid
  f.px(3, 20, C.STEEL_LL); f.px(26, 20, C.STEEL_LL);
  f.rect(1, 7, 14, 12, C.INK);                         // motor
  hcyl(f, 2, 8, 12, 10, M_GREEN);
  for (let x = 4; x < 13; x += 3) f.rect(x, 10, 1, 8, C.GREEN_D);
  f.rect(10, 12, 3, 2, C.CREAM);
  box(f, 4, 3, 7, 5, M_STEEL);                         // terminal box
  f.rect(15, 11, 2, 4, C.INK); f.px(15, 12, C.STEEL_L); f.px(16, 12, C.STEEL_L); f.px(15, 13, C.STEEL_D); f.px(16, 13, C.STEEL_D);
  f.rect(18, 0, 9, 6, C.INK);                          // outlet neck
  f.rect(19, 1, 7, 1, C.STEEL_LL); f.rect(19, 2, 7, 1, C.STEEL); f.rect(20, 3, 5, 3, C.STEEL_D);
  wheel(f, 22, 12, 7, M_STEEL);                        // volute casing
  f.disc(22, 12, 4, C.INK);
  f.disc(22, 12, 3, C.STEEL_DD);
});
function livePump(fb, x, y, S) {
  spokes(fb, x + 22, y + 12, 3, S.phase, 4, C.BRASS, C.CREAM);
  fb.px(x + 22, y + 12, C.AMBER_L);
  const bob = S.dead ? 1 : Math.round(Math.sin(S.phase * TAU * 2));
  fb.px(x + 7, y + 2 - Math.max(0, bob), C.STEEL_LL);  // oiler bobbing on the terminal box
  fb.px(x + 6, y + 5, S.dead ? C.RED_D : C.GREEN_L);
}

// ---- upright coolant tank ---------------------------------------------------------------
const TANK_SPR = bake(26, 54, (f) => {
  box(f, 3, 49, 5, 5, M_STEEL); box(f, 18, 49, 5, 5, M_STEEL);
  f.rect(1, 7, 24, 44, C.INK);
  vcyl(f, 2, 8, 22, 42, M_NAVY);
  domeTop(f, 1, 1, 24, 7, M_NAVY);
  for (const by of [13, 44]) { f.rect(2, by, 22, 1, C.NIGHT); for (let x = 4; x < 23; x += 4) f.px(x, by, C.BLUE_L); }
  f.rect(2, 49, 22, 1, C.NIGHT);
  box(f, 16, 0, 7, 6, M_STEEL);                        // overhead nozzle on the shoulder
  f.rect(15, 17, 5, 24, C.INK);                        // sight glass
  f.rect(16, 18, 3, 22, C.STEEL_DD);
  dialFace(f, 8, 22, 4);
  drawText(f, 3, 31, 'H2O', C.SKY);
});
function liveTank(fb, x, y, S) {
  // coolant boils away as the core heats up
  const lvl = S.dead ? 2 : Math.round(22 * (0.92 - 0.6 * S.heat)) + (S.level ? (hash(S.tick, 21) < 0.5 ? 1 : 0) : 0);
  fb.rect(x + 16, y + 40 - lvl, 3, lvl, S.dead ? C.BLUE_D : C.BLUE_L);
  if (!S.dead) {
    fb.rect(x + 16, y + 40 - lvl, 3, 1, C.CYAN_L);
    const b = frac(S.phase * 0.9), by = y + 39 - Math.floor(b * (lvl - 1));
    if (lvl > 3) fb.px(x + 16 + (Math.floor(S.phase * 0.9) % 3 + 3) % 3, by, C.WHITE);
  }
  needle(fb, x + 8, y + 22, 3, S.dead ? 0 : 0.12 + 0.8 * S.heat + S.shake(22) * 0.06, C.INK);
}

// ---- turbine + dynamo -------------------------------------------------------------------
const TURBINE_SPR = bake(44, 24, (f) => {
  box(f, 0, 20, 44, 4, M_STEEL);
  f.px(3, 21, C.STEEL_LL); f.px(40, 21, C.STEEL_LL);
  // ribbed copper casing with rounded ends
  f.rect(3, 4, 20, 16, C.INK); f.rect(2, 5, 22, 14, C.INK); f.rect(1, 6, 24, 12, C.INK);
  hcyl(f, 3, 5, 20, 14, M_COPPER); f.rect(2, 7, 1, 10, C.COPPER); f.rect(23, 7, 1, 10, C.COPPER_D);
  for (let x = 6; x < 22; x += 5) { f.rect(x, 5, 1, 14, C.COPPER_D); f.rect(x + 1, 5, 1, 3, C.CREAM); }
  box(f, 3, 0, 7, 5, M_STEEL);                         // condensate outlet (to the waist pipe)
  box(f, 15, 0, 9, 5, M_STEEL);                        // steam inlet (from the overhead pipe)
  dialFace(f, 13, 12, 3);
  f.rect(25, 10, 4, 5, C.INK);                         // shaft
  f.rect(25, 11, 4, 1, C.STEEL_LL); f.rect(25, 12, 4, 1, C.STEEL); f.rect(25, 13, 4, 1, C.STEEL_D);
  wheel(f, 35, 11, 8, M_STEEL);                        // flywheel / dynamo housing
  f.disc(35, 11, 5, C.INK);
  f.disc(35, 11, 4, C.STEEL_DD);
});
function liveTurbine(fb, x, y, S) {
  spokes(fb, x + 35, y + 11, 4, S.phase * 1.5, 3, C.BRASS, C.CREAM);
  fb.px(x + 35, y + 11, C.AMBER_L);
  const m = ((Math.floor(S.phase * 12) % 4) + 4) % 4;  // key spinning on the shaft
  fb.px(x + 25 + m, y + 12, C.STEEL_DD);
  needle(fb, x + 13, y + 12, 2, S.dead ? 0 : 0.2 + 0.75 * S.heat + S.shake(23) * 0.1, C.INK);
}

// ---- control cabinet --------------------------------------------------------------------
const CABINET_SPR = bake(22, 36, (f) => {
  box(f, 0, 0, 22, 36, M_STEEL);
  f.rect(1, 1, 20, 1, C.STEEL_LL);
  f.rect(2, 3, 18, 14, C.INK);
  f.rect(3, 4, 16, 12, C.STEEL_D);
  dialFace(f, 7, 8, 3); dialFace(f, 15, 8, 3);
  f.rect(4, 13, 14, 2, C.INK);
  f.rect(3, 19, 16, 9, C.STEEL_D); f.frame(2, 18, 18, 11, C.INK);
  f.disc(11, 23, 3, C.INK); f.disc(11, 23, 2, C.RED); f.px(10, 22, C.RED_L);   // the big red button
  for (const sx of [5, 17]) { f.rect(sx - 1, 20, 3, 7, C.INK); f.rect(sx, 21, 1, 5, C.STEEL_DD); }
  for (let y = 30; y < 34; y += 2) f.rect(4, y, 14, 1, C.STEEL_DD);
  f.rect(1, 34, 20, 1, C.STEEL_DD);
});
function liveCabinet(fb, x, y, S) {
  const top = y + 36 - 74;                             // conduit up to the ceiling
  fb.rect(x + 9, top, 4, y - top, C.INK);
  fb.rect(x + 10, top, 1, y - top, C.STEEL); fb.rect(x + 11, top, 1, y - top, C.STEEL_D);
  for (let cy = y - 6; cy > top + 2; cy -= 12) { fb.rect(x + 8, cy, 6, 2, C.INK); fb.rect(x + 9, cy, 4, 1, C.STEEL_L); }
  needle(fb, x + 7, y + 8, 2, S.dead ? 0 : 0.1 + 0.85 * S.heat + S.shake(24) * 0.08, C.INK);
  needle(fb, x + 15, y + 8, 2, S.dead ? 0 : S.pct === '--' ? 0 : parseInt(S.pct, 10) / 100, C.INK);
  const blink = Math.floor(S.t * (S.level === 2 ? 5 : 2.5)) % 2 === 0;
  fb.rect(x + 5, y + 13, 2, 2, S.level === 0 && !S.dead ? C.GREEN_L : C.GREEN_DD);
  fb.rect(x + 10, y + 13, 2, 2, S.level === 1 && blink ? C.AMBER_L : C.AMBER_D);
  fb.rect(x + 15, y + 13, 2, 2, S.dead || (S.level === 2 && blink) ? C.RED_L : C.RED_D);
  // two slide switches: up while running, slammed down after the scram
  const up = !S.dead;
  fb.px(x + 5, y + (up ? 21 : 25), C.CREAM); fb.px(x + 17, y + (up ? 21 : 25), C.CREAM);
  if (S.dead) { fb.disc(x + 11, y + 23, 2, C.RED_D); }
}

// ---- fan-cooled heat exchanger ----------------------------------------------------------
const PIPE_HDR = [C.BLUE_L, C.BLUE_L, C.BLUE, C.BLUE_D, C.BLUE_D];
const HX_SPR = bake(36, 40, (f) => {
  box(f, 3, 35, 5, 5, M_STEEL); box(f, 28, 35, 5, 5, M_STEEL);
  f.rect(0, 7, 36, 29, C.INK);                         // finned radiator block
  for (let x = 1; x < 35; x++) f.rect(x, 8, 1, 27, (x & 1) ? C.STEEL_L : C.STEEL_D);
  f.rect(1, 8, 34, 1, C.STEEL_LL); f.rect(1, 34, 34, 1, C.STEEL_DD);
  f.rect(0, 2, 36, 6, C.INK);                          // header pipe
  hcyl(f, 1, 3, 34, 4, PIPE_HDR);
  for (let x = 5; x < 34; x += 6) f.rect(x, 3, 1, 4, C.BLUE_D);
  box(f, 14, 0, 7, 4, M_STEEL);                        // overhead nozzle
  for (const fx of [10, 25]) {                         // two fan shrouds
    wheel(f, fx, 21, 8, M_HAZ);
    f.disc(fx, 21, 6, C.INK);
    f.disc(fx, 21, 5, C.STEEL_DD);
  }
});
function liveHx(fb, x, y, S) {
  for (let i = 0; i < 2; i++) {
    const fx = x + (i ? 25 : 10), fy = y + 21;
    spokes(fb, fx, fy, 5, S.phase * (i ? -2.3 : 2), 3, S.dead ? C.STEEL : C.STEEL_LL, S.dead ? C.STEEL : C.WHITE);
    fb.px(fx, fy, C.HAZARD);
  }
}

// ---- lying storage tank with an instrument board behind it --------------------------------
const HTANK_SPR = bake(46, 50, (f) => {
  // instrument board on two posts
  for (const px of [20, 40]) { f.rect(px, 14, 3, 16, C.INK); f.rect(px + 1, 14, 1, 16, C.STEEL); }
  box(f, 14, 0, 32, 15, M_STEEL);
  f.rect(16, 2, 28, 11, C.STEEL_D);
  for (const dx of [21, 30, 39]) dialFace(f, dx, 7, 4);
  // the tank on its saddles
  box(f, 7, 44, 7, 6, M_STEEL); box(f, 32, 44, 7, 6, M_STEEL);
  const ins = [4, 2, 1];
  for (let j = 0; j < 18; j++) {
    const inset = j < 3 ? ins[j] : j > 14 ? ins[17 - j] : 0;
    f.rect(inset, 28 + j, 46 - inset * 2, 1, C.INK);
    if (j > 0 && j < 17) f.rect(inset + 1, 28 + j, 44 - inset * 2, 1, M_TAN[cyl((j - 0.5) / 16)]);
  }
  f.rect(6, 30, 1, 14, C.SAND); f.rect(39, 30, 1, 14, C.SAND);
  f.rect(7, 30, 1, 14, C.PACKAGE);
  drawText(f, 10, 35, 'COOLANT', C.LEATHER);
  box(f, 4, 22, 9, 7, M_STEEL);                        // overhead nozzle
  f.rect(41, 32, 3, 11, C.INK); f.rect(42, 33, 1, 9, C.STEEL_DD);   // level tube
  f.rect(27, 25, 1, 3, C.STEEL_L); f.rect(24, 23, 7, 3, C.INK); f.rect(25, 24, 5, 1, C.RED_L);   // hand wheel
});
function liveHtank(fb, x, y, S) {
  needle(fb, x + 21, y + 7, 3, S.dead ? 0 : 0.1 + 0.85 * S.heat + S.shake(41) * 0.07, C.INK);
  needle(fb, x + 30, y + 7, 3, S.dead || S.pct === '--' ? 0 : parseInt(S.pct, 10) / 100, C.INK);
  needle(fb, x + 39, y + 7, 3, S.dead ? 0 : 0.15 + 0.7 * S.speed + S.shake(42) * 0.07, C.INK);
  const lvl = S.dead ? 1 : Math.round(9 * (0.9 - 0.55 * S.heat));
  fb.rect(x + 42, y + 42 - lvl, 1, lvl, S.dead ? C.BLUE_D : C.CYAN);
}

// ---- drums ------------------------------------------------------------------------------
function drum(f, x, y, h, m) {
  f.rect(x, y, 10, h, C.INK);
  vcyl(f, x + 1, y + 1, 8, h - 2, m);
  f.rect(x + 1, y + 1, 8, 1, m[1]);
  f.rect(x + 1, y + 4, 8, 1, m[3]); f.rect(x + 1, y + h - 5, 8, 1, m[3]);
}
const DRUMS_SPR = bake(22, 16, (f) => {
  drum(f, 0, 2, 14, M_HAZ);
  f.px(4, 9, C.INK); f.px(6, 9, C.INK); f.px(5, 10, C.INK); f.px(5, 8, C.INK);
  drum(f, 11, 0, 16, M_STEEL);
  f.rect(13, 7, 6, 3, C.RED); f.rect(13, 7, 6, 1, C.RED_L);
});

// ---- condenser tower --------------------------------------------------------------------
const COND_SPR = bake(26, 56, (f) => {
  box(f, 3, 51, 5, 5, M_STEEL); box(f, 18, 51, 5, 5, M_STEEL);
  f.rect(1, 9, 24, 44, C.INK);
  vcyl(f, 2, 10, 22, 42, M_TAN);
  domeTop(f, 1, 3, 24, 7, M_TAN);
  f.rect(2, 51, 22, 1, C.DIRT);
  for (let y = 22; y < 48; y += 8) {                   // copper coil wound round the shell
    f.rect(0, y - 1, 26, 4, C.INK);
    f.rect(1, y, 24, 1, C.COPPER_L); f.rect(1, y + 1, 24, 1, C.COPPER_D);
    f.rect(5, y, 4, 1, C.CREAM); f.rect(17, y, 8, 1, C.COPPER);
  }
  box(f, 9, 0, 7, 5, M_STEEL);                         // overhead nozzle
  f.rect(19, 3, 3, 5, C.INK); f.px(20, 4, C.BRASS); f.rect(20, 5, 1, 3, C.AMBER_D);    // relief valve
  f.disc(12, 14, 4, C.INK); f.disc(12, 14, 3, C.BRASS); f.disc(12, 14, 2, C.INK);       // porthole
});
function liveCond(fb, x, y, S) {
  const c = S.dead ? C.RED_D : S.look.ramp[(S.level && hash(S.tick, 51) < 0.4) ? 0 : 1];
  fb.px(x + 12, y + 14, c); fb.px(x + 11, y + 14, c); fb.px(x + 13, y + 14, c); fb.px(x + 12, y + 13, c); fb.px(x + 12, y + 15, c);
  if (S.level > 0) drawSteam(fb, x + 20, y + 3, 10, S.t, S.level === 2 ? 1 : 0.4, 52);
}

// ---- transformer ------------------------------------------------------------------------
const XFMR_SPR = bake(32, 34, (f) => {
  box(f, 0, 30, 32, 4, M_STEEL);
  for (const fx of [0, 27]) {                          // radiator fins
    f.rect(fx, 13, 5, 17, C.INK);
    for (let y = 14; y < 29; y += 2) { f.rect(fx + 1, y, 3, 1, C.GRASS); f.rect(fx + 1, y + 1, 3, 1, C.GREEN_DD); }
  }
  box(f, 4, 10, 24, 21, M_OLIVE);
  f.rect(3, 8, 26, 3, C.INK); f.rect(4, 9, 24, 1, C.GRASS);
  for (const ix of [9, 16, 23]) {                      // ceramic insulators
    for (let k = 0; k < 3; k++) {
      f.rect(ix - 2, 2 + k * 2, 5, 1, C.INK); f.rect(ix - 1, 2 + k * 2, 3, 1, k === 0 ? C.WHITE : C.PACKAGE);
      f.rect(ix - 1, 3 + k * 2, 3, 1, C.INK); f.px(ix, 3 + k * 2, C.TAN);
    }
    f.rect(ix - 1, 0, 3, 2, C.INK); f.px(ix, 1, C.COPPER_L);
  }
  f.rect(12, 14, 9, 8, C.INK); f.rect(13, 15, 7, 6, C.HAZARD);          // danger plate
  f.line(17, 15, 15, 17, C.INK); f.line(15, 17, 17, 18, C.INK); f.line(17, 18, 15, 20, C.INK);
  f.rect(8, 25, 5, 2, C.CREAM); f.px(23, 26, C.GREEN_DD); f.px(6, 13, C.GREEN_DD); f.px(25, 13, C.GREEN_DD);
});
function liveXfmr(fb, x, y, S) {
  const top = y + 34 - 74;                             // ceiling line
  for (let i = 0; i < 3; i++) {
    const cxk = x + 9 + i * 7;
    fb.rect(cxk, top, 1, y - top, S.dead ? C.STEEL_D : C.AMBER_D);
    if (S.dead) continue;
    const len = y - top;
    const p = frac(S.phase * 0.8 + i / 3);
    const py = y - 1 - Math.floor(p * len);
    fb.px(cxk, py, C.CREAM); if (py + 1 < y) fb.px(cxk, py + 1, C.AMBER_L);
  }
  fb.px(x + 23, y + 26, S.dead ? C.RED : S.level ? C.AMBER_L : C.GREEN_L);
}

// ---- gas bottles ------------------------------------------------------------------------
const BOTTLES_SPR = bake(26, 30, (f) => {
  f.rect(0, 12, 26, 3, C.INK); f.rect(1, 13, 24, 1, C.STEEL);          // wall rail
  for (let i = 0; i < 3; i++) {
    const bx = 1 + i * 8, m = i === 1 ? M_STEEL : M_RED;
    f.rect(bx, 6, 8, 24, C.INK);
    vcyl(f, bx + 1, 7, 6, 22, m);
    f.rect(bx + 1, 5, 6, 1, C.INK); f.rect(bx + 2, 4, 4, 1, C.INK); f.rect(bx + 2, 5, 4, 1, m[2]); f.px(bx + 2, 5, m[1]);
    f.rect(bx + 3, 1, 2, 3, C.INK); f.px(bx + 3, 2, C.BRASS); f.px(bx + 4, 2, C.AMBER_D);
    f.rect(bx + 2, 1, 4, 1, C.INK);
    f.rect(bx + 1, 13, 6, 1, C.STEEL_L);                                 // strap
    f.rect(bx + 1, 28, 6, 1, m[4]);
  }
});

function noLive() {}

const LEFT = [
  { w: 30, h: 23, gap: 5, up: -1, mid: 22, spr: PUMP_SPR, live: livePump },
  { w: 26, h: 54, gap: 5, up: 6, mid: 24, spr: TANK_SPR, live: liveTank },
  { w: 36, h: 40, gap: 5, up: 18, mid: 34, spr: HX_SPR, live: liveHx },
  { w: 46, h: 50, gap: 5, up: 37, mid: -1, top: 22, spr: HTANK_SPR, live: liveHtank },
  { w: 22, h: 16, gap: 5, up: -1, mid: -1, spr: DRUMS_SPR, live: noLive },
];
const RIGHT = [
  { w: 44, h: 24, gap: 6, up: 19, mid: 6, spr: TURBINE_SPR, live: liveTurbine },
  { w: 22, h: 36, gap: 5, up: -1, mid: -1, spr: CABINET_SPR, live: liveCabinet },
  { w: 26, h: 56, gap: 5, up: 12, mid: 1, spr: COND_SPR, live: liveCond },
  { w: 32, h: 34, gap: 6, up: -1, mid: -1, spr: XFMR_SPR, live: liveXfmr },
  { w: 26, h: 30, gap: 6, up: -1, mid: -1, spr: BOTTLES_SPR, live: noLive },
];

/** Place modules outward from the core; returns [{m, x}] with absolute left edges. */
function layoutSide(cx, halfW, side, mods, out) {
  out.length = 0;
  let cur = 28;                                         // distance from the centre, growing outward
  for (const m of mods) {
    if (cur + m.gap + m.w > halfW - 7) break;
    cur += m.gap;
    out.push({ m, x: side < 0 ? cx - cur - m.w : cx + cur });
    cur += m.w;
  }
  return out;
}

const PLACED_L = [], PLACED_R = [];

function drawSide(fb, cx, floorY, S, side, placed) {
  const pipe = side < 0 ? PIPE_COOL : PIPE_STEAM;
  const upY = floorY - UP_H, midY = floorY - MID_H;
  const rx = cx + side * RISER_DX;
  const flowOut = S.flow === null ? null : side * S.flow;       // overhead: away from the core
  const flowIn = S.flow === null ? null : -side * S.flow;       // waist: back toward the core
  const base = side < 0 ? 100 : 200;
  const portX = (p, off) => p.x + (side < 0 ? p.m.w - 1 - off : off);

  // waist run: from the pylon collar out to the farthest module that taps it. It passes
  // behind taller machines and drops a stub into the low ones.
  let far = -1;
  for (let i = 0; i < placed.length; i++) if (placed[i].m.mid >= 0) far = i;
  let prev = cx + side * 30;
  for (let i = 0; i <= far; i++) {
    const p = placed[i];
    if (p.m.mid < 0) continue;
    const px = portX(p, p.m.mid), top = floorY - p.m.h;
    hpipe(fb, prev, px, midY + S.shake(base + 10 + i), pipe, flowIn);
    if (Math.abs(px - prev) > 16) hcollar(fb, prev + side * 5, midY);
    if (top > midY + 2) { vpipe(fb, px, midY, top, pipe, null); elbow(fb, px, midY, pipe); }
    prev = px;
  }

  // overhead run: riser out of the dome, along the ceiling, a drop into each machine
  let farUp = -1;
  for (let i = 0; i < placed.length; i++) if (placed[i].m.up >= 0) farUp = i;
  vpipe(fb, rx + S.shake(base + 1), upY, floorY - CORE_H + 3, pipe, null);
  prev = rx;
  for (let i = 0; i <= farUp; i++) {
    const p = placed[i];
    if (p.m.up < 0) continue;
    const px = portX(p, p.m.up), top = floorY - p.m.h + (p.m.top || 0);
    const lo = Math.min(prev, px), hi = Math.max(prev, px);
    hpipe(fb, prev, px, upY + S.shake(base + 20 + i), pipe, flowOut);
    for (let hx = lo + 12; hx < hi - 8; hx += 24) {    // hangers from the ceiling
      fb.rect(hx, floorY - 74, 3, 3, C.INK); fb.rect(hx + 1, floorY - 74, 1, 3, C.STEEL);
    }
    vpipe(fb, px + S.shake(base + 30 + i), upY, top, pipe, S.flow);
    if (i === farUp) elbow(fb, px, upY, pipe);
    else { fb.rect(px - 3, upY - 3, 7, 7, C.INK); fb.rect(px - 2, upY - 2, 5, 5, pipe[2]); fb.rect(px - 2, upY - 2, 5, 1, pipe[1]); fb.rect(px - 2, upY + 2, 5, 1, pipe[3]); fb.px(px, upY, C.INK); }
    if (top - upY > 12) vcollar(fb, px, upY + 6);
    hcollar(fb, prev + side * 5, upY);
    prev = px;
  }
  if (farUp >= 0) elbow(fb, rx, upY, pipe);

  // the machines themselves
  for (const p of placed) {
    const top = floorY - p.m.h;
    fb.blit(p.m.spr, p.x, top);
    p.m.live(fb, p.x, top, S);
  }
}

/**
 * Draw the reactor and its hall machinery inside the hall interior. The hall room
 * shell (walls, floor, back wall) is already drawn; this adds the core in the middle
 * and coolant tanks / pumps / pipes toward the sides, as much as the width allows.
 * w is 448 in the full layout and 232 in the compact one.
 * @param {import('./fb.mjs').Framebuffer} fb
 * @param {number} x @param {number} y @param {number} w @param {number} h   hall rectangle (h = REACTOR_H)
 * @param {number} t seconds
 * @param {{heat:number, status:'ok'|'hot'|'critical'|'meltdown', phase:number, speed:number, percent:number|null}} r
 *   ok        calm blue-green glow, slow pulse
 *   hot       weekly limit approaching: brighter, pipes shake a little, gauges high
 *   critical  close to the limit: orange-red core, strong shake, vents open
 *   meltdown  weekly limit reached: core cracked and dark-red (the world adds flames and smoke)
 *   phase: accumulated animation phase (pumps, coolant flow); percent: weekly allowance used
 */
export function drawReactor(fb, x, y, w, h, t, r) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const cx = x + (w >> 1), floorY = y + h - FLOOR_T;
  const S = scene(t, r);
  const halfW = (w >> 1) - WALL_T;
  drawSide(fb, cx, floorY, S, -1, layoutSide(cx, halfW, -1, LEFT, PLACED_L));
  drawSide(fb, cx, floorY, S, 1, layoutSide(cx, halfW, 1, RIGHT, PLACED_R));
  drawCore(fb, cx, floorY, S);
}

// ---------------------------------------------------------------------------------------
// Session switchboard (28x40)
// ---------------------------------------------------------------------------------------

// Local layout: dials at (6,8) and (21,8); main breaker slot x 11..16, y 3..22 with its
// contact jaws at y 9..10 (where the world puts the trip sparks); lamps y 15..18;
// five branch breakers y 25..30; percent readout y 31..37.
const SB_SLOT_X = 11, SB_SLOT_Y = 3, SB_SLOT_W = 6, SB_SLOT_H = 20, SB_PIVOT = 15;
const SB_BRANCH_X = [3, 8, 13, 18, 23];
const SB_TRIPPED_BRANCH = [true, false, true, true, false];

const SWITCH_SPR = bake(SWITCHBOARD_W, SWITCHBOARD_H, (f) => {
  const W = SWITCHBOARD_W, H = SWITCHBOARD_H;
  box(f, 0, 0, W, H, M_STEEL);
  // top cap with vent slits
  f.rect(1, 1, W - 2, 1, C.STEEL_LL);
  for (let x = 4; x < W - 4; x += 3) f.px(x, 2, C.STEEL_DD);
  // plinth
  f.rect(1, H - 3, W - 2, 2, C.STEEL_D);
  f.rect(1, H - 3, W - 2, 1, C.STEEL_DD);
  for (let x = 2; x < W - 2; x++) if (((x + 1) % 4) < 2) f.px(x, H - 2, C.HAZARD);
  // main breaker slot: recessed, with copper contact jaws and a hinge block
  f.rect(SB_SLOT_X, SB_SLOT_Y, SB_SLOT_W, SB_SLOT_H, C.INK);
  f.rect(SB_SLOT_X + 1, SB_SLOT_Y + 1, SB_SLOT_W - 2, SB_SLOT_H - 2, C.STEEL_DD);
  f.rect(SB_SLOT_X - 1, SB_SLOT_Y - 1, SB_SLOT_W + 2, 1, C.STEEL_D);
  f.rect(SB_SLOT_X - 1, SB_SLOT_Y + SB_SLOT_H, SB_SLOT_W + 2, 1, C.STEEL_L);
  for (const jx of [12, 15]) { f.rect(jx, 9, 1, 2, C.COPPER_L); f.px(jx, 11, C.COPPER_D); }
  f.rect(12, SB_PIVOT, 4, 3, C.INK); f.rect(13, SB_PIVOT + 1, 2, 1, C.STEEL_L);
  // dial bezels (faces and needles are live)
  for (const dx of [6, 21]) {
    f.disc(dx, 8, 5, C.STEEL_D);
    f.disc(dx, 8, 4, C.INK);
    f.px(dx - 3, 4, C.STEEL_LL); f.px(dx - 4, 5, C.STEEL_LL);
  }
  // lamp housings
  for (const lx of [2, 7, 18, 23]) { f.rect(lx, 15, 4, 4, C.INK); f.px(lx, 15, C.STEEL_D); }
  // divider rail
  f.rect(2, 23, W - 4, 1, C.INK); f.rect(2, 24, W - 4, 1, C.STEEL_L);
  // branch breaker slots
  for (const bx of SB_BRANCH_X) { f.rect(bx - 1, 25, 3, 6, C.INK); f.rect(bx, 26, 1, 4, C.STEEL_DD); }
  // readout window
  f.rect(4, 31, 20, 7, C.INK);
  for (const [rx, ry] of [[2, 21], [25, 21], [2, 33], [25, 33]]) { f.px(rx, ry, C.STEEL_LL); f.px(rx + 1, ry + 1, C.STEEL_D); }
});

/**
 * Session switchboard, 28x40, anchored bottom-centre at (cx, floorY).
 * @param {{status:'ok'|'warn'|'tripped', percent:number|null}} s
 *   ok: breakers up, green lamps; warn: needles in the red, amber lamp blinking;
 *   tripped: main breaker down, red lamp, dark dials (the world adds sparks).
 */
export function drawSwitchboard(fb, cx, floorY, t, s) {
  const x = Math.round(cx) - SWITCHBOARD_W / 2, y = Math.round(floorY) - SWITCHBOARD_H;
  const status = s && (s.status === 'warn' || s.status === 'tripped') ? s.status : 'ok';
  const pRaw = s && s.percent !== null && s.percent !== undefined && Number.isFinite(+s.percent) ? +s.percent : null;
  const pct = pRaw === null ? '--' : `${Math.max(0, Math.min(999, Math.round(pRaw)))}%`;
  const v = pRaw === null ? 0.3 : clamp01(pRaw / 100);
  const tick = Math.floor(t * 12);
  fb.blit(SWITCH_SPR, x, y);

  // dials: session use (left) and line load (right)
  const dead = status === 'tripped';
  for (let i = 0; i < 2; i++) {
    const dx = x + (i ? 21 : 6), dy = y + 8;
    fb.disc(dx, dy, 3, dead ? C.STEEL_D : C.CREAM);
    if (!dead) { fb.px(dx + 2, dy - 2, C.RED); fb.px(dx + 3, dy - 1, C.RED); fb.px(dx + 1, dy - 3, C.RED); }
    let nv = i === 0 ? v : 0.35 + 0.5 * v + 0.06 * Math.sin(t * 3.1);
    if (status === 'warn') nv = 0.86 + 0.1 * hash(tick, i, 3);
    if (dead) nv = 0;
    needle(fb, dx, dy, 3, nv, dead ? C.STEEL_DD : C.INK);
    fb.px(dx, dy, dead ? C.STEEL : C.RED_D);
  }

  // main breaker: a big lever with a red T-grip, up = closed, thrown down = tripped
  const hx = x + 13;
  if (!dead) {
    const jig = status === 'warn' && hash(tick, 7) < 0.35 ? 1 : 0;   // straining against the latch
    const top = y + 5 + jig;
    fb.rect(hx, top + 2, 2, y + SB_PIVOT - top - 2, C.COPPER_L);
    fb.rect(hx + 1, top + 2, 1, y + SB_PIVOT - top - 2, C.COPPER);
    fb.rect(hx - 2, top - 1, 6, 4, C.INK);
    fb.rect(hx - 1, top, 4, 1, C.RED_L); fb.rect(hx - 1, top + 1, 4, 1, C.RED);
    fb.px(hx - 1, top, C.CREAM);
  } else {
    // blade swung down past the hinge, grip hanging below the slot; jaws left open
    const bot = y + SB_SLOT_Y + SB_SLOT_H + 2;
    fb.rect(hx, y + SB_PIVOT + 1, 2, bot - (y + SB_PIVOT + 1), C.COPPER);
    fb.rect(hx + 1, y + SB_PIVOT + 1, 1, bot - (y + SB_PIVOT + 1), C.COPPER_D);
    fb.rect(hx - 2, bot - 1, 6, 4, C.INK);
    fb.rect(hx - 1, bot, 4, 1, C.RED); fb.rect(hx - 1, bot + 1, 4, 1, C.RED_D);
    fb.px(hx - 1, bot, C.RED_L);
    fb.rect(hx, y + 10, 2, 1, C.INK);                 // scorch between the open jaws
    fb.px(hx, y + 8, C.SMOKE_D); fb.px(hx + 1, y + 12, C.SMOKE_D);
  }
  fb.rect(hx, y + SB_PIVOT + 1, 2, 1, C.STEEL_LL);    // hinge pin

  // lamps: green (power), amber (warning), red x2 (trip)
  const blink = Math.floor(t * 2.5) % 2 === 0, fast = Math.floor(t * 5) % 2 === 0;
  const lamp = (lx, on, c, cOff) => {
    fb.rect(x + lx + 1, y + 16, 2, 2, on ? c : cOff);
    if (on) fb.px(x + lx + 1, y + 16, C.WHITE);
  };
  lamp(2, !dead, C.GREEN_L, C.GREEN_DD);
  lamp(7, status === 'warn' && blink, C.AMBER_L, C.AMBER_D);
  lamp(18, dead && fast, C.RED_L, C.RED_D);
  lamp(23, dead && !fast, C.RED_L, C.RED_D);

  // branch breakers
  for (let i = 0; i < SB_BRANCH_X.length; i++) {
    const bx = x + SB_BRANCH_X[i];
    const down = dead && SB_TRIPPED_BRANCH[i];
    const ky = y + (down ? 28 : 25);
    fb.rect(bx - 1, ky, 3, 2, C.INK);
    fb.px(bx, ky, down ? C.STEEL : C.WHITE);
  }

  // percent readout (alternates with TRIP once tripped)
  const bg = dead ? C.RED_D : status === 'warn' ? C.WALL_D : C.GREEN_DD;
  fb.rect(x + 5, y + 32, 18, 5, bg);
  const txt = dead && Math.floor(t * 1.5) % 2 === 0 ? 'TRIP' : pct;
  const tc = dead ? C.RED_L : status === 'warn' ? C.AMBER_L : C.GREEN_L;
  drawText(fb, x + 14, y + 32, txt, tc, { align: 'center' });
}

// ---------------------------------------------------------------------------------------
// Backup generator (44x30)
// ---------------------------------------------------------------------------------------

const M_GEN = [C.CREAM, C.YELLOW, C.HAZARD, C.AMBER, C.AMBER_D];
const GEN_STACK_X = 17, GEN_STACK_TOP = 4;
const GEN_FLY = [29, 17], GEN_LAMP = [34, 5], GEN_DIAL = [39, 5];

// Skid / day tank (never shakes).
const GEN_BASE_SPR = bake(GENERATOR_W, 7, (f) => {
  box(f, 0, 1, GENERATOR_W, 6, M_STEEL);
  f.rect(1, 2, GENERATOR_W - 2, 1, C.STEEL_L);
  for (const hx of [1, GENERATOR_W - 6]) {
    for (let yy = 3; yy < 5; yy++) for (let xx = hx; xx < hx + 5; xx++) f.px(xx, yy, ((xx + yy) % 4) < 2 ? C.HAZARD : C.INK);
  }
  f.rect(8, 3, 2, 2, C.INK); f.px(8, 3, C.BRASS);       // filler cap
  f.rect(22, 2, 16, 4, C.INK);                          // fuel bar window (fill is live)
  f.rect(23, 3, 14, 2, C.STEEL_DD);
  for (const fx2 of [3, 40]) f.rect(fx2, 6, 2, 1, C.INK); // feet
});

// Engine, radiator, alternator and control box (shakes as one piece while running).
const GEN_BODY_SPR = bake(GENERATOR_W, 25, (f) => {
  // radiator with grille slats
  box(f, 1, 6, 10, 19, M_STEEL);
  f.rect(2, 8, 8, 15, C.STEEL_DD);
  for (let yy = 9; yy < 22; yy += 2) { f.rect(3, yy, 6, 1, C.STEEL_L); f.px(8, yy, C.STEEL); }
  f.rect(2, 7, 8, 1, C.STEEL_LL);
  // engine block
  box(f, 10, 10, 18, 15, M_GEN);
  f.rect(11, 11, 16, 1, C.CREAM);
  for (let yy = 15; yy < 21; yy += 2) f.rect(13, yy, 8, 1, C.AMBER_D);
  f.rect(22, 15, 4, 5, C.INK); f.rect(23, 16, 2, 3, C.STEEL);           // oil filter
  f.px(23, 16, C.STEEL_LL);
  // cylinder head with rocker covers
  box(f, 11, 7, 16, 4, M_STEEL);
  for (const rx of [13, 18, 23]) { f.rect(rx, 6, 3, 2, C.INK); f.px(rx + 1, 7, C.STEEL_L); }
  // exhaust: manifold and stack with a rain cap
  f.rect(GEN_STACK_X - 1, GEN_STACK_TOP + 1, 4, 3, C.INK);
  f.rect(GEN_STACK_X, GEN_STACK_TOP + 1, 1, 3, C.STEEL); f.rect(GEN_STACK_X + 1, GEN_STACK_TOP + 1, 1, 3, C.STEEL_D);
  f.rect(GEN_STACK_X - 2, GEN_STACK_TOP - 1, 6, 2, C.INK); f.rect(GEN_STACK_X - 1, GEN_STACK_TOP - 1, 4, 1, C.STEEL_L);
  // alternator
  box(f, 31, 10, 12, 15, M_STEEL);
  for (let yy = 13; yy < 22; yy += 2) f.rect(35, yy, 6, 1, C.COPPER_D);
  f.rect(35, 13, 6, 1, C.COPPER);
  // flywheel bell housing with a window onto the flywheel
  wheel(f, GEN_FLY[0], GEN_FLY[1], 6, M_STEEL);
  f.disc(GEN_FLY[0], GEN_FLY[1], 4, C.INK);
  f.disc(GEN_FLY[0], GEN_FLY[1], 3, C.STEEL_DD);
  // control box on top of the alternator
  box(f, 31, 0, 12, 10, M_STEEL);
  f.rect(32, 1, 10, 1, C.STEEL_LL);
  f.rect(GEN_LAMP[0] - 2, GEN_LAMP[1] - 2, 4, 4, C.INK);
  f.disc(GEN_DIAL[0], GEN_DIAL[1], 3, C.INK);
  f.rect(33, 8, 8, 1, C.STEEL_D);
});

// Empty bay: footprint stencil on the floor, anchor bolts, a capped wall socket.
const GEN_BAY_SPR = bake(GENERATOR_W, GENERATOR_H, (f) => {
  // dashed footprint of the missing skid, painted on the floor
  for (let xx = 6; xx < GENERATOR_W - 6; xx += 4) { f.rect(xx, 24, 2, 1, C.STEEL); f.rect(xx, 29, 2, 1, C.STEEL); }
  // hazard corner brackets
  for (const [kx, sx] of [[0, 1], [GENERATOR_W - 1, -1]]) {
    for (const [ky, sy] of [[24, 1], [29, -1]]) {
      for (let k = 0; k < 4; k++) f.px(kx + sx * k, ky, C.HAZARD);
      for (let k = 1; k < 3; k++) f.px(kx, ky + sy * k, C.HAZARD);
    }
  }
  // anchor bolts where the skid would be bolted down
  for (const bx of [6, 36]) { f.rect(bx, 26, 2, 2, C.INK); f.px(bx, 26, C.STEEL_LL); }
  drawText(f, 22, 13, 'NO UNIT', C.STEEL_L, { align: 'center', shadow: C.INK });
  box(f, 34, 3, 7, 7, M_STEEL);                         // wall socket with a red blanking cap
  f.rect(36, 5, 3, 3, C.RED); f.px(36, 5, C.RED_L);
});

/**
 * Backup generator (extra usage credits), 44x30, anchored bottom-centre at (cx, floorY).
 * @param {{present:boolean, running:boolean, utilization:number|null, phase:number}} g
 *   present=false: draw an empty bay with a faint floor outline / "NO UNIT" stencil.
 *   running: engine shakes, exhaust puffs, lamp on; utilization 0..1 fills a fuel gauge
 *   (how much of the monthly credit limit is used) when not null.
 * Exhaust puffs of a running unit rise up to 8px above the 44x30 box.
 */
export function drawGenerator(fb, cx, floorY, t, g) {
  const x = Math.round(cx) - GENERATOR_W / 2, y = Math.round(floorY) - GENERATOR_H;
  if (!g || !g.present) { fb.blit(GEN_BAY_SPR, x, y); return; }
  const run = !!g.running;
  const phase = +g.phase || 0;
  const u = g.utilization === null || g.utilization === undefined || !Number.isFinite(+g.utilization) ? null : clamp01(+g.utilization);
  const tick = Math.floor(t * 15);
  // engine shudder: a pixel sideways or a hop, never outside the box
  let sx = 0, sy = 0;
  if (run) {
    const h1 = hash(tick, 1, 17), h2 = hash(tick, 2, 17);
    sx = h1 < 0.25 ? -1 : h1 > 0.75 ? 1 : 0;
    sy = h2 < 0.4 ? -1 : 0;
  }
  fb.blit(GEN_BASE_SPR, x, y + 23);
  const bx = x + sx, by = y + sy;
  fb.blit(GEN_BODY_SPR, bx, by);

  // flywheel
  spokes(fb, bx + GEN_FLY[0], by + GEN_FLY[1], 3, phase * (run ? 1 : 0) + (run ? 0 : phase), 3, C.STEEL_L, run ? C.WHITE : C.STEEL_LL);
  fb.px(bx + GEN_FLY[0], by + GEN_FLY[1], C.BRASS);
  // run lamp
  const [lx, ly] = GEN_LAMP;
  fb.rect(bx + lx - 1, by + ly - 1, 2, 2, run ? C.GREEN_L : C.GREEN_DD);
  if (run) fb.px(bx + lx - 1, by + ly - 1, C.WHITE);
  // credit dial: needle = share of the credit limit used, red zone at the top end
  const [dx, dy] = GEN_DIAL;
  fb.disc(bx + dx, by + dy, 2, u === null ? C.STEEL_L : C.CREAM);
  if (u !== null) {
    fb.px(bx + dx + 2, by + dy - 1, C.RED); fb.px(bx + dx + 1, by + dy - 2, C.RED);
    needle(fb, bx + dx, by + dy, 2, u, C.INK);
  }
  // fuel bar on the day tank: what is left of the credit
  if (u !== null) {
    const left = Math.round(14 * (1 - u));
    const c = u < 0.6 ? C.GREEN_L : u < 0.85 ? C.AMBER_L : C.RED_L;
    const show = !(run && u >= 0.9 && Math.floor(t * 3) % 2 === 1);
    if (show && left > 0) { fb.rect(x + 23, y + 26, left, 2, c); fb.rect(x + 23, y + 26, left, 1, u < 0.6 ? C.MINT : u < 0.85 ? C.CREAM : C.PINK); }
    for (let k = 1; k < 4; k++) fb.px(x + 23 + Math.round(k * 3.5), y + 27, C.INK);
  }
  if (!run) return;

  // exhaust puffs, one per firing stroke, driven by phase
  const stx = bx + GEN_STACK_X, sty = by + GEN_STACK_TOP - 2;
  for (let k = 0; k < 3; k++) {
    const p = frac(phase * 1.5 + k / 3);
    const py = sty - Math.round(p * 7), px = stx + Math.round(p * 3 + Math.sin(p * 5 + k) * 0.8);
    const r = p < 0.25 ? 0 : p < 0.6 ? 1 : 2;
    const c = p < 0.3 ? C.SMOKE_D : p < 0.65 ? C.SMOKE : C.SMOKE_L;
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        if (ox * ox + oy * oy > r * r + r) continue;
        if (p > 0.7 && ((px + ox + py + oy) & 1)) continue;
        fb.px(px + ox, py + oy, (ox + oy < 0 && r > 0) ? (c === C.SMOKE_D ? C.SMOKE : C.SMOKE_L) : c);
      }
    }
  }
}
