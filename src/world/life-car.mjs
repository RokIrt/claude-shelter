// The elevator car: one car serving the surface stop (-1) and every row stop (0..n-1).
// Pure motion + scheduling. Who boards and alights is decided by life.mjs, which tells
// the car each update what every stop wants (req) and whether people are still walking
// in or out (busy).
//
// Scheduling is directional collective control (LOOK): keep going in the current direction
// while anything ahead wants the car, stopping for riders who want out and for waiters who
// travel the same way; then turn around. An empty car answers any call. A stop the car can
// no longer brake for is picked up on the way back.

/** Passengers per trip, and where each one stands inside the car (offset from its centre). */
export const CAP = 4;
export const RIDER_DX = [-4, 4, -1, 2];

/** req bits per stop (index s + 1). */
export const OUT = 1, DOWN = 2, UP = 4, CROSS = 8;

const ACC = 420;          // px/s^2
const VMAX_MIN = 120;     // px/s; long shafts get faster cars so a full run stays short
const RUN_TIME = 2.6;     // seconds for a full surface-to-bottom run at cruising speed
const DOOR_T = 0.18;      // seconds to open or close
const MIN_DWELL = 0.2;    // doors stay open at least this long
const MAX_DWELL = 3.5;    // ... and at most this long (stragglers are hurried in or out)

/** Floor line of a stop: -1 is the surface entrance, 0.. are layout rows. */
export const stopY = (L, s) => (s < 0 ? L.surfaceStopY : L.rows[s].floorY);

export function createCar() {
  return {
    at: -1,          // stop the car stands at (-2 while moving)
    target: -1,      // stop it is heading to
    y: 0,            // floor line
    v: 0,            // speed (px/s, magnitude)
    dir: 0,          // +1 down (towards higher stops), -1 up, 0 none
    phase: 'idle',   // idle | moving | opening | open | closing
    door: 0,         // 0 closed .. 1 open
    dwell: 0,
    vmax: VMAX_MIN,
    n: 0,            // number of row stops
    slots: new Array(CAP).fill(null),
    look: { door: 0 },
  };
}

/** Put the car at a stop on (new) geometry, doors closed, empty. */
export function resetCar(car, L) {
  car.n = L.rows.length;
  let s = car.phase === 'moving' ? car.target : car.at;
  if (!(s >= -1 && s < car.n)) s = -1;
  car.at = s; car.target = s; car.y = stopY(L, s);
  car.v = 0; car.dir = 0; car.phase = 'idle'; car.door = 0; car.dwell = 0;
  car.slots.fill(null);
  const span = stopY(L, car.n - 1) - stopY(L, -1);
  car.vmax = Math.max(VMAX_MIN, span / RUN_TIME);
}

export const riderCount = (car) => { let n = 0; for (const r of car.slots) if (r) n++; return n; };

/** Does stop s want the car if it is travelling in direction dir? */
export function wants(car, req, s, dir) {
  const b = req[s + 1];
  if (b & (OUT | CROSS)) return true;
  if (riderCount(car) === 0 || dir === 0) return (b & (UP | DOWN)) !== 0;
  return (b & (dir > 0 ? DOWN : UP)) !== 0;
}

/** Nearest stop ahead in direction dir (0 = either way) that the car can still brake for. */
function nearest(car, L, req, dir, strict) {
  let best = -2, bestD = Infinity;
  const brake = (car.v * car.v) / (2 * ACC);
  for (let s = -1; s < car.n; s++) {
    if (!(strict ? wants(car, req, s, dir) : req[s + 1])) continue;
    const dy = stopY(L, s) - car.y;
    if (dir !== 0 && dy * dir <= 0) continue;
    const d = Math.abs(dy);
    if (d + 0.01 < brake) continue;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/**
 * Advance the car by dt.
 * @param {Uint8Array} req  req[s + 1]: OUT | DOWN | UP | CROSS bits (waiter bits only while there is room)
 * @param {boolean} busy    while open: residents are still walking in / out or about to board
 * @returns {boolean} true when the doors were forced shut while people were still transferring
 */
export function stepCar(car, L, dt, req, busy) {
  switch (car.phase) {
    case 'idle': {
      const here = car.at >= -1 ? req[car.at + 1] : 0;
      if (here && wants(car, req, car.at, car.dir)) { car.phase = 'opening'; break; }
      let s = -2;
      if (car.dir) {
        s = nearest(car, L, req, car.dir, true);
        if (s === -2) s = nearest(car, L, req, car.dir, false);
        // end of the sweep: turn around and serve this stop first
        if (s === -2 && here) { car.dir = 0; car.phase = 'opening'; break; }
        if (s === -2) s = nearest(car, L, req, -car.dir, false);
      }
      if (s === -2) s = nearest(car, L, req, 0, false);
      if (s !== -2) {
        car.target = s;
        car.dir = stopY(L, s) > car.y ? 1 : -1;
        car.at = -2;
        car.phase = 'moving';
      }
      break;
    }
    case 'moving': {
      const s2 = nearest(car, L, req, car.dir, true);
      if (s2 !== -2 && Math.abs(stopY(L, s2) - car.y) < Math.abs(stopY(L, car.target) - car.y)) car.target = s2;
      const ty = stopY(L, car.target), dy = ty - car.y, d = Math.abs(dy);
      const cap = Math.min(car.vmax, Math.sqrt(2 * ACC * d) + 4);
      car.v = Math.min(cap, car.v + ACC * dt);
      const step = car.v * dt;
      if (step >= d || d < 0.25) {
        car.y = ty; car.v = 0; car.at = car.target;
        // the end of a sweep (nothing more ahead): serve whoever is here, whichever way they go
        if (nearest(car, L, req, car.dir, true) === -2) car.dir = 0;
        car.phase = wants(car, req, car.at, car.dir) ? 'opening' : 'idle';
      } else car.y += Math.sign(dy) * step;
      break;
    }
    case 'opening':
      car.door = Math.min(1, car.door + dt / DOOR_T);
      if (car.door >= 1) { car.phase = 'open'; car.dwell = 0; }
      break;
    case 'open':
      car.dwell += dt;
      if ((car.dwell >= MIN_DWELL && !busy) || car.dwell >= MAX_DWELL) {
        car.phase = 'closing';
        return busy;
      }
      break;
    case 'closing':
      if (busy) { car.phase = 'opening'; break; }
      car.door = Math.max(0, car.door - dt / DOOR_T);
      if (car.door <= 0) car.phase = 'idle';
      break;
  }
  return false;
}
