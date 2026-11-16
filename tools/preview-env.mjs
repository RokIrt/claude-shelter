// Close-up previews and sanity checks for src/gfx/env.mjs.
//   node tools/preview-env.mjs [what] [t]
//   what: rooms | parts | shelter | light | check | all (default all); t: seconds (default 1.3)
// Writes out/env-*.png. Other painters are replaced by plain stand-in boxes at the geom
// anchors (pass --real to use the sibling painters instead, when they import cleanly).
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C, LIGHT } from '../src/gfx/palette.mjs';
import { drawText } from '../src/gfx/font.mjs';
import * as G from '../src/gfx/geom.mjs';
import * as ENV from '../src/gfx/env.mjs';
import { savePng } from './png.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const what = args[0] ?? 'all';
const T = Number(args[1] ?? 1.3);
const REAL = process.argv.includes('--real');
const out = (name) => new URL(`../out/env-${name}.png`, import.meta.url).pathname;

let ACT = null, MACH = null, POW = null;
if (REAL) {
  try { ACT = await import('../src/gfx/actors.mjs'); } catch (e) { console.log('actors.mjs unavailable:', e.message); }
  try { MACH = await import('../src/gfx/machines.mjs'); } catch (e) { console.log('machines.mjs unavailable:', e.message); }
  try { POW = await import('../src/gfx/power.mjs'); } catch (e) { console.log('power.mjs unavailable:', e.message); }
}

// --- stand-ins ---------------------------------------------------------------------
const UNI = [[C.VIOLET, C.VIOLET_D], [C.COPPER, C.COPPER_D], [C.BLUE, C.BLUE_D], [C.GREEN, C.GREEN_D], [C.STEEL, C.STEEL_D]];
function resident(fb, cx, fy, i = 0, sit = false, t = 0) {
  if (ACT) { ACT.drawResident(fb, cx, fy, t, { role: i === 0 ? 'foreman' : 'programmer', pose: sit ? 'sit' : 'idle', facing: 1, uniform: ['fable', 'opus', 'sonnet', 'haiku', 'generic'][i % 5], mood: 'happy', seed: i }); return; }
  const [main, shade] = UNI[i % UNI.length];
  const x = cx - 5, y = fy - (sit ? 11 : 14);
  fb.rect(x + 2, y, 6, 6, C.STEEL_LL); fb.frame(x + 2, y, 6, 6, C.INK);
  fb.rect(x + 3, y + 2, 4, 2, C.GREEN_DD);
  fb.rect(x + 1, y + 6, 8, sit ? 3 : 5, main); fb.frame(x + 1, y + 6, 8, sit ? 3 : 5, C.INK);
  if (sit) { fb.rect(x + 2, y + 9, 7, 2, shade); }
  else { fb.rect(x + 2, y + 11, 2, 3, shade); fb.rect(x + 6, y + 11, 2, 3, shade); }
}
function bubble(fb, cx, y) {
  const x = cx - 5, top = y - 13;
  fb.rect(x, top, 11, 11, C.CREAM); fb.frame(x, top, 11, 11, C.INK); fb.px(cx, y - 2, C.INK);
}
function box(fb, cx, fy, w, h, c, label) {
  const x = cx - (w >> 1), y = fy - h;
  fb.rect(x, y, w, h, c); fb.frame(x, y, w, h, C.INK);
  if (label) drawText(fb, cx, y + (h >> 1) - 2, label, C.WHITE, { align: 'center', shadow: C.INK });
}
function item(fb, x, y, kind) { fb.rect(x, y, 6, 6, kind === 'crate' ? C.CRATE : C.PACKAGE); fb.frame(x, y, 6, 6, C.INK); }

/** Draw a room and (optionally) everything the world would layer on top of it. */
function room(fb, x, y, kind, t, opts = {}, standins = true, w) {
  const h = kind === 'reactor' ? G.REACTOR_H : G.ROOM_H;
  w = w ?? (kind === 'machine' ? G.ROOM_W : kind === 'reactor' ? 448 : G.HALF_W);
  ENV.drawRoom(fb, x, y, w, h, kind, t, { label: kind, ...opts });
  const fy = y + h - G.FLOOR_T;
  if (!standins) return;
  if (kind === 'machine') {
    ENV.drawBelt(fb, x + G.BELT_IN[0], y + G.BELT_Y, G.BELT_IN[1] - G.BELT_IN[0], t * 12);
    ENV.drawBelt(fb, x + G.BELT_OUT[0], y + G.BELT_Y, G.BELT_OUT[1] - G.BELT_OUT[0], t * 12);
    const L = G.LOOP;
    ENV.drawPipe(fb, [[x + G.MACHINE_CX - 44, y + L.y1], [x + L.x0, y + L.y1], [x + L.x0, y + L.y0], [x + L.x1, y + L.y0], [x + L.x1, y + L.y1], [x + G.MACHINE_CX + 44, y + L.y1]], 'cache');
    item(fb, x + 20, y + G.BELT_Y - 6, 'crate'); item(fb, x + 36, y + G.BELT_Y - 6, 'crate'); item(fb, x + 170, y + G.BELT_Y - 6, 'package');
    fb.rect(x + 90, y + L.y0 - 1, 4, 4, C.CYAN);
    if (MACH) MACH.drawMachine(fb, x + G.MACHINE_CX, fy, opts.design ?? 'fable', t, { status: 'running', heat: 0.1, powered: true, phase: t * 0.8, speed: 0.6 });
    else box(fb, x + G.MACHINE_CX, fy, G.MACHINE_W, G.MACHINE_H, opts.accent ?? C.VIOLET, 'MACHINE');
    G.SLOT_XS.forEach((sx, k) => {
      if (opts.sparse && k % 2) return;
      if (ACT) ACT.drawWorkstation(fb, x + sx, fy, ['terminal', 'documents', 'inspection'][k % 3], t, { active: true, facing: sx < G.MACHINE_CX ? 1 : -1 });
      else { fb.rect(x + sx - 6, fy - 20, 12, 8, C.STEEL_D); fb.rect(x + sx - 5, fy - 19, 10, 6, C.GREEN); fb.rect(x + sx - 1, fy - 12, 2, 12, C.STEEL_DD); }
      resident(fb, x + sx, fy, k + 1, false, t);
      if (k === 1 || k === 4) bubble(fb, x + sx, fy - G.RESIDENT_H - 1);
    });
  } else if (kind === 'control') {
    G.CONTROL.stand.slice(0, opts.crowd ? 4 : 2).forEach((sx, i) => { resident(fb, x + sx, fy, i, false, t); if (i < 2) bubble(fb, x + sx, fy - G.RESIDENT_H - 1); });
  } else if (kind === 'lounge') {
    G.LOUNGE.seats.forEach((sx, i) => resident(fb, x + sx, fy, i + 1, true, t));
    bubble(fb, x + G.LOUNGE.seats[0], fy - G.RESIDENT_H - 1);
    if (opts.crowd) G.LOUNGE.stand.forEach((sx, i) => resident(fb, x + sx, fy, i + 3, false, t));
  } else if (kind === 'dock') {
    ENV.drawBelt(fb, x + G.DOCK.belt[0], y + G.DOCK.beltY, G.DOCK.belt[1] - G.DOCK.belt[0], t * 12);
    item(fb, x + G.DOCK.hatchCx - 3, y + 14 + Math.floor((t * 10) % 20), 'crate');
    item(fb, x + 40, y + G.DOCK.beltY - 6, 'crate'); item(fb, x + 60, y + G.DOCK.beltY - 6, 'crate'); item(fb, x + G.DOCK.chuteCx - 6, y + G.DOCK.beltY - 6, 'crate');
  } else if (kind === 'power') {
    if (POW) { POW.drawSwitchboard(fb, x + G.POWER.switchboardCx, fy, t, { status: 'ok', percent: 40 }); POW.drawGenerator(fb, x + G.POWER.generatorCx, fy, t, { present: !opts.empty, running: true, utilization: 0.4, phase: t }); }
    else { box(fb, x + G.POWER.switchboardCx, fy, G.SWITCHBOARD_W, G.SWITCHBOARD_H, C.STEEL, 'SW'); if (!opts.empty) box(fb, x + G.POWER.generatorCx, fy, G.GENERATOR_W, G.GENERATOR_H, C.HAZARD, 'GEN'); }
  } else if (kind === 'reactor') {
    const cx = x + (w >> 1);
    if (POW) POW.drawReactor(fb, x, y, w, h, t, { status: 'ok', heat: 0.1, phase: t, speed: 0.5, percent: 20 });
    else { box(fb, cx, fy, 56, 62, C.STEEL_D, 'CORE'); fb.disc(cx, fy - 34, 14, C.TEAL); }
    fb.rect(cx - 46, fy - 68, 5, 4, C.AMBER_L); fb.rect(cx + 42, fy - 68, 5, 4, C.AMBER_L);
  }
}

function save(fb, name, scale) { console.log(savePng(fb, out(name), scale)); }

// --- room close-ups ----------------------------------------------------------------
function rooms() {
  for (const kind of ['control', 'lounge', 'dock', 'power']) {
    const fb = new Framebuffer(3 * G.HALF_W + 16, G.ROOM_H + 8);
    ENV.drawRock(fb, 0, 0, fb.w, fb.h, 1);
    room(fb, 4, 4, kind, T, { doorL: true }, false);
    room(fb, 8 + G.HALF_W, 4, kind, T, { doorL: true, doorR: true }, true);
    room(fb, 12 + 2 * G.HALF_W, 4, kind, T + 0.7, { doorR: true, crowd: true, empty: true }, true);
    save(fb, kind, 4);
  }
  {
    const fb = new Framebuffer(G.ROOM_W + 8, 2 * G.ROOM_H + 12);
    ENV.drawRock(fb, 0, 0, fb.w, fb.h, 1);
    room(fb, 4, 4, 'machine', T, { accent: C.VIOLET, label: 'fable', doorL: true, doorR: true, seed: 1 }, false);
    room(fb, 4, 8 + G.ROOM_H, 'machine', T, { accent: C.COPPER, label: 'opus 4.1', doorL: true, seed: 2 }, true);
    save(fb, 'machine', 6);
  }
  {
    const fb = new Framebuffer(2 * 232 + 12, 2 * G.REACTOR_H + 12);
    ENV.drawRock(fb, 0, 0, fb.w, fb.h, 1);
    room(fb, 4, 4, 'reactor', T, { doorL: true }, false, 232);
    room(fb, 8 + 232, 4, 'reactor', T + 0.6, { doorR: true }, true, 232);
    room(fb, 4, 8 + G.REACTOR_H, 'reactor', T, {}, true, 448);
    save(fb, 'reactor', 3);
  }
}

// --- small parts ----------------------------------------------------------------------
function parts() {
  const fb = new Framebuffer(330, 250);
  ENV.drawRock(fb, 0, 0, fb.w, fb.h, 0);
  // belts at several phases on a wall-coloured strip
  fb.rect(4, 4, 150, 40, C.WALL);
  for (let i = 0; i < 4; i++) ENV.drawBelt(fb, 8, 8 + i * 9, [58, 100, 31, 140][i], T * 12 + i * 1.5);
  item(fb, 20, 2, 'crate');
  // pipes
  fb.rect(160, 4, 166, 60, C.WALL);
  ENV.drawPipe(fb, [[166, 54], [176, 54], [176, 12], [240, 12], [240, 40], [260, 40]], 'cache');
  ENV.drawPipe(fb, [[186, 58], [186, 24], [228, 24], [228, 56], [250, 56]], 'coolant');
  ENV.drawPipe(fb, [[320, 8], [270, 8], [270, 30], [300, 30], [300, 58]], 'steam');
  ENV.drawPipe(fb, [[196, 44], [216, 44]], 'steam');
  // pipes and cables over rock
  ENV.drawPipe(fb, [[166, 76], [210, 76], [210, 96], [320, 96]], 'coolant');
  ENV.drawPipe(fb, [[166, 86], [200, 86], [200, 106], [320, 106]], 'steam');
  ENV.drawCable(fb, [[166, 116], [230, 116], [230, 130], [320, 130]], true);
  ENV.drawCable(fb, [[166, 122], [220, 122], [220, 136], [320, 136]], false);
  fb.rect(4, 150, 150, 20, C.WALL);
  ENV.drawCable(fb, [[8, 156], [80, 156], [80, 164], [150, 164]], true);
  ENV.drawCable(fb, [[8, 160], [70, 160], [70, 167], [150, 167]], false);
  // shafts with cars at several door states
  let x = 4;
  for (const [w, door] of [[32, 0], [32, 0.5], [32, 1], [24, 0], [24, 0.7]]) {
    ENV.drawShaft(fb, x, 48, w, G.ROOM_H, T);
    ENV.drawShaft(fb, x, 48 + G.ROOM_H, w, 34, T);
    const cx = x + (w >> 1), fy = 48 + G.ROOM_H - G.FLOOR_T + (door === 0.5 ? 0 : 0);
    ENV.drawElevatorCar(fb, cx, fy, T, { door });
    resident(fb, cx, fy, 2, false, T);
    ENV.drawElevatorDoors(fb, cx, fy, T, { door });
    x += w + 3;
  }
  // a car between floors
  ENV.drawShaft(fb, 4, 176, 32, 70, T);
  ENV.drawElevatorCar(fb, 20, 176 + 44, T, { door: 0 }); ENV.drawElevatorDoors(fb, 20, 176 + 44, T, { door: 0 });
  // surfaces
  ENV.drawSurface(fb, 44, 176, 280, G.SURFACE_H, T, { shaftX: 44 + 60, shaftW: 32 });
  ENV.drawSurface(fb, 44, 212, 280, G.SURFACE_H, 0, { shaftX: 44 + 200, shaftW: 24, emergency: true });
  // residents at the entrance doors and on the ground line
  resident(fb, 44 + 60 + 16, 176 + G.SURFACE_H - 8, 1, false, T); resident(fb, 44 + 150, 176 + G.SURFACE_H - 8, 2, false, T);
  resident(fb, 44 + 200 + 12, 212 + G.SURFACE_H - 8, 3, false, T);
  save(fb, 'parts', 4);
}

// --- a believable mini-shelter ------------------------------------------------------------
function shelter(t = T, name = 'shelter', scale = 3, emergency = false) {
  const M = 16, W = M + G.ROOM_W + G.SHAFT_W_FULL + G.ROOM_W + M;
  const H = G.SURFACE_H + 2 * G.ROOM_H + G.REACTOR_H + 14;
  const fb = new Framebuffer(W, H);
  const sx = M + G.ROOM_W;
  ENV.drawRock(fb, 0, G.SURFACE_H, W, H - G.SURFACE_H, 0);
  ENV.drawSurface(fb, 0, 0, W, G.SURFACE_H, t, { shaftX: sx, shaftW: G.SHAFT_W_FULL, emergency });
  let y = G.SURFACE_H;
  // floor 1: dock + control | shaft | machine
  room(fb, M, y, 'dock', t, {});
  room(fb, M + G.HALF_W, y, 'control', t, { doorR: true });
  ENV.drawShaft(fb, sx, y, G.SHAFT_W_FULL, G.ROOM_H, t);
  room(fb, sx + G.SHAFT_W_FULL, y, 'machine', t, { accent: C.VIOLET, label: 'fable', doorL: true, seed: 1 });
  y += G.ROOM_H;
  // floor 2: machine | shaft | lounge + power
  room(fb, M, y, 'machine', t, { accent: C.BLUE, label: 'sonnet', doorR: true, seed: 2, sparse: true });
  ENV.drawShaft(fb, sx, y, G.SHAFT_W_FULL, G.ROOM_H, t);
  room(fb, sx + G.SHAFT_W_FULL, y, 'lounge', t, { doorL: true, doorR: true });
  room(fb, sx + G.SHAFT_W_FULL + G.HALF_W, y, 'power', t, { doorL: true });
  // car on floor 2
  const fy = y + G.ROOM_H - G.FLOOR_T, cx = sx + (G.SHAFT_W_FULL >> 1);
  ENV.drawElevatorCar(fb, cx, fy, t, { door: 0.8 }); resident(fb, cx, fy, 3, false, t); ENV.drawElevatorDoors(fb, cx, fy, t, { door: 0.8 });
  y += G.ROOM_H;
  // reactor hall across the bottom
  room(fb, M, y, 'reactor', t, {}, true, 448);
  // utilities through the rock
  ENV.drawCable(fb, [[W - 8, y + 30], [W - 8, G.SURFACE_H + G.ROOM_H + 20], [W - M, G.SURFACE_H + G.ROOM_H + 20]], !emergency);
  ENV.drawCable(fb, [[8, y + 30], [8, G.SURFACE_H + 20], [M, G.SURFACE_H + 20]], true);
  ENV.drawPipe(fb, [[M + 60, y + G.REACTOR_H], [M + 60, y + G.REACTOR_H + 8], [W - M - 60, y + G.REACTOR_H + 8], [W - M - 60, y + G.REACTOR_H]], 'coolant');
  if (emergency) fb.relight(0, G.SURFACE_H, W, H - G.SURFACE_H, LIGHT.EMERGENCY);
  save(fb, name, scale);
}

// --- relit copies ----------------------------------------------------------------------
function light() {
  const kinds = ['control', 'lounge', 'dock', 'power'];
  const fb = new Framebuffer(4 * G.HALF_W + 20, 3 * (G.ROOM_H + 4) + 4);
  fb.clear(C.ROCK_D);
  [LIGHT.AMBER, LIGHT.EMERGENCY, LIGHT.DARK].forEach((mode, r) => kinds.forEach((kind, i) => {
    const x = 4 + i * (G.HALF_W + 4), y = 4 + r * (G.ROOM_H + 4);
    room(fb, x, y, kind, T, { doorL: true }, true);
    fb.relight(x, y, G.HALF_W, G.ROOM_H, mode);
  }));
  save(fb, 'light', 3);
  const fb2 = new Framebuffer(G.ROOM_W + 232 + 12, 3 * (G.REACTOR_H + 4) + 4);
  fb2.clear(C.ROCK_D);
  [LIGHT.AMBER, LIGHT.EMERGENCY, LIGHT.DARK].forEach((mode, r) => {
    const y = 4 + r * (G.REACTOR_H + 4);
    room(fb2, 4, y, 'machine', T, { accent: C.GREEN, label: 'haiku', doorL: true }, true);
    fb2.relight(4, y, G.ROOM_W, G.ROOM_H, mode);
    room(fb2, 8 + G.ROOM_W, y, 'reactor', T, {}, true, 232);
    fb2.relight(8 + G.ROOM_W, y, 232, G.REACTOR_H, mode);
  });
  save(fb2, 'light2', 3);
}

// --- checks --------------------------------------------------------------------------------
function check() {
  let bad = 0;
  const fail = (msg) => { bad++; console.log('FAIL', msg); };
  const cases = [
    ['machine', G.ROOM_W, G.ROOM_H], ['control', G.HALF_W, G.ROOM_H], ['lounge', G.HALF_W, G.ROOM_H], ['dock', G.HALF_W, G.ROOM_H],
    ['power', G.HALF_W, G.ROOM_H], ['reactor', 448, G.REACTOR_H], ['reactor', 232, G.REACTOR_H], ['mystery', G.HALF_W, G.ROOM_H],
  ];
  const painters = [
    ...cases.flatMap(([kind, w, h]) => [0.4, 1.3, 7.77].map((t) => [`room ${kind} ${w} t=${t}`, w, h, true, (fb, x, y) => ENV.drawRoom(fb, x, y, w, h, kind, t, { doorL: true, doorR: true, accent: C.BLUE, label: kind })])),
    ['rock', 300, 200, true, (fb, x, y) => ENV.drawRock(fb, x, y, 300, 200, 3)],
    ['surface', 480, 32, true, (fb, x, y) => ENV.drawSurface(fb, x, y, 480, 32, 2.2, { shaftX: x + 224, shaftW: 32 })],
    ['surface emergency', 264, 32, true, (fb, x, y) => ENV.drawSurface(fb, x, y, 264, 32, 0.2, { shaftX: x + 30, shaftW: 24, emergency: true })],
    ...[0, 0.05, 0.45, 1.0].map((t) => [`surface emergency flash t=${t}`, 200, 32, true, (fb, x, y) => ENV.drawSurface(fb, x, y, 200, 32, t, { shaftX: x + 160, shaftW: 32, emergency: true })]),
    ['surface left edge', 200, 32, true, (fb, x, y) => ENV.drawSurface(fb, x, y, 200, 32, 0, { shaftX: x + 2, shaftW: 24, emergency: true })],
    ['shaft 32', 32, 64, true, (fb, x, y) => ENV.drawShaft(fb, x, y, 32, 64, 1.1)],
    ['shaft 24', 24, 300, true, (fb, x, y) => ENV.drawShaft(fb, x, y, 24, 300, 1.1)],
    ['belt', 58, 6, false, (fb, x, y) => ENV.drawBelt(fb, x, y, 58, 13.7)],
    ['belt short', 5, 6, false, (fb, x, y) => ENV.drawBelt(fb, x, y, 5, -3.2)],
  ];
  for (const [name, w, h, mustFill, fn] of painters) {
    const P = 12, fb = new Framebuffer(w + 2 * P, h + 2 * P);
    fb.clear(C.MAGENTA);
    fn(fb, P, P);
    let outside = 0, holes = 0, big = 0;
    for (let y = 0; y < fb.h; y++) for (let x = 0; x < fb.w; x++) {
      const v = fb.buf[y * fb.w + x], inside = x >= P && x < P + w && y >= P && y < P + h;
      if (v > 63) big++;
      if (!inside && v !== C.MAGENTA) outside++;
      if (inside && mustFill && v === C.MAGENTA) holes++;
    }
    if (outside || holes || big) fail(`${name}: outside=${outside} holes=${holes} relit=${big}`);
    const fb2 = new Framebuffer(fb.w, fb.h); fb2.clear(C.MAGENTA); fn(fb2, P, P);
    if (Buffer.compare(Buffer.from(fb.buf), Buffer.from(fb2.buf)) !== 0) fail(`${name}: not deterministic`);
  }
  // elevator car: allowed to use the two rows below floorY within its own columns
  {
    const fb = new Framebuffer(60, 60); fb.clear(C.MAGENTA);
    ENV.drawElevatorCar(fb, 30, 40, 1, { door: 0.3 }); ENV.drawElevatorDoors(fb, 30, 40, 1, { door: 0.3 });
    let outside = 0;
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
      const inside = x >= 20 && x < 40 && y >= 12 && y < 42;
      if (!inside && fb.buf[y * 60 + x] !== C.MAGENTA) outside++;
    }
    if (outside) fail(`car: outside=${outside}`);
  }
  // clipping: off-buffer positions and a clip rectangle must neither throw nor leak
  try {
    const fb = new Framebuffer(120, 90);
    for (const [x, y] of [[-50, -20], [70, 50], [-300, 10], [10, -200], [119, 89], [400, 400]]) {
      ENV.drawRock(fb, x, y, 200, 100, 5);
      ENV.drawSurface(fb, x, y, 200, 32, 1, { shaftX: x + 90, shaftW: 32, emergency: true });
      for (const kind of ['machine', 'control', 'lounge', 'dock', 'power', 'reactor']) ENV.drawRoom(fb, x, y, kind === 'machine' ? 208 : kind === 'reactor' ? 232 : 104, kind === 'reactor' ? 80 : 64, kind, 2.5, { doorL: true });
      ENV.drawShaft(fb, x, y, 32, 64, 1);
      ENV.drawElevatorCar(fb, x, y, 1, { door: 0.5 }); ENV.drawElevatorDoors(fb, x, y, 1, { door: 0.5 });
      ENV.drawBelt(fb, x, y, 100, 3);
      ENV.drawPipe(fb, [[x, y], [x + 40, y], [x + 40, y + 30]], 'steam');
      ENV.drawCable(fb, [[x, y], [x + 40, y], [x + 40, y + 30]], true);
    }
    fb.clear(C.MAGENTA); fb.setClip(30, 20, 40, 30);
    ENV.drawRock(fb, 0, 0, 120, 90, 2);
    ENV.drawRoom(fb, 10, 5, 104, 64, 'lounge', 1, {});
    ENV.drawSurface(fb, 0, 10, 120, 32, 1, { shaftX: 40, shaftW: 32 });
    ENV.drawShaft(fb, 25, 0, 32, 90, 1);
    fb.clearClip();
    let leak = 0;
    for (let y = 0; y < 90; y++) for (let x = 0; x < 120; x++) {
      if (!(x >= 30 && x < 70 && y >= 20 && y < 50) && fb.buf[y * 120 + x] !== C.MAGENTA) leak++;
    }
    if (leak) fail(`clip leak: ${leak}`);
  } catch (e) { fail(`clipping threw: ${e.stack}`); }
  // odd inputs
  try {
    const fb = new Framebuffer(64, 64);
    ENV.drawRoom(fb, 0, 0, 104, 64, 'control', undefined);
    ENV.drawRoom(fb, 0.5, 0.5, 30, 20, 'lounge', 1, {});
    ENV.drawRoom(fb, 0, 0, 0, 0, 'dock', 1, {});
    ENV.drawRoom(fb, 0, 0, 104, 64, 'power', 1, null);
    ENV.drawSurface(fb, 0, 0, 64, 32, 1, { shaftX: 10, shaftW: 24 });
    ENV.drawPipe(fb, [], 'cache'); ENV.drawPipe(fb, [[3, 3]], 'x'); ENV.drawCable(fb, [[1, 1]], false);
    ENV.drawBelt(fb, 0, 0, 0, 1); ENV.drawShaft(fb, 0, 0, 24, 3, 1);
  } catch (e) { fail(`odd inputs threw: ${e.stack}`); }
  // timing: 200 frames of a full shelter's worth of environment
  {
    const fb = new Framebuffer(480, 400);
    const t0 = performance.now();
    for (let f = 0; f < 200; f++) {
      const t = f / 30;
      ENV.drawRock(fb, 0, 32, 480, 368, 0);
      ENV.drawSurface(fb, 0, 0, 480, 32, t, { shaftX: 224, shaftW: 32 });
      for (let fl = 0; fl < 4; fl++) {
        const y = 32 + fl * 64;
        ENV.drawRoom(fb, 16, y, 208, 64, 'machine', t, { accent: C.VIOLET + fl, label: 'm' + fl, doorR: true });
        ENV.drawShaft(fb, 224, y, 32, 64, t);
        if (fl % 2) ENV.drawRoom(fb, 256, y, 208, 64, 'machine', t, { accent: C.BLUE, label: 'n' + fl, doorL: true });
        else { ENV.drawRoom(fb, 256, y, 104, 64, ['control', 'dock'][fl >> 1], t, { doorL: true }); ENV.drawRoom(fb, 360, y, 104, 64, ['lounge', 'power'][fl >> 1], t, {}); }
        ENV.drawBelt(fb, 18, y + 34, 58, t * 12); ENV.drawBelt(fb, 164, y + 34, 58, t * 12);
        ENV.drawPipe(fb, [[76, y + 20], [70, y + 20], [70, y + 6], [170, y + 6], [170, y + 20], [164, y + 20]], 'cache');
      }
      ENV.drawRoom(fb, 16, 288, 448, 80, 'reactor', t, {});
      ENV.drawElevatorCar(fb, 240, 92, t, { door: 0.5 }); ENV.drawElevatorDoors(fb, 240, 92, t, { door: 0.5 });
      ENV.drawCable(fb, [[8, 300], [8, 60], [16, 60]], true);
    }
    const ms = (performance.now() - t0) / 200;
    console.log(`timing: ${ms.toFixed(3)} ms per frame of environment`);
    if (ms > 4) fail(`slow: ${ms.toFixed(2)} ms/frame`);
  }
  console.log(bad ? `${bad} check(s) failed` : 'all checks passed');
}

if (what === 'rooms' || what === 'all') rooms();
if (what === 'parts' || what === 'all') parts();
if (what === 'shelter' || what === 'all') { shelter(T, 'shelter', 3); shelter(T + 0.4, 'shelter-emergency', 2, true); }
if (what === 'light' || what === 'all') light();
if (what === 'check' || what === 'all') check();
