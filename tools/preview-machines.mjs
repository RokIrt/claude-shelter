// Close-up previews and contract checks for src/gfx/machines.mjs.
//   node tools/preview-machines.mjs [design|all] [scale]
// Writes out/machines-<design>-states.png, -anim.png, -zoom.png (and -variants.png for
// generic), then runs the checks (bounds, palette range, ports, stillness when unpowered).
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C, LIGHT } from '../src/gfx/palette.mjs';
import { drawText } from '../src/gfx/font.mjs';
import { drawMachine, MACHINE_ANCHORS } from '../src/gfx/machines.mjs';
import * as FX from '../src/gfx/fx.mjs';
import { savePng } from './png.mjs';

const ALL = ['fable', 'opus', 'sonnet', 'haiku', 'generic'];
const which = process.argv[2] && process.argv[2] !== 'all' ? [process.argv[2]] : ALL;
const SCALE = Number(process.argv[3] ?? 4);
const out = (name) => new URL(`../out/machines-${name}.png`, import.meta.url).pathname;

const MW = 88, MH = 48, PAD = 6, CW = MW + PAD * 2, CH = MH + 16;
const STYLE = { accent: C.PINK, accent2: C.TEAL, variant: 1 };

function look(status, heat, phase, style = STYLE) {
  const powered = status === 'idle' || status === 'running' || status === 'hot';
  return { status, heat, powered, phase, speed: powered && status !== 'idle' ? 0.6 : 0, style };
}

/** One preview cell: a slice of machine room with belt and pipe stubs, the machine, the beacon. */
function cell(fb, ox, oy, design, lk, t, opts = {}) {
  const bx = ox + PAD, by = oy + 10, floorY = by + MH, cx = bx + MW / 2;
  fb.rect(ox, oy, CW, CH, C.WALL);
  fb.rect(ox, floorY, CW, CH - (floorY - oy), C.STEEL_D);
  fb.rect(ox, by + 22, PAD, 3, C.STEEL_DD); fb.rect(bx + MW, by + 22, PAD, 3, C.STEEL_DD);
  fb.rect(ox, by + 7, PAD, 3, C.TEAL_D); fb.rect(bx + MW, by + 7, PAD, 3, C.TEAL_D);
  if (opts.box) fb.frame(bx - 1, by - 1, MW + 2, MH + 2, C.MAGENTA);
  drawMachine(fb, cx, floorY, design, t, lk);
  if (opts.relight) fb.relight(ox, oy, CW, CH, opts.relight);
  const a = MACHINE_ANCHORS[design];
  if (opts.fx) {
    FX.drawFire(fb, cx + a.fire[0], floorY + a.fire[1], 22, 18, t, 0.6, 3);
    FX.drawSmoke(fb, cx + a.smoke[0], floorY + a.smoke[1], 14, t, 0.6, 3);
    for (const s of a.sparks) FX.drawSparks(fb, cx + s[0], floorY + s[1], 0, 1, 5);
  }
  if (!opts.noBeacon) FX.drawBeacon(fb, cx + a.lamp[0], floorY + a.lamp[1], t, lk.status === 'hot' ? 'amber' : lk.status === 'fire' ? 'red' : 'off');
  if (opts.label) drawText(fb, ox + 2, oy + 2, opts.label, C.CREAM, { shadow: C.INK });
}

function grid(cols, rows) {
  const fb = new Framebuffer(cols * (CW + 2) + 2, rows * (CH + 2) + 2);
  fb.clear(C.ROCK_D);
  return { fb, at: (i) => [2 + (i % cols) * (CW + 2), 2 + Math.floor(i / cols) * (CH + 2)] };
}

function renderStates(d) {
  const { fb, at } = grid(4, 3);
  const t = 1.3, ph = 1.04;
  const cells = [
    ['idle', look('idle', 0.05, ph), {}],
    ['running .1', look('running', 0.1, ph), {}],
    ['hot .6', look('hot', 0.6, ph), {}],
    ['hot .8', look('hot', 0.8, ph), {}],
    ['hot 1.0', look('hot', 1.0, ph), {}],
    ['fire', look('fire', 1, ph), {}],
    ['fire+fx', look('fire', 1, ph), { fx: true }],
    ['pitstop raw', look('pitstop', 0.3, ph), {}],
    ['pitstop', look('pitstop', 0.3, ph), { relight: LIGHT.AMBER }],
    ['emergency', look('emergency', 0.3, ph), { relight: LIGHT.EMERGENCY }],
    ['dark', look('pitstop', 0.3, ph), { relight: LIGHT.DARK }],
    ['idle t+2', look('idle', 0.05, ph), {}],
  ];
  cells.forEach(([label, lk, opts], i) => { const [x, y] = at(i); cell(fb, x, y, d, lk, i === 11 ? t + 2 : t, { ...opts, label }); });
  return savePng(fb, out(`${d}-states`), SCALE);
}

function renderAnim(d) {
  const { fb, at } = grid(4, 3);
  for (let i = 0; i < 8; i++) {
    const t = 1.0 + i * 0.125, [x, y] = at(i);
    cell(fb, x, y, d, look('running', 0.2, t * 0.8), t, { label: `ph ${(t * 0.8).toFixed(2)}` });
  }
  for (let i = 0; i < 4; i++) {
    const t = 1000.37 + i * 0.125, [x, y] = at(8 + i);
    cell(fb, x, y, d, look('hot', 0.9, t * 0.8), t, { label: `hot ph ${(t * 0.8).toFixed(2)}` });
  }
  return savePng(fb, out(`${d}-anim`), SCALE);
}

function renderZoom(d) {
  const fb = new Framebuffer(CW * 2 + 2, CH);
  fb.clear(C.ROCK_D);
  cell(fb, 0, 0, d, look('running', 0.2, 1.04), 1.3, {});
  cell(fb, CW + 2, 0, d, look('pitstop', 0.2, 1.04), 1.3, { noBeacon: true });
  return savePng(fb, out(`${d}-zoom`), 8);
}

function renderVariants() {
  const pairs = [[C.PINK, C.TEAL], [C.COPPER, C.CYAN], [C.STEEL, C.AMBER], [C.RED, C.YELLOW], [C.INK, C.INK], [C.WHITE, C.WHITE], [C.BLACK, C.GREEN_L], [C.GRASS, C.SAND]];
  const { fb, at } = grid(4, 4);
  for (let i = 0; i < 16; i++) {
    const v = i % 4, p = pairs[(i >> 2) * 2 + (v >> 1)] ?? pairs[i % pairs.length];
    const [x, y] = at(i);
    const pr = pairs[(Math.floor(i / 4) * 2 + (v & 1)) % pairs.length];
    cell(fb, x, y, 'generic', look(i >= 12 ? 'pitstop' : 'running', 0.2, 1.04 + i * 0.11, { accent: pr[0], accent2: pr[1], variant: v }), 1.3 + i * 0.07, { label: `v${v} ${pr[0]}/${pr[1]}` });
    void p;
  }
  return savePng(fb, out('generic-variants'), SCALE);
}

// ---- checks -------------------------------------------------------------------------
function snapshot(d, lk, t) {
  const SENT = 200, M = 20;
  const fb = new Framebuffer(MW + M * 2, MH + M * 2);
  fb.clear(SENT);
  drawMachine(fb, M + MW / 2, M + MH, d, t, lk);
  return { fb, SENT, M };
}

function checks(d) {
  const problems = [];
  const styles = d === 'generic'
    ? [STYLE, { accent: 0, accent2: 0, variant: 0 }, { accent: C.INK, accent2: C.INK, variant: 2 }, { accent: C.WHITE, accent2: C.WHITE, variant: 3 }, undefined, { accent: C.RED, accent2: C.RED, variant: 7 }]
    : [STYLE];
  for (const style of styles) {
    for (const status of ['idle', 'running', 'hot', 'fire', 'pitstop', 'emergency']) {
      for (const ph of [0, 0.13, 0.37, 0.5, 0.77, 1000.37, -0.4]) {
        for (const heat of [0, 0.6, 1]) {
          const lk = look(status, heat, ph, style);
          const { fb, SENT, M } = snapshot(d, lk, 3.3 + ph);
          let outside = 0, bad = 0;
          for (let y = 0; y < fb.h; y++) for (let x = 0; x < fb.w; x++) {
            const v = fb.buf[y * fb.w + x];
            const inside = x >= M && x < M + MW && y >= M && y < M + MH;
            if (!inside && v !== SENT) outside++;
            if (inside && v !== SENT && (v >= 64 || v === 0)) bad++;
          }
          if (outside) problems.push(`${status} ph${ph}: ${outside} px outside the box`);
          if (bad) problems.push(`${status} ph${ph}: ${bad} px out of palette range / BLACK`);
          // ports: both edge columns opaque at y 6..9 and 13..22
          for (const ex of [M, M + MW - 1]) for (const yy of [6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
            if (fb.buf[(M + yy) * fb.w + ex] === SENT) problems.push(`${status} ph${ph}: port column x=${ex - M} y=${yy} is open`);
          }
          if (!lk.powered) {
            const b = snapshot(d, lk, 77.7).fb, c = snapshot(d, lk, 0).fb;
            for (let i = 0; i < fb.buf.length; i++) if (fb.buf[i] !== b.buf[i] || fb.buf[i] !== c.buf[i]) { problems.push(`${status} ph${ph}: not still across t`); break; }
          }
        }
      }
    }
  }
  // unpowered machines must not contain emissive colours
  const EMISSIVE = new Set([C.CREAM, C.WHITE, C.YELLOW, C.RED_L, C.ORANGE, C.GREEN_L, C.MINT, C.CYAN, C.CYAN_L, C.PINK, C.AMBER_L, C.HAZARD, C.MAGENTA, C.SKY]);
  for (const status of ['pitstop', 'emergency']) {
    const { fb, SENT } = snapshot(d, look(status, 0.9, 0.37), 1);
    const seen = new Map();
    for (const v of fb.buf) if (v !== SENT && EMISSIVE.has(v)) seen.set(v, (seen.get(v) ?? 0) + 1);
    if (seen.size) console.log(`  note ${d}/${status}: bright colours present: ${[...seen].map(([k, n]) => `${Object.keys(C).find((key) => C[key] === k)}x${n}`).join(' ')}`);
  }
  const uniq = [...new Set(problems)];
  console.log(`${d}: ${uniq.length ? 'PROBLEMS\n  ' + uniq.slice(0, 12).join('\n  ') : 'checks ok'}`);
  // timing
  const fb = new Framebuffer(200, 100);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) drawMachine(fb, 100, 80, d, i / 60, look(i % 3 ? 'hot' : 'fire', 0.9, i / 75));
  console.log(`  ${((performance.now() - t0) / 2000 * 1000).toFixed(1)} us per draw`);
}

function renderVariantStates() {
  const { fb, at } = grid(4, 4);
  const sts = [['idle', 0.05], ['hot', 1], ['fire', 1], ['pitstop', 0.3]];
  for (let v = 0; v < 4; v++) sts.forEach(([st, heat], j) => {
    const [x, y] = at(v * 4 + j);
    cell(fb, x, y, 'generic', look(st, heat, 1.37 + v * 0.31, { accent: [C.TEAL, C.AMBER, C.STEEL_D, C.VIOLET][v], accent2: [C.CREAM, C.CYAN, C.ORANGE, C.MINT][v], variant: v }), 2.1, { label: `v${v} ${st}`, relight: st === 'pitstop' ? LIGHT.AMBER : undefined, fx: st === 'fire' });
  });
  return savePng(fb, out('generic-vstates'), SCALE);
}

for (const d of which) {
  console.log(renderStates(d));
  console.log(renderAnim(d));
  console.log(renderZoom(d));
  if (d === 'generic') { console.log(renderVariants()); console.log(renderVariantStates()); }
  checks(d);
}
