// Shared geometry of the shelter, in logical pixels. FROZEN: art and world both use it.
//
// A room is a rectangle (x, y, w, h). Its side walls are WALL_T thick and included in
// w; its ceiling is CEIL_T at the top; its floor slab is FLOOR_T at the bottom.
// Residents stand with their feet on the floor line:  floorY = y + h - FLOOR_T.
// "Anchored at (cx, floorY)" always means bottom-centre: the thing occupies
// x in [cx - w/2, cx + w/2) and y in [floorY - h, floorY).

export const ROOM_H = 64;        // every room except the reactor hall
export const REACTOR_H = 80;     // the reactor hall is taller
export const ROOM_W = 208;       // machine rooms
export const HALF_W = 104;       // utility rooms: control, lounge, dock, power
export const WALL_T = 2;
export const CEIL_T = 2;
export const FLOOR_T = 4;
export const SURFACE_H = 32;     // sky + ground strip above the top floor
export const SHAFT_W_FULL = 32;  // elevator shaft between the two columns (full layout)
export const SHAFT_W_COMPACT = 24;
export const DOOR_H = 20;        // doorway opening height in side walls, from the floor up

// --- Machine rooms (ROOM_W x ROOM_H). Offsets are relative to the room's x / y. ---
export const MACHINE_W = 88;
export const MACHINE_H = 48;
export const MACHINE_CX = 104;               // machine centre x in its room
// Workstation cells (16px wide each): three left of the machine, three right.
// A resident stands at the cell centre facing the machine.
export const SLOT_XS = [18, 34, 50, 158, 174, 190];
// Conveyor belts run along the back wall. BELT_Y is the belt's top surface (items sit on it).
export const BELT_Y = 34;                    // room.y + BELT_Y
export const BELT_IN = [WALL_T, 60];         // input belt x-range (left wall -> machine)
export const BELT_OUT = [148, ROOM_W - WALL_T]; // output belt x-range (machine -> right wall)
// Cache recycling loop: a pipe rectangle framing the machine top. Blobs travel around it.
export const LOOP = { x0: 54, x1: 154, y0: 6, y1: 20 };   // corners, relative to room x / y
// In machine-local coordinates (origin = top-left of the 88x48 machine box):
//   input hatch  : left edge,  y 13..22 (belt surface at y = 22)
//   output hatch : right edge, y 13..22
//   loop flanges : both edges, y 6..9

// --- Utility rooms (HALF_W x ROOM_H). x offsets relative to the room's x. ---
export const CONTROL = {
  consoleCx: 78,                 // foreman console (about 44 wide, 26 tall)
  stand: [49, 37, 25, 13],       // where foremen stand, facing right toward the console (spans x 56..100)
};
export const LOUNGE = {
  sofaCx: 34,                    // sofa about 40 wide
  seats: [22, 34, 46],           // sit positions on the sofa
  stand: [66, 78, 90],           // overflow standing spots (near the coffee machine at ~x 84)
};
export const DOCK = {
  hatchCx: 26,                   // freight hatch from the surface (crates drop in here)
  beltY: 44,                     // belt top surface, relative to room y
  belt: [WALL_T, HALF_W - WALL_T],
  chuteCx: 84,                   // wall chute where crates leave toward the machines
};
export const POWER = {
  switchboardCx: 28,             // SWITCHBOARD_W x SWITCHBOARD_H, floor anchored
  generatorCx: 72,               // GENERATOR_W x GENERATOR_H, floor anchored
};
export const SWITCHBOARD_W = 28;
export const SWITCHBOARD_H = 40;
export const GENERATOR_W = 44;
export const GENERATOR_H = 30;

// --- Actors and props ---
export const RESIDENT_W = 10;
export const RESIDENT_H = 20;    // antenna tip to boot soles; drawn with a 1px dark outline around it
export const STATION_W = 16;     // workstation prop cell
export const STATION_H = 26;     // grows with RESIDENT_H so the screen stays just above the head
export const BUBBLE_W = 11;      // status bubble above a resident
export const BUBBLE_H = 11;
export const ITEM = 6;           // crates and packages are 6x6; cache blobs are 4x4
export const CAR_W = 20;         // elevator car
export const CAR_H = 28;
