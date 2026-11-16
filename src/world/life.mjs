// The life in the shelter: residents and their behaviour, the elevator car, token items.
//
// Every ShelterState resident gets one persistent entity with its own position and a small
// state machine:
//
//   stand   on a row's floor line, walking towards its target (or standing at its post)
//   wait    queued at the shaft landing for the car (at the surface: an arrival not yet in view)
//   board   walking into the car          car   riding          alight  walking out of the car
//   ladder  shortcut: climbing the service ladder in the shaft when the car takes too long
//
// The target is recomputed every update from the resident's ResidentState: a post (control
// console, lounge seat, machine workstation), a short visit to a machine (a foreman whose
// agent switched model) or the exit (ride up to the surface and disappear). Posts come from
// stable pools, so a resident keeps its seat or workstation while it stays.
//
// Draw / pick / locate only read positions cached by update(), never the live layout, so a
// render between a layout switch and the next update cannot go wrong (it draws nothing).
import * as G from '../gfx/geom.mjs';
import { C } from '../gfx/palette.mjs';
import { hash } from '../gfx/fb.mjs';
import { drawResident, drawWorkstation, drawBubble, SIT_DROP } from '../gfx/actors.mjs';
import { drawElevatorCar, drawElevatorDoors } from '../gfx/env.mjs';
import { createCar, resetCar, stepCar, stopY, riderCount, CAP, RIDER_DX, OUT, DOWN, UP, CROSS } from './life-car.mjs';
import { createItems } from './life-items.mjs';

const WALK = 36;            // px/s
const HURRY = 56;           // px/s once a trip has taken a while
const HURRY_AFTER = 5;      // s into a trip
const STEP_IN = 56;         // px/s walking in / out of the car
const LANDING = 7;          // landing spot: this far outside the shaft wall
const QUEUE_GAP = 8;        // queue spacing at a landing
const WAIT_PATIENCE = 14;   // s at the landing before taking the service ladder ...
const TRIP_PATIENCE = 6;    // ... or (arrivals, who have a time bound) this long into their trip
const CLIMB_TIME = 3;       // a ladder climb never takes longer than this
const SNAP_AFTER = 18;      // s: last resort, the resident is simply put at its post
const VISIT_TIME = 2.5;     // s a foreman operates a newly selected machine
const CHEER_TIME = 2;
const CLIP_TOP = G.SURFACE_H - 25;   // the car and climbers hide under the hatch-house roof

// Machine workstation fill order (indices into SLOT_XS), door side first, alternating sides
// so the room fills symmetrically.  Rooms with the door on the left / on the right.
const SLOT_ORDER_L = [2, 3, 1, 4, 0, 5];
const SLOT_ORDER_R = [3, 2, 4, 1, 5, 0];
// More than six on one machine: between the cells, then in front of the machine.
const OVER_L = [42, 166, 26, 182, 66, 142, 74, 134, 82, 126, 90, 118];
const OVER_R = [166, 42, 182, 26, 142, 66, 134, 74, 126, 82, 118, 90];
const LOUNGE_EXTRA = [60, 72, 84, 96];
// Sofa seats fill from the middle outwards.
const SEAT_ORDER = G.LOUNGE.seats.map((x, i) => i).sort((a, b) => Math.abs(G.LOUNGE.seats[a] - G.LOUNGE.sofaCx) - Math.abs(G.LOUNGE.seats[b] - G.LOUNGE.sofaCx));

const STATION_POSE = { terminal: 'work', documents: 'read', inspection: 'inspect' };

function strSeed(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h & 0x7fffffff; }

function makePool(kind, cap, modelKey = null) { return { kind, cap, modelKey, holders: [] }; }

function poolTake(pool, r) {
  let i = pool.holders.indexOf(null);
  if (i < 0) i = pool.holders.length;
  pool.holders[i] = r; r.pool = pool; r.poolIdx = i;
}

function poolTrim(pool) { const h = pool.holders; while (h.length && !h[h.length - 1]) h.pop(); }

function poolRelease(r) {
  const p = r.pool;
  if (!p) return;
  if (p.holders[r.poolIdx] === r) p.holders[r.poolIdx] = null;
  poolTrim(p);
  r.pool = null; r.poolIdx = -1;
}

/** A free regular spot is handed to the longest-waiting overflow holder. */
function poolPromote(pool) {
  const h = pool.holders;
  for (let i = 0; i < pool.cap && i < h.length; i++) {
    if (h[i]) continue;
    let j = pool.cap;
    while (j < h.length && !h[j]) j++;
    if (j >= h.length) break;
    h[i] = h[j]; h[j] = null; h[i].poolIdx = i;
  }
  poolTrim(pool);
}

/** Diagnostics hook for tools and tests: the most recently created life (not part of the contract). */
export const lifeDebug = { last: null };

export function createLife() {
  /** @type {import('./layout.mjs').Layout|null} geometry of the last update */
  let L = null;
  let t = 0, dt = 0, frame = 0;
  let selId = null;                // id of the selected resident: its bubble always shows
  const car = createCar();
  const items = createItems();
  const byId = new Map();          // id -> resident entity
  const list = [];                 // entities in arrival order
  const departed = new Set();      // ids that rode out but are still listed (done, lingering)
  const ids = new Set();           // ids in the current state
  const mByKey = new Map();        // modelKey -> MachineState
  const roomByModel = new Map();   // modelKey -> machine Room (current layout)
  const machinePools = new Map();  // modelKey -> pool
  const controlPool = makePool('control', G.CONTROL.stand.length);
  const loungePool = makePool('lounge', G.LOUNGE.seats.length);
  const resets = [];               // recent limit_reset events {scope, modelKey, at}
  const generic = new Map();       // modelKey -> [main, shade, trim] for generic machines
  let req = new Uint8Array(1);
  // draw order, rebuilt every update
  const floorList = [], carList = [], ladderList = [];
  const look = { role: 'operator', pose: 'idle', facing: 1, uniform: 'generic', colors: undefined, mood: 'neutral', seed: 0 };
  const wsOpts = { active: false, facing: 1, seed: 0 };
  // bubble layout scratch
  const bub = [], bx = [], by = [];

  // ───────────────────────────── geometry helpers ─────────────────────────────

  const sideOf = (x) => (L.mode === 'compact' || x >= L.shaft.cx ? 1 : -1);
  const landingX = (side) => L.shaft.cx + side * (L.shaft.w / 2 + LANDING);
  const ladderX = (side) => (side < 0 ? L.shaft.x + 5 : L.shaft.x + L.shaft.w - 5);
  const slotX = (i) => L.shaft.cx + RIDER_DX[i];
  const clampIn = (rm, x) => Math.max(rm.x + G.WALL_T + 5, Math.min(rm.x + rm.w - G.WALL_T - 5, x));

  function relay(layout) {
    L = layout;
    roomByModel.clear();
    for (const rm of L.rooms) if (rm.kind === 'machine') roomByModel.set(rm.modelKey, rm);
    resetCar(car, L);
    items.reset(L);
    req = new Uint8Array(L.rows.length + 1);
  }

  function machinePool(modelKey) {
    let p = machinePools.get(modelKey);
    if (!p) { p = makePool('machine', G.SLOT_XS.length, modelKey); machinePools.set(modelKey, p); }
    return p;
  }

  function wantedPool(r) {
    const rs = r.rs;
    if (r.leaving || rs.place === 'exit') return null;
    if (rs.place === 'control') return controlPool;
    if (rs.place === 'machine' && roomByModel.has(rs.modelKey)) return machinePool(rs.modelKey);
    if (rs.place === 'machine') {
      // its machine has no room (yet): keep a claimed workstation, else wait in the lounge
      if (r.pool && r.pool.kind === 'machine' && r.pool.modelKey === rs.modelKey) return r.pool;
      return loungePool;
    }
    return loungePool;
  }

  // ───────────────────────────── residents ─────────────────────────────

  function makeResident(rs, placeNow) {
    const r = {
      id: rs.id, seed: strSeed(rs.id), rs, seenFrame: frame,
      leaving: false, arriving: !placeNow, gone: false,
      mode: placeNow ? 'stand' : 'wait', stop: -1, x: L.shaft.cx, y: L.surfaceStopY, side: 1, facing: 1, moving: false,
      tStop: -1, tX: 0, tPose: 'idle', tFacing: 1, tKind: 'post', tRoom: null, tSig: -1, wsX: NaN,
      tripStart: t, arrived: false,
      pool: null, poolIdx: -1,
      dest: -1, exitSide: 1, carSlot: -1, requestAt: t, waitSince: placeNow ? -1 : t, climbV: 0,
      visit: null, visitStart: 0, visitUntil: Infinity, prevModelKey: rs.modelKey,
      cheerUntil: -1, lastBlockedAt: -1e9,
      lastIcon: rs.icon, lastStatus: rs.status, lastBlocked: rs.blocked, iconSince: t,
      vis: false, dx: 0, dy: 0, pose: 'idle', dfacing: 1, rank: 0,
    };
    byId.set(r.id, r); list.push(r);
    return r;
  }

  function setTarget(r, stop, x, pose, facing, kind, room, ws) {
    const sig = (stop + 2) * 8192 + Math.round(x) * 4 + (kind === 'exit' ? 1 : kind === 'visit' ? 2 : 0);
    if (sig !== r.tSig) {
      if (r.arrived) r.tripStart = t;   // a new trip; a retarget mid-trip keeps the clock running
      r.tSig = sig; r.arrived = false;
    }
    r.tStop = stop; r.tX = x; r.tPose = pose; r.tFacing = facing; r.tKind = kind; r.tRoom = room; r.wsX = ws;
  }

  function computeTarget(r) {
    if (r.leaving || r.rs.place === 'exit') { setTarget(r, -1, L.shaft.cx, 'ride', 1, 'exit', null, NaN); return; }
    if (r.visit) {
      const rm = roomByModel.get(r.visit);
      const x = rm.x + G.MACHINE_CX + (rm.doorL ? -30 : 30);
      setTarget(r, rm.row, x, 'work', rm.doorL ? 1 : -1, 'visit', rm, NaN);
      return;
    }
    const p = r.pool, i = r.poolIdx;
    if (!p) { setTarget(r, r.stop, r.x, 'idle', r.facing, 'post', null, NaN); return; }
    if (p.kind === 'machine') {
      const rm = roomByModel.get(p.modelKey);
      if (rm) {
        let x, pose, ws = NaN;
        if (i < 6) {
          x = rm.x + G.SLOT_XS[(rm.doorL ? SLOT_ORDER_L : SLOT_ORDER_R)[i]];
          // Between prompts an agent keeps its post but stands back from the station.
          pose = r.rs.status === 'working' ? STATION_POSE[r.rs.station] ?? 'work' : 'idle'; ws = x;
        } else {
          const over = rm.doorL ? OVER_L : OVER_R, k = i - 6;
          x = clampIn(rm, rm.x + over[k % over.length] + 3 * Math.floor(k / over.length));
          pose = 'idle';
        }
        setTarget(r, rm.row, x, pose, x < rm.x + G.MACHINE_CX ? 1 : -1, 'post', rm, ws);
        return;
      }
    }
    const rm = p.kind === 'control' ? L.byId.control : L.byId.lounge;
    if (!rm) { setTarget(r, r.stop, r.x, 'idle', r.facing, 'post', null, NaN); return; }
    if (p.kind === 'control') {
      const st = G.CONTROL.stand, n = st.length;
      // at the console: waiting for input stands by it, anything else operates it
      if (i < n) setTarget(r, rm.row, rm.x + st[i], r.rs.status === 'waiting' ? 'idle' : 'work', 1, 'post', rm, NaN);
      else setTarget(r, rm.row, clampIn(rm, rm.x + st[(i - n) % n] + 6 - 3 * Math.floor((i - n) / n)), 'idle', 1, 'post', rm, NaN);
      return;
    }
    const seats = G.LOUNGE.seats, stand = G.LOUNGE.stand;
    if (i < seats.length) {
      const sx = seats[SEAT_ORDER[i] ?? i];
      const f = sx < G.LOUNGE.sofaCx ? 1 : sx > G.LOUNGE.sofaCx ? -1 : (r.seed & 1 ? 1 : -1);
      setTarget(r, rm.row, rm.x + sx, 'sit', f, 'post', rm, NaN);
    } else {
      const k = i - seats.length;
      const sx = k < stand.length ? stand[k] : LOUNGE_EXTRA[(k - stand.length) % LOUNGE_EXTRA.length] + 2 * Math.floor((k - stand.length) / LOUNGE_EXTRA.length);
      setTarget(r, rm.row, clampIn(rm, rm.x + sx), 'idle', sx < 84 ? 1 : -1, 'post', rm, NaN);
    }
  }

  function placeAtTarget(r) {
    if (r.carSlot >= 0 && car.slots[r.carSlot] === r) car.slots[r.carSlot] = null;
    r.carSlot = -1;
    r.mode = 'stand'; r.stop = r.tStop; r.x = r.tX; r.y = stopY(L, Math.max(-1, r.stop));
    r.side = sideOf(r.x); r.facing = r.tFacing;
    r.arrived = true; r.arriving = false; r.waitSince = -1;
  }

  function gone(r) {
    poolRelease(r);
    if (r.carSlot >= 0 && car.slots[r.carSlot] === r) car.slots[r.carSlot] = null;
    r.carSlot = -1; r.gone = true; r.vis = false;
    byId.delete(r.id);
    if (ids.has(r.id)) departed.add(r.id);
  }

  /** Walk towards x; true once there. */
  function step(r, x, speed) {
    const d = x - r.x, s = speed * dt;
    if (Math.abs(d) <= s) { r.x = x; return true; }
    r.x += d > 0 ? s : -s; r.facing = d > 0 ? 1 : -1; r.moving = true;
    return false;
  }

  const canWalk = (r) => r.stop >= 0 && r.stop === r.tStop && sideOf(r.x) === sideOf(r.tX);

  function queueX(r) {
    let k = 0;
    for (const o of list) {
      if (o !== r && o.mode === 'wait' && o.stop === r.stop && o.side === r.side &&
          (o.requestAt < r.requestAt || (o.requestAt === r.requestAt && o.seed < r.seed))) k++;
    }
    return landingX(r.side) + r.side * QUEUE_GAP * Math.min(k, 6);
  }

  function startClimb(r) {
    r.mode = 'ladder';
    r.y = stopY(L, r.stop);
    r.x = ladderX(r.stop < 0 ? r.exitSide : r.side);
    r.climbV = Math.max(55, Math.abs(stopY(L, r.dest) - r.y) / CLIMB_TIME);
  }

  function move(r) {
    const speed = t - r.tripStart > HURRY_AFTER ? HURRY : WALK;
    r.moving = false;
    switch (r.mode) {
      case 'stand':
        r.y = stopY(L, r.stop);
        if (canWalk(r)) {
          if (step(r, r.tX, speed) && !r.arrived) { r.arrived = true; r.arriving = false; r.iconSince = t; }
        } else {
          r.arrived = false;
          r.mode = 'wait'; r.requestAt = t; r.waitSince = -1; r.side = sideOf(r.x);
        }
        break;
      case 'wait':
        r.dest = r.tStop; r.exitSide = r.tStop < 0 ? 1 : sideOf(r.tX);
        if (r.stop < 0) {
          if (r.tStop < 0) { gone(r); return; }           // left again before it ever came down
          if (r.waitSince < 0) r.waitSince = t;
        } else {
          if (canWalk(r)) { r.mode = 'stand'; break; }
          r.y = stopY(L, r.stop);
          if (step(r, queueX(r), speed)) { if (r.waitSince < 0) r.waitSince = t; r.facing = -r.side; }
        }
        // The service ladder is a last resort: for arrivals running out of time (they have a
        // deadline), or anyone kept waiting far too long. Crossing the shaft is car-only.
        if (r.waitSince >= 0 && r.dest !== r.stop &&
            (t - r.waitSince > WAIT_PATIENCE || (r.arriving && t - r.tripStart > TRIP_PATIENCE)) &&
            car.at !== r.stop && !(car.target === r.stop && Math.abs(car.y - stopY(L, r.stop)) < 80)) startClimb(r);
        break;
      case 'board':
        r.y = car.y;
        if (step(r, slotX(r.carSlot), STEP_IN)) r.mode = 'car';
        break;
      case 'car':
        r.x = slotX(r.carSlot); r.y = car.y;
        r.dest = r.tStop; r.exitSide = r.tStop < 0 ? 1 : sideOf(r.tX);
        break;
      case 'alight':
        r.y = stopY(L, r.stop);
        if (step(r, r.stop < 0 ? L.shaft.cx + G.CAR_W / 2 : landingX(r.exitSide), STEP_IN)) {
          if (r.stop < 0) { gone(r); return; }
          r.mode = 'stand'; r.side = r.exitSide;
        }
        break;
      case 'ladder': {
        r.dest = r.tStop; r.exitSide = r.tStop < 0 ? 1 : sideOf(r.tX);
        const ty = stopY(L, r.dest), d = ty - r.y, s = r.climbV * dt;
        if (Math.abs(d) <= s) {
          r.stop = r.dest;
          if (r.stop < 0) { gone(r); return; }
          r.y = ty; r.mode = 'stand'; r.x = landingX(r.exitSide); r.side = r.exitSide;
        } else { r.y += d > 0 ? s : -s; r.moving = true; }
        break;
      }
    }
    // Last resort: nobody may ever be stuck. (Leavers have no deadline; the ladder gets them out.)
    if (!r.arrived && (r.mode === 'stand' || r.mode === 'wait') && t - r.tripStart > (r.tStop < 0 ? 3 * SNAP_AFTER : SNAP_AFTER)) {
      if (r.tStop < 0) gone(r); else placeAtTarget(r);
    }
  }

  // ───────────────────────────── elevator ─────────────────────────────

  const travelDir = (r) => (r.dest > r.stop ? 1 : r.dest < r.stop ? -1 : 0);

  /** May this waiter board now? Riders all travel the car's way; an empty car takes anyone. */
  const mayBoard = (r) => {
    if (r.mode !== 'wait' || r.stop !== car.at || r.waitSince < 0) return false;
    const d = travelDir(r);
    return d === 0 || car.dir === 0 || d === car.dir || riderCount(car) === 0;
  };

  function exchange() {
    const s = car.at;
    for (let i = 0; i < CAP; i++) {
      const r = car.slots[i];
      if (r && r.mode === 'car' && r.dest === s) { r.mode = 'alight'; r.stop = s; r.carSlot = -1; car.slots[i] = null; }
    }
    for (;;) {
      const slot = car.slots.indexOf(null);
      if (slot < 0) break;
      let best = null;
      for (const r of list) if (mayBoard(r) && (!best || r.requestAt < best.requestAt)) best = r;
      if (!best) break;
      if (riderCount(car) === 0 && travelDir(best) !== 0) car.dir = travelDir(best);   // the first one in sets the way
      best.mode = 'board'; best.carSlot = slot; car.slots[slot] = best;
      if (s < 0) { best.x = L.shaft.cx + G.CAR_W / 2 - 2; best.y = car.y; }   // steps in from the hatch house
    }
  }

  function buildReq() {
    req.fill(0);
    for (const r of car.slots) if (r && r.mode === 'car' && r.dest >= -1) req[r.dest + 1] |= OUT;
    if (riderCount(car) < CAP) {
      for (const r of list) {
        if (r.mode !== 'wait' || r.waitSince < 0) continue;
        const d = r.dest > r.stop ? DOWN : r.dest < r.stop ? UP : CROSS;
        req[r.stop + 1] |= d;
      }
    }
  }

  function finishTransfers() {
    for (const r of list) {
      if (r.mode === 'board') { r.mode = 'car'; r.x = slotX(r.carSlot); }
      else if (r.mode === 'alight') {
        if (r.stop < 0) gone(r);
        else { r.mode = 'stand'; r.x = landingX(r.exitSide); r.side = r.exitSide; }
      }
    }
  }

  // ───────────────────────────── per-update bookkeeping ─────────────────────────────

  function blockedTone(r) {
    const m = mByKey.get(r.rs.modelKey);
    return m && m.status === 'pitstop' ? 'warn' : 'alert';
  }

  function resetAffects(r) {
    for (const e of resets) if (t - e.at < 2 && (e.scope !== 'model' || e.modelKey === r.rs.modelKey)) return true;
    return false;
  }

  function computeDrawState(r) {
    r.vis = true; r.dx = r.x; r.dy = r.y; r.dfacing = r.facing;
    switch (r.mode) {
      case 'stand':
        if (r.arrived && r.tKind !== 'exit') {
          r.dfacing = r.tFacing;
          if (r.cheerUntil > t) r.pose = 'cheer';
          else if (r.rs.blocked && blockedTone(r) === 'alert') {
            const a = t * 2.3 + (r.seed % 13);
            r.pose = 'panic'; r.dx = r.tX + 4 * Math.sin(a); r.dfacing = Math.cos(a) >= 0 ? 1 : -1;
          } else if (r.rs.blocked) r.pose = 'idle';
          else r.pose = r.tPose;
        } else r.pose = r.moving ? 'walk' : 'idle';
        floorList.push(r);
        break;
      case 'wait':
        if (r.stop < 0) { r.vis = false; break; }
        r.pose = r.moving ? 'walk' : 'idle';
        floorList.push(r);
        break;
      case 'board': case 'alight':
        r.pose = 'walk'; carList.push(r); break;
      case 'car':
        r.pose = 'ride'; r.dfacing = r.exitSide; carList.push(r); break;
      case 'ladder':   // arms up, legs going: climbing the service ladder
        r.pose = 'panic'; r.dfacing = r.side; ladderList.push(r); break;
    }
  }

  function setLook(r) {
    const rs = r.rs;
    look.role = rs.role; look.pose = r.pose; look.facing = r.dfacing; look.mood = rs.mood; look.seed = r.seed;
    look.uniform = rs.modelKey;
    const m = mByKey.get(rs.modelKey);
    if (m && m.design === 'generic') {
      let cols = generic.get(rs.modelKey);
      if (!cols || cols[0] !== m.style.accent || cols[2] !== m.style.accent2) {
        cols = [m.style.accent, C.STEEL_D, m.style.accent2]; generic.set(rs.modelKey, cols);
      }
      look.colors = cols;
    } else look.colors = undefined;
    return look;
  }

  const atStation = (r) => r.mode === 'stand' && r.arrived && r.tKind === 'post' && r.pool && r.pool.kind === 'machine';

  function bubbleShown(r) {
    if (r.rs.blocked || r.arriving || r.leaving || r.cheerUntil > t) return true;
    if (selId === r.id) return true;
    if (!atStation(r)) return true;
    // At a workstation the bubble would hide the station's screen: show it when something
    // changes, then for ~2 s of every 8 s, staggered per resident.
    if (t - r.iconSince < 3) return true;
    return (t + hash(r.seed, 9) * 8) % 8 < 2;
  }

  function bubbleIcon(r) {
    if (r.leaving || r.rs.place === 'exit') return 'done';
    if (r.arriving) return 'hello';
    return r.rs.icon;
  }

  function bubbleTone(r) { return r.rs.blocked ? blockedTone(r) : 'normal'; }

  function bubbleRank(r, epoch) {
    const tone = bubbleTone(r);
    const base = tone === 'alert' ? 0 : tone === 'warn' ? 1 : r.arriving || r.leaving ? 2 : 3;
    return base * 4096 + ((Math.imul(r.seed ^ epoch, 0x9e3779b1) >>> 0) & 4095);
  }

  function inRoom(r, rm) { return rm && r.stop === rm.row && r.x >= rm.x && r.x < rm.x + rm.w; }

  const api = {
    /** @param {import('./world.mjs').Ctx} c */
    update(c) {
      const st = c.state;
      if (!st || !c.layout) return;
      t = c.t; dt = c.dt; frame++;
      const placeAll = c.relaid || !L || L.key !== c.layout.key;
      if (placeAll) relay(c.layout);

      mByKey.clear();
      for (const m of st.machines) mByKey.set(m.modelKey, m);

      // Who is here?
      ids.clear();
      for (const rs of st.residents) ids.add(rs.id);
      for (const id of departed) if (!ids.has(id)) departed.delete(id);
      for (const rs of st.residents) {
        let r = byId.get(rs.id);
        if (!r) {
          if (departed.has(rs.id)) { if (rs.place === 'exit') continue; departed.delete(rs.id); }
          if (rs.place === 'exit') { departed.add(rs.id); continue; }   // finished before we ever saw it
          r = makeResident(rs, placeAll);
        }
        r.rs = rs; r.seenFrame = frame;
      }
      // Leaving: finished (place 'exit', which agent_left events accompany) or vanished from the
      // state (keep its last ResidentState and walk it out). Recomputed every update, so an
      // agent that comes back to work before it is out simply turns around.
      for (const r of list) r.leaving = r.seenFrame !== frame || r.rs.place === 'exit';

      for (const e of c.events) if (e.type === 'limit_reset') resets.push({ scope: e.scope, modelKey: e.modelKey, at: t });
      while (resets.length && t - resets[0].at > 3) resets.shift();

      // Intentions: model switches, cheering, bubble triggers, posts.
      for (const r of list) {
        const rs = r.rs;
        if (r.prevModelKey !== rs.modelKey) {
          if (!placeAll && rs.place === 'control' && !r.leaving && roomByModel.has(rs.modelKey)) {
            r.visit = rs.modelKey; r.visitStart = t; r.visitUntil = Infinity;
          }
          r.prevModelKey = rs.modelKey;
        }
        if (r.visit && (placeAll || r.leaving || rs.place !== 'control' || t - r.visitStart > 30 || !roomByModel.has(r.visit))) r.visit = null;
        if (rs.blocked) r.lastBlockedAt = t;
        else if (r.cheerUntil < t && t - r.lastBlockedAt < 1 && resetAffects(r)) { r.cheerUntil = t + CHEER_TIME; r.lastBlockedAt = -1e9; }
        if (rs.icon !== r.lastIcon || rs.status !== r.lastStatus || rs.blocked !== r.lastBlocked) {
          r.lastIcon = rs.icon; r.lastStatus = rs.status; r.lastBlocked = rs.blocked; r.iconSince = t;
        }
        const want = wantedPool(r);
        if (want !== r.pool) { poolRelease(r); if (want) poolTake(want, r); }
      }
      poolPromote(controlPool); poolPromote(loungePool);
      for (const p of machinePools.values()) poolPromote(p);

      for (const r of list) {
        computeTarget(r);
        if (r.visit && r.tKind === 'visit' && r.arrived && r.mode === 'stand') {
          if (r.visitUntil === Infinity) r.visitUntil = t + VISIT_TIME;
          else if (t >= r.visitUntil) { r.visit = null; computeTarget(r); }
        }
      }

      if (placeAll) {
        for (const r of list) { if (r.leaving) gone(r); else placeAtTarget(r); }
      } else {
        if (car.phase === 'open') exchange();
        buildReq();
        let busy = false;
        if (car.phase === 'open' || car.phase === 'closing') {
          const room = riderCount(car) < CAP;
          for (const r of list) {
            if (r.mode === 'board' || r.mode === 'alight' || (room && mayBoard(r))) { busy = true; break; }
            if (r.mode === 'car' && r.dest === car.at) { busy = true; break; }
          }
        }
        if (stepCar(car, L, dt, req, busy)) finishTransfers();
        for (const r of list) if (!r.gone) move(r);
      }

      // Tidy up and build the draw order (at posts first, people on the move in front).
      let n = 0;
      for (const r of list) if (!r.gone) list[n++] = r;
      list.length = n;
      floorList.length = 0; carList.length = 0; ladderList.length = 0;
      for (const r of list) if (r.mode === 'stand' && r.arrived) computeDrawState(r);
      for (const r of list) if (!(r.mode === 'stand' && r.arrived)) computeDrawState(r);

      items.update(c);
    },

    /** Elevator car, workstation props, residents, token items (all subject to room lighting). */
    drawBack(fb, c) {
      if (!L || c.layout.key !== L.key) return;
      const tt = c.t;
      items.draw(fb, tt);
      // workstation furniture, then the residents on the floors
      for (const r of floorList) {
        if (r.wsX === r.wsX && r.tKind === 'post' && inRoom(r, r.tRoom)) {
          wsOpts.active = r.rs.status === 'working' && !r.rs.blocked;
          wsOpts.facing = r.tFacing; wsOpts.seed = r.seed;
          drawWorkstation(fb, r.wsX, r.tRoom.floorY, r.rs.station, tt, wsOpts);
        }
      }
      for (const r of floorList) drawResident(fb, r.dx, r.dy, tt, setLook(r));
      // the car with its passengers, then anyone on the service ladder
      fb.setClip(0, CLIP_TOP, fb.w, fb.h - CLIP_TOP);
      car.look.door = car.door;
      drawElevatorCar(fb, L.shaft.cx, car.y, tt, car.look);
      for (const r of carList) {
        if (r.stop < 0 && r.mode !== 'car') fb.setClip(L.shaft.cx - G.CAR_W / 2 + 2, CLIP_TOP, G.CAR_W - 4, fb.h);
        drawResident(fb, r.dx, r.dy, tt, setLook(r));
        fb.setClip(0, CLIP_TOP, fb.w, fb.h - CLIP_TOP);
      }
      drawElevatorDoors(fb, L.shaft.cx, car.y, tt, car.look);
      for (const r of ladderList) drawResident(fb, r.dx, r.dy, tt, setLook(r));
      fb.clearClip();
    },

    /** Status bubbles and anything about residents that must stay readable in the dark. */
    drawFront(fb, c) {
      if (!L || c.layout.key !== L.key) return;
      const tt = c.t, epoch = Math.floor(tt / 3);
      selId = c.selection?.type === 'resident' ? c.selection.id : null;
      bub.length = 0;
      for (const r of floorList) if (bubbleShown(r)) bub.push(r);
      // riders packed in the car share one bubble, taking turns
      let riders = 0;
      for (const r of carList) if (r.mode === 'car') riders++;
      let turn = riders ? Math.floor(tt / 1.5) % riders : 0;
      for (const r of carList) {
        if (r.mode === 'car' && turn-- !== 0) continue;
        if (bubbleShown(r)) bub.push(r);
      }
      for (const r of ladderList) if (bubbleShown(r)) bub.push(r);
      for (const r of bub) r.rank = bubbleRank(r, epoch);
      bub.sort((a, b) => a.rank - b.rank);
      // Greedy placement: at head height, else one bubble higher, else wait for its turn.
      let n = 0;
      const W = G.BUBBLE_W + 1, H = G.BUBBLE_H + 3;
      for (const r of bub) {
        const x = Math.floor(r.dx);
        let y = Math.floor(r.dy) - G.RESIDENT_H - 1 + (r.pose === 'sit' ? SIT_DROP : 0);
        y = Math.max(y, H);
        let placed = false;
        for (let lv = 0; lv < 2 && !placed; lv++) {
          const yy = y - lv * H;
          if (yy < H) break;
          let free = true;
          for (let k = 0; k < n; k++) if (Math.abs(bx[k] - x) < W && Math.abs(by[k] - yy) < H) { free = false; break; }
          if (free) { bx[n] = x; by[n] = yy; n++; placed = true; drawBubble(fb, x, yy, bubbleIcon(r), tt, bubbleTone(r)); }
        }
      }
    },

    /** @returns {import('./world.mjs').Pick|null} the top-most resident at (x, y), if any */
    pick(x, y, c) {
      if (!L || c.layout.key !== L.key) return null;
      for (let pass = 0; pass < 2; pass++) {
        const hx = pass ? 7 : 5, top = pass ? G.RESIDENT_H + 2 : G.RESIDENT_H, bot = pass ? 1 : 0;
        for (const lst of [ladderList, carList, floorList]) {
          for (let i = lst.length - 1; i >= 0; i--) {
            const r = lst[i];
            if (!r.vis) continue;
            const cx = Math.floor(r.dx), fy = Math.floor(r.dy);
            if (x >= cx - hx && x < cx + hx && y >= fy - top && y < fy + bot) return { type: 'resident', id: r.id };
          }
        }
      }
      return null;
    },

    /** Bounding box {x, y, w, h} of a resident pick, or null when it is not in the shelter. */
    locate(pick, c) {
      if (!L || !pick || c.layout.key !== L.key) return null;
      const r = byId.get(pick.id);
      if (!r || !r.vis) return null;
      return { x: Math.floor(r.dx) - G.RESIDENT_W / 2, y: Math.floor(r.dy) - G.RESIDENT_H, w: G.RESIDENT_W, h: G.RESIDENT_H };
    },

    /** Diagnostics for tools and tests (not part of the world contract). */
    debug() {
      return {
        car: { at: car.at, y: car.y, phase: car.phase, door: car.door, riders: car.slots.filter(Boolean).map((r) => r.id) },
        residents: list.map((r) => ({
          id: r.id, mode: r.mode, stop: r.stop, x: r.x, y: r.y, vis: r.vis, arrived: r.arrived, leaving: r.leaving,
          tStop: r.tStop, tX: r.tX, tKind: r.tKind, tripStart: r.tripStart, pose: r.pose, pool: r.pool?.kind ?? null, poolIdx: r.poolIdx,
        })),
      };
    },
  };
  lifeDebug.last = api;
  return api;
}
