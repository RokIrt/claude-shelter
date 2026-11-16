// Where every room sits. Pure geometry shared by the scene and the residents.
// FROZEN: scene.mjs and life.mjs both depend on it.
import * as G from '../gfx/geom.mjs';

/**
 * @typedef {Object} Room
 * @property {string} id        'control' | 'lounge' | 'dock' | 'power' | 'reactor' | 'machine:<modelKey>'
 * @property {'control'|'lounge'|'dock'|'power'|'machine'|'reactor'} kind
 * @property {string|null} modelKey   for machine rooms
 * @property {number} x @property {number} y @property {number} w @property {number} h
 * @property {number} floorY    y of the floor line (feet)
 * @property {number} row       index into layout.rows; -1 for the reactor hall (no elevator stop)
 * @property {-1|1} side        -1: left of the shaft, 1: right of the shaft
 * @property {boolean} doorL @property {boolean} doorR   doorways through the side walls
 */

/**
 * @typedef {Object} Row   one elevator stop
 * @property {number} index
 * @property {number} y @property {number} floorY
 * @property {Room[]} left    rooms left of the shaft, nearest the shaft first
 * @property {Room[]} right   rooms right of the shaft, nearest the shaft first
 */

/**
 * @typedef {Object} Layout
 * @property {'full'|'compact'} mode
 * @property {number} w @property {number} h          logical size of the whole world
 * @property {{x:number,y:number,w:number,h:number}} surface
 * @property {{x:number,y:number,w:number,h:number,cx:number}} shaft   cx: centre line the car rides on
 * @property {number} surfaceStopY   car floor line when it is up at the surface entrance
 * @property {Row[]} rows
 * @property {Room[]} rooms          every room including the reactor hall
 * @property {Object<string, Room>} byId
 * @property {Room} reactor
 * @property {string} key            changes whenever the geometry changes (cache key)
 */

function room(id, kind, x, y, w, h, row, side, doorL, doorR, modelKey = null) {
  return { id, kind, modelKey, x, y, w, h, floorY: y + h - G.FLOOR_T, row, side, doorL, doorR };
}

/**
 * Lay the shelter out.
 * full:    two columns, 480 wide. Top row: control, lounge | shaft | dock, power.
 *          Then machine rooms two per row, then the reactor hall across the full width.
 * compact: one column, 240 wide, shaft on the left. Top row: control, lounge; one
 *          machine room per row; then dock, power; then the reactor hall.
 * @param {'full'|'compact'} mode
 * @param {string[]} modelKeys machine order (ShelterState.machines order)
 * @returns {Layout}
 */
export function computeLayout(mode, modelKeys) {
  const keys = modelKeys.length ? modelKeys : ['fable', 'opus', 'sonnet', 'haiku'];
  const rooms = [], rows = [];
  const top = G.SURFACE_H;
  const addRow = (index) => { const y = top + index * G.ROOM_H; const r = { index, y, floorY: y + G.ROOM_H - G.FLOOR_T, left: [], right: [] }; rows.push(r); return r; };
  let w, shaft, reactor;

  if (mode === 'compact') {
    w = 240;
    const sx = 4, rx = sx + G.SHAFT_W_COMPACT;                     // rooms start at x = 28
    let r = addRow(0);
    r.right.push(room('control', 'control', rx, r.y, G.HALF_W, G.ROOM_H, 0, 1, true, true));
    r.right.push(room('lounge', 'lounge', rx + G.HALF_W, r.y, G.HALF_W, G.ROOM_H, 0, 1, true, false));
    keys.forEach((key, i) => {
      r = addRow(1 + i);
      r.right.push(room(`machine:${key}`, 'machine', rx, r.y, G.ROOM_W, G.ROOM_H, r.index, 1, true, false, key));
    });
    r = addRow(1 + keys.length);
    r.right.push(room('dock', 'dock', rx, r.y, G.HALF_W, G.ROOM_H, r.index, 1, true, true));
    r.right.push(room('power', 'power', rx + G.HALF_W, r.y, G.HALF_W, G.ROOM_H, r.index, 1, true, false));
    const bottom = top + rows.length * G.ROOM_H;
    shaft = { x: sx, y: top, w: G.SHAFT_W_COMPACT, h: bottom - top, cx: sx + G.SHAFT_W_COMPACT / 2 };
    reactor = room('reactor', 'reactor', sx, bottom, G.SHAFT_W_COMPACT + G.ROOM_W, G.REACTOR_H, -1, 1, false, false);
  } else {
    w = 480;
    const lx = 16, sx = lx + G.ROOM_W, rx = sx + G.SHAFT_W_FULL;   // 16 | 224 | 256
    let r = addRow(0);
    r.left.push(room('lounge', 'lounge', lx + G.HALF_W, r.y, G.HALF_W, G.ROOM_H, 0, -1, true, true));
    r.left.push(room('control', 'control', lx, r.y, G.HALF_W, G.ROOM_H, 0, -1, false, true));
    r.right.push(room('dock', 'dock', rx, r.y, G.HALF_W, G.ROOM_H, 0, 1, true, true));
    r.right.push(room('power', 'power', rx + G.HALF_W, r.y, G.HALF_W, G.ROOM_H, 0, 1, true, false));
    keys.forEach((key, i) => {
      if (i % 2 === 0) r = addRow(1 + (i >> 1));
      if (i % 2 === 0) r.left.push(room(`machine:${key}`, 'machine', lx, r.y, G.ROOM_W, G.ROOM_H, r.index, -1, false, true, key));
      else r.right.push(room(`machine:${key}`, 'machine', rx, r.y, G.ROOM_W, G.ROOM_H, r.index, 1, true, false, key));
    });
    const bottom = top + rows.length * G.ROOM_H;
    shaft = { x: sx, y: top, w: G.SHAFT_W_FULL, h: bottom - top, cx: sx + G.SHAFT_W_FULL / 2 };
    reactor = room('reactor', 'reactor', lx, bottom, G.ROOM_W * 2 + G.SHAFT_W_FULL, G.REACTOR_H, -1, 1, false, false);
  }

  for (const r of rows) rooms.push(...r.left, ...r.right);
  rooms.push(reactor);
  const byId = Object.fromEntries(rooms.map((r) => [r.id, r]));
  return {
    mode: mode === 'compact' ? 'compact' : 'full',
    w, h: reactor.y + reactor.h + 8,
    surface: { x: 0, y: 0, w, h: G.SURFACE_H },
    shaft, surfaceStopY: G.SURFACE_H - 2,
    rows, rooms, byId, reactor,
    key: `${mode}:${keys.join(',')}`,
  };
}

/** The machine room of a model, or null. */
export const machineRoom = (layout, modelKey) => layout.byId[`machine:${modelKey}`] ?? null;

/**
 * Belt and item speed in pixels per second for a machine (MachineState). Both the belt
 * treads (scene) and the items riding them (life) must use this so they move together.
 */
export const beltSpeed = (m) => (m && m.powered ? 6 + 22 * m.speed : 0);

/**
 * The cache recycling loop of a machine room as a closed polyline (absolute points),
 * leaving the machine's right flange, going up and over, and re-entering on the left.
 */
export function loopPath(rm) {
  const { x0, x1, y0, y1 } = G.LOOP;
  const mx0 = rm.x + G.MACHINE_CX - G.MACHINE_W / 2, mx1 = rm.x + G.MACHINE_CX + G.MACHINE_W / 2;
  return [[mx1, rm.y + y1], [rm.x + x1, rm.y + y1], [rm.x + x1, rm.y + y0], [rm.x + x0, rm.y + y0], [rm.x + x0, rm.y + y1], [mx0, rm.y + y1]];
}
