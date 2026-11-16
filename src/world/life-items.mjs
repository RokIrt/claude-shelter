// Token items: data crates, finished packages and cache blobs riding the belts of every
// machine room, plus the shelter-wide freight traffic in the dock.
//
// Items move at exactly beltSpeed(machine) px/s, so they ride with the treads the scene
// draws, and stop dead when the machine has no power. Spawn spacing follows the token
// rates on a log scale (they span orders of magnitude) and is capped so a belt never jams.
import * as G from '../gfx/geom.mjs';
import { hash } from '../gfx/fb.mjs';
import { drawItem } from '../gfx/actors.mjs';
import { beltSpeed, loopPath, machineRoom } from './layout.mjs';

const ITEM = G.ITEM, BLOB = 4;

/** Dock belt speed in px/s: the same formula scene.mjs uses for the dock treads. */
export const dockBeltSpeed = (state) => beltSpeed({ powered: (state?.speed ?? 0) > 0, speed: state?.speed ?? 0 });

// Spacing (px between consecutive items) from a token rate (tokens per minute), log scale:
// at `lo` tpm and below the belt is sparse (maxGap), at `hi` and above it is as dense as it
// may get (minGap). Zero rate spawns nothing.
const CRATES = { lo: 30, hi: 60_000, maxGap: 46, minGap: 13 };
const PACKAGES = { lo: 100, hi: 200_000, maxGap: 46, minGap: 13 };
const BLOBS = { lo: 1_000, hi: 20_000_000, maxGap: 44, minGap: 10 };
const DOCK_IN = { lo: 30, hi: 100_000, maxGap: 44, minGap: 14 };
const DOCK_OUT = { lo: 100, hi: 600_000, maxGap: 40, minGap: 14 };

function gapFor(rate, k) {
  if (!(rate > 0)) return Infinity;
  const d = Math.max(0, Math.min(1, Math.log10(rate / k.lo) / Math.log10(k.hi / k.lo)));
  return k.maxGap + (k.minGap - k.maxGap) * d;
}

/** A lane: items at distances `pos` along it (descending: oldest first), spawned every `gap` px. */
function makeLane(len, size, seed) { return { len, size, seed, pos: [], acc: 0, n: 0 }; }

const jitter = (lane) => 0.8 + 0.4 * hash(lane.seed, lane.n, 17);

function advanceLane(lane, ds, gap) {
  if (ds <= 0) return;
  const p = lane.pos;
  for (let i = 0; i < p.length; i++) p[i] += ds;
  while (p.length && p[0] > lane.len) p.shift();
  if (gap === Infinity) { lane.acc = 0; return; }
  lane.acc += ds;
  for (let g = gap * jitter(lane); lane.acc >= g; g = gap * jitter(lane)) {
    lane.acc -= g; lane.n++;
    p.push(-lane.size + lane.acc);
  }
}

/** Pre-populate a lane as if it had been running for a while. */
function fillLane(lane, gap) {
  lane.pos.length = 0; lane.acc = 0;
  if (gap === Infinity) return;
  for (let x = lane.len - gap * (0.3 + 0.5 * hash(lane.seed, 3)); x > -lane.size; x -= gap * jitter(lane)) {
    lane.pos.push(x); lane.n++;
  }
}

function strSeed(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }

/** Point at distance s along a polyline with precomputed cumulative lengths. Writes into out. */
function along(pts, cum, s, out) {
  let i = 0;
  while (i < cum.length - 2 && s > cum[i + 1]) i++;
  const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
  const seg = cum[i + 1] - cum[i] || 1, f = Math.max(0, Math.min(1, (s - cum[i]) / seg));
  out[0] = ax + (bx - ax) * f; out[1] = ay + (by - ay) * f; out[2] = i;
  return out;
}

export function createItems() {
  /** modelKey -> {room, inp, out, loop, pts, cum, mx0, mx1} */
  const machines = new Map();
  const dock = { room: null, crates: [], packs: [], accIn: 0, accOut: 0, nIn: 0, nOut: 0, spare: [] };
  const P = [0, 0, 0];
  let L = null;

  function entry(m, fill) {
    let e = machines.get(m.modelKey);
    if (e) return e;
    const room = machineRoom(L, m.modelKey);
    if (!room) return null;
    const pts = loopPath(room), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]));
    const seed = strSeed(m.modelKey);
    e = {
      room, pts, cum,
      mx0: room.x + G.MACHINE_CX - G.MACHINE_W / 2, mx1: room.x + G.MACHINE_CX + G.MACHINE_W / 2,
      inp: makeLane(G.BELT_IN[1] - G.BELT_IN[0], ITEM, seed + 1),
      out: makeLane(G.BELT_OUT[1] - G.BELT_OUT[0], ITEM, seed + 2),
      loop: makeLane(cum[cum.length - 1], BLOB / 2, seed + 3),
      seen: true,
    };
    if (fill) {
      fillLane(e.inp, gapFor(m.rate.input, CRATES));
      fillLane(e.out, gapFor(m.rate.output, PACKAGES));
      fillLane(e.loop, gapFor(m.rate.cacheRead, BLOBS));
    }
    machines.set(m.modelKey, e);
    return e;
  }

  function dockItem(x, y, vy) {
    const it = dock.spare.pop() ?? { x: 0, y: 0, vy: 0, x0: 0, age: 0 };
    it.x = x; it.y = y; it.vy = vy; it.x0 = x; it.age = 0;
    return it;
  }

  function updateDock(state, dt) {
    const rm = dock.room;
    if (!rm) return;
    const v = dockBeltSpeed(state);
    if (v <= 0) return;                                   // mains down: the dock freezes too
    const ds = v * dt;
    const beltTop = rm.y + G.DOCK.beltY - ITEM;
    const chuteIn = rm.x + G.DOCK.chuteCx - 6;            // crates vanish into the chute mouth
    const outX = rm.x + G.DOCK.chuteCx + 11;              // packages land here after hopping out
    const end = rm.x + G.DOCK.belt[1];
    // crates: fall down the hatch channel, then ride to the chute
    for (let i = dock.crates.length - 1; i >= 0; i--) {
      const it = dock.crates[i];
      if (it.y < beltTop) {
        it.vy += 320 * dt; it.y = Math.min(beltTop, it.y + it.vy * dt);
        if (it.y >= beltTop && it.vy > 70) { it.vy = -it.vy * 0.25; it.y = beltTop - 0.01; }   // a little bounce
      } else { it.y = beltTop; it.x += ds; }
      if (it.x > chuteIn) { dock.spare.push(it); dock.crates.splice(i, 1); }
    }
    // packages: hop out of the chute mouth, land on the belt, ride out through the wall
    for (let i = dock.packs.length - 1; i >= 0; i--) {
      const it = dock.packs[i];
      it.age += dt;
      if (it.age < 0.55) {
        const f = it.age / 0.55;
        it.x = it.x0 + (outX - it.x0) * f;
        it.y = beltTop - 3 - 9 * Math.sin(Math.PI * f) + 3 * f;
      } else { it.y = beltTop; it.x = Math.max(it.x, outX) + ds; }
      if (it.x > end) { dock.spare.push(it); dock.packs.splice(i, 1); }
    }
    const gIn = gapFor(state.rate.input, DOCK_IN), gOut = gapFor(state.rate.output, DOCK_OUT);
    if (gIn !== Infinity) {
      dock.accIn += ds;
      const g = gIn * (0.75 + 0.5 * hash(dock.nIn, 31));
      if (dock.accIn >= g && dock.crates.length < 8) {
        dock.accIn = 0; dock.nIn++;
        dock.crates.push(dockItem(rm.x + G.DOCK.hatchCx - ITEM / 2, rm.y + G.CEIL_T + 2, 0));
      }
    }
    if (gOut !== Infinity) {
      dock.accOut += ds;
      const g = gOut * (0.75 + 0.5 * hash(dock.nOut, 37));
      if (dock.accOut >= g && dock.packs.length < 4) {
        dock.accOut = 0; dock.nOut++;
        dock.packs.push(dockItem(rm.x + G.DOCK.chuteCx - 3, beltTop - 3, 0));
      }
    }
  }

  return {
    /** Forget everything (new geometry). */
    reset(layout) {
      L = layout;
      machines.clear();
      for (const it of dock.crates) dock.spare.push(it);
      for (const it of dock.packs) dock.spare.push(it);
      dock.crates.length = 0; dock.packs.length = 0;
      dock.room = layout.byId.dock ?? null;
      dock.accIn = 0; dock.accOut = 0;
    },

    /** @param {import('./world.mjs').Ctx} c  New belts start pre-populated, as if running a while. */
    update(c) {
      if (!L) return;
      for (const e of machines.values()) e.seen = false;
      for (const m of c.state.machines) {
        const e = entry(m, true);
        if (!e) continue;
        e.seen = true;
        const ds = beltSpeed(m) * c.dt;
        if (ds <= 0) continue;                              // unpowered: everything freezes in place
        advanceLane(e.inp, ds, gapFor(m.rate.input, CRATES));
        advanceLane(e.out, ds, gapFor(m.rate.output, PACKAGES));
        advanceLane(e.loop, ds, gapFor(m.rate.cacheRead, BLOBS));
      }
      for (const [k, e] of machines) if (!e.seen) machines.delete(k);
      updateDock(c.state, c.dt);
    },

    /** Draw every item (clips to belt spans; leaves the clip cleared). */
    draw(fb, t) {
      for (const e of machines.values()) {
        const rm = e.room, y = rm.y + G.BELT_Y - ITEM;
        let x0 = rm.x + G.BELT_IN[0];
        fb.setClip(x0, rm.y, G.BELT_IN[1] - G.BELT_IN[0], rm.h);
        for (const p of e.inp.pos) drawItem(fb, x0 + p, y, 'crate', t);
        x0 = rm.x + G.BELT_OUT[0];
        fb.setClip(x0, rm.y, G.BELT_OUT[1] - G.BELT_OUT[0], rm.h);
        for (const p of e.out.pos) drawItem(fb, x0 + p, y, 'package', t);
        // cache blobs: out of the right flange, up and over, back in on the left
        const last = e.pts.length - 2;
        for (const s of e.loop.pos) {
          along(e.pts, e.cum, s, P);
          if (P[2] === 0) fb.setClip(e.mx1, rm.y, rm.x + rm.w - e.mx1, rm.h);
          else if (P[2] === last) fb.setClip(rm.x, rm.y, e.mx0 - rm.x, rm.h);
          else fb.setClip(rm.x, rm.y, rm.w, rm.h);
          drawItem(fb, Math.round(P[0]) - 2, Math.round(P[1]) - 2, 'cache', t);
        }
      }
      const rm = dock.room;
      if (rm) {
        const b0 = rm.x + G.DOCK.belt[0];
        fb.setClip(b0, rm.y + G.CEIL_T, rm.x + G.DOCK.chuteCx - 6 - b0, rm.h);
        for (const it of dock.crates) drawItem(fb, it.x, it.y, 'crate', t);
        fb.setClip(rm.x + G.DOCK.chuteCx - 7, rm.y, rm.x + G.DOCK.belt[1] - (rm.x + G.DOCK.chuteCx - 7), rm.h);
        for (const it of dock.packs) drawItem(fb, it.x, it.y, 'package', t);
      }
      fb.clearClip();
    },
  };
}
