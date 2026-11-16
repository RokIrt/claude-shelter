// Scene tests: every scenario renders in both layouts, pick/locate round-trip, the pit-stop
// and emergency lighting really reach the framebuffer, and reset sequences play out.
//   node --test test/scene.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Framebuffer } from '../src/gfx/fb.mjs';
import { createWorld } from '../src/world/world.mjs';
import { createScene } from '../src/world/scene.mjs';
import { computeLayout } from '../src/world/layout.mjs';
import { scenarioSnapshot, SCENARIOS } from '../src/shared/scenarios.mjs';
import { derive, diffStates } from '../src/shared/derive.mjs';
import { modelDef, zeroRate, zeroTokens } from '../src/shared/models.mjs';

const EPOCH = 1_794_790_000_000;
const LAYOUTS = ['full', 'compact'];

/** Drive a world through a scenario the way the app does (derive every 0.25 s). */
function runner(scenario, layout, { fps = 30, snap = (t) => scenarioSnapshot(scenario, t, EPOCH + t * 1000) } = {}) {
  const world = createWorld({ layout });
  let t = 0, prev = null, state = null, lastDerive = -1;
  const dt = 1 / fps;
  return {
    world,
    get state() { return state; },
    get t() { return t; },
    step(toT) {
      while (t < toT - 1e-9) {
        let events = [];
        if (t - lastDerive >= 0.25 - 1e-9) {
          lastDerive = t;
          state = derive(snap(t), { now: EPOCH + t * 1000 });
          events = diffStates(prev, state);
          prev = state;
        }
        world.update(dt, state, events);
        t += dt;
      }
    },
    render() {
      const { w, h } = world.size;
      const fb = new Framebuffer(w, h);
      world.render(fb);
      assert.deepEqual([fb.cx0, fb.cy0, fb.cx1, fb.cy1], [0, 0, w, h], 'drawing left a clip rectangle set');
      return fb;
    },
  };
}

/** Histogram of light modes (0..3) inside a rectangle. */
function modes(fb, r) {
  const n = [0, 0, 0, 0];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) n[fb.get(x, y) >> 6]++;
  return n;
}
const share = (n, k) => n[k] / (n[0] + n[1] + n[2] + n[3]);

function picksOf(state) {
  const p = state.machines.map((m) => ({ type: 'machine', modelKey: m.modelKey }));
  p.push({ type: 'reactor' }, { type: 'switchboard' });
  if (state.generator.present) p.push({ type: 'generator' });
  return p;
}

function assertBoxesInside(world, state, label) {
  const { w, h } = world.size;
  for (const pick of picksOf(state)) {
    const b = world.locate(pick);
    assert.ok(b, `${label}: no box for ${JSON.stringify(pick)}`);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h, `${label}: ${JSON.stringify(pick)} box out of bounds`);
  }
}

test('every scenario renders in both layouts without throwing and stays in bounds', () => {
  const times = [1, 8, 15, 25, 31, 41, 47, 55, 63, 70, 85, 101, 110];
  for (const scenario of SCENARIOS) {
    for (const layout of LAYOUTS) {
      const r = runner(scenario, layout, { fps: 20 });
      for (const at of times) {
        r.step(at);
        const fb = r.render();
        assert.equal(fb.w, layout === 'full' ? 480 : 240);
        assertBoxesInside(r.world, r.state, `${scenario}@${at} ${layout}`);
        // a few frames later too, so blinking / flickering branches get exercised
        r.step(at + 0.35);
        r.render();
      }
    }
  }
});

test('pick and locate round-trip for machines, reactor, switchboard and generator', () => {
  for (const layout of LAYOUTS) {
    for (const scenario of ['generator', 'busy', 'calm']) {
      const state = derive(scenarioSnapshot(scenario, 30, EPOCH + 30_000), { now: EPOCH + 30_000 });
      const L = computeLayout(layout, state.machines.map((m) => m.modelKey));
      const scene = createScene();
      const c = { t: 30, dt: 0, state, events: [], layout: L, relaid: true };
      scene.update({ ...c, dt: 1 / 60 });
      for (const pick of picksOf(state)) {
        const b = scene.locate(pick, c);
        assert.ok(b, `${layout}/${scenario}: locate ${JSON.stringify(pick)}`);
        assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= L.w && b.y + b.h <= L.h, 'box inside the world');
        for (const [px, py] of [[b.x + (b.w >> 1), b.y + (b.h >> 1)], [b.x, b.y], [b.x + b.w - 1, b.y + b.h - 1]]) {
          assert.deepEqual(scene.pick(px, py, c), pick, `${layout}/${scenario}: pick at ${px},${py}`);
        }
      }
      assert.equal(scene.pick(2, 2, c), null, 'sky is not pickable');
      assert.equal(scene.pick(L.w - 1, L.h - 1, c), null, 'rock is not pickable');
      if (!state.generator.present) {
        assert.equal(scene.locate({ type: 'generator' }, c), null, 'no generator box without a generator');
        const sb = scene.locate({ type: 'switchboard' }, c);
        // where the generator would stand: nothing to pick
        const pk = scene.pick(sb.x + 50, sb.y + sb.h - 5, c);
        assert.ok(pk === null || pk.type !== 'generator');
      }
      assert.equal(scene.locate({ type: 'machine', modelKey: 'no-such-model' }, c), null);
    }
  }
});

test('pit stop turns every room but the reactor hall amber', () => {
  for (const layout of LAYOUTS) {
    const r = runner('session-cap', layout);
    r.step(30);
    assert.equal(r.state.power, 'pitstop');
    const fb = r.render();
    const L = computeLayout(layout, r.state.machines.map((m) => m.modelKey));
    for (const rm of L.rooms) {
      const n = modes(fb, rm);
      if (rm.kind === 'reactor') assert.ok(share(n, 0) > 0.97, `${layout}: reactor hall stays lit`);
      else assert.ok(share(n, 1) > 0.6, `${layout}: ${rm.id} amber share ${share(n, 1).toFixed(2)}`);
    }
  }
});

test('emergency power turns the underground red and rooms flicker dark', () => {
  for (const layout of LAYOUTS) {
    const r = runner('weekly-cap', layout);
    r.step(28);
    assert.equal(r.state.power, 'emergency');
    const L = computeLayout(layout, r.state.machines.map((m) => m.modelKey));
    let red = 0, dark = 0;
    for (let i = 0; i < 40; i++) {
      r.step(28 + i * 0.07);
      const fb = r.render();
      const n = modes(fb, { x: 0, y: 40, w: L.w, h: L.h - 40 });
      red = Math.max(red, share(n, 2));
      for (const rm of L.rooms) if (share(modes(fb, rm), 3) > 0.5) dark++;
    }
    assert.ok(red > 0.6, `${layout}: emergency share ${red.toFixed(2)}`);
    assert.ok(dark > 0, `${layout}: no room ever dipped dark`);
  }
});

test('a hot reactor dips the shelter lights now and then', () => {
  const r = runner('weekly-warn', 'full');
  r.step(35);
  assert.ok(['hot', 'critical'].includes(r.state.reactor.status));
  const L = computeLayout('full', r.state.machines.map((m) => m.modelKey));
  let dipped = 0, lit = 0;
  const frames = 100;
  for (let i = 0; i < frames; i++) {
    r.step(35 + i * 0.1);
    const fb = r.render();
    if (L.rooms.some((rm) => share(modes(fb, rm), 0) < 0.5)) dipped++;
    else lit++;
  }
  assert.ok(dipped > 0, 'the lights never dipped');
  assert.ok(lit > frames * 0.8, `lights dipped too often (${dipped}/${frames})`);
});

test('a burning machine room flickers in firelight while the others carry on', () => {
  const r = runner('model-cap', 'full');
  r.step(20);
  assert.equal(r.state.machines.find((m) => m.modelKey === 'fable').status, 'fire');
  const L = computeLayout('full', r.state.machines.map((m) => m.modelKey));
  let fableDim = 0, othersDim = 0;
  for (let i = 0; i < 40; i++) {
    r.step(20 + i * 0.06);
    const fb = r.render();
    for (const rm of L.rooms) {
      const lit = share(modes(fb, rm), 0);
      if (rm.id === 'machine:fable') { if (lit < 0.5) fableDim++; } else if (lit < 0.9) othersDim++;
    }
  }
  assert.ok(fableDim > 0, 'fable room never flickered');
  assert.equal(othersDim, 0, 'other rooms should stay lit');
});

test('a weekly reset plays cool-down, repair and restart, then the shelter is back to normal', () => {
  for (const layout of LAYOUTS) {
    const r = runner('reset', layout);
    r.step(29);
    assert.equal(r.state.power, 'emergency');
    r.step(31.2);
    assert.equal(r.state.power, 'normal', 'state has already recovered');
    assert.equal(r.state.reactor.status, 'ok');
    const L = computeLayout(layout, r.state.machines.map((m) => m.modelKey));
    const under = { x: 0, y: 40, w: L.w, h: L.h - 40 };
    let fb = r.render();
    assert.ok(share(modes(fb, under), 0) < 0.3, `${layout}: the sequence keeps emergency lighting during the repair`);
    r.step(39);
    fb = r.render();
    assert.ok(share(modes(fb, under), 0) > 0.995, `${layout}: lights back to normal after the sequence`);
  }
});

test('a machine reset darkens only its room for the repair, and the session reset holds the amber', () => {
  const r = runner('tour', 'full');
  r.step(39);
  assert.equal(r.state.machines.find((m) => m.modelKey === 'fable').status, 'fire');
  r.step(41);
  assert.notEqual(r.state.machines.find((m) => m.modelKey === 'fable').status, 'fire');
  const L = computeLayout('full', r.state.machines.map((m) => m.modelKey));
  let fb = r.render();
  assert.ok(share(modes(fb, L.byId['machine:fable']), 3) > 0.9, 'fable room dark during the repair');
  assert.ok(share(modes(fb, L.byId['machine:opus']), 0) > 0.95, 'other rooms unaffected');
  r.step(47.5);
  fb = r.render();
  assert.ok(share(modes(fb, L.byId['machine:fable']), 0) > 0.95, 'fable room lit again');

  r.step(61.5);
  assert.equal(r.state.power, 'pitstop');
  r.step(63);
  assert.equal(r.state.power, 'normal');
  fb = r.render();
  assert.ok(share(modes(fb, L.byId.control), 1) > 0.6, 'rooms stay amber while the switchboard is repaired');
  r.step(69);
  fb = r.render();
  // the reactor is heating by now and may dip the lights; take the best of a few frames
  let best = 0;
  for (let i = 0; i < 6; i++) { r.step(69 + i * 0.13); best = Math.max(best, share(modes(r.render(), L.byId.control), 0)); }
  assert.ok(best > 0.95, 'control room lit again after the session repair');
});

test('any number of machines, and no machines at all', () => {
  const extra = (snap, keys) => ({
    ...snap,
    models: [...snap.models, ...keys.map((k) => ({ ...modelDef(k), tokens: zeroTokens(), rate: zeroRate(), activeAgents: 0 }))],
  });
  for (const layout of LAYOUTS) {
    const many = runner('busy', layout, { fps: 20, snap: (t) => extra(scenarioSnapshot('busy', t, EPOCH + t * 1000), ['zeta', 'omega', 'kappa']) });
    many.step(8);
    const base = scenarioSnapshot('busy', 8, EPOCH + 8000).models.length;
    assert.equal(many.state.machines.length, base + 3);
    many.render();
    assertBoxesInside(many.world, many.state, `${base + 3} machines ${layout}`);
    const none = runner('calm', layout, { fps: 20, snap: (t) => ({ ...scenarioSnapshot('calm', t, EPOCH + t * 1000), models: [], agents: [] }) });
    none.step(2);
    assert.equal(none.state.machines.length, 0);
    none.render();
  }
});

test('switching layout between updates does not use stale geometry', () => {
  const r = runner('weekly-cap', 'full');
  r.step(20);
  r.world.setLayout('compact');
  const fb = r.render();                  // render before the next update
  assert.equal(fb.w, 240);
  assertBoxesInside(r.world, r.state, 'after setLayout');
  r.step(21);
  r.world.setLayout('full');
  r.render();
});

test('scene modules use no Math.random, Date or platform APIs', () => {
  const dir = new URL('../src/world/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => /^scene.*\.mjs$/.test(n))) {
    const src = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random|\bDate\b|performance\.now|\bdocument\b|\bwindow\b|\bprocess\b|node:/.test(src), `${f} uses a forbidden API`);
  }
});
