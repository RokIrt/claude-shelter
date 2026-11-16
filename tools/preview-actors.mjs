// Close-up previews and contract checks for src/gfx/actors.mjs.
//   node tools/preview-actors.mjs [page|all|check]
// Pages (written to out/actors-<page>.png): roles, walls, poses1, poses2, slow, moods, scene
// (T=<t> env var), lift, icons, stations, items, small. `check` runs only the contract
// checks (they also run after `all`). scene/lift import env.mjs read-only for context.
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C, LIGHT } from '../src/gfx/palette.mjs';
import { drawText } from '../src/gfx/font.mjs';
import * as G from '../src/gfx/geom.mjs';
import * as ACT from '../src/gfx/actors.mjs';
import * as ENV from '../src/gfx/env.mjs';
import { savePng } from './png.mjs';

const which = process.argv[2] ?? 'all';
const out = (name) => new URL(`../out/actors-${name}.png`, import.meta.url).pathname;

const ROLES = ['foreman', 'programmer', 'researcher', 'reviewer', 'operator'];
const POSES = ['idle', 'walk', 'work', 'read', 'inspect', 'sit', 'panic', 'cheer', 'ride'];
const MOODS = ['happy', 'neutral', 'focused', 'sleepy', 'worried', 'shocked'];
const MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'generic'];
const KINDS = ['terminal', 'documents', 'inspection'];
const WALLS = [C.WALL, C.WALL_L, C.WALL_D, C.STEEL_D, C.AMBER_D, C.STEEL_DD];

/** A slice of room: wall colour with a floor slab; returns floorY. */
function room(fb, x, y, w, h, wall = C.WALL) {
  fb.rect(x, y, w, h, wall);
  fb.rect(x, y + h - 3, w, 3, C.STEEL_D);
  fb.hline(x, y + h - 3, w, C.STEEL);
  return y + h - 3;
}
const label = (fb, x, y, s, c = C.CREAM) => drawText(fb, x, y, s, c, { shadow: C.INK });

const pages = {
  // Every role (columns) in every model uniform (rows), idle, both facings.
  roles() {
    const cw = 18, ch = 24;
    const fb = new Framebuffer(ROLES.length * cw * 2 + 30, MODELS.length * ch + 10);
    fb.clear(C.ROCK_D);
    ROLES.forEach((role, i) => label(fb, 30 + i * cw * 2, 2, role.slice(0, 8)));
    MODELS.forEach((m, j) => {
      const y = 9 + j * ch;
      const fy = room(fb, 28, y, ROLES.length * cw * 2, ch - 1, C.WALL);
      label(fb, 1, y + 8, m);
      ROLES.forEach((role, i) => {
        for (const f of [1, -1]) {
          ACT.drawResident(fb, 28 + i * cw * 2 + (f > 0 ? 9 : 27), fy, 0.9, { role, pose: 'idle', facing: f, uniform: m, mood: 'neutral', seed: 3 });
        }
      });
    });
    return [fb, 6];
  },

  // Every uniform on every background a resident can stand in front of.
  walls() {
    const cw = 14, ch = 22;
    const fb = new Framebuffer(MODELS.length * cw * 3 + 4, WALLS.length * ch + 2);
    fb.clear(C.ROCK_D);
    WALLS.forEach((wall, j) => {
      const fy = room(fb, 2, 1 + j * ch, MODELS.length * cw * 3, ch - 1, wall);
      MODELS.forEach((m, i) => {
        ACT.drawResident(fb, 2 + i * cw * 3 + 7, fy, 0.9, { role: 'operator', pose: 'idle', facing: 1, uniform: m, mood: 'happy', seed: i });
        ACT.drawResident(fb, 2 + i * cw * 3 + 7 + cw, fy, 0.9, { role: ROLES[i], pose: 'walk', facing: -1, uniform: m, mood: 'neutral', seed: i });
        ACT.drawResident(fb, 2 + i * cw * 3 + 7 + cw * 2, fy, 0.9, { role: ROLES[(i + 1) % 5], pose: 'cheer', facing: 1, uniform: m, seed: i });
      });
    });
    return [fb, 5];
  },

  // Filmstrips: 10 consecutive frames (dt = 1/10 s) of each pose.
  poses1() { return strip(POSES.slice(0, 5), 'operator', 'sonnet'); },
  poses2() { return strip(POSES.slice(5), 'foreman', 'fable'); },
  // Slow-motion strips for poses whose animation is slower than 10 fps.
  slow() { return strip(['idle', 'read', 'inspect', 'sit', 'ride'], 'researcher', 'haiku', 0.35); },

  moods() {
    const cw = 16, ch = 22;
    const fb = new Framebuffer(MOODS.length * cw * 2 + 2, ROLES.length * ch + 10);
    fb.clear(C.ROCK_D);
    MOODS.forEach((m, i) => label(fb, 4 + i * cw * 2, 2, m));
    ROLES.forEach((role, j) => {
      const fy = room(fb, 1, 9 + j * ch, MOODS.length * cw * 2, ch - 1, C.WALL);
      MOODS.forEach((mood, i) => {
        // find a time when this resident is not blinking, and one when it is
        const look = { role, pose: 'ride', facing: 1, uniform: MODELS[j], mood, seed: 1 };
        ACT.drawResident(fb, 1 + i * cw * 2 + 8, fy, tOpen(look), look);
        ACT.drawResident(fb, 1 + i * cw * 2 + 8 + cw, fy, tBlink(look), { ...look, facing: -1 });
      });
    });
    return [fb, 6];
  },

  // The sheet's scenes with residents, at 3x, using the real room painters.
  scene() {
    const t = Number(process.env.T ?? 1.3);
    const fb = new Framebuffer(G.ROOM_W + 8, G.ROOM_H * 3 + 12);
    fb.clear(C.ROCK_D);
    let y = 2;
    for (const [d, fire] of [['opus', false], ['fable', true]]) {
      const x = 4;
      ENV.drawRoom(fb, x, y, G.ROOM_W, G.ROOM_H, 'machine', t, { accent: ACT.UNIFORMS[d][0], label: d, doorL: true });
      const fy = y + G.ROOM_H - G.FLOOR_T;
      ENV.drawBelt(fb, x + G.BELT_IN[0], y + G.BELT_Y, G.BELT_IN[1] - G.BELT_IN[0], t * 12);
      ENV.drawBelt(fb, x + G.BELT_OUT[0], y + G.BELT_Y, G.BELT_OUT[1] - G.BELT_OUT[0], t * 12);
      ACT.drawItem(fb, x + 20, y + G.BELT_Y - 6, 'crate', t); ACT.drawItem(fb, x + 30, y + G.BELT_Y - 6, 'crate', t);
      ACT.drawItem(fb, x + 170, y + G.BELT_Y - 6, 'package', t);
      ACT.drawItem(fb, x + 90, y + G.LOOP.y0 - 1, 'cache', t); ACT.drawItem(fb, x + 100, y + G.LOOP.y0 - 1, 'cache', t);
      fb.rect(x + G.MACHINE_CX - 44, fy - 48, 88, 48, C.STEEL_D);
      G.SLOT_XS.forEach((sx, k) => {
        const kind = KINDS[k % 3], facing = sx < G.MACHINE_CX ? 1 : -1;
        ACT.drawWorkstation(fb, x + sx, fy, kind, t, { active: !fire, facing, seed: k });
        ACT.drawResident(fb, x + sx, fy, t, { role: ['programmer', 'researcher', 'reviewer'][k % 3], pose: fire ? 'panic' : ['work', 'read', 'inspect'][k % 3], facing, uniform: [d, 'haiku', 'sonnet'][k % 3], mood: fire ? 'shocked' : undefined, seed: k });
        if (k === 1 && !fire) ACT.drawBubble(fb, x + sx, fy - G.RESIDENT_H - 1, 'search', t);
        if (k === 4 && fire) ACT.drawBubble(fb, x + sx, fy - G.RESIDENT_H - 1, 'fire', t, 'alert');
      });
      y += G.ROOM_H + 2;
    }
    let x = 4;
    for (const kind of ['control', 'lounge']) {
      ENV.drawRoom(fb, x, y, G.HALF_W, G.ROOM_H, kind, t, { doorL: true, doorR: true, label: kind });
      const fy = y + G.ROOM_H - G.FLOOR_T;
      if (kind === 'control') G.CONTROL.stand.forEach((sx, i) => { ACT.drawResident(fb, x + sx, fy, t, { role: 'foreman', pose: ['work', 'idle', 'cheer', 'walk'][i], facing: 1, uniform: MODELS[i], mood: 'happy', seed: i }); if (i < 2) ACT.drawBubble(fb, x + sx, fy - G.RESIDENT_H - 1, i ? 'delegate' : 'plan', t); });
      else {
        G.LOUNGE.seats.forEach((sx, i) => ACT.drawResident(fb, x + sx, fy, t, { role: ROLES[i + 1], pose: 'sit', facing: 1, uniform: ['haiku', 'sonnet', 'generic'][i], mood: i === 1 ? 'happy' : 'sleepy', seed: i }));
        ACT.drawBubble(fb, x + G.LOUNGE.seats[0], fy - G.RESIDENT_H - 1, 'zzz', t);
        G.LOUNGE.stand.forEach((sx, i) => ACT.drawResident(fb, x + sx, fy, t, { role: ROLES[(i + 2) % 5], pose: 'idle', facing: i ? -1 : 1, uniform: MODELS[i + 1], mood: ['neutral', 'worried', 'happy'][i], seed: i + 7 }));
        ACT.drawBubble(fb, x + G.LOUNGE.stand[1], fy - G.RESIDENT_H - 1, 'wait', t, 'warn');
      }
      x += G.HALF_W;
    }
    return [fb, 3];
  },

  // Lift ride: car, resident, half-open doors (drawn by the shaft painter over the resident).
  lift() {
    const t = 1.3;
    const fb = new Framebuffer(4 * 40, 40);
    fb.clear(C.ROCK_D);
    [0, 0.4, 0.8, 1].forEach((door, i) => {
      const x = i * 40, fy = 36;
      ENV.drawShaft(fb, x + 4, 0, G.SHAFT_W_FULL, 40, t);
      ENV.drawElevatorCar(fb, x + 20, fy, t, { door });
      ACT.drawResident(fb, x + 20, fy, t + i, { role: ROLES[i], pose: 'ride', facing: 1, uniform: MODELS[i], mood: 'neutral', seed: i });
      ENV.drawElevatorDoors(fb, x + 20, fy, t, { door });
    });
    return [fb, 6];
  },

  icons() {
    const fb = new Framebuffer(8 * 16 + 4, 2 * 36 + 4);
    fb.clear(C.ROCK_D);
    fb.rect(2, 2, 8 * 16, 2 * 36, C.WALL);
    ACT.ICONS.forEach((icon, i) => {
      const x = 2 + (i % 8) * 16, y = 2 + Math.floor(i / 8) * 36;
      ACT.drawBubble(fb, x + 8, y + 15, icon, 0, ['normal', 'warn', 'alert'][i % 3]);
      fb.rect(x + 4, y + 17, 9, 9, C.CREAM);
      ACT.drawIcon(fb, x + 5, y + 18, icon, C.INK);
      label(fb, x + 1, y + 28, icon.slice(0, 4));
    });
    return [fb, 8];
  },

  stations() {
    const cw = 20, ch = 40;
    const fb = new Framebuffer(8 * cw + 2, KINDS.length * ch + 2);
    fb.clear(C.ROCK_D);
    KINDS.forEach((kind, j) => {
      const fy = room(fb, 1, 1 + j * ch, 8 * cw, ch - 1, C.WALL);
      const role = ['programmer', 'researcher', 'reviewer'][j], pose = ['work', 'read', 'inspect'][j];
      for (let i = 0; i < 8; i++) {
        const cx = 1 + i * cw + 10, facing = i % 2 ? -1 : 1, active = i < 6;
        const t = 1.3 + i * 0.37;
        fb.frame(cx - 8, fy - 20, 16, 20, C.WALL_L);
        ACT.drawWorkstation(fb, cx, fy, kind, t, { active, facing, seed: i });
        if (i >= 2) ACT.drawResident(fb, cx, fy, t, { role, pose: i === 7 ? 'idle' : pose, facing, uniform: MODELS[i % 5], seed: i });
        if (i === 4 || i === 5) ACT.drawBubble(fb, cx, fy - G.RESIDENT_H - 1, ['code', 'doc', 'check'][j], t);
      }
    });
    return [fb, 6];
  },

  items() {
    const fb = new Framebuffer(120, 44);
    fb.clear(C.ROCK_D);
    WALLS.slice(0, 2).forEach((wall, j) => {
      fb.rect(1, 1 + j * 21, 118, 20, wall);
      fb.rect(1, 14 + j * 21, 118, 3, C.STEEL_DD);
      for (let i = 0; i < 4; i++) ACT.drawItem(fb, 4 + i * 9, 8 + j * 21, 'crate', i * 0.3);
      for (let i = 0; i < 4; i++) ACT.drawItem(fb, 44 + i * 9, 8 + j * 21, 'package', i * 0.3);
      for (let i = 0; i < 8; i++) ACT.drawItem(fb, 84 + i * 4, 9 + j * 21 - (i & 1), 'cache', i * 0.13);
    });
    return [fb, 8];
  },

  // Everything at game scale (2x): the real readability verdict.
  small() {
    const fb = new Framebuffer(330, 150);
    fb.clear(C.ROCK_D);
    let y = 1;
    [C.WALL, C.WALL_L].forEach((wall, w) => {
      const fy = room(fb, 1, y, 328, 30, wall);
      ROLES.forEach((role, i) => MODELS.forEach((m, k) => {
        ACT.drawResident(fb, 9 + (i * 5 + k) * 13, fy, 0.4 + k * 0.2, { role, pose: w ? POSES[(i + k) % 9] : 'idle', facing: (i + k) % 2 ? -1 : 1, uniform: m, mood: MOODS[(i + k) % 6], seed: i * 5 + k });
      }));
      y += 31;
    });
    {
      const fy = room(fb, 1, y, 328, 42, C.WALL);
      for (let i = 0; i < 18; i++) {
        const cx = 12 + i * 18, kind = KINDS[i % 3];
        ACT.drawWorkstation(fb, cx, fy, kind, 1.3 + i, { active: i % 5 !== 4, facing: i % 2 ? -1 : 1, seed: i });
        ACT.drawResident(fb, cx, fy, 1.3 + i * 0.3, { role: ['programmer', 'researcher', 'reviewer'][i % 3], pose: ['work', 'read', 'inspect'][i % 3], facing: i % 2 ? -1 : 1, uniform: MODELS[i % 5], seed: i });
        if (i % 4 === 0) ACT.drawBubble(fb, cx, fy - G.RESIDENT_H - 1, ACT.ICONS[i % 16], 1.3 + i, ['normal', 'warn', 'alert'][(i / 4) % 3]);
      }
      y += 43;
    }
    {
      const fy = room(fb, 1, y, 328, 44, C.WALL_L);
      ACT.ICONS.forEach((icon, i) => {
        ACT.drawResident(fb, 10 + i * 14, fy, 0.3 * i, { role: ROLES[i % 5], pose: ['sit', 'idle', 'ride'][i % 3], facing: 1, uniform: MODELS[i % 5], mood: MOODS[i % 6], seed: i });
        ACT.drawBubble(fb, 10 + i * 14, fy - G.RESIDENT_H - 1, icon, 0.3 * i, ['normal', 'warn', 'alert'][i % 3]);
      });
      ['crate', 'package', 'cache'].forEach((k, i) => { for (let n = 0; n < 4; n++) ACT.drawItem(fb, 240 + i * 30 + n * 7, fy - 8, k, n * 0.3); });
    }
    return [fb, 3];
  },
};

function strip(poses, role, uniform, dt = 0.1) {
  const n = 10, cw = 18, ch = 22;
  const fb = new Framebuffer(n * cw + 30, poses.length * ch * 2 + 2);
  fb.clear(C.ROCK_D);
  poses.forEach((pose, j) => {
    for (const f of [1, -1]) {
      const y = 1 + (j * 2 + (f > 0 ? 0 : 1)) * ch;
      const fy = room(fb, 28, y, n * cw, ch - 1, f > 0 ? C.WALL : C.WALL_L);
      if (f > 0) label(fb, 1, y + 8, pose);
      for (let i = 0; i < n; i++) {
        ACT.drawResident(fb, 28 + i * cw + 9, fy, 2 + i * dt, { role: f > 0 ? role : ROLES[(j + 1) % 5], pose, facing: f, uniform: f > 0 ? uniform : MODELS[j % 5], seed: 2 });
      }
    }
  });
  return [fb, 6];
}

// --- helpers for the moods page: find a non-blinking / blinking moment by brute force ---
function shot(look, t) {
  const fb = new Framebuffer(20, 20);
  ACT.drawResident(fb, 10, 18, t, look);
  return fb.buf.join(',');
}
function tOpen(look) {
  const counts = new Map();
  for (let i = 0; i < 100; i++) { const s = shot(look, i * 0.05); counts.set(s, (counts.get(s) ?? 0) + 1); }
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (let i = 0; i < 100; i++) if (shot(look, i * 0.05) === common) return i * 0.05;
  return 0;
}
function tBlink(look) {
  const open = shot(look, tOpen(look));
  for (let i = 0; i < 400; i++) if (shot(look, i * 0.02) !== open) return i * 0.02;
  return 0;
}

// ---------------------------------------------------------------------------------
// Contract checks
// ---------------------------------------------------------------------------------
function check() {
  const problems = [];
  const note = (s) => { if (problems.length < 40) problems.push(s); };
  const SENT = 200;   // a value no painter may write
  const W = 48, H = 48, cx = 24, fy = 40;
  const fb = new Framebuffer(W, H);

  function bbox(what, x0, y0, x1, y1) {
    let bad = 0, minx = W, miny = H, maxx = -1, maxy = -1, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = fb.buf[y * W + x];
      if (v === SENT) continue;
      n++;
      if (v >= 64) bad++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (bad) note(`${what}: ${bad} pixels with light bits / index >= 64`);
    if (!n) note(`${what}: drew nothing`);
    else if (minx < x0 || maxx >= x1 || miny < y0 || maxy >= y1) note(`${what}: bbox x ${minx - cx}..${maxx - cx} y ${miny - fy}..${maxy - fy} outside ${x0 - cx}..${x1 - 1 - cx}, ${y0 - fy}..${y1 - 1 - fy}`);
    return { minx, miny, maxx, maxy };
  }

  // Residents: palette range, bounds (RESIDENT_W x RESIDENT_H box + 2px margin, the cheer hop
  // and a 1px outline), exact mirroring, determinism.
  let extent = { l: 0, r: 0, u: 0 };
  for (const role of [...ROLES, 'nobody']) for (const pose of [...POSES, 'dance']) for (const mood of [...MOODS, undefined, 'odd']) for (const uniform of [...MODELS, 'mystery']) {
    for (let k = 0; k < 14; k++) {
      const t = k * 0.173 + (k > 10 ? 1000 : 0), seed = k * 7 + 1;
      const look = { role, pose, uniform, mood, seed: k === 13 ? undefined : seed };
      fb.buf.fill(SENT);
      ACT.drawResident(fb, cx, fy, t, { ...look, facing: 1 });
      const b = bbox(`resident ${role}/${pose}/${mood}/${uniform} t=${t.toFixed(2)}`, cx - 8, fy - G.RESIDENT_H - 5, cx + 8, fy + 1);
      extent.l = Math.max(extent.l, cx - 5 - b.minx); extent.r = Math.max(extent.r, b.maxx - (cx + 4)); extent.u = Math.max(extent.u, fy - G.RESIDENT_H - b.miny);
      const a = fb.buf.slice();
      fb.buf.fill(SENT);
      ACT.drawResident(fb, cx, fy, t, { ...look, facing: 1 });
      if (a.some((v, i) => v !== fb.buf[i])) note(`resident ${role}/${pose}: not deterministic`);
      fb.buf.fill(SENT);
      ACT.drawResident(fb, cx, fy, t, { ...look, facing: -1 });
      let mirrored = true;
      for (let y = 0; y < H && mirrored; y++) for (let x = 0; x < W; x++) if (a[y * W + x] !== fb.buf[y * W + (2 * cx - 1 - x)]) { mirrored = false; break; }
      if (!mirrored) note(`resident ${role}/${pose}/${mood} t=${t.toFixed(2)}: facing -1 is not an exact mirror`);
    }
  }
  // explicit colours override the uniform
  fb.buf.fill(SENT);
  ACT.drawResident(fb, cx, fy, 0, { role: 'operator', pose: 'idle', facing: 1, uniform: 'fable', colors: [C.PINK, C.RED_D, C.WHITE] });
  if (!fb.buf.includes(C.PINK) || fb.buf.includes(C.VIOLET)) note('resident: r.colors does not override r.uniform');

  // Workstations.
  for (const kind of [...KINDS, 'unknown']) for (const facing of [1, -1]) for (const active of [true, false]) for (let k = 0; k < 12; k++) {
    fb.buf.fill(SENT);
    ACT.drawWorkstation(fb, cx, fy, kind, k * 0.31, { active, facing, seed: k === 0 ? undefined : k });
    bbox(`station ${kind} f=${facing} active=${active}`, cx - 8, fy - G.STATION_H, cx + 8, fy);
    const a = fb.buf.slice();
    fb.buf.fill(SENT);
    ACT.drawWorkstation(fb, cx, fy, kind, k * 0.31, { active, facing: -facing, seed: k === 0 ? undefined : k });
    for (let i = 0, bad = false; i < H * W && !bad; i++) {
      const x = i % W, y = (i / W) | 0;
      if (a[i] !== fb.buf[y * W + (2 * cx - 1 - x)]) { bad = true; note(`station ${kind}: facing ${-facing} is not an exact mirror of ${facing}`); }
    }
  }

  // Icons, bubbles, items.
  for (const icon of [...ACT.ICONS, 'nonsense']) {
    fb.buf.fill(SENT);
    ACT.drawIcon(fb, 10, 10, icon, C.INK);
    bbox(`icon ${icon}`, 10, 10, 17, 17);
    fb.buf.fill(SENT);
    ACT.drawIcon(fb, 10, 10, icon);
    for (const tone of ['normal', 'warn', 'alert', undefined]) for (let k = 0; k < 10; k++) {
      fb.buf.fill(SENT);
      ACT.drawBubble(fb, cx, fy, icon, k * 0.21, tone);
      bbox(`bubble ${icon}/${tone}`, cx - 5, fy - 14, cx + 6, fy);
    }
  }
  for (const [kind, s] of [['crate', 6], ['package', 6], ['cache', 4]]) for (let k = 0; k < 12; k++) {
    fb.buf.fill(SENT);
    ACT.drawItem(fb, 10, 10, kind, k * 0.17);
    bbox(`item ${kind}`, 10, 10, 10 + s, 10 + s);
  }
  fb.buf.fill(SENT);
  ACT.drawItem(fb, 10, 10, 'crate');

  // Translation: moving the anchor by (1, 1), or by a fraction, must move the picture rigidly
  // (cache blobs are the one deliberate exception: their shimmer rolls with position).
  const shiftSame = (what, draw) => {
    for (const [dx, dy, fx] of [[1, 1, 0], [0, 0, 0.6], [2, -1, 0.3]]) for (let k = 0; k < 6; k++) {
      const t = k * 0.29 + 0.05;
      fb.buf.fill(SENT); draw(cx, fy, t);
      const a = fb.buf.slice();
      fb.buf.fill(SENT); draw(cx + dx + fx, fy + dy + fx, t);
      for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        if (a[y * W + x] !== fb.buf[(y + dy) * W + x + dx]) { note(`${what}: not translation-invariant (shift ${dx + fx},${dy + fx}) t=${t.toFixed(2)}`); return; }
      }
    }
  };
  for (const pose of POSES) shiftSame(`resident ${pose}`, (x, y, t) => ACT.drawResident(fb, x, y, t, { role: 'researcher', pose, facing: -1, uniform: 'opus', seed: 4 }));
  for (const kind of KINDS) shiftSame(`station ${kind}`, (x, y, t) => ACT.drawWorkstation(fb, x, y, kind, t, { active: true, facing: 1, seed: 2 }));
  for (const tone of ['normal', 'warn', 'alert']) shiftSame(`bubble ${tone}`, (x, y, t) => ACT.drawBubble(fb, x, y, 'fire', t, tone));

  // Exports.
  for (const k of ['fable', 'opus', 'sonnet', 'haiku', 'generic']) {
    const u = ACT.UNIFORMS[k];
    if (!Array.isArray(u) || u.length !== 3 || u.some((v) => !(v >= 1 && v < 64))) note(`UNIFORMS.${k} is not [main, shade, trim]`);
  }
  for (const fn of ['drawResident', 'drawWorkstation', 'drawIcon', 'drawBubble', 'drawItem']) if (typeof ACT[fn] !== 'function') note(`missing export ${fn}`);
  if (ACT.ICONS.join() !== 'code,doc,search,check,shell,plan,think,web,delegate,wait,zzz,alert,fire,power,done,hello') note('ICONS changed');

  console.log(`resident overhang beyond the 10x14 box: left ${extent.l}px, right ${extent.r}px, up ${extent.u}px`);
  if (problems.length) { console.log('CONTRACT PROBLEMS:'); for (const p of problems) console.log('  - ' + p); process.exitCode = 1; }
  else console.log('contract checks passed');
}

const list = which === 'all' ? Object.keys(pages) : which === 'check' ? [] : which.split(',');
for (const name of list) {
  if (!pages[name]) { console.error(`unknown page ${name}; pages: ${Object.keys(pages).join(', ')}`); process.exit(1); }
  const [fb, scale] = pages[name]();
  console.log(savePng(fb, out(name), scale));
}
if (which === 'all' || which === 'check') check();
