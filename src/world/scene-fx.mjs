// Scene-only drawing helpers: in-world gauge plates, lit signs, and the few effects the
// painter modules do not provide (limit-reached bursts, welding sparks, heavy steam, a
// heat halo ring). Pure functions of their arguments; no state, no allocation per call
// beyond what the font needs. Effects are deterministic from (t, seed) via hash().
import { C } from '../gfx/palette.mjs';
import { hash } from '../gfx/fb.mjs';
import { drawText, textWidth } from '../gfx/font.mjs';
import { drawSteam, drawGlow } from '../gfx/fx.mjs';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
const frac = (v) => v - Math.floor(v);

/** Text colour of an allowance level. */
export const LEVEL_COL = Object.freeze({ ok: C.GREEN_L, warn: C.AMBER_L, critical: C.RED_L, exhausted: C.RED_L });

/** Pixel height of a plate with n text lines. */
export const plateH = (n) => n * 6 + 3;

/**
 * Small dark gauge plate on the back wall: ink face, steel rim, two rivets, then up to
 * `n` lines of 3x5 text. texts/cols are parallel arrays (reused by the caller).
 */
export function drawPlate(fb, x, y, w, n, texts, cols) {
  const h = plateH(n);
  fb.rect(x, y, w, h, C.INK);
  fb.frame(x, y, w, h, C.STEEL_D);
  fb.px(x, y, C.STEEL); fb.px(x + w - 1, y + h - 1, C.STEEL_DD);
  for (let i = 0; i < n; i++) drawText(fb, x + 2, y + 2 + i * 6, texts[i], cols[i]);
}

/**
 * One-line plate whose text is made of segments in different colours, laid out from
 * the left with a 4px gap between segments.
 */
export function drawPlateRow(fb, x, y, w, texts, cols, n) {
  fb.rect(x, y, w, 9, C.INK);
  fb.frame(x, y, w, 9, C.STEEL_D);
  fb.px(x, y, C.STEEL);
  let cx = x + 2;
  for (let i = 0; i < n; i++) cx += drawText(fb, cx, y + 2, texts[i], cols[i]) + 4;
}

/**
 * A lit (emissive) sign: ink plate, a bright border that blinks, text in `col`.
 * align: 'left' | 'center' | 'right' relative to x. 1 or 2 lines (b may be null).
 * Returns nothing; draws over everything (call after relighting).
 */
export function drawSign(fb, x, y, a, b, col, dim, t, align = 'left', blinkRate = 1.5) {
  const w = Math.max(textWidth(a), b ? textWidth(b) : 0) + 6;
  const h = b ? 15 : 9;
  let x0 = x | 0;
  if (align === 'center') x0 -= w >> 1; else if (align === 'right') x0 -= w;
  const on = blinkRate <= 0 || frac(t * blinkRate) < 0.62;
  fb.rect(x0, y, w, h, C.INK);
  fb.frame(x0, y, w, h, on ? col : dim);
  fb.px(x0, y, C.INK); fb.px(x0 + w - 1, y, C.INK); fb.px(x0, y + h - 1, C.INK); fb.px(x0 + w - 1, y + h - 1, C.INK);
  drawText(fb, x0 + (w >> 1), y + 2, a, on ? col : dim, { align: 'center' });
  if (b) drawText(fb, x0 + (w >> 1), y + 8, b, col, { align: 'center' });
}

/** Ordered-dither disc: density 0..1 of pixels lit. */
export function ditherDisc(fb, cx, cy, r, col, density) {
  if (r < 0.5 || density <= 0) return;
  const R = Math.ceil(r), r2 = r * r, th = density * 16;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (bayer(x, y) < th) fb.px(x, y, col);
    }
  }
}

/**
 * Shaded smoke puff (light from the top-left), dithered thinner at the rim.
 * density 0..1. Colours: body, highlight, shadow.
 */
export function smokePuff(fb, cx, cy, r, density, body = C.SMOKE, hi = C.SMOKE_L, lo = C.SMOKE_D) {
  if (r < 0.5 || density <= 0) return;
  const R = Math.ceil(r), r2 = r * r, rin = r * r * 0.4;
  const tIn = Math.min(16, density * 18), tRim = density * 9;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (bayer(x, y) >= (d2 <= rin ? tIn : tRim)) continue;
      const s = (dx + dy) / r;
      fb.px(x, y, s < -0.55 ? hi : s > 0.55 ? lo : body);
    }
  }
}

/**
 * Burst of sparks and a flash when a limit is reached: particles shoot out, fall and cool.
 * @param {number} age seconds since the burst started (draws nothing after ~1.4 s)
 */
export function drawBurst(fb, cx, cy, age, seed, scale = 1) {
  if (age < 0 || age > 1.4) return;
  cx = Math.round(cx); cy = Math.round(cy);
  if (age < 0.22) {                                   // flash
    const k = age / 0.22;
    drawGlow(fb, cx, cy, Math.round((5 + 12 * k) * scale), k < 0.5 ? C.CREAM : C.YELLOW, 0);
    if (k < 0.6) { fb.rect(cx - 1, cy - 1, 3, 3, C.WHITE); fb.ring(cx, cy, Math.round((3 + 10 * k) * scale), C.WHITE); }
  }
  const n = Math.round(14 * scale);
  for (let i = 0; i < n; i++) {
    const life = 0.6 + 0.8 * hash(i, seed, 1);
    if (age > life) continue;
    const q = age / life;
    const a = -Math.PI * (0.05 + 0.9 * hash(i, seed, 2)) + (hash(i, seed, 5) < 0.2 ? Math.PI * 0.6 : 0);
    const v = (26 + 46 * hash(i, seed, 3)) * scale;
    const x = cx + Math.cos(a) * v * age, y = cy + Math.sin(a) * v * age + 70 * age * age;
    const col = q < 0.3 ? C.WHITE : q < 0.55 ? C.CREAM : q < 0.8 ? C.YELLOW : C.ORANGE;
    fb.px(Math.round(x), Math.round(y), col);
    if (q < 0.6) {
      const tb = Math.max(0, age - 0.03);
      fb.px(Math.round(cx + Math.cos(a) * v * tb), Math.round(cy + Math.sin(a) * v * tb + 70 * tb * tb), C.YELLOW);
    }
  }
}

/**
 * Welding-style repair sparks at (x, y): a flickering white-blue arc point with a small
 * halo and a steady stream of sparks falling away under gravity.
 */
export function drawWeld(fb, x, y, t, seed = 0, intensity = 1) {
  if (intensity <= 0) return;
  x = Math.round(x); y = Math.round(y);
  const f = Math.floor(t * 22);
  const lit = hash(f, seed, 7) < 0.55 + 0.4 * intensity;
  if (lit) {
    drawGlow(fb, x, y, Math.round((5 + 2 * (f & 1)) * Math.min(1, 0.5 + intensity)), C.TEAL, 0);
    drawGlow(fb, x, y, 3, C.CYAN, 0);
    fb.rect(x - 1, y - 1, 3, 3, C.CYAN_L);
    fb.px(x - 2, y, C.CYAN_L); fb.px(x + 2, y, C.CYAN_L); fb.px(x, y - 2, C.CYAN_L); fb.px(x, y + 2, C.CYAN_L);
    fb.px(x, y, C.WHITE);
  } else {
    fb.px(x, y, C.CYAN);
  }
  const n = 3 + Math.round(6 * intensity);
  for (let k = 0; k < n; k++) {
    const period = 0.45 + 0.35 * hash(k, seed, 11);
    const ph = t / period + hash(k, seed, 12);
    const cyc = Math.floor(ph), p = ph - cyc;
    if (p > 0.85) continue;
    const tau = p * period;
    const vx = (hash(k, cyc, seed + 13) - 0.5) * 46;
    const vy = -6 - 26 * hash(k, cyc, seed + 14);
    const sx = x + vx * tau, sy = y + vy * tau + 95 * tau * tau;
    const col = p < 0.25 ? C.WHITE : p < 0.5 ? C.YELLOW : C.ORANGE;
    fb.px(Math.round(sx), Math.round(sy), col);
    if (p < 0.55) fb.px(Math.round(sx - vx * 0.02), Math.round(sy - (vy + 190 * tau) * 0.02), C.YELLOW);
  }
}

/**
 * Heavy steam: several wisps across a width plus soft white billows rising and thinning.
 * Used when flames die (cool-down) and on very hot vents.
 */
export function drawSteamCloud(fb, cx, baseY, w, h, t, intensity, seed = 0) {
  if (intensity <= 0) return;
  cx = Math.round(cx); baseY = Math.round(baseY);
  const nw = 1 + Math.round(3 * intensity);
  for (let k = 0; k < nw; k++) {
    const ox = nw === 1 ? 0 : Math.round((k / (nw - 1) - 0.5) * w);
    drawSteam(fb, cx + ox, baseY, Math.round(h * (0.75 + 0.25 * hash(k, seed, 21))), t, 1, seed + k * 7);
  }
  const nb = 2 + Math.round(4 * intensity);
  const T = Math.floor(t * 12) / 12;
  for (let k = 0; k < nb; k++) {
    const period = 1.3 + 0.8 * hash(k, seed, 22);
    const ph = T / period + hash(k, seed, 23);
    const cyc = Math.floor(ph), p = ph - cyc;
    const x = cx + Math.round((hash(k, cyc, seed + 24) - 0.5) * w + Math.sin(p * 5 + k) * 2);
    const y = baseY - Math.round(p * h);
    const r = 1.5 + 4 * p;
    const d = intensity * (p < 0.3 ? 0.75 : p < 0.6 ? 0.5 : 0.28);
    ditherDisc(fb, x, y, r, p < 0.4 ? C.WHITE : C.STEEL_LL, d);
  }
}

/** Dithered heat halo in a ring around a box-ish object (does not cover the object). */
export function drawHaloRing(fb, cx, cy, r0, r1, col, t, strength = 1) {
  const R = Math.ceil(r1);
  const breathe = 0.85 + 0.15 * Math.sin(Math.floor(t * 10) * 0.6);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < r0 || d > r1) continue;
      const q = 1 - (d - r0) / (r1 - r0);
      if (bayer(cx + dx, cy + dy) < q * q * 9 * strength * breathe) fb.px(cx + dx, cy + dy, col);
    }
  }
}
