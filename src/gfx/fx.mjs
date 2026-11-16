// Stateless procedural effects: every frame is a pure function of (t, seed), so the
// world keeps no particle lists. Names and signatures are the contract.
// Effects are drawn AFTER room relighting so they stay bright in dark rooms.
//
// Everything here is drawn with base palette colours and plain / ordered dithering.
// Animation is stepped on a 10..15 Hz tick (hand-animated VGA feel, no sub-pixel crawl).
import { C } from './palette.mjs';
import { hash } from './fb.mjs';

// 4x4 ordered-dither thresholds (0..15), anchored to screen coordinates so moving
// shapes do not make the pattern crawl.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];

/** Smooth 2D value noise, 0..1. */
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// scratch: per-call tongue table along the flame lattice (no per-frame allocation)
const TONGUE_H = new Float32Array(48), TONGUE_X = new Float32Array(48), TONGUE_K = new Float32Array(48);
const FIRE_RAMP = [C.RED_D, C.RED, C.ORANGE, C.YELLOW, C.CREAM];

// One sheet of flame: a row of pointed tongues (each with its own position, width and
// flicker rhythm) that sway toward the tip and are torn by an upward-scrolling noise
// field, so tips split off and drift up. Colour bands nest inside the silhouette.
function flameSheet(fb, cx, baseY, half, H, T, seed, heatMul, maxBand) {
  const x0 = Math.floor(cx - half), x1 = Math.ceil(cx + half);
  const rows = Math.ceil(H * 1.08);
  const cell = Math.max(4.2, Math.min(6.5, half / 2));     // tongue spacing, pixels
  const kx = 1 / cell, ky = 1 / (cell * 2.2);
  const rise = Math.max(1.2, H / 15);                // pixels the noise field climbs per tick
  const off = Math.floor(hash(seed, 77) * 64) + 0.37;
  const i0 = Math.floor((x0 - 4) * kx + off) - 1;
  const nT = Math.min(TONGUE_H.length, Math.ceil((x1 + 4) * kx + off) - i0 + 3);
  for (let i = 0; i < nT; i++) {
    const id = i0 + i;
    const rate = 0.13 + 0.13 * hash(id, seed, 71);
    const a = vnoise(T * rate + hash(id, seed, 72) * 40, hash(id, seed, 74) * 90, seed + 73);
    TONGUE_H[i] = 0.5 + 0.72 * a * a * (3 - 2 * a);
    TONGUE_X[i] = id + (hash(id, seed, 75) - 0.5) * 0.6;
    TONGUE_K[i] = 1 / (0.75 + 0.6 * hash(id, seed, 76));   // 1 / half-width in cells
  }
  for (let j = 0; j < rows; j++) {
    const py = baseY - 1 - j;
    const v = (j + 0.5) / H;
    const sway = Math.sin(j * 0.3 + T * 0.6 + seed) * 1.7 * v + Math.sin(T * 0.23 + seed * 2.1) * 1.2 * v;
    const amp = 0.2 + 0.5 * v;
    for (let px = x0; px < x1; px++) {
      const u = (px + 0.5 - cx) / half;
      const prof = Math.pow(Math.max(0, 1 - u * u), 0.55);
      const xs = (px + sway) * kx + off;
      const k = Math.floor(xs) - i0;
      let reach = 0.33;                              // the low body all tongues grow out of
      for (let q = k - 1; q <= k + 2; q++) {
        if (q < 0 || q >= nT) continue;
        const d = 1 - Math.abs(xs - TONGUE_X[q]) * TONGUE_K[q];
        if (d > 0) { const r = TONGUE_H[q] * Math.pow(d, 0.8); if (r > reach) reach = r; }
      }
      const n = vnoise((px + sway * 0.5) * kx * 1.3 + seed * 1.3, (py + T * rise) * ky, seed + 5);
      const f = (reach * prof - v + (n - 0.5) * amp) * heatMul;
      if (f <= 0) continue;
      const band = f < 0.07 ? 0 : f < 0.16 ? 1 : f < 0.31 ? 2 : f < 0.52 ? 3 : 4;
      fb.px(px, py, FIRE_RAMP[band > maxBand ? maxBand : band]);
    }
  }
}

/**
 * Flames rising from a base line centred at (cx, baseY).
 * @param {number} w  width of the fire at its base  @param {number} h  tallest flame height
 * @param {number} intensity 0..1 (0 draws nothing; small local machine fire ~0.5; reactor eruption 1)
 * @param {number} seed integer so two fires do not move in unison
 *
 * Layers nest from the outside in: dark red, red, orange, yellow, cream heart. Strong
 * fires get a second, darker sheet of taller flames behind the bright one.
 */
export function drawFire(fb, cx, baseY, w, h, t, intensity, seed = 0) {
  if (!(intensity > 0) || !(w >= 1) || !(h >= 1)) return;
  const I = Math.min(1, intensity);
  cx = Math.round(cx); baseY = Math.round(baseY); seed |= 0;
  const T = Math.floor(t * 14);                      // animation tick
  const H = Math.max(4, h * (0.42 + 0.58 * I));      // tallest tongue, pixels
  const half = Math.max(2, (w * (0.72 + 0.28 * I)) / 2);
  if (I > 0.7 && H >= 16) flameSheet(fb, cx, baseY, half, H, T, seed + 101, 0.62, 2);
  flameSheet(fb, cx, baseY, half * (I > 0.7 && H >= 16 ? 0.92 : 1), H * (I > 0.7 && H >= 16 ? 0.9 : 1), T, seed, 0.7 + 0.3 * I, 4);
  // detached embers: rise, wobble, cool and wink out
  const ne = 2 + Math.round((half / 4) * (0.4 + 0.6 * I));
  for (let k = 0; k < ne; k++) {
    const period = 9 + Math.floor(hash(k, seed, 31) * 10);          // ticks per life
    const ph = (T + Math.floor(hash(k, seed, 32) * period)) / period;
    const cyc = Math.floor(ph), p = ph - cyc;
    if (p > 0.92) continue;
    const ex = cx + (hash(k, cyc, seed + 33) - 0.5) * half * 1.5 + Math.sin(p * 7 + k * 1.7) * (1 + 2 * p);
    const ey = baseY - H * (0.35 + 0.95 * p * (0.75 + 0.5 * hash(k, cyc, seed + 34)));
    const c = p < 0.3 ? C.CREAM : p < 0.55 ? C.YELLOW : p < 0.78 ? C.ORANGE : C.RED;
    fb.px(Math.round(ex), Math.round(ey), c);
    if (H > 20 && p < 0.5 && (k & 1) === 0) fb.px(Math.round(ex), Math.round(ey) + 1, C.ORANGE);
  }
}

// One smoke puff: shaded disc (light from the top-left) whose rim is one dither step
// thinner than its middle. level: 4 = solid .. 1 = sparse scatter.
const PUFF_IN = [0, 3, 8, 12, 16], PUFF_RIM = [0, 1, 4, 8, 10];
function puff(fb, x, y, r, level, body, hi, lo) {
  const R = Math.ceil(r), r2 = r * r, rin = (r * 0.62) * (r * 0.62);
  const tIn = PUFF_IN[level], tRim = PUFF_RIM[level];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      if (bayer(x + dx, y + dy) >= (d2 <= rin ? tIn : tRim)) continue;
      const s = (dx + dy) / r;
      fb.px(x + dx, y + dy, s < -0.5 ? hi : s > 0.6 ? lo : body);
    }
  }
}

/**
 * Smoke column rising from (cx, baseY) up to about h pixels, drifting and thinning.
 * @param {number} intensity 0..1 density
 */
export function drawSmoke(fb, cx, baseY, h, t, intensity, seed = 0) {
  if (!(intensity > 0) || !(h >= 2)) return;
  const I = Math.min(1, intensity);
  cx = Math.round(cx); baseY = Math.round(baseY); seed |= 0;
  const T = Math.floor(t * 12) / 12;
  const n = Math.max(3, Math.round(3 + h / 5.5));
  const period = 1.5 + h / 26;                       // seconds for a puff to climb h
  const lean = (hash(seed, 91) < 0.5 ? -1 : 1) * (0.1 + 0.16 * hash(seed, 92)) * h;
  const r0 = Math.min(3, 0.9 + h / 36), r1 = Math.min(10, 1.4 + h / 6.5);
  const base = T / period;
  const bf = base - Math.floor(base);
  const kTop = Math.ceil((1 - bf) * n) - 1;          // puff with the largest age
  for (let i = 0; i < n; i++) {                      // oldest (highest) first
    const k = ((kTop - i) % n + n) % n;
    const ph = base + k / n;
    const cyc = Math.floor(ph), p = ph - cyc;
    const wob = Math.sin(p * 6.5 + hash(k, cyc, seed) * 6.28) * (0.6 + 2.2 * p) * (0.5 + h / 60);
    const x = cx + Math.round(lean * p * p + wob);
    const r = r0 + (r1 - r0) * Math.pow(p, 0.8) * (0.8 + 0.4 * hash(k, cyc, seed + 3));
    const y = baseY - Math.round(p * h) - Math.round(r * 0.5);
    // thin with age (and with low intensity): solid -> 75% -> checker -> scatter
    const level = Math.max(1, Math.round((p < 0.42 ? 4 : p < 0.62 ? 3 : p < 0.82 ? 2 : 1) - (1 - I) * 2));
    if (p < 0.25) puff(fb, x, y, r, level, C.SMOKE_D, C.SMOKE, C.INK);
    else if (p < 0.6) puff(fb, x, y, r, level, C.SMOKE, C.SMOKE_L, C.SMOKE_D);
    else puff(fb, x, y, r, level, C.SMOKE_L, C.STEEL_LL, C.SMOKE);
  }
}

/** Short electrical sparks bursting from (cx, cy); intermittent, driven by t and seed. */
export function drawSparks(fb, cx, cy, t, intensity = 1, seed = 0) {
  if (!(intensity > 0)) return;
  const I = Math.min(1, intensity);
  cx = Math.round(cx); cy = Math.round(cy); seed |= 0;
  const SLOT = 0.48, LIFE = 0.62;                    // seconds per slot, lit fraction of a slot
  const s = t / SLOT + hash(seed, 5) * 7;
  const slot = Math.floor(s), u = (s - slot) / LIFE;
  if (u >= 1 || hash(slot, seed, 11) > 0.28 + 0.34 * I) return;   // real dark time between bursts
  const f = Math.floor(u * 6);                       // 6 frames of ~50 ms
  // jagged arcs, re-jittered every frame, only while the burst is young
  if (f < 3) {
    const nb = I > 0.6 ? 3 : 2;
    for (let b = 0; b < nb; b++) {
      const a = (hash(slot, 0, seed + 21) + b / nb + (hash(slot, b, seed + 24) - 0.5) * 0.22) * Math.PI * 2;
      const len = (3.5 + 5 * hash(slot, b, seed + 22)) * (0.7 + 0.3 * I);
      const dx = Math.cos(a), dy = Math.sin(a);
      let x = cx, y = cy;
      for (let k = 1; k <= 3; k++) {
        const j = k < 3 ? (hash(slot * 7 + f, b * 5 + k, seed + 23) - 0.5) * 3.4 : 0;
        const nx = Math.round(cx + dx * len * (k / 3) - dy * j);
        const ny = Math.round(cy + dy * len * (k / 3) + dx * j);
        fb.line(x, y, nx, ny, f === 0 ? C.WHITE : k === 3 ? C.CYAN : f === 1 ? C.CYAN_L : C.CYAN);
        x = nx; y = ny;
      }
      fb.px(x, y, f === 0 ? C.CYAN_L : C.WHITE);
    }
  }
  if (f === 0) {                                     // flash at the contact
    fb.px(cx - 1, cy, C.CREAM); fb.px(cx + 1, cy, C.CREAM);
    fb.px(cx, cy - 1, C.CREAM); fb.px(cx, cy + 1, C.CREAM);
    fb.px(cx - 2, cy, C.YELLOW); fb.px(cx + 2, cy, C.YELLOW);
    fb.px(cx, cy, C.WHITE);
  } else if (f === 1) {
    fb.px(cx, cy, C.CREAM);
  }
  // flying sparks: shoot out, arc down under gravity, cool from cream to orange
  const np = 4 + Math.round(4 * I);
  const tau = u * LIFE * SLOT;
  for (let k = 0; k < np; k++) {
    const a = -Math.PI * (0.08 + 0.84 * hash(slot, k, seed + 41));   // upper half plane
    const v = 16 + 30 * hash(slot, k, seed + 42);
    const life = 0.55 + 0.45 * hash(slot, k, seed + 43);
    if (u > life) continue;
    const q = u / life;
    const sx = cx + Math.cos(a) * v * tau, sy = cy + Math.sin(a) * v * tau + 70 * tau * tau;
    if (f > 0 && q < 0.8) {                          // short trail
      const tb = Math.max(0, tau - 0.035);
      fb.px(Math.round(cx + Math.cos(a) * v * tb), Math.round(cy + Math.sin(a) * v * tb + 70 * tb * tb), q < 0.4 ? C.YELLOW : C.ORANGE);
    }
    fb.px(Math.round(sx), Math.round(sy), q < 0.45 ? C.CREAM : q < 0.78 ? C.YELLOW : C.ORANGE);
  }
}

/** Thin white steam wisp venting upward from (cx, baseY) (coolant vents, coffee, hot pipes). */
export function drawSteam(fb, cx, baseY, h, t, intensity = 1, seed = 0) {
  if (!(intensity > 0) || !(h >= 2)) return;
  cx = Math.round(cx); baseY = Math.round(baseY); seed |= 0;
  const T = Math.floor(t * 12) / 12;
  const n = intensity >= 0.75 ? 3 : intensity >= 0.35 ? 2 : 1;
  const period = 1.1 + h / 30;
  for (let k = 0; k < n; k++) {
    const ph = T / period + k / n + hash(seed, k, 61) * 0.37;
    const cyc = Math.floor(ph), p = ph - cyc;
    const len = 3 + Math.round((h / 5) * (0.6 + 0.4 * hash(k, cyc, seed + 62)));
    const side = hash(k, cyc, seed + 63) < 0.5 ? -1 : 1;
    const wave = 0.7 + 0.35 * hash(k, cyc, seed + 64);
    const phase = hash(k, cyc, seed + 65) * 6.28;
    const head = p * (h + len);
    let lastX = cx;
    for (let j = len - 1; j >= 0; j--) {             // tail (low) to head (high)
      const yy = head - j;
      if (yy < 0 || yy >= h) continue;
      const a = yy / h;                              // 0 at the vent .. 1 at the top
      const x = cx + Math.round(Math.sin(yy * wave + phase) * (0.4 + 2.0 * a) + side * a * 1.8);
      const y = baseY - 1 - Math.round(yy);
      const c = a < 0.35 ? C.WHITE : a < 0.7 ? C.STEEL_LL : C.STEEL_L;
      const thin = a > 0.85 ? bayer(x, y) >= 6 : a > 0.6 ? ((x + y) & 1) === 1 : false;
      if (!thin) {
        fb.px(x, y, c);
        // keep the curl connected where it bends more than a pixel sideways
        if (j < len - 1 && Math.abs(x - lastX) > 1) fb.px((x + lastX) >> 1, y, c);
      }
      lastX = x;
    }
  }
}

/**
 * Rotating warning beacon, about 7x6, centred at (cx, cy).
 * @param {'off'|'amber'|'red'} mode   @param {number} rate  flashes per second
 *
 * Occupies x in [cx-3, cx+3], y in [cy-3, cy+2]; its 7px base plate is the bottom row
 * (cy+2), so it sits on a support whose top is at cy+3. When lit, a reflector sweeps
 * across the lens once per flash and throws a small dithered halo around the dome.
 */
export function drawBeacon(fb, cx, cy, t, mode, rate = 2) {
  cx = Math.round(cx); cy = Math.round(cy);
  const lit = mode === 'amber' || mode === 'red';
  const red = mode === 'red';
  const ph = t * rate;
  const s = ph - Math.floor(ph);
  const front = lit && s < 0.5;
  const col = front ? -2 + Math.min(4, Math.floor(s * 10)) : 2 - Math.min(4, Math.floor((s - 0.5) * 10));
  if (front) {                                       // halo, biased toward the beam side
    const hx = cx + col, hy = cy - 1;
    const R = 4.2 + 2.2 * Math.sin(s * 2 * Math.PI);
    const near = red ? C.RED_L : C.AMBER_L, far = red ? C.RED : C.AMBER;
    const Ri = Math.ceil(R);
    for (let dy = -Ri; dy <= Ri; dy++) {
      for (let dx = -Ri; dx <= Ri; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > R) continue;
        const x = hx + dx, y = hy + dy;
        if (y > cy + 1) continue;                    // light spills up and sideways, not under the base
        if (bayer(x, y) >= (1 - d / R) * 11) continue;
        fb.px(x, y, d < R * 0.5 ? near : far);
      }
    }
  }
  // housing: outline, base plate, collar
  fb.rect(cx - 1, cy - 3, 3, 1, C.INK);
  fb.px(cx - 2, cy - 2, C.INK); fb.px(cx + 2, cy - 2, C.INK);
  fb.rect(cx - 3, cy - 1, 1, 3, C.INK); fb.rect(cx + 3, cy - 1, 1, 3, C.INK);
  fb.rect(cx - 3, cy + 2, 7, 1, C.INK);
  fb.rect(cx - 2, cy + 1, 5, 1, C.STEEL);
  fb.px(cx - 2, cy + 1, C.STEEL_LL); fb.px(cx + 2, cy + 1, C.STEEL_D);
  // lens
  const body = !lit ? C.STEEL_D : front ? (red ? C.RED : C.AMBER) : (red ? C.RED_D : C.AMBER_D);
  fb.rect(cx - 1, cy - 2, 3, 1, body);
  fb.rect(cx - 2, cy - 1, 5, 2, body);
  if (!lit) {
    fb.px(cx - 1, cy - 2, C.STEEL); fb.px(cx - 2, cy - 1, C.STEEL); fb.px(cx - 1, cy - 1, C.STEEL_L);
    return;
  }
  if (front) {
    const hi = red ? C.RED_L : C.AMBER_L;
    for (const d of [-1, 1]) {
      const x = cx + col + d;
      if (x < cx - 2 || x > cx + 2) continue;
      fb.rect(x, cy - 1, 1, 2, hi);
      if (Math.abs(col + d) <= 1) fb.px(x, cy - 2, hi);
    }
    fb.rect(cx + col, cy - 1, 1, 2, C.CREAM);
    if (Math.abs(col) <= 1) fb.px(cx + col, cy - 2, C.CREAM);
    fb.px(cx + col, cy - 1, C.WHITE);
  } else {                                           // reflector passing behind the lens
    const mid = red ? C.RED : C.AMBER;
    fb.rect(cx + col, cy - 1, 1, 2, mid);
    if (Math.abs(col) <= 1) fb.px(cx + col, cy - 2, mid);
  }
}

const PULSE_DIM = {
  [C.CREAM]: C.AMBER_L, [C.WHITE]: C.STEEL_LL, [C.YELLOW]: C.AMBER, [C.AMBER_L]: C.AMBER,
  [C.CYAN_L]: C.CYAN, [C.CYAN]: C.TEAL, [C.MINT]: C.GREEN_L, [C.GREEN_L]: C.GREEN,
  [C.RED_L]: C.RED, [C.ORANGE]: C.RED, [C.SKY]: C.BLUE_L, [C.BLUE_L]: C.BLUE, [C.PINK]: C.VIOLET_L,
};

/** A bright pulse travelling along a power cable, centred at (x, y); about 3px. */
export function drawPulse(fb, x, y, t, color = C.CREAM) {
  x = Math.round(x); y = Math.round(y);
  const dim = PULSE_DIM[color] ?? C.AMBER_L;
  // cables run in any direction, so the pulse is a small twinkling plus, not a streak
  if ((Math.floor(t * 10) & 1) === 0) {
    fb.px(x - 1, y, dim); fb.px(x + 1, y, dim); fb.px(x, y - 1, dim); fb.px(x, y + 1, dim);
    fb.px(x, y, color);
  } else {
    fb.px(x - 1, y, color); fb.px(x + 1, y, color); fb.px(x, y - 1, color); fb.px(x, y + 1, color);
    fb.px(x, y, C.WHITE);
  }
}

/**
 * Soft dithered glow halo around (cx, cy) of radius r in colour c (heat glow, fire light
 * on nearby walls). Uses dithering only, never blending.
 */
export function drawGlow(fb, cx, cy, r, c, t = 0) {
  if (!(r >= 1)) return;
  cx = Math.round(cx); cy = Math.round(cy);
  const rr = r * (1 + 0.06 * Math.sin(Math.floor(t * 10) * 0.55));   // slow breathing
  const R = Math.ceil(rr), r2 = rr * rr;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const q = Math.sqrt(d2) / rr;                  // 0 centre .. 1 rim
      // dense (never solid) in the middle, a sparse scatter at the rim
      if (bayer(cx + dx, cy + dy) >= 0.5 + 11.5 * Math.pow(1 - q, 1.25)) continue;
      fb.px(cx + dx, cy + dy, c);
    }
  }
}
