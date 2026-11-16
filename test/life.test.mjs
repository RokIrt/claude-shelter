// The shelter's life: residents, the elevator and token items, driven through the real
// world pipeline (scenario -> derive -> diff -> createWorld) in both layouts.
//   node --test test/life.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Framebuffer } from '../src/gfx/fb.mjs';
import * as G from '../src/gfx/geom.mjs';
import { createWorld } from '../src/world/world.mjs';
import { computeLayout, machineRoom } from '../src/world/layout.mjs';
import { lifeDebug } from '../src/world/life.mjs';
import { scenarioSnapshot, SCENARIOS } from '../src/shared/scenarios.mjs';
import { derive, diffStates } from '../src/shared/derive.mjs';
import { modelDef, modelKeyOf } from '../src/shared/models.mjs';

const EPOCH = 1_794_790_000_000;
const LAYOUTS = ['full', 'compact'];
const ARRIVAL_BOUND = 15;    // seconds from agent_arrived to standing in the right room

/**
 * Step a fresh world like tools/snap.mjs (30 fps, a new state every 0.25 s).
 * onFrame(world, t, state, events, layout) runs after every update.
 */
function drive({ scenario = 'calm', layout = 'full', t0 = 0, t1, fps = 30, snap, onFrame, world = createWorld({ layout }) }) {
  const dt = 1 / fps;
  const snapAt = snap ?? ((t) => scenarioSnapshot(scenario, t, EPOCH + t * 1000));
  let prev = null, state = null, last = -1;
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    let events = [];
    if (t - last >= 0.25) {
      last = t;
      state = derive(snapAt(t), { now: EPOCH + t * 1000 });
      events = diffStates(prev, state);
      prev = state;
    }
    world.update(dt, state, events);
    if (onFrame && onFrame(world, t, state, events, layoutOf(world, state)) === false) break;
  }
  return { world, state };
}

const layoutOf = (world, state) => computeLayout(world.layout, state.machines.map((m) => m.modelKey));

/** The room a resident's place implies (null for 'exit'). */
function roomFor(L, r) {
  if (r.place === 'control') return L.byId.control;
  if (r.place === 'lounge') return L.byId.lounge;
  if (r.place === 'machine') return machineRoom(L, r.modelKey) ?? L.byId.lounge;
  return null;
}

const inside = (b, rm) => !!b && !!rm && b.x >= rm.x && b.x + b.w <= rm.x + rm.w && b.y >= rm.y && b.y + b.h <= rm.y + rm.h;
const contains = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

function render(world) {
  const { w, h } = world.size;
  const fb = new Framebuffer(w, h);
  world.render(fb);
  return fb;
}

/** Every listed resident (place != exit) stands inside the room its place implies. */
function assertPlaced(world, state, L, label) {
  for (const r of state.residents) {
    if (r.place === 'exit') continue;
    const b = world.locate({ type: 'resident', id: r.id });
    assert.ok(inside(b, roomFor(L, r)), `${label}: ${r.id} (${r.place} ${r.modelKey}) box ${JSON.stringify(b)} not in ${roomFor(L, r)?.id}`);
  }
}

/** pick() at the centre of a resident's box returns it, unless another resident covers that spot. */
function assertPickable(world, state, label) {
  const boxes = state.residents.map((r) => [r.id, world.locate({ type: 'resident', id: r.id })]).filter(([, b]) => b);
  for (const [id, b] of boxes) {
    const cx = b.x + (b.w >> 1), cy = b.y + (b.h >> 1);
    if (boxes.some(([o, ob]) => o !== id && contains({ x: ob.x - 2, y: ob.y - 2, w: ob.w + 4, h: ob.h + 4 }, cx, cy))) continue;
    assert.deepEqual(world.pick(cx, cy), { type: 'resident', id }, `${label}: pick at the centre of ${id}`);
  }
}

// ───────────────────────────── scenarios ─────────────────────────────

for (const layout of LAYOUTS) {
  test(`every scenario runs in the ${layout} layout; residents are at their posts and pickable`, () => {
    for (const scenario of SCENARIOS) {
      let checked = false;
      drive({
        scenario, layout, t1: 75,
        onFrame(world, t, state, events, L) {
          if (Math.abs(t - Math.round(t)) < 1e-6) {             // once a second: draw, pick, select
            const sel = state.residents[0] ? { type: 'resident', id: state.residents[0].id } : null;
            world.setSelection(sel);
            render(world);
            world.pick(L.w / 2, L.h / 2);
          }
          if (!checked && t >= 42) {
            checked = true;
            assertPlaced(world, state, L, `${scenario}/${layout} t=42`);
            assertPickable(world, state, `${scenario}/${layout} t=42`);
          }
        },
      });
      assert.ok(checked);
    }
  });
}

for (const [layout, fps] of [['full', 30], ['compact', 30], ['full', 10], ['compact', 60]]) {
  test(`arrivals come down in the car and reach their post in time (busy, ${layout}, ${fps} fps)`, () => {
    const L0 = computeLayout(layout, []);
    const watch = new Map();   // id -> {at, first, done}
    drive({
      scenario: 'busy', layout, t1: 110, fps,
      onFrame(world, t, state, events, L) {
        for (const e of events) if (e.type === 'agent_arrived' && t > 58) watch.set(e.id, { at: t, first: null, done: null });
        for (const [id, w] of watch) {
          if (w.done !== null) continue;
          const b = world.locate({ type: 'resident', id });
          const r = state.residents.find((q) => q.id === id);
          if (b && !w.first) w.first = b;
          if (r && r.place !== 'exit' && inside(b, roomFor(L, r))) w.done = t;
        }
      },
    });
    assert.ok(watch.size >= 12, `expected a rush of arrivals, got ${watch.size}`);
    const shaft = L0.shaft;
    for (const [id, w] of watch) {
      if (w.at > 110 - ARRIVAL_BOUND) continue;
      assert.ok(w.first, `${id} never appeared`);
      const cx = w.first.x + w.first.w / 2;
      assert.ok(cx >= shaft.x - 1 && cx <= shaft.x + shaft.w + 1, `${id} first seen at x=${cx}, not in the shaft`);
      assert.ok(w.first.y + w.first.h <= L0.surfaceStopY + 1, `${id} first seen below the surface stop (box ${JSON.stringify(w.first)})`);
      assert.ok(w.done !== null && w.done - w.at <= ARRIVAL_BOUND, `${id} took ${w.done === null ? 'forever' : (w.done - w.at).toFixed(1) + ' s'} to reach its post`);
    }
  });
}

for (const layout of LAYOUTS) {
  test(`departed agents ride out and stop being locatable (calm + busy, ${layout})`, () => {
    for (const scenario of ['calm', 'busy']) {
      const left = new Map();   // id -> {at, goneAt}
      drive({
        scenario, layout, t1: 100,
        onFrame(world, t, state, events) {
          for (const e of events) if (e.type === 'agent_left' && t > 1) left.set(e.id, { at: t, goneAt: null });
          for (const [id, w] of left) {
            const b = world.locate({ type: 'resident', id });
            if (b && w.goneAt !== null && state.residents.some((r) => r.id === id && r.place === 'exit')) {
              assert.fail(`${id} came back after leaving`);
            }
            if (!b && w.goneAt === null) w.goneAt = t;
          }
        },
      });
      assert.ok(left.size >= 6, `${scenario}: expected departures, got ${left.size}`);
      for (const [id, w] of left) {
        if (w.at > 100 - 30) continue;
        assert.ok(w.goneAt !== null && w.goneAt - w.at < 30, `${scenario}/${layout}: ${id} still in the shelter ${w.goneAt === null ? 'at the end' : (w.goneAt - w.at).toFixed(1) + ' s'} after leaving`);
        assert.ok(w.goneAt - w.at > 0.5, `${scenario}/${layout}: ${id} vanished on the spot instead of walking out`);
      }
    }
  });
}

for (const [layout, fps] of [['full', 30], ['compact', 30], ['full', 60], ['compact', 10]]) {
  test(`nobody gets stuck in the rush (busy, ${layout}, ${fps} fps)`, () => {
    const since = new Map();   // id -> time its expected room last changed
    let worst = 0, worstId = '';
    drive({
      scenario: 'busy', layout, t1: 130, fps,
      onFrame(world, t, state, events, L) {
        for (const r of state.residents) {
          if (r.place === 'exit') { since.delete(r.id); continue; }
          const rm = roomFor(L, r);
          const key = `${rm?.id}`;
          const s = since.get(r.id);
          if (!s || s.key !== key) since.set(r.id, { key, at: t, ok: false });
          const cur = since.get(r.id);
          const b = world.locate({ type: 'resident', id: r.id });
          if (inside(b, rm)) { cur.ok = true; cur.at = t; continue; }
          // foremen walk off to operate a newly selected machine for a while: allow them longer
          const allow = r.kind === 'main' ? 45 : 20;
          const late = t - cur.at;
          if (late > worst) { worst = late; worstId = r.id; }
          assert.ok(late <= allow, `${r.id} has been out of ${key} for ${late.toFixed(1)} s at t=${t.toFixed(1)}`);
        }
      },
    });
    assert.ok(worst < 45, `${worstId} ${worst}`);
  });
}

test('a foreman works at its model\'s machine and moves when the agent switches model', () => {
  for (const layout of LAYOUTS) {
    let atFable = null, visited = null, back = null, climbed = false;
    drive({
      scenario: 'calm', layout, t1: 125,
      onFrame(world, t, state, events, L) {
        const b = world.locate({ type: 'resident', id: 'sim-main-1' });
        const r = state.residents.find((q) => q.id === 'sim-main-1');
        if (t < 68) {
          if (atFable === null && inside(b, machineRoom(L, 'fable'))) atFable = t;
          if (t > 30) assert.ok(!inside(b, L.byId.control), `${layout}: the foreman should not be at the console (t=${t})`);
          return;
        }
        if (r.place === 'machine' && t > 70 && t < 92) assert.ok(state.machines.find((m) => m.modelKey === 'opus').residentIds.includes('sim-main-1'));
        if (visited === null && inside(b, machineRoom(L, 'opus'))) visited = t;
        if (visited !== null && back === null && t > 92 && inside(b, machineRoom(L, 'fable'))) back = t;
        if (lifeDebug.last.debug().residents.some((q) => q.id === 'sim-main-1' && q.mode === 'ladder')) climbed = true;
      },
    });
    assert.ok(atFable !== null && atFable < 30, `${layout}: the foreman never reached the fable machine (${atFable})`);
    assert.ok(visited !== null && visited < 92, `${layout}: the foreman never reached the opus machine (${visited})`);
    assert.ok(back !== null, `${layout}: the foreman never went back to the fable machine`);
    assert.ok(!climbed, `${layout}: in a calm shift the foreman should not need the service ladder`);
  }
});

test('a layout switch re-places everyone at once, and a render before the next update is safe', () => {
  const world = createWorld({ layout: 'full' });
  let state = null;
  drive({ scenario: 'busy', layout: 'full', t1: 40, world, onFrame(w, t, s) { state = s; } });
  world.setLayout('compact');
  render(world);                                     // stale geometry: must not throw or draw garbage
  assert.equal(world.locate({ type: 'resident', id: 'sim-main-1' }), null);
  world.update(1 / 30, state, []);
  const L = layoutOf(world, state);
  assertPlaced(world, state, L, 'after switching to compact');
  render(world);
  world.setLayout('full');
  world.update(1 / 30, state, []);
  assertPlaced(world, state, layoutOf(world, state), 'after switching back to full');
});

// ───────────────────────────── hand-built situations ─────────────────────────────

/**
 * A calm snapshot whose agents are replaced by `agentsAt(t)` ([{id, model, status?}]) and whose
 * machines are the default four plus `extraModels`.
 */
function customSnap(agentsAt, extraModels = []) {
  return (t) => {
    const base = scenarioSnapshot('calm', 40, EPOCH + t * 1000);
    const tpl = base.agents.find((a) => a.kind === 'sub');
    const main = base.agents.filter((a) => a.kind === 'main');
    const agents = [...main, ...agentsAt(t).map((s) => ({
      ...tpl, id: s.id, model: s.model, modelKey: modelKeyOf(s.model), status: s.status ?? 'working',
      finishedAt: null, activity: 'code', tool: 'Edit',
    }))];
    const keys = ['fable', 'opus', 'sonnet', 'haiku', ...extraModels];
    for (const a of agents) if (!keys.includes(a.modelKey)) keys.push(a.modelKey);
    const models = keys.map((key) => {
      const own = agents.filter((a) => a.modelKey === key);
      const rate = { input: 0, output: 0, cacheRead: 0 }, tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const a of own) { for (const k in rate) rate[k] += a.rate[k]; for (const k in tokens) tokens[k] += a.tokens[k]; }
      return { ...modelDef(key), tokens, rate, activeAgents: own.length };
    });
    return { ...base, agents, models };
  };
}

for (const layout of LAYOUTS) {
  test(`more than six on one machine: everyone stays visible in the room (${layout})`, () => {
    const crowd = (t) => Array.from({ length: t < 10 ? 10 : 13 }, (_, i) => ({ id: `crowd-${i}`, model: 'claude-sonnet-5-5' }));
    drive({
      layout, t1: 40, snap: customSnap(crowd),
      onFrame(world, t, state, events, L) {
        if (Math.abs(t - 5) < 1e-6 || Math.abs(t - 35) < 1e-6) {
          assertPlaced(world, state, L, `crowd t=${t.toFixed(0)}`);
          const xs = state.residents.filter((r) => r.id.startsWith('crowd')).map((r) => world.locate({ type: 'resident', id: r.id }).x);
          assert.equal(new Set(xs).size, xs.length, `two crowd members share a spot: ${xs}`);
          render(world);
        }
      },
    });
  });
}

test('a subagent switching to the machine across the shaft rides across and settles in', () => {
  for (const layout of LAYOUTS) {
    let arrivedAt = null;
    drive({
      layout, t1: 40,
      snap: customSnap((t) => [{ id: 'hopper', model: t < 10 ? 'claude-fable-5-2' : 'claude-opus-5-5' }, { id: 'stay', model: 'claude-fable-5-2' }]),
      onFrame(world, t, state, events, L) {
        if (t < 10.3 || arrivedAt !== null) return;
        if (inside(world.locate({ type: 'resident', id: 'hopper' }), machineRoom(L, 'opus'))) arrivedAt = t;
      },
    });
    assert.ok(arrivedAt !== null && arrivedAt - 10 < ARRIVAL_BOUND, `${layout}: hopper reached opus at ${arrivedAt}`);
  }
});

test('a dozen machines in both layouts: arrivals still reach their posts', () => {
  const extra = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08'];
  const agents = (t) => {
    const out = [];
    extra.forEach((k, i) => { if (t >= 2) out.push({ id: `early-${k}`, model: `claude-${k}` }); if (t >= 8 + i) out.push({ id: `late-${k}`, model: `claude-${k}` }); });
    return out;
  };
  for (const layout of LAYOUTS) {
    const watch = new Map();
    drive({
      layout, t1: 45, snap: customSnap(agents, extra),
      onFrame(world, t, state, events, L) {
        for (const e of events) if (e.type === 'agent_arrived' && e.id.startsWith('late')) watch.set(e.id, null);
        for (const [id, done] of watch) {
          if (done !== null) continue;
          const r = state.residents.find((q) => q.id === id);
          if (inside(world.locate({ type: 'resident', id }), roomFor(L, r))) watch.set(id, t);
        }
        if (Math.abs(t - 44) < 1e-6) { render(world); assertPlaced(world, state, L, `dozen/${layout}`); }
      },
    });
    assert.equal(watch.size, extra.length);
    for (const [id, done] of watch) assert.ok(done !== null && done - (8 + extra.indexOf(id.slice(5))) <= ARRIVAL_BOUND + 1, `${layout}: ${id} at ${done}`);
  }
});

test('a machine resident whose model has no machine room waits in the lounge', () => {
  for (const layout of LAYOUTS) {
    drive({
      layout, t1: 25,
      snap: (t) => { const s = customSnap(() => [{ id: 'orphan', model: 'claude-ghost-1' }])(t); s.models = s.models.filter((m) => m.key !== 'ghost'); return s; },
      onFrame(world, t, state, events, L) {
        if (Math.abs(t - 24) > 1e-6) return;
        const r = state.residents.find((q) => q.id === 'orphan');
        assert.equal(r.place, 'machine');
        assert.ok(inside(world.locate({ type: 'resident', id: 'orphan' }), L.byId.lounge), `${layout}: orphan not in the lounge`);
        render(world);
      },
    });
  }
});

test('an agent that is already done when first seen never appears; a recurring id arrives again', () => {
  const agents = (t) => (t < 5 ? [] : t < 8 ? [{ id: 'flash', model: 'claude-haiku-5-5', status: 'done' }] : t < 12 ? [] : [{ id: 'flash', model: 'claude-haiku-5-5' }]);
  let seenDone = false, seenAgain = false;
  drive({
    layout: 'full', t1: 30, snap: customSnap(agents),
    onFrame(world, t) {
      const b = world.locate({ type: 'resident', id: 'flash' });
      if (t >= 5 && t < 8 && b) seenDone = true;
      if (t >= 12 && b) seenAgain = true;
    },
  });
  assert.ok(!seenDone, 'a finished agent popped up');
  assert.ok(seenAgain, 'the recurring id never arrived');
});

test('belts carry items at belt speed and freeze without power (debug view)', () => {
  // diagnostics only: the items are internal; check the world renders different pixels on a
  // running belt over time and identical ones on a frozen machine
  // only the columns by the wall hatch (no workstation bubble reaches that far left), and only
  // base colours (& 63): the scene may flicker the room lighting
  const crop = (fb, rm) => { const out = []; for (let x = rm.x + G.BELT_IN[0]; x < rm.x + 11; x++) for (let y = rm.y + G.BELT_Y - G.ITEM; y < rm.y + G.BELT_Y; y++) out.push(fb.get(x, y) & 63); return out.join(','); };
  for (const [scenario, key, moving] of [['calm', 'sonnet', true], ['model-cap', 'fable', false]]) {
    const shots = [];
    drive({
      scenario, layout: 'full', t1: 24,
      onFrame(world, t, state, events, L) {
        if (t > 19.99 && Math.abs(t * 2 - Math.round(t * 2)) < 1e-6) shots.push(crop(render(world), machineRoom(L, key)));
      },
    });
    assert.ok(shots.length >= 8);
    const distinct = new Set(shots).size;
    if (moving) assert.ok(distinct > 1, `${key} belt should move`);
    else assert.equal(distinct, 1, `${key} belt should be frozen`);
  }
  assert.ok(lifeDebug.last, 'debug hook available');
});
