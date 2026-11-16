// Close-up previews of the power plant art and the effects (headless).
//   node tools/preview-power.mjs [what...]      what = fx | core | hall | room | anim | check (default: all)
// Writes out/power-*.png. Only depends on the frozen gfx files plus power.mjs / fx.mjs.
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C, LIGHT } from '../src/gfx/palette.mjs';
import { drawText } from '../src/gfx/font.mjs';
import * as G from '../src/gfx/geom.mjs';
import { drawReactor, drawSwitchboard, drawGenerator, REACTOR_ANCHORS } from '../src/gfx/power.mjs';
import * as FX from '../src/gfx/fx.mjs';
import { savePng } from './png.mjs';

const out = (name) => new URL(`../out/power-${name}.png`, import.meta.url).pathname;
const want = process.argv.slice(2);
const on = (k) => want.length === 0 || want.includes(k);
const DT = 1 / 15;

// A neutral stand-in room shell (the real one is someone else's): back wall, ceiling, floor, walls.
function shell(fb, x, y, w, h, wall = C.STEEL_DD) {
  fb.rect(x, y, w, h, wall);
  fb.rect(x, y, w, G.CEIL_T, C.INK);
  fb.rect(x, y + h - G.FLOOR_T, w, G.FLOOR_T, C.STEEL_D);
  fb.rect(x, y + h - G.FLOOR_T, w, 1, C.STEEL);
  fb.rect(x, y, G.WALL_T, h, C.INK); fb.rect(x + w - G.WALL_T, y, G.WALL_T, h, C.INK);
  drawText(fb, x + 5, y + 5, 'REACTOR', C.CREAM);
}

const STATES = {
  ok: { status: 'ok', heat: 0.12, percent: 20, speed: 0.5 },
  hot: { status: 'hot', heat: 0.7, percent: 78, speed: 0.8 },
  critical: { status: 'critical', heat: 0.93, percent: 93, speed: 1 },
  meltdown: { status: 'meltdown', heat: 1, percent: 100, speed: 0 },
};

function hall(fb, x, y, w, t, st, opts = {}) {
  const h = G.REACTOR_H;
  shell(fb, x, y, w, h, opts.wall);
  const r = { ...STATES[st], phase: st === 'meltdown' ? 3.37 : t * STATES[st].speed * 1.6, ...(opts.r || {}) };
  drawReactor(fb, x, y, w, h, t, r);
  const cx = x + (w >> 1), fy = y + h - G.FLOOR_T;
  const A = REACTOR_ANCHORS;
  if (opts.fx) {
    if (st === 'meltdown') {
      fb.relight(x, y, w, h, LIGHT.EMERGENCY);
      FX.drawGlow(fb, cx + A.fire[0][0], fy + A.fire[0][1] - 10, 30, C.RED, t);
      A.smoke.forEach(([sx, sy], i) => FX.drawSmoke(fb, cx + sx, fy + sy, i ? 22 : 30, t, i ? 0.7 : 1, 1 + i));
      A.fire.forEach(([fx, fyy], i) => FX.drawFire(fb, cx + fx, fy + fyy, i ? 16 : 40, i ? 14 : 34, t, i ? 0.7 : 1, 1 + i));
      A.lamps.forEach(([lx, ly]) => FX.drawBeacon(fb, cx + lx, fy + ly, t, 'red', 2));
    } else {
      const mode = st === 'ok' ? 'off' : st === 'hot' ? 'amber' : 'red';
      A.lamps.forEach(([lx, ly]) => FX.drawBeacon(fb, cx + lx, fy + ly, t, mode, st === 'hot' ? 1 : 2));
    }
  }
  if (opts.marks) {
    for (const [ax, ay] of A.fire) fb.px(cx + ax, fy + ay, C.MAGENTA);
    for (const [ax, ay] of A.smoke) fb.px(cx + ax, fy + ay, C.GREEN_L);
    for (const [ax, ay] of A.lamps) fb.px(cx + ax, fy + ay, C.CYAN_L);
  }
}

// ---- effects ---------------------------------------------------------------------------
if (on('fx')) {
  const N = 12;
  const fb = new Framebuffer(8 + N * 50, 420);
  fb.clear(C.STEEL_DD);
  fb.rect(0, 210, fb.w, 60, C.WALL);                 // mid-tone band to check contrast
  for (let i = 0; i < N; i++) {
    const t = 1.3 + i * DT, x = 28 + i * 50;
    // big reactor fire, small machine fire, tiny fire
    FX.drawFire(fb, x, 44, 40, 34, t, 1, 1);
    FX.drawFire(fb, x, 74, 22, 18, t, 0.5, 3);
    FX.drawFire(fb, x - 12, 96, 22, 18, t, 0.8, 4);
    FX.drawFire(fb, x + 12, 96, 12, 10, t, 0.3, 5);
    // smoke: three sizes
    FX.drawSmoke(fb, x - 12, 162, 50, t, 1, 4);
    FX.drawSmoke(fb, x + 8, 162, 30, t, 1, 1);
    FX.drawSmoke(fb, x + 20, 162, 14, t, 0.6, 3);
    // sparks (several seeds so some are mid-burst), steam
    FX.drawSparks(fb, x - 12, 185, t, 1, 2);
    FX.drawSparks(fb, x + 12, 185, t, 0.5, 9);
    FX.drawSteam(fb, x - 14, 258, 30, t, 1, 2);
    FX.drawSteam(fb, x, 258, 16, t, 0.5, 5);
    FX.drawSteam(fb, x + 12, 258, 10, t, 1, 7);
    FX.drawSparks(fb, x + 4, 225, t, 1, 4);
    // beacons: off / amber / red at rate 2 and 1
    FX.drawBeacon(fb, x - 16, 290, t, 'off', 2);
    FX.drawBeacon(fb, x - 2, 290, t, 'amber', 2);
    FX.drawBeacon(fb, x + 14, 290, t, 'red', 2);
    FX.drawBeacon(fb, x - 10, 308, t, 'amber', 1);
    FX.drawBeacon(fb, x + 8, 308, t, 'red', 1);
    // pulses on cables
    fb.hline(x - 20, 326, 40, C.AMBER_D); fb.vline(x + 14, 318, 16, C.AMBER_D);
    FX.drawPulse(fb, x - 20 + ((i * 4) % 40), 326, t);
    FX.drawPulse(fb, x + 14, 319 + (i % 14), t, C.CYAN_L);
    // glows
    FX.drawGlow(fb, x - 10, 360, 14, C.ORANGE, t);
    FX.drawGlow(fb, x + 14, 350, 7, C.TEAL, t);
    FX.drawGlow(fb, x + 14, 372, 5, C.RED, t);
    // glow + fire together, as the world would use them
    FX.drawGlow(fb, x, 400, 20, C.RED, t);
    FX.drawFire(fb, x, 414, 22, 18, t, 0.6, 8);
  }
  console.log(savePng(fb, out('fx'), 2));

  // big close-up of a few consecutive fire frames
  const fc = new Framebuffer(6 * 60, 130);
  fc.clear(C.STEEL_DD);
  for (let i = 0; i < 6; i++) {
    const t = 2.0 + i * DT, x = 30 + i * 60;
    FX.drawSmoke(fc, x, 22, 20, t, 1, 1);
    FX.drawFire(fc, x, 60, 44, 40, t, 1, 1);
    FX.drawFire(fc, x - 14, 92, 22, 18, t, 0.5, 3);
    FX.drawFire(fc, x + 14, 92, 22, 18, t, 0.6, 3);
    FX.drawSmoke(fc, x - 14, 128, 14, t, 0.6, 3);
    FX.drawSparks(fc, x + 14, 116, 0.05 + i * DT, 1, 2);
  }
  console.log(savePng(fc, out('fx-close'), 4));
}

// ---- zoomed strips of the small effects ------------------------------------------------------
if (on('fxz')) {
  const N = 12, cw = 26;
  const fb = new Framebuffer(N * cw, 150);
  fb.clear(C.STEEL_DD);
  fb.rect(0, 50, fb.w, 46, C.WALL);
  // find the start of a spark burst so the strip shows one whole burst
  const burstStart = (seed, inten) => {
    const probe = new Framebuffer(40, 40);
    let prev = false;
    for (let t = 0; t < 30; t += 1 / 60) {
      probe.clear(0); FX.drawSparks(probe, 20, 20, t, inten, seed);
      const lit = probe.buf.some((b) => b !== 0);
      if (lit && !prev && t > 0.5) return t;
      prev = lit;
    }
    return 0;
  };
  const b1 = burstStart(2, 1), b2 = burstStart(7, 0.5);
  for (let i = 0; i < N; i++) {
    const x = 13 + i * cw;
    FX.drawSparks(fb, x, 14, b1 + i * 0.03, 1, 2);
    FX.drawSparks(fb, x, 38, b2 + i * 0.03, 0.5, 7);
    FX.drawSparks(fb, x, 60, b1 + i * 0.03, 1, 2);
    const t = 1.3 + i * DT;
    FX.drawSteam(fb, x - 6, 94, 30, t, 1, 2);
    FX.drawSteam(fb, x + 4, 94, 16, t, 0.5, 5);
    FX.drawSteam(fb, x + 9, 94, 10, t, 1, 7);
    const tb = i / N / 2;                              // one full rotation at rate 2
    fb.rect(x - 9, 109, 5, 2, C.STEEL); fb.rect(x + 3, 109, 7, 2, C.STEEL);
    FX.drawBeacon(fb, x - 7, 106, tb, 'amber', 2);
    FX.drawBeacon(fb, x + 6, 106, tb, 'red', 2);
    FX.drawBeacon(fb, x, 122, tb, 'off', 2);
    fb.hline(x - 12, 136, 24, C.AMBER_D); fb.vline(x + 8, 128, 16, C.STEEL_D);
    FX.drawPulse(fb, x - 10 + i * 2, 136, t);
    FX.drawPulse(fb, x + 8, 130 + i, t, C.CYAN_L);
  }
  console.log(savePng(fb, out('fx-zoom'), 5));
}

// ---- reactor core, compact hall ---------------------------------------------------------
if (on('core')) {
  const W = 232, H = G.REACTOR_H;
  const fb = new Framebuffer(W * 2 + 12, (H + 4) * 4 + 4);
  fb.clear(C.ROCK_D);
  Object.keys(STATES).forEach((st, i) => {
    hall(fb, 4, 4 + i * (H + 4), W, 1.3, st, { fx: st !== 'meltdown' });
    hall(fb, 8 + W, 4 + i * (H + 4), W, 1.3, st, { fx: true, wall: st === 'meltdown' ? C.STEEL_DD : C.WALL });
  });
  console.log(savePng(fb, out('core'), 3));

  // close-up of just the core in each state, with anchor marks
  const fc = new Framebuffer(4 * 84 + 4, 84);
  fc.clear(C.ROCK_D);
  Object.keys(STATES).forEach((st, i) => {
    fc.setClip(4 + i * 84, 2, 80, 80);
    hall(fc, 4 + i * 84 - 76, 2, W, 1.3, st, { marks: true });
    fc.clearClip();
  });
  console.log(savePng(fc, out('core-close'), 5));
}

// ---- full-width hall ---------------------------------------------------------------------
if (on('hall')) {
  const W = 448, H = G.REACTOR_H;
  const fb = new Framebuffer(W + 8, (H + 4) * 4 + 4);
  fb.clear(C.ROCK_D);
  Object.keys(STATES).forEach((st, i) => hall(fb, 4, 4 + i * (H + 4), W, 1.3, st, { fx: true }));
  console.log(savePng(fb, out('hall'), 3));
  // left and right halves at a bigger scale (ok + critical)
  for (const [name, off] of [['hall-left', 0], ['hall-right', W / 2]]) {
    const f2 = new Framebuffer(W / 2 + 4, (H + 4) * 2 + 4);
    f2.clear(C.ROCK_D);
    ['ok', 'critical'].forEach((st, i) => {
      f2.setClip(2, 4 + i * (H + 4), W / 2, H);
      hall(f2, 2 - off, 4 + i * (H + 4), W, 1.3, st, { fx: true });
      f2.clearClip();
    });
    console.log(savePng(f2, out(name), 6));
  }
}

// ---- power room: switchboard + generator -------------------------------------------------
if (on('room')) {
  const cellW = 60, cellH = 60;
  const sw = [
    { status: 'ok', percent: 22 }, { status: 'ok', percent: 64 }, { status: 'warn', percent: 86 },
    { status: 'warn', percent: 97 }, { status: 'tripped', percent: 100 }, { status: 'ok', percent: null },
  ];
  const fb = new Framebuffer(sw.length * cellW + 4, cellH * 4 + 4);
  fb.clear(C.ROCK_D);
  sw.forEach((s, i) => {
    for (let k = 0; k < 2; k++) {
      const x = 2 + i * cellW, y = 2 + k * cellH;
      fb.rect(x, y, cellW - 2, cellH - 2, k ? C.WALL : C.STEEL_D);
      fb.rect(x, y + cellH - 6, cellW - 2, 4, C.STEEL_DD);
      const t = 1.3 + k * 0.3;
      drawSwitchboard(fb, x + 29, y + cellH - 6, t, s);
      if (s.status === 'tripped') {
        if (k) fb.relight(x, y, cellW - 2, cellH - 2, LIGHT.AMBER);
        FX.drawSparks(fb, x + 29, y + cellH - 6 - 30, 0.1 + k * 0.05, 1, 2);
      }
    }
  });
  const gens = [
    { present: false, running: false, utilization: null, phase: 0 },
    { present: true, running: false, utilization: null, phase: 0 },
    { present: true, running: false, utilization: 0.3, phase: 0.3 },
    { present: true, running: true, utilization: 0.1, phase: 1.3 },
    { present: true, running: true, utilization: 0.7, phase: 1.3 * 1.37 },
    { present: true, running: true, utilization: 0.97, phase: 9.61 },
  ];
  gens.forEach((g, i) => {
    for (let k = 0; k < 2; k++) {
      const x = 2 + i * cellW, y = 2 + (2 + k) * cellH;
      fb.rect(x, y, cellW - 2, cellH - 2, k ? C.WALL : C.STEEL_D);
      fb.rect(x, y + cellH - 6, cellW - 2, 4, C.STEEL_DD);
      drawGenerator(fb, x + 29, y + cellH - 6, 1.3 + k * 0.21 + i * 0.07, g);
      if (k && i < 2) fb.relight(x, y, cellW - 2, cellH - 2, i ? LIGHT.DARK : LIGHT.AMBER);
    }
  });
  console.log(savePng(fb, out('room'), 4));
}

// ---- animation strips ---------------------------------------------------------------------
if (on('anim')) {
  const N = 8, cw = 96, ch = 80;
  const fb = new Framebuffer(N * (cw + 2) + 2, 4 * (ch + 2) + 2);
  fb.clear(C.ROCK_D);
  Object.keys(STATES).forEach((st, row) => {
    for (let i = 0; i < N; i++) {
      const x = 2 + i * (cw + 2), y = 2 + row * (ch + 2);
      fb.setClip(x, y, cw, ch);
      hall(fb, x - (116 - cw / 2) - 20, y, 232, 2.0 + i * DT * 2, st, { fx: true });
      fb.clearClip();
    }
  });
  console.log(savePng(fb, out('anim'), 2));

  // switchboard + generator over time
  const f2 = new Framebuffer(N * 50 + 2, 3 * 52 + 2);
  f2.clear(C.STEEL_D);
  for (let i = 0; i < N; i++) {
    const t = 2.0 + i * DT * 2, x = 26 + i * 50;
    drawSwitchboard(f2, x - 8, 48, t, { status: 'warn', percent: 91 });
    drawGenerator(f2, x, 100, t, { present: true, running: true, utilization: 0.55, phase: t * 1.5 });
    drawGenerator(f2, x, 152, t, { present: true, running: false, utilization: 0.55, phase: 0.2 });
  }
  console.log(savePng(f2, out('anim-room'), 3));
}

// ---- contract checks -----------------------------------------------------------------------
if (on('check')) {
  let bad = 0;
  const fail = (msg) => { bad++; console.log('FAIL: ' + msg); };
  const SENT = C.MAGENTA;
  const bbox = (fb) => {
    let x0 = fb.w, y0 = fb.h, x1 = -1, y1 = -1;
    for (let y = 0; y < fb.h; y++) for (let x = 0; x < fb.w; x++) {
      if (fb.buf[y * fb.w + x] !== SENT) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return [x0, y0, x1, y1];
  };
  const same = (a, b) => { for (let i = 0; i < a.buf.length; i++) if (a.buf[i] !== b.buf[i]) return false; return true; };
  const maxByte = (fb) => { let m = 0; for (const b of fb.buf) if (b > m && b !== SENT) m = b; return m; };
  const ts = [0, 0.37, 1.3, 2.71, 36000.37];

  // switchboard stays inside 28x40
  for (const status of ['ok', 'warn', 'tripped', 'bogus']) for (const percent of [null, 0, 50, 86.4, 100, 140, -5]) for (const t of ts) {
    const fb = new Framebuffer(80, 80); fb.clear(SENT);
    drawSwitchboard(fb, 40, 60, t, { status, percent });
    const [x0, y0, x1, y1] = bbox(fb);
    if (x0 < 40 - 14 || x1 > 40 + 13 || y0 < 60 - 40 || y1 > 59) fail(`switchboard ${status} ${percent} t=${t} bbox ${[x0, y0, x1, y1]}`);
    if (maxByte(fb) > 63) fail('switchboard wrote light bits');
    const fb2 = new Framebuffer(80, 80); fb2.clear(SENT); drawSwitchboard(fb2, 40, 60, t, { status, percent });
    if (!same(fb, fb2)) fail('switchboard not deterministic');
  }
  // generator stays inside 44x30 (exhaust puffs of a running unit may rise above: reported separately)
  let genTop = 0;
  for (const present of [false, true]) for (const running of [false, true]) for (const utilization of [null, 0, 0.5, 1, 1.7, -1]) for (const t of ts) {
    const fb = new Framebuffer(100, 100); fb.clear(SENT);
    const g = { present, running, utilization, phase: t * 1.3 };
    drawGenerator(fb, 50, 80, t, g);
    const [x0, y0, x1, y1] = bbox(fb);
    if (x1 >= 0) {
      if (x0 < 50 - 22 || x1 > 50 + 21 || y1 > 79) fail(`generator ${JSON.stringify(g)} bbox ${[x0, y0, x1, y1]}`);
      if (y0 < 50) { if (!(present && running)) fail(`generator above box while not running ${[x0, y0, x1, y1]}`); genTop = Math.max(genTop, 50 - y0); }
    }
    if (maxByte(fb) > 63) fail('generator wrote light bits');
    const fb2 = new Framebuffer(100, 100); fb2.clear(SENT); drawGenerator(fb2, 50, 80, t, g);
    if (!same(fb, fb2)) fail('generator not deterministic');
  }
  console.log(`generator exhaust rises up to ${genTop}px above its 44x30 box when running`);
  // a stopped generator is identical across t
  {
    const a = new Framebuffer(100, 100), b = new Framebuffer(100, 100);
    for (const g of [{ present: true, running: false, utilization: 0.4, phase: 0.6 }, { present: false, running: false, utilization: null, phase: 0 }]) {
      a.clear(SENT); b.clear(SENT);
      drawGenerator(a, 50, 80, 0.2, g); drawGenerator(b, 50, 80, 7.77, g);
      if (!same(a, b)) fail('stopped generator changes with t');
    }
  }
  // reactor stays inside the hall interior
  for (const w of [232, 448, 300, 160]) for (const st of ['ok', 'hot', 'critical', 'meltdown', 'bogus']) for (const t of ts) for (const percent of [null, 0, 55.5, 100, 250]) {
    const fb = new Framebuffer(w + 40, 120); fb.clear(SENT);
    const r = { status: st, heat: st === 'ok' ? 0.1 : st === 'bogus' ? 7 : 0.9, phase: t * 0.7, speed: 0.5, percent };
    drawReactor(fb, 20, 20, w, G.REACTOR_H, t, r);
    const [x0, y0, x1, y1] = bbox(fb);
    if (x0 < 20 + G.WALL_T || x1 > 20 + w - G.WALL_T - 1 || y0 < 20 + G.CEIL_T || y1 > 20 + G.REACTOR_H - G.FLOOR_T - 1) fail(`reactor w=${w} ${st} t=${t} bbox ${[x0 - 20, y0 - 20, x1 - 20, y1 - 20]}`);
    if (maxByte(fb) > 63) fail('reactor wrote light bits');
    const fb2 = new Framebuffer(w + 40, 120); fb2.clear(SENT); drawReactor(fb2, 20, 20, w, G.REACTOR_H, t, r);
    if (!same(fb, fb2)) fail('reactor not deterministic');
  }
  // effects: deterministic, base colours only
  for (const t of ts) {
    const mk = () => {
      const fb = new Framebuffer(200, 120); fb.clear(SENT);
      FX.drawFire(fb, 30, 60, 40, 34, t, 1, 1); FX.drawFire(fb, 30, 110, 22, 18, t, 0.5, 3);
      FX.drawSmoke(fb, 80, 110, 50, t, 1, 4); FX.drawSparks(fb, 110, 30, t, 1, 2); FX.drawSteam(fb, 110, 110, 30, t, 1, 2);
      FX.drawBeacon(fb, 140, 30, t, 'red', 2); FX.drawBeacon(fb, 160, 30, t, 'amber', 2); FX.drawBeacon(fb, 180, 30, t, 'off', 2);
      FX.drawPulse(fb, 140, 60, t); FX.drawGlow(fb, 160, 90, 14, C.ORANGE, t);
      return fb;
    };
    const a = mk(), b = mk();
    if (!same(a, b)) fail('fx not deterministic');
    if (maxByte(a) > 63) fail('fx wrote light bits');
  }
  // timing
  const time = (label, fn, n = 300) => {
    const fb = new Framebuffer(480, 120);
    for (let i = 0; i < 30; i++) fn(fb, i * 0.016);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(fb, 36000.37 + i * 0.016);
    console.log(`${label.padEnd(26)} ${((performance.now() - t0) / n).toFixed(3)} ms`);
  };
  time('reactor 448 ok', (fb, t) => drawReactor(fb, 4, 4, 448, 80, t, { status: 'ok', heat: 0.1, phase: t, speed: 0.5, percent: 20 }));
  time('reactor 448 critical', (fb, t) => drawReactor(fb, 4, 4, 448, 80, t, { status: 'critical', heat: 0.9, phase: t, speed: 0.5, percent: 93 }));
  time('reactor 232 meltdown', (fb, t) => drawReactor(fb, 4, 4, 232, 80, t, { status: 'meltdown', heat: 1, phase: 1, speed: 0, percent: 100 }));
  time('switchboard', (fb, t) => drawSwitchboard(fb, 40, 60, t, { status: 'warn', percent: 90 }));
  time('generator running', (fb, t) => drawGenerator(fb, 40, 60, t, { present: true, running: true, utilization: 0.5, phase: t }));
  time('fire 40x34 @1', (fb, t) => FX.drawFire(fb, 60, 100, 40, 34, t, 1, 1));
  time('fire 22x18 @0.5', (fb, t) => FX.drawFire(fb, 60, 100, 22, 18, t, 0.5, 1));
  time('smoke h50', (fb, t) => FX.drawSmoke(fb, 60, 100, 50, t, 1, 1));
  time('smoke h14', (fb, t) => FX.drawSmoke(fb, 60, 100, 14, t, 0.6, 1));
  time('sparks', (fb, t) => FX.drawSparks(fb, 60, 60, t, 1, 1));
  time('steam h30', (fb, t) => FX.drawSteam(fb, 60, 100, 30, t, 1, 1));
  time('beacon red', (fb, t) => FX.drawBeacon(fb, 60, 60, t, 'red', 2));
  time('glow r14', (fb, t) => FX.drawGlow(fb, 60, 60, 14, C.ORANGE, t));
  time('glow r30', (fb, t) => FX.drawGlow(fb, 60, 60, 30, C.ORANGE, t));
  console.log(bad ? `${bad} check(s) FAILED` : 'all checks passed');
  if (bad) process.exitCode = 1;
}
