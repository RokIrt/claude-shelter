// Scene previews: run a scenario through the real pipeline (scenario -> derive -> diff ->
// world) and save one or more frames, optionally cropped and tiled, as a PNG.
//
//   node tools/preview-scene.mjs <scenario> <tSec> <full|compact> [options]
//     --frames N     render N frames (default 1), tiled left to right
//     --step S       seconds between frames (default 0.2)
//     --crop x,y,w,h crop every frame to this logical rectangle
//     --scale K      pixel scale (default 3)
//     --warmup S     seconds simulated before tSec (default 20)
//     --cols N       frames per row when tiling (default: all in one row)
//     --out PATH     output file (default out/scene-<scenario>-<t>-<layout>.png)
//
// Example: node tools/preview-scene.mjs tour 30 full --frames 4 --crop 0,96,240,80 --scale 4
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C } from '../src/gfx/palette.mjs';
import { createWorld } from '../src/world/world.mjs';
import { scenarioSnapshot } from '../src/shared/scenarios.mjs';
import { derive, diffStates } from '../src/shared/derive.mjs';
import { savePng } from './png.mjs';

/**
 * Step a world through a scenario and grab frames.
 * @returns {{frames: Framebuffer[], world: object, states: object[]}}
 */
export function grabFrames({ scenario = 'tour', tSec = 30, layout = 'full', warmupSec = 20, frames = 1, step = 0.2, fps = 30, whatIf = 1 } = {}) {
  const world = createWorld({ layout });
  const epoch = 1_794_790_000_000;
  const dt = 1 / fps;
  let prev = null, state = null, lastDerive = -1;
  const out = [], states = [];
  const shots = [];
  for (let i = 0; i < frames; i++) shots.push(tSec + i * step);
  let next = 0;
  const end = shots[shots.length - 1];
  for (let t = Math.max(0, tSec - warmupSec); t <= end + 1e-9; t += dt) {
    let events = [];
    if (t - lastDerive >= 0.25) {
      lastDerive = t;
      state = derive(scenarioSnapshot(scenario, t, epoch + t * 1000), { now: epoch + t * 1000, whatIf });
      events = diffStates(prev, state);
      prev = state;
    }
    world.update(dt, state, events);
    while (next < shots.length && t + dt / 2 >= shots[next]) {
      const { w, h } = world.size;
      const fb = new Framebuffer(w, h);
      world.render(fb);
      out.push(fb); states.push(state);
      next++;
    }
  }
  return { frames: out, world, states };
}

/** Tile frames (optionally cropped) into one framebuffer with a 2px gap. */
export function tile(frames, crop, cols = frames.length) {
  const cw = crop ? crop[2] : frames[0].w, ch = crop ? crop[3] : frames[0].h;
  const rows = Math.ceil(frames.length / cols);
  const gap = 2;
  const W = cols * cw + (cols - 1) * gap, H = rows * ch + (rows - 1) * gap;
  const out = new Framebuffer(W, H);
  out.clear(C.MAGENTA);
  frames.forEach((fb, i) => {
    const ox = (i % cols) * (cw + gap), oy = Math.floor(i / cols) * (ch + gap);
    const sx = crop ? crop[0] : 0, sy = crop ? crop[1] : 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out.buf[(oy + y) * W + ox + x] = fb.get(sx + x, sy + y);
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const pos = [], opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  const [scenario = 'tour', t = '30', layout = 'full'] = pos;
  const frames = Number(opt.frames ?? 1);
  const crop = opt.crop ? opt.crop.split(',').map(Number) : null;
  const { frames: fbs, states } = grabFrames({ scenario, tSec: Number(t), layout, warmupSec: Number(opt.warmup ?? 20), frames, step: Number(opt.step ?? 0.2) });
  const img = tile(fbs, crop, Number(opt.cols ?? fbs.length));
  const path = opt.out ?? new URL(`../out/scene-${scenario}-${t}-${layout}.png`, import.meta.url).pathname;
  const s = states[states.length - 1];
  console.log(savePng(img, path, Number(opt.scale ?? 3)), `${img.w}x${img.h}`, `power=${s.power}`, `reactor=${s.reactor.status}`, s.machines.map((m) => `${m.modelKey}:${m.status}`).join(' '));
}
