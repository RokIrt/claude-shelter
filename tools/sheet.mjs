// Contact sheet of every painter, for eyeballing art headlessly.
//   node tools/sheet.mjs [t] [outPath]   (t = animation time in seconds, default 1.3;
//                                         outPath default out/sheet.png)
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C, LIGHT } from '../src/gfx/palette.mjs';
import { drawText } from '../src/gfx/font.mjs';
import * as G from '../src/gfx/geom.mjs';
import { drawMachine, MACHINE_ANCHORS } from '../src/gfx/machines.mjs';
import { drawReactor, drawSwitchboard, drawGenerator } from '../src/gfx/power.mjs';
import * as FX from '../src/gfx/fx.mjs';
import * as ENV from '../src/gfx/env.mjs';
import * as ACT from '../src/gfx/actors.mjs';
import { savePng } from './png.mjs';

const t = Number(process.argv[2] ?? 1.3);
const fb = new Framebuffer(960, 760);
fb.clear(C.ROCK_D);
let y = 4;

// Machines: each design in each status, inside a machine room.
const designs = ['fable', 'opus', 'sonnet', 'haiku', 'generic'];
const looks = [
  { status: 'running', heat: 0.1, powered: true },
  { status: 'hot', heat: 0.85, powered: true },
  { status: 'fire', heat: 1, powered: false },
  { status: 'pitstop', heat: 0.3, powered: false },
];
for (const d of designs) {
  looks.forEach((look, i) => {
    const x = 4 + i * 236;
    if (x + G.ROOM_W > fb.w) return;
    ENV.drawRoom(fb, x, y, G.ROOM_W, G.ROOM_H, 'machine', t, { accent: ACT.UNIFORMS[d]?.[0] ?? C.STEEL, label: d, doorL: true });
    const fy = y + G.ROOM_H - G.FLOOR_T, cx = x + G.MACHINE_CX;
    ENV.drawBelt(fb, x + G.BELT_IN[0], y + G.BELT_Y, G.BELT_IN[1] - G.BELT_IN[0], t * 12);
    ENV.drawBelt(fb, x + G.BELT_OUT[0], y + G.BELT_Y, G.BELT_OUT[1] - G.BELT_OUT[0], t * 12);
    ENV.drawPipe(fb, [[x + G.MACHINE_CX - 44, y + G.LOOP.y1], [x + G.LOOP.x0, y + G.LOOP.y1], [x + G.LOOP.x0, y + G.LOOP.y0], [x + G.LOOP.x1, y + G.LOOP.y0], [x + G.LOOP.x1, y + G.LOOP.y1], [x + G.MACHINE_CX + 44, y + G.LOOP.y1]], 'cache');
    ACT.drawItem(fb, x + 20, y + G.BELT_Y - 6, 'crate', t);
    ACT.drawItem(fb, x + 170, y + G.BELT_Y - 6, 'package', t);
    ACT.drawItem(fb, x + 90, y + G.LOOP.y0 - 1, 'cache', t);
    drawMachine(fb, cx, fy, d, t, { ...look, phase: t * 0.8, speed: look.powered ? 0.6 : 0, style: { accent: C.PINK, accent2: C.TEAL, variant: 1 } });
    const kinds = ['terminal', 'documents', 'inspection'];
    G.SLOT_XS.forEach((sx, k) => {
      if (k % 2) return;
      ACT.drawWorkstation(fb, x + sx, fy, kinds[(k / 2) % 3], t, { active: look.powered, facing: sx < G.MACHINE_CX ? 1 : -1 });
      ACT.drawResident(fb, x + sx, fy, t, { role: ['programmer', 'researcher', 'reviewer'][(k / 2) % 3], pose: look.status === 'fire' ? 'panic' : ['work', 'read', 'inspect'][(k / 2) % 3], facing: sx < G.MACHINE_CX ? 1 : -1, uniform: d, mood: look.status === 'fire' ? 'shocked' : 'focused', seed: k });
    });
    if (look.status === 'pitstop') fb.relight(x, y, G.ROOM_W, G.ROOM_H, LIGHT.AMBER);
    const a = MACHINE_ANCHORS[d];
    if (look.status === 'fire') {
      FX.drawFire(fb, cx + a.fire[0], fy + a.fire[1], 22, 18, t, 0.6, 3);
      FX.drawSmoke(fb, cx + a.smoke[0], fy + a.smoke[1], 14, t, 0.6, 3);
      FX.drawSparks(fb, cx + a.sparks[0][0], fy + a.sparks[0][1], t, 1, 5);
    }
    FX.drawBeacon(fb, cx + a.lamp[0], fy + a.lamp[1], t, look.status === 'hot' ? 'amber' : look.status === 'fire' ? 'red' : 'off');
  });
  y += G.ROOM_H + 4;
}

// Utility rooms + shaft + elevator.
let x = 4;
for (const kind of ['control', 'lounge', 'dock', 'power']) {
  ENV.drawRoom(fb, x, y, G.HALF_W, G.ROOM_H, kind, t, { doorL: true, doorR: true, label: kind });
  const fy = y + G.ROOM_H - G.FLOOR_T;
  if (kind === 'control') G.CONTROL.stand.slice(0, 2).forEach((sx, i) => { ACT.drawResident(fb, x + sx, fy, t, { role: 'foreman', pose: i ? 'idle' : 'work', facing: 1, uniform: i ? 'opus' : 'fable', mood: 'happy', seed: i }); ACT.drawBubble(fb, x + sx, fy - G.RESIDENT_H - 1, i ? 'delegate' : 'plan', t); });
  if (kind === 'lounge') { G.LOUNGE.seats.forEach((sx, i) => ACT.drawResident(fb, x + sx, fy, t, { role: 'programmer', pose: 'sit', facing: 1, uniform: ['haiku', 'sonnet', 'generic'][i], mood: 'sleepy', seed: i })); ACT.drawBubble(fb, x + G.LOUNGE.seats[0], fy - G.RESIDENT_H - 1, 'zzz', t); }
  if (kind === 'dock') { ENV.drawBelt(fb, x + G.DOCK.belt[0], y + G.DOCK.beltY, G.DOCK.belt[1] - G.DOCK.belt[0], t * 12); ACT.drawItem(fb, x + 40, y + G.DOCK.beltY - 6, 'crate', t); ACT.drawItem(fb, x + 60, y + G.DOCK.beltY - 6, 'package', t); }
  if (kind === 'power') { drawSwitchboard(fb, x + G.POWER.switchboardCx, fy, t, { status: 'warn', percent: 86 }); drawGenerator(fb, x + G.POWER.generatorCx, fy, t, { present: true, running: true, utilization: 0.4, phase: t }); }
  x += G.HALF_W;
}
ENV.drawShaft(fb, x, y, G.SHAFT_W_FULL, G.ROOM_H, t);
ENV.drawElevatorCar(fb, x + 16, y + G.ROOM_H - G.FLOOR_T, t, { door: 0.6 });
ACT.drawResident(fb, x + 16, y + G.ROOM_H - G.FLOOR_T, t, { role: 'researcher', pose: 'ride', facing: 1, uniform: 'sonnet', mood: 'neutral' });
ENV.drawElevatorDoors(fb, x + 16, y + G.ROOM_H - G.FLOOR_T, t, { door: 0.6 });
x += G.SHAFT_W_FULL + 8;
// second power room: tripped switchboard, empty generator bay, amber light
ENV.drawRoom(fb, x, y, G.HALF_W, G.ROOM_H, 'power', t, { label: 'power' });
drawSwitchboard(fb, x + G.POWER.switchboardCx, y + G.ROOM_H - G.FLOOR_T, t, { status: 'tripped', percent: 100 });
drawGenerator(fb, x + G.POWER.generatorCx, y + G.ROOM_H - G.FLOOR_T, t, { present: false, running: false, utilization: null, phase: 0 });
fb.relight(x, y, G.HALF_W, G.ROOM_H, LIGHT.AMBER);
FX.drawSparks(fb, x + G.POWER.switchboardCx, y + 30, t, 1, 2);
x += G.HALF_W + 8;
ENV.drawSurface(fb, x, y, 260, G.SURFACE_H, t, { shaftX: x + 110, shaftW: G.SHAFT_W_FULL });
ENV.drawSurface(fb, x, y + 34, 260, G.SURFACE_H, t, { shaftX: x + 110, shaftW: G.SHAFT_W_FULL, emergency: true });
y += G.ROOM_H + 4;

// Reactor hall, full width, three states.
['ok', 'critical', 'meltdown'].forEach((status, i) => {
  const w = i === 0 ? 448 : 232, rx = i === 0 ? 4 : 4 + 456 + (i - 1) * 240;
  ENV.drawRoom(fb, rx, y, w, G.REACTOR_H, 'reactor', t, { label: 'reactor' });
  drawReactor(fb, rx, y, w, G.REACTOR_H, t, { status, heat: [0.1, 0.85, 1][i], phase: t, speed: 0.5, percent: [20, 93, 100][i] });
  if (status === 'meltdown') {
    fb.relight(rx, y, w, G.REACTOR_H, LIGHT.EMERGENCY);
    const cx = rx + (w >> 1), fy = y + G.REACTOR_H - G.FLOOR_T;
    FX.drawFire(fb, cx, fy - 40, 40, 34, t, 1, 1);
    FX.drawSmoke(fb, cx, fy - 62, 30, t, 1, 1);
  }
});
y += G.REACTOR_H + 4;

// Residents: roles x poses, icons, items, rock.
const roles = ['foreman', 'programmer', 'researcher', 'reviewer', 'operator'];
const poses = ['idle', 'walk', 'work', 'read', 'inspect', 'sit', 'panic', 'cheer', 'ride'];
fb.rect(4, y, 420, 110, C.WALL);
roles.forEach((role, ri) => poses.forEach((pose, pi) => {
  ACT.drawResident(fb, 20 + pi * 18, y + 20 + ri * 20, t, { role, pose, facing: pi % 2 ? -1 : 1, uniform: designs[ri], mood: ['happy', 'neutral', 'focused', 'sleepy', 'worried', 'shocked'][pi % 6], seed: pi + ri * 9 });
}));
ACT.ICONS.forEach((icon, i) => ACT.drawBubble(fb, 200 + (i % 8) * 16, y + 24 + Math.floor(i / 8) * 20, icon, t, ['normal', 'warn', 'alert'][i % 3]));
['crate', 'package', 'cache'].forEach((k, i) => ACT.drawItem(fb, 340 + i * 12, y + 20, k, t));
drawText(fb, 200, y + 60, 'THE QUICK BROWN FOX 0123456789 %:+-', C.CREAM, { shadow: C.INK });
ENV.drawRock(fb, 430, y, 200, 60, 4);
FX.drawGlow(fb, 680, y + 30, 14, C.ORANGE, t);
FX.drawSteam(fb, 720, y + 50, 30, t, 1, 2);
FX.drawSmoke(fb, 760, y + 56, 50, t, 1, 4);
FX.drawFire(fb, 820, y + 56, 30, 30, t, 1, 6);

// Optional 3rd argument: output path (so several people can render at once without clobbering).
const outPath = process.argv[3] ?? new URL('../out/sheet.png', import.meta.url).pathname;
console.log(savePng(fb, outPath, 2));
