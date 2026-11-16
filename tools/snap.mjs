// Headless screenshot of the world: run a simulation scenario through the real
// pipeline (scenario -> derive -> diff -> world) and save a PNG.
//
//   node tools/snap.mjs [scenario] [tSec] [layout] [outPath] [scale] [warmupSec]
//   node tools/snap.mjs tour 30 full out/tour-30.png 3
//
// The world is stepped from (tSec - warmupSec) to tSec at 30 fps so residents have
// time to walk to their places (warmupSec default 20).
import { Framebuffer } from '../src/gfx/fb.mjs';
import { createWorld } from '../src/world/world.mjs';
import { scenarioSnapshot } from '../src/shared/scenarios.mjs';
import { derive, diffStates } from '../src/shared/derive.mjs';
import { savePng } from './png.mjs';

/** Step a fresh world through a scenario and return {world, fb, state}. */
export function runScenario({ scenario = 'tour', tSec = 30, layout = 'full', warmupSec = 20, whatIf = 1, fps = 30 } = {}) {
  const world = createWorld({ layout });
  const epoch = 1_794_790_000_000;
  const dt = 1 / fps;
  let prev = null, state = null, lastDerive = -1;
  for (let t = Math.max(0, tSec - warmupSec); t <= tSec + 1e-9; t += dt) {
    let events = [];
    if (t - lastDerive >= 0.25) {
      lastDerive = t;
      state = derive(scenarioSnapshot(scenario, t, epoch + t * 1000), { now: epoch + t * 1000, whatIf });
      events = diffStates(prev, state);
      prev = state;
    }
    world.update(dt, state, events);
  }
  const { w, h } = world.size;
  const fb = new Framebuffer(w, h);
  world.render(fb);
  return { world, fb, state };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [scenario = 'tour', tSec = '30', layout = 'full', out, scale = '3', warmup = '20'] = process.argv.slice(2);
  const { fb, state } = runScenario({ scenario, tSec: Number(tSec), layout, warmupSec: Number(warmup) });
  const path = out ?? new URL(`../out/snap-${scenario}-${tSec}-${layout}.png`, import.meta.url).pathname;
  console.log(savePng(fb, path, Number(scale)), `${fb.w}x${fb.h}`, `power=${state.power}`, state.alerts[0]?.text ?? '');
}
