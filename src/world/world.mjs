// The shelter world: turns ShelterState into a living scene in a Framebuffer.
// This file only orchestrates. The scene (rooms, machines, power, effects, lighting)
// lives in scene.mjs; the life in it (residents, elevator, token items) in life.mjs.
//
// No DOM, no Node APIs: it runs in the browser and headlessly in Node (tools/snap.mjs).
import { C } from '../gfx/palette.mjs';
import { computeLayout } from './layout.mjs';
import { createScene } from './scene.mjs';
import { createLife } from './life.mjs';

/**
 * @typedef {{type:'resident', id:string} | {type:'machine', modelKey:string} | {type:'reactor'} |
 *           {type:'switchboard'} | {type:'generator'}} Pick
 *
 * @typedef {Object} Ctx  passed to every scene / life call
 * @property {number} t        seconds since the world started
 * @property {number} dt       seconds since the last update (0 in draw calls)
 * @property {import('../shared/contract.mjs').ShelterState} state
 * @property {import('../shared/contract.mjs').ShelterEvent[]} events   transitions since the last update
 * @property {import('./layout.mjs').Layout} layout
 * @property {boolean} relaid  true on the update where the layout changed (reposition everything)
 * @property {Pick|null} selection  what the player has selected (inspector open), or null
 */

/**
 * @param {{layout?: 'full'|'compact'}} [opts]
 *   full: two columns of rooms with the elevator shaft between them (480 wide);
 *   compact: one column with the shaft on the left (240 wide), for a narrow side pane.
 */
export function createWorld(opts = {}) {
  let mode = opts.layout === 'compact' ? 'compact' : 'full';
  let layout = computeLayout(mode, []);
  let state = null;
  let t = 0;
  let selection = null;
  let pendingRelaid = true;
  const scene = createScene();
  const life = createLife();
  const ctx = () => ({ t, dt: 0, state, events: [], layout, relaid: false, selection });

  function relayout() {
    const keys = state ? state.machines.map((m) => m.modelKey) : [];
    const next = computeLayout(mode, keys);
    if (next.key !== layout.key) { layout = next; pendingRelaid = true; }
  }

  return {
    /** Current logical size {w, h}. Can change after update() (layout or number of machines). */
    get size() { return { w: layout.w, h: layout.h }; },
    get layout() { return mode; },
    setLayout(m) { mode = m === 'compact' ? 'compact' : 'full'; relayout(); },

    /**
     * Advance the simulation.
     * @param {number} dt seconds since the last update (already clamped to <= 0.1)
     * @param {import('../shared/contract.mjs').ShelterState|null} next latest state (null until data arrives)
     * @param {import('../shared/contract.mjs').ShelterEvent[]} events transitions since the last update
     */
    update(dt, next, events) {
      t += dt;
      state = next;
      if (!state) return;
      relayout();
      const c = { t, dt, state, events: events ?? [], layout, relaid: pendingRelaid, selection };
      pendingRelaid = false;
      scene.update(c);
      life.update(c);
    },

    /** Draw the whole scene. fb is a Framebuffer of exactly `size`. */
    render(fb) {
      if (!state) { fb.clear(C.ROCK_D); return; }
      const c = ctx();
      scene.drawBack(fb, c);    // rock, surface, shaft, rooms, belts, pipes, cables, machines, power plant, gauges
      life.drawBack(fb, c);     // elevator car, workstations, residents, token items
      scene.drawLight(fb, c);   // relight rooms: amber pit stop, red emergency, flicker
      scene.drawFront(fb, c);   // emissive: fire, smoke, sparks, beacons, pulses, lit signs
      life.drawFront(fb, c);    // status bubbles and anything that must stay readable in the dark
      if (selection) {
        const b = this.locate(selection);
        if (b) {
          const col = Math.floor(t * 3) % 2 ? C.CREAM : C.AMBER_L;
          const x0 = b.x - 2, y0 = b.y - 2, x1 = b.x + b.w + 1, y1 = b.y + b.h + 1, n = 3;
          for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
            for (let i = 0; i < n; i++) { fb.px(cx + i * sx, cy, col); fb.px(cx, cy + i * sy, col); }
          }
        }
      }
    },

    /** What is at logical pixel (x, y)? Residents win over machines. @returns {Pick|null} */
    pick(x, y) {
      if (!state) return null;
      const c = ctx();
      return life.pick(x, y, c) ?? scene.pick(x, y, c);
    },

    /** Current bounding box {x, y, w, h} of a pickable thing, or null if it is not on screen. */
    locate(pick) {
      if (!state || !pick) return null;
      const c = ctx();
      return pick.type === 'resident' ? life.locate(pick, c) : scene.locate(pick, c);
    },

    /** Mark something as selected (a blinking corner marker is drawn around it); null clears it. */
    setSelection(pick) { selection = pick ?? null; },
  };
}
