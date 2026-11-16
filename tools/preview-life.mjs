// Previews and traces for the shelter's life (residents, elevator, items).
//
//   node tools/preview-life.mjs strip <scenario> <layout> <t0> <t1> <every> <out.png> [x,y,w,h] [scale] [cols] [from]
//       Fresh world started at t0, frames every <every> seconds from <from> (default t0) until
//       t1, laid out in a grid (optionally cropped to a region of the world).
//   node tools/preview-life.mjs trace <scenario> <layout> <t0> <t1>
//       Prints, per resident, when it arrived / reached its post / left, plus elevator
//       and shortcut statistics.
import { Framebuffer } from '../src/gfx/fb.mjs';
import { C } from '../src/gfx/palette.mjs';
import { drawText } from '../src/gfx/font.mjs';
import { createWorld } from '../src/world/world.mjs';
import { scenarioSnapshot } from '../src/shared/scenarios.mjs';
import { derive, diffStates } from '../src/shared/derive.mjs';
import { savePng } from './png.mjs';
import { lifeDebug } from '../src/world/life.mjs';

const EPOCH = 1_794_790_000_000;

/**
 * Step a fresh world through a scenario from t0 to t1 at `fps`, deriving a state every
 * 0.25 s like tools/snap.mjs, calling onFrame(world, t, state, events) after each update.
 */
export function simulate({ scenario = 'tour', layout = 'full', t0 = 0, t1 = 30, fps = 30, whatIf = 1, onFrame }) {
  const world = createWorld({ layout });
  const dt = 1 / fps;
  let prev = null, state = null, lastDerive = -1;
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    let events = [];
    if (t - lastDerive >= 0.25) {
      lastDerive = t;
      state = derive(scenarioSnapshot(scenario, t, EPOCH + t * 1000), { now: EPOCH + t * 1000, whatIf });
      events = diffStates(prev, state);
      prev = state;
    }
    world.update(dt, state, events);
    if (onFrame) onFrame(world, t, state, events);
  }
  return { world, state };
}

function strip(scenario, layout, t0, t1, every, out, crop, scale = 2, cols = 3, from = t0) {
  const frames = [];
  let next = from;
  let size = null;
  simulate({
    scenario, layout, t0, t1,
    onFrame(world, t) {
      if (t + 1e-9 < next) return;
      next += every;
      const { w, h } = world.size;
      const fb = new Framebuffer(w, h);
      world.render(fb);
      const [cx, cy, cw, ch] = crop ?? [0, 0, w, h];
      const f = new Framebuffer(cw, ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) f.buf[y * cw + x] = fb.get(cx + x, cy + y);
      drawText(f, 2, 2, `T=${t.toFixed(2)}`, C.WHITE, { bg: C.INK });
      frames.push(f); size = [cw, ch];
    },
  });
  const [fw, fh] = size;
  const rows = Math.ceil(frames.length / cols);
  const sheet = new Framebuffer(cols * (fw + 2), rows * (fh + 2));
  sheet.clear(C.MAGENTA);
  frames.forEach((f, i) => {
    const ox = (i % cols) * (fw + 2), oy = Math.floor(i / cols) * (fh + 2);
    for (let y = 0; y < fh; y++) sheet.buf.set(f.buf.subarray(y * fw, y * fw + fw), (oy + y) * sheet.w + ox);
  });
  console.log(savePng(sheet, out, scale), `${frames.length} frames`);
}

function trace(scenario, layout, t0, t1) {
  const info = new Map();   // id -> {seen, posted, left, ladder, maxTrip}
  let ladders = 0;
  const lastMode = new Map();
  simulate({
    scenario, layout, t0, t1,
    onFrame(world, t, state, events) {
      const life = lifeDebug.last;
      for (const e of events) {
        if (e.type === 'agent_arrived') info.set(e.id, { arrived: t, posted: null, left: null, gone: null });
        if (e.type === 'agent_left' && info.has(e.id)) info.get(e.id).left = t;
      }
      const dbg = life?.debug();
      if (!dbg) return;
      const present = new Set();
      for (const r of dbg.residents) {
        present.add(r.id);
        const i = info.get(r.id);
        if (i && i.posted === null && r.arrived && r.tKind !== 'exit') i.posted = t;
        if (r.mode === 'ladder' && lastMode.get(r.id) !== 'ladder') { ladders++; console.log(`  ${t.toFixed(2)} ladder ${r.id} stop ${r.stop} -> ${r.tStop}`); }
        lastMode.set(r.id, r.mode);
      }
      for (const [id, i] of info) if (i.gone === null && !present.has(id) && t > i.arrived + 0.1) i.gone = t;
    },
  });
  let worst = 0;
  for (const [id, i] of info) {
    const took = i.posted !== null ? i.posted - i.arrived : null;
    if (took !== null) worst = Math.max(worst, took);
    console.log(`${id.padEnd(28)} arrived ${i.arrived.toFixed(1).padStart(6)}  posted ${took === null ? '   -  ' : ('+' + took.toFixed(1)).padStart(6)}  left ${i.left === null ? '   -  ' : i.left.toFixed(1).padStart(6)}  gone ${i.gone === null ? '   -  ' : ('+' + (i.gone - (i.left ?? i.arrived)).toFixed(1)).padStart(6)}`);
  }
  console.log(`worst time to post: ${worst.toFixed(1)} s, ladder shortcuts: ${ladders}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, scenario = 'busy', layout = 'full', t0 = '0', t1 = '30', ...rest] = process.argv.slice(2);
  if (mode === 'strip') {
    const [every = '0.5', out = 'out/life-strip.png', crop, scale = '2', cols = '3', from = t0] = rest;
    strip(scenario, layout, Number(t0), Number(t1), Number(every), out, crop && crop !== '-' ? crop.split(',').map(Number) : null, Number(scale), Number(cols), Number(from));
  } else if (mode === 'trace') {
    trace(scenario, layout, Number(t0), Number(t1));
  } else {
    console.log('usage: node tools/preview-life.mjs strip|trace <scenario> <layout> <t0> <t1> ...');
  }
}
