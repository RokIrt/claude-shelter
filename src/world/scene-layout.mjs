// Static, per-layout geometry of the scene: where gauge plates, warning beacons, lit
// signs and junction boxes go in each room, the pick boxes of the pickable things, and
// the power wiring (reactor -> switchboard -> every room) as polylines with arc lengths
// so pulses can travel along them. Built once per Layout (keyed by layout.key).
//
// Wiring topology (no crossings in either layout):
//   FEED  reactor hall -> switchboard. Full: along the hall ceiling, up the right rock
//         margin, in along the power room's cable tray, down into the switchboard top.
//         Compact: straight up from the hall into the switchboard foot.
//   DIST  switchboard -> rooms, leaving the switchboard at both sides.
//         Right tap: to the right margin, then (full) down to the right-column machine
//         rooms, or (compact) up past every machine room into the topsoil and over to the
//         control room and lounge. Left tap: into the dock. Full only: on from the dock
//         up into the topsoil, across over the shaft head to the left margin, then down
//         to the left-column machine rooms; control and lounge drop from the topsoil.
//   GEN   generator -> switchboard (only when a generator is present).
// Every machine room branch runs along its ceiling slab and drops into its gauge plate.
import * as G from '../gfx/geom.mjs';
import { REACTOR_ANCHORS } from '../gfx/power.mjs';
import { loopPath } from './layout.mjs';
import { plateH } from './scene-fx.mjs';

/** Machine-room plate: right edge, top, width (room-relative). 3 lines. */
export const M_PLATE = { right: G.ROOM_W - G.WALL_T - 2, y: 5, w: 47, lines: 3 };
/** Reactor plate, hall-relative, under the hall label. */
export const R_PLATE = { x: 4, y: 13, w: 47, lines: 3 };
/** Session plate in the power room (one row), right-aligned under the ceiling. */
export const S_PLATE = { right: G.HALF_W - G.WALL_T - 1, y: 2, w: 67 };
const DROP_X = G.ROOM_W - 8;            // machine-room branch drops into the plate here
const SOIL_Y = G.SURFACE_H - 3;         // buried run through the topsoil
const UTIL_DROP = 72;                    // control / lounge junction x (room-relative)
const DOCK_JX = G.HALF_W - 8;            // dock junction x (room-relative)

/** A polyline run with cumulative lengths. s0 = arc distance of its start from the net root. */
function run(net, pts, s0 = 0, room = null) {
  const cum = new Float32Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
  return { net, pts, cum, len: cum[pts.length - 1], s0, room };
}

/** Arc distance (from the net root) of a point lying on a run. */
function arcAt(r, x, y) {
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1];
    if (ay === by && y === ay && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)) return r.s0 + r.cum[i] + Math.abs(x - ax);
    if (ax === bx && x === ax && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return r.s0 + r.cum[i] + Math.abs(y - ay);
  }
  return r.s0;
}

/** Point at local arc distance s along a run, written into out[0..1]. */
export function pointOn(r, s, out) {
  const n = r.pts.length;
  let i = 0;
  while (i + 2 < n && r.cum[i + 1] <= s) i++;
  const [ax, ay] = r.pts[i], [bx, by] = r.pts[i + 1];
  const seg = r.cum[i + 1] - r.cum[i];
  const k = seg > 0 ? (s - r.cum[i]) / seg : 0;
  out[0] = Math.round(ax + (bx - ax) * k); out[1] = Math.round(ay + (by - ay) * k);
  return out;
}

/**
 * @param {import('./layout.mjs').Layout} L
 */
export function buildSceneLayout(L) {
  const H = L.reactor, P = L.byId.power, D = L.byId.dock, Ct = L.byId.control, Lg = L.byId.lounge;
  const hcx = H.x + (H.w >> 1), hFloor = H.floorY;
  const sbCx = P.x + G.POWER.switchboardCx, sbFloor = P.floorY;
  const sbBox = { x: sbCx - G.SWITCHBOARD_W / 2, y: sbFloor - G.SWITCHBOARD_H, w: G.SWITCHBOARD_W, h: G.SWITCHBOARD_H };
  const gnCx = P.x + G.POWER.generatorCx;
  const genBox = { x: gnCx - G.GENERATOR_W / 2, y: sbFloor - G.GENERATOR_H, w: G.GENERATOR_W, h: G.GENERATOR_H };
  const coreW = REACTOR_ANCHORS.coreW ?? 56, coreH = REACTOR_ANCHORS.coreH ?? 62;
  const coreBox = { x: hcx - (coreW >> 1), y: hFloor - coreH, w: coreW, h: coreH };
  const rPlate = { x: H.x + R_PLATE.x, y: H.y + R_PLATE.y, w: R_PLATE.w, h: plateH(R_PLATE.lines) };
  const sPlate = { x: P.x + S_PLATE.right - S_PLATE.w + 1, y: P.y + S_PLATE.y, w: S_PLATE.w, h: 9 };

  // ---- per-room spots --------------------------------------------------------------
  const rooms = L.rooms.map((rm, index) => {
    const spot = { rm, index, beacon: null, sign: null, plate: null, machineBox: null, loop: null, cx: 0 };
    if (rm.kind === 'machine') {
      spot.cx = rm.x + G.MACHINE_CX;
      spot.machineBox = { x: spot.cx - G.MACHINE_W / 2, y: rm.floorY - G.MACHINE_H, w: G.MACHINE_W, h: G.MACHINE_H };
      spot.plate = { x: rm.x + M_PLATE.right - M_PLATE.w + 1, y: rm.y + M_PLATE.y, w: M_PLATE.w, h: plateH(M_PLATE.lines) };
      spot.beacon = [rm.x + DROP_X, rm.y + M_PLATE.y + plateH(M_PLATE.lines) + 3];
      spot.sign = { x: spot.cx, y: rm.floorY - 31, align: 'center' };
      spot.limit = { x: rm.x + 6, y: rm.y + 15 };
      spot.loop = loopPath(rm);
    } else if (rm.kind === 'reactor') {
      spot.cx = hcx;
      spot.plate = rPlate;
    } else if (rm.kind === 'power') {
      spot.beacon = [rm.x + 8, rm.y + 18];
      spot.sign = { x: rm.x + rm.w - 4, y: rm.y + 21, align: 'right' };
      spot.plate = sPlate;
    } else {
      spot.beacon = [rm.x + rm.w - 9, rm.y + 9];
      spot.sign = { x: rm.x + rm.w - 4, y: rm.y + 15, align: 'right' };
    }
    return spot;
  });
  const byId = Object.fromEntries(rooms.map((s) => [s.rm.id, s]));

  // ---- wiring ------------------------------------------------------------------------
  const runs = [];
  const boxes = [];          // junction boxes: [x, y, kind] kind: 'wall' | 'ceil' | 'clamp'
  const tapY = P.y + 28;
  const sbL = sbBox.x - 1, sbR = sbBox.x + sbBox.w;
  const machineRooms = L.rooms.filter((r) => r.kind === 'machine');
  const branch = (trunk, x, rm) => {
    const pts = [[x, rm.y], [rm.x + DROP_X, rm.y], [rm.x + DROP_X, rm.y + M_PLATE.y - 1]];
    runs.push(run('dist', pts, arcAt(trunk, x, rm.y), rm.id));
  };
  const drop = (trunk, rm) => {
    const x = rm.x + UTIL_DROP;
    runs.push(run('dist', [[x, SOIL_Y], [x, rm.y + 3]], arcAt(trunk, x, SOIL_Y), rm.id));
    boxes.push([x, rm.y + 3, 'ceil']);
  };

  if (L.mode === 'full') {
    const feedX = L.w - 4, distX = L.w - 10, leftX = 8;
    runs.push(run('feed', [[hcx + 34, H.y], [feedX, H.y], [feedX, P.y + 12], [sbCx, P.y + 12], [sbCx, sbBox.y - 1]]));
    boxes.push([hcx + 34, H.y + 1, 'clamp']);
    const right = machineRooms.filter((r) => r.side === 1).sort((a, b) => a.y - b.y);
    const left = machineRooms.filter((r) => r.side === -1).sort((a, b) => a.y - b.y);
    if (right.length) {
      const r0 = run('dist', [[sbR, tapY], [distX, tapY], [distX, right[right.length - 1].y]]);
      runs.push(r0);
      for (const rm of right) branch(r0, distX, rm);
    }
    const lastLeft = left.length ? left[left.length - 1].y : Ct.y;
    const l0 = run('dist', [[sbL, tapY], [D.x + DOCK_JX, tapY], [D.x + DOCK_JX, SOIL_Y], [leftX, SOIL_Y], [leftX, lastLeft]]);
    runs.push(l0);
    boxes.push([D.x + DOCK_JX, tapY, 'wall']);
    drop(l0, Lg); drop(l0, Ct);
    for (const rm of left) branch(l0, leftX, rm);
  } else {
    const rightX = L.w - 2;
    runs.push(run('feed', [[P.x + 36, H.y + 14], [P.x + 36, sbFloor]]));
    boxes.push([P.x + 36, H.y + 14, 'wall']);
    const r0 = run('dist', [[sbR, tapY], [rightX, tapY], [rightX, SOIL_Y], [Ct.x + UTIL_DROP, SOIL_Y], [Ct.x + UTIL_DROP, Ct.y + 3]], 0, null);
    runs.push(r0);
    boxes.push([Ct.x + UTIL_DROP, Ct.y + 3, 'ceil']);
    drop(r0, Lg);
    for (const rm of machineRooms) branch(r0, rightX, rm);
    runs.push(run('dist', [[sbL, tapY], [D.x + DOCK_JX, tapY]]));
    boxes.push([D.x + DOCK_JX, tapY, 'wall']);
  }
  const gen = run('gen', [[genBox.x - 1, P.y + 50], [sbR, P.y + 50]]);

  return {
    key: L.key, rooms, byId, runs, gen, boxes,
    sbCx, sbFloor, sbBox, gnCx, genBox, coreBox, hcx, hFloor, rPlate, sPlate,
    machineRooms: rooms.filter((s) => s.rm.kind === 'machine'),
  };
}
