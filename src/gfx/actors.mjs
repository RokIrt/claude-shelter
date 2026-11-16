// Actors and small props: residents, workstations, status bubbles, token items.
//
// Residents are small boxy robots: a rounded monitor for a head (the dark screen shows
// a pixel face), a stubby antenna, a torso in the uniform colour of their model, dark
// hose arms and legs with bright gloves and coloured boots. Everything is built once
// as small indexed sprites (recoloured per uniform and cached lazily); per frame a
// resident costs two or three tiny blits plus a dozen face pixels.
//
// No DOM, no Node, no Math.random, no Date: animation comes from `t`, variety from
// hash() and the resident's seed.
import { C } from './palette.mjs';
import { Framebuffer, sprite, hash } from './fb.mjs';
import { RESIDENT_W, RESIDENT_H, STATION_W, STATION_H, BUBBLE_W, BUBBLE_H } from './geom.mjs';

/** Uniform colours per model key; unknown keys fall back to `generic`. [main, shade, trim] */
export const UNIFORMS = {
  fable:   [C.VIOLET, C.VIOLET_D, C.CYAN],
  opus:    [C.COPPER, C.COPPER_D, C.BRASS],
  sonnet:  [C.BLUE, C.BLUE_D, C.SKY],
  haiku:   [C.GREEN, C.GREEN_D, C.MINT],
  generic: [C.STEEL, C.STEEL_D, C.STEEL_LL],
};

/** Every icon name drawIcon / drawBubble understands. */
export const ICONS = ['code', 'doc', 'search', 'check', 'shell', 'plan', 'think', 'web', 'delegate', 'wait', 'zzz', 'alert', 'fire', 'power', 'done', 'hello'];

// ---------------------------------------------------------------------------------
// Sprite plumbing
// ---------------------------------------------------------------------------------

// Placeholder indices that the art never uses for real; swapped for [main, shade, trim].
const P_MAIN = C.MAGENTA, P_SHADE = C.GRASS_D, P_TRIM = C.GRASS;

const KEY = {
  K: C.INK, D: C.STEEL_DD, d: C.STEEL_D, s: C.STEEL, g: C.STEEL_L, W: C.STEEL_LL, w: C.WHITE,
  k: C.NIGHT_D,
  M: P_MAIN, S: P_SHADE, T: P_TRIM,
  Y: C.HAZARD, y: C.AMBER, L: C.CREAM, a: C.AMBER_L, A: C.AMBER_D,
  R: C.RED, r: C.RED_L, o: C.ORANGE,
  G: C.GREEN, n: C.GREEN_L, N: C.GREEN_D, u: C.GREEN_DD, i: C.MINT,
  B: C.BRASS, e: C.LEATHER, O: C.WOOD, c: C.CRATE, p: C.PACKAGE, t: C.TAN,
  x: C.GLASS, X: C.GLASS_L, C: C.CYAN, l: C.CYAN_L, b: C.BLUE, v: C.BLUE_D, V: C.VIOLET, z: C.TEAL,
  F: C.WALL_D,
};

const FLIP = { flipX: true };

/** A recoloured copy of a sprite for one [main, shade, trim] triple, built once. */
function tinted(spr, cols) {
  const key = cols[0] | (cols[1] << 6) | (cols[2] << 12);
  let cache = spr.tints;
  if (!cache) cache = spr.tints = new Map();
  let out = cache.get(key);
  if (!out) {
    const data = new Uint8Array(spr.data.length);
    for (let i = 0; i < data.length; i++) {
      const c = spr.data[i];
      data[i] = c === P_MAIN ? cols[0] : c === P_SHADE ? cols[1] : c === P_TRIM ? cols[2] : c;
    }
    out = { w: spr.w, h: spr.h, data };
    cache.set(key, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Residents
// ---------------------------------------------------------------------------------

// Sprite canvas: the 10x20 box plus a 2px margin left, right and above (for raised
// arms and held props). Art is drawn facing right; facing left is a flipX blit.
// Canvas rows: antenna 2-3, head 4-9, torso 10-13, hips 14, legs 15-19, boots 20-21.
const CW = RESIDENT_W + 4, CH = RESIDENT_H + 2;

/** How far a seated resident's torso and head drop (the sofa seat is 6px high). */
export const SIT_DROP = 5;
const BLANK = '.'.repeat(CW);

/** Body frame: `rows` start at canvas row `top`; everything else is transparent. */
function body(top, rows) {
  const all = [];
  for (let y = 0; y < CH; y++) all.push(rows[y - top] ?? BLANK);
  return sprite(all, KEY);
}

// Heads: 14 wide, 8 tall (2 antenna rows + 6 head rows), blitted at canvas row 2.
// The screen is the 6x4 block of `k` at columns 4..9, rows 3..6.
const HEADS = {
  operator: sprite([
    '......T.......',
    '......s.......',
    '....wwwwww....',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '....gggggg....',
  ], KEY),
  // yellow hard hat
  foreman: sprite([
    '.....YYYY.....',
    '....YLYYYy....',
    '...yYYYYYYYy..',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '....gggggg....',
  ], KEY),
  // headset: band, ear cups, boom mic with a red tip
  programmer: sprite([
    '......T.......',
    '....DDDDDD....',
    '...DwwwwwwD...',
    '..DWkkkkkkWD..',
    '..DWkkkkkkWD..',
    '...WkkkkkkWD..',
    '...WkkkkkkWr..',
    '....gggggg....',
  ], KEY),
  // head-lamp on a leather strap (the lens is lit in drawResident)
  researcher: sprite([
    '......T.......',
    '......s..dd...',
    '....eeeeedLd..',
    '...WkkkkkkWd..',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '....gggggg....',
  ], KEY),
  // green eyeshade with a translucent peak
  reviewer: sprite([
    '......T.......',
    '......s.......',
    '....GGGGGGnn..',
    '...WkkkkkkWnn.',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '...WkkkkkkW...',
    '....gggggg....',
  ], KEY),
};

// Faces: 6x4 maps for the screen. E = eye, m = mouth / brow (dimmer), r = red.
// `shut` is the blink frame, `alt` an occasional second frame (see drawResident).
const FACES = {
  neutral: { open: ['......', '.E..E.', '.E..E.', '......'], shut: ['......', '......', '.E..E.', '......'] },
  happy:   { open: ['.E..E.', '......', '.m..m.', '..mm..'], shut: ['......', '.E..E.', 'E.EE.E', '......'] },
  focused: { open: ['......', '.EE.EE', '..E..E', '......'], shut: ['......', '.EE.EE', '......', '......'] },
  sleepy:  { open: ['......', '......', 'E.EE.E', '.E..E.'], shut: ['......', '......', 'EE..EE', '......'] },
  worried: { open: ['......', '.E..E.', 'E....E', '.m.m..'], shut: ['......', '......', 'E....E', '.m.m..'], alt: ['......', '.E..E.', 'E....E', '..m.m.'] },
  shocked: { open: ['EE..EE', 'EE..EE', '..rr..', '..rr..'], shut: ['EE..EE', 'EE..EE', '..rr..', '..rr..'], alt: ['EE..EE', 'EE..EE', '......', '..rr..'] },
};
// How far each face may shift sideways (eyes glancing) without leaving the screen.
for (const f of Object.values(FACES)) {
  let lo = 5, hi = 0;
  for (const row of f.open) for (let i = 0; i < 6; i++) if (row[i] !== '.') { if (i < lo) lo = i; if (i > hi) hi = i; }
  f.lo = -lo; f.hi = 5 - hi;
}
// [eye, mouth] colours per mood.
const FACE_COLS = {
  happy: [C.MINT, C.GREEN_L], neutral: [C.CYAN_L, C.CYAN], focused: [C.CYAN_L, C.CYAN],
  sleepy: [C.TEAL, C.TEAL], worried: [C.AMBER_L, C.AMBER], shocked: [C.WHITE, C.RED_L],
};
// Mood used when the caller gives none.
const POSE_MOOD = { work: 'focused', read: 'focused', inspect: 'focused', sit: 'sleepy', panic: 'shocked', cheer: 'happy' };

// --- Body frames (torso, arms, legs, boots). Rows are canvas rows; see body(). ---
// Standing legs (canvas rows 14-21): shade hips, steel legs with knee joints, boots.
const LEGS = [
  '....SSSSSS....',
  '....ss..ss....',
  '....ss..ss....',
  '....gs..gs....',
  '....ss..ss....',
  '....ss..ss....',
  '....MMM.MMM...',
  '....SSS.SSS...',
];
const B_IDLE = body(10, [
  '...dMMMMMMd...',
  '...dMMMMTMd...',
  '...dMMMMMMd...',
  '...TSSSSSST...',
  ...LEGS,
]);
const B_RIDE = body(10, [
  '...dMMMMMMd...',
  '...dMMMMTMd...',
  '...dMMMMMMd...',
  '...TSSSSSST...',
  '....SSSSSS....',
  '.....ssss.....',
  '.....ssss.....',
  '.....gssg.....',
  '.....ssss.....',
  '.....ssss.....',
  '.....MMMMM....',
  '.....SSSSS....',
]);
// Walk: contact frames sit 1px low with the legs spread and the arms swinging, passing
// frames stand tall with one foot lifted. The far leg wears the shade-coloured boot.
const walkContact = (back, front) => body(11, [
  '...dMMMMMMd...',
  '..d.MMMMTM.d..',
  '..T.MMMMMM..T.',
  '....SSSSSS....',
  '....SSSSSS....',
  '....ss..ss....',
  '...ss....ss...',
  '...ss....ss...',
  '..ss......ss..',
  '..ss......ss..',
  `.${back}${back}${back}......${front}${front}${front}.`,
]);
const walkPassing = (lifted, planted) => body(10, [
  '...dMMMMMMd...',
  '...dMMMMTMd...',
  '...dMMMMMMd...',
  '...TSSSSSST...',
  '....SSSSSS....',
  '.....ssss.....',
  '.....ss.ss....',
  '.....ss..ss...',
  '.....ss..ss...',
  '.....ss.ss....',
  `.....ss.${lifted}${lifted}${lifted}...`,
  `.....${planted}${planted}${planted}......`,
]);
const B_WALK = [walkContact('S', 'M'), walkPassing('S', 'M'), walkContact('M', 'S'), walkPassing('M', 'S')];
const B_WORK = [
  body(10, [
    '...dMMMMMMdT..',
    '...dMMMMTMddT.',
    '...dMMMMMM....',
    '...dSSSSSS....',
    ...LEGS,
  ]),
  body(10, [
    '...dMMMMMMddT.',
    '...dMMMMTMdT..',
    '...dMMMMMM....',
    '...dSSSSSS....',
    ...LEGS,
  ]),
];
const B_READ = body(10, [
  '...dMMMMMMd...',
  '...dMMMMTM....',
  '...dMMMMMM....',
  '...TSSSSSS....',
  ...LEGS,
]);
// Held document (two frames: the text lines swap when a page is turned).
const O_READ = [
  body(7, [
    '..........www.',
    '..........wgw.',
    '..........www.',
    '..........wgw.',
    '..........TwT.',
  ]),
  body(6, [
    '...........ww.',
    '..........www.',
    '..........wgw.',
    '..........wgw.',
    '..........www.',
    '..........TwT.',
  ]),
];
const B_INSPECT = body(9, [
  '..d...........',
  '.OwwdMMMMMMdT.',
  '.OwgTMMMMTMd..',
  '.OOO.MMMMMMd..',
  '.....SSSSSS...',
  '.....SSSSSS...',
  '.....ss..ss...',
  '.....ss..ss...',
  '.....gs..gs...',
  '.....ss..ss...',
  '.....ss..ss...',
  '.....MMM.MMM..',
  '.....SSS.SSS..',
]);
// Hand lens for inspecting away from a bench; at the inspection station the bench's
// own magnifier arm hangs in the same spot, so the two line up.
const O_INSPECT = body(6, [
  '...........BB.',
  '..........BXXB',
  '..........BXXB',
  '...........BB.',
]);
// Seated: the torso drops SIT_DROP rows onto the cushion, thighs forward, shins down.
// Frame 0 flicks a toe up.
const B_SIT = [
  body(10 + SIT_DROP, [
    '...dMMMMMMd...',
    '...dMMMMTMd...',
    '...dMMMMMMd...',
    '...TSSSSSSsss.',
    '...........ss.',
    '...........sM.',
    '..........MM.M',
  ]),
  body(10 + SIT_DROP, [
    '...dMMMMMMd...',
    '...dMMMMTMd...',
    '...dMMMMMMd...',
    '...TSSSSSSsss.',
    '...........ss.',
    '...........ss.',
    '..........MMMM',
  ]),
];
const B_PANIC = [
  body(5, [
    '.T............',
    '..d...........',
    '..d.........T.',
    '..d........d..',
    '...d......d...',
    '....MMMMMM....',
    '....MMMMTM....',
    '....MMMMMM....',
    '....SSSSSS....',
  ]),
  body(5, [
    '............T.',
    '...........d..',
    '.T.........d..',
    '..d........d..',
    '...d......d...',
    '....MMMMMM....',
    '....MMMMTM....',
    '....MMMMMM....',
    '....SSSSSS....',
  ]),
];
const B_CHEER = [
  body(6, [
    '.T..........T.',
    '..d........d..',
    '..d........d..',
    '...d......d...',
    '....MMMMMM....',
    '....MMMMTM....',
    '....MMMMMM....',
    '....SSSSSS....',
    ...LEGS,
  ]),
  body(5, [
    '..T........T..',
    '..d........d..',
    '..d........d..',
    '..d........d..',
    '...d......d...',
    '....MMMMMM....',
    '....MMMMTM....',
    '....MMMMMM....',
    '....SSSSSS....',
    '....SSSSSS....',
    '....ss..ss....',
    '....ss..ss....',
    '...gs....sg...',
    '...ss....ss...',
    '...ss....ss...',
    '..MMM....MMM..',
    '..SSS....SSS..',
  ]),
];
// Running legs for panic (drawn under the torso frames above), canvas rows 14-21.
const runSpread = (back, front) => body(14, [
  '....SSSSSS....',
  '....ss..ss....',
  '...ss....ss...',
  '...ss....ss...',
  '..ss......ss..',
  '..ss......ss..',
  `.${back}${back}........${front}${front}.`,
  `.${back}${back}........${front}${front}.`,
]);
const runTuck = (lifted, planted) => body(14, [
  '....SSSSSS....',
  '.....ssss.....',
  '.....ss.ss....',
  '.....ss..ss...',
  '.....ss..ss...',
  `.....ss..${lifted}${lifted}...`,
  '.....ss.......',
  `.....${planted}${planted}${planted}......`,
]);
const B_RUN = [runSpread('S', 'M'), runTuck('M', 'S'), runSpread('M', 'S'), runTuck('S', 'M')];

/**
 * @typedef {Object} ResidentLook
 * @property {'foreman'|'programmer'|'researcher'|'reviewer'|'operator'} role
 *   foreman wears a hard hat; the others differ by a small accessory: programmer a headset,
 *   researcher a head-lamp, reviewer a green eyeshade and checklist badge, operator nothing.
 * @property {'idle'|'walk'|'work'|'read'|'inspect'|'sit'|'panic'|'cheer'|'ride'} pose
 *   idle    standing, occasional blink / look around
 *   walk    2-4 frame walk cycle (advance with t)
 *   work    operating a terminal or lever: arms forward, typing bob
 *   read    holding a document, head tilting
 *   inspect leaning in with a magnifier / clipboard: the hand lens is drawn exactly where
 *           the inspection bench hangs its own lens, so at a bench the two coincide
 *   sit     seated on the lounge sofa (draw so feet still rest at floorY; body 3px lower):
 *           torso and head drop 3px, the legs fold forward and the boots rest on floorY
 *   panic   arms up, running in place (fire / emergency)
 *   cheer   arms up happily (after a reset / repair)
 *   ride    standing still inside the elevator
 * @property {1|-1} facing   1 = facing right, -1 = facing left
 * @property {string} uniform  key into UNIFORMS (the agent's model key)
 * @property {[number, number, number]} [colors] explicit [main, shade, trim] overriding uniform
 * @property {'happy'|'neutral'|'focused'|'sleepy'|'worried'|'shocked'} [mood]  face expression
 * @property {number} [seed]  per-resident integer so blinks and bobbing are not synchronised
 */

// Each resident is painted into this scratch buffer, outlined, then blitted. PAD leaves
// room for the outline, the cheer hop (2px up) and the panic sway (1px sideways).
const PAD = 3;
const SCR = new Framebuffer(CW + 2 * PAD, CH + 2 * PAD);
const SCR_SPRITE = { w: SCR.w, h: SCR.h, data: SCR.buf };
const SCR_MARK = new Uint8Array(SCR.buf.length);

/** A 1px INK rim around everything opaque in the scratch buffer (4-neighbour). */
function outlineScratch() {
  const { w, h, buf } = SCR;
  for (let i = 0; i < buf.length; i++) SCR_MARK[i] = buf[i] !== 0 ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (SCR_MARK[i]) continue;
      if ((x > 0 && SCR_MARK[i - 1]) || (x < w - 1 && SCR_MARK[i + 1]) || (y > 0 && SCR_MARK[i - w]) || (y < h - 1 && SCR_MARK[i + w])) buf[i] = C.INK;
    }
  }
}

/**
 * Draw one resident, RESIDENT_W x RESIDENT_H (10x20), anchored bottom-centre at (cx, floorY),
 * with a 1px dark outline so it reads against busy rooms (the rim under the boots doubles as
 * a contact shadow). Residents are small robot workers with a screen face showing their mood.
 */
export function drawResident(fb, cx, floorY, t, r) {
  cx = Math.floor(cx); floorY = Math.floor(floorY);
  const x0 = cx - (CW >> 1) - PAD, y0 = floorY - CH - PAD;
  SCR.clear(0);
  paintResident(SCR, cx - x0, floorY - y0, t, r);
  outlineScratch();
  fb.blit(SCR_SPRITE, x0, y0);
}

function paintResident(fb, cx, floorY, t, r) {
  const cols = r.colors ?? UNIFORMS[r.uniform] ?? UNIFORMS.generic;
  const seed = (r.seed ?? 0) | 0;
  const flip = r.facing < 0;
  const opt = flip ? FLIP : undefined;
  const ph = hash(seed, 71);                 // 0..1 personal phase
  const pose = r.pose;
  const mood = FACES[r.mood] ? r.mood : (POSE_MOOD[pose] ?? 'neutral');
  const face = FACES[mood], fc = FACE_COLS[mood];
  const blink = ((t + ph * 9) % (2.6 + hash(seed, 5) * 2.4)) < 0.14;

  // Pose state, all in facing-right canvas space.
  let b = B_IDLE, under = null, over = null;
  let ox = 0, oy = 0;        // whole-figure offset
  let hx = 0, hy = 0;        // extra head offset
  let tx = 0, ty = 0;        // where the torso sits relative to the idle frame
  let look = 0;              // eye shift: +1 toward facing, -1 back

  switch (pose) {
    case 'walk': {
      const f = Math.floor(t * 8 + ph * 4) & 3;
      b = B_WALK[f];
      hy = ty = (f & 1) ? 0 : 1;
      look = 1;
      break;
    }
    case 'work': {
      b = B_WORK[Math.floor(t * 7 + ph * 2) & 1];
      hx = 1;
      hy = (Math.floor(t * 1.2 + ph * 3) % 3 === 0) ? 1 : 0;     // nod at the screen
      look = 1;
      break;
    }
    case 'read': {
      const c = (t * 0.3 + ph) % 1;
      b = B_READ; over = O_READ[c > 0.92 ? 1 : 0];
      hy = (t * 0.45 + ph) % 1 < 0.5 ? 0 : 1;                    // head follows the lines
      look = 1;
      break;
    }
    case 'inspect': {
      b = B_INSPECT; over = O_INSPECT;
      tx = 1;
      hx = ((t * 0.3 + ph) % 1) < 0.78 ? 1 : 0;                  // lean in, now and then lean back
      look = 1;
      break;
    }
    case 'sit': {
      b = B_SIT[((t * 0.5 + ph) % 1) < 0.25 ? 0 : 1];            // wiggles a toe
      hy = ty = SIT_DROP;
      if (mood === 'sleepy') hy += ((t * 0.3 + ph) % 1) < 0.55 ? 0 : 1;   // nodding off
      break;
    }
    case 'panic': {
      const f = Math.floor(t * 10 + ph * 4);
      b = B_PANIC[(f >> 1) & 1];
      under = B_RUN[f & 3];
      ox = (f & 3) === 1 ? 1 : (f & 3) === 3 ? -1 : 0;
      hy = (f & 1) ? 0 : 1;
      break;
    }
    case 'cheer': {
      const c = (t * 1.6 + ph) % 1;
      const up = c < 0.5;
      b = B_CHEER[up ? 1 : 0];
      oy = up ? (c > 0.12 && c < 0.38 ? -2 : -1) : 0;
      break;
    }
    case 'ride':
      b = B_RIDE;
      break;
    default: {
      // idle: slow breathing bob and an occasional look around.
      hy = ((t * 0.4 + ph) % 1) < 0.35 ? 1 : 0;
      const la = (t * 0.17 + ph * 3) % 1;
      look = la < 0.08 ? -1 : la < 0.5 ? 0 : la < 0.62 ? 1 : 0;
    }
  }

  // Canvas column c (facing-right space) lands on screen x = X0 + c, or mirrored X1 - c.
  const X0 = cx - (CW >> 1) + ox, X1 = cx + (CW >> 1) - 1 - ox;
  const bx = flip ? X1 - (CW - 1) : X0;
  const by = floorY - CH + oy;
  if (under) fb.blit(tinted(under, cols), bx, by, opt);
  fb.blit(tinted(b, cols), bx, by, opt);
  const role = HEADS[r.role] ? r.role : 'operator';
  fb.blit(tinted(HEADS[role], cols), bx + (flip ? -hx : hx), by + 2 + hy, opt);

  // Antenna lamp: a slow heartbeat, an alarm flicker when shocked, dim when dozing.
  if (role !== 'foreman') {
    let lamp = -1;
    if (mood === 'shocked') lamp = Math.floor(t * 8 + ph * 2) & 1 ? C.RED_L : C.YELLOW;
    else if (mood === 'sleepy') lamp = cols[1];
    else if (((t + ph * 5) % 2.2) < 0.12) lamp = C.WHITE;
    if (lamp >= 0) { const c = 6 + hx; fb.px(flip ? X1 - c : X0 + c, by + 2 + hy, lamp); }
  }

  // Researcher's head-lamp: bright while reading, off while dozing.
  if (role === 'researcher') {
    const c = 10 + hx, lens = mood === 'sleepy' ? C.AMBER_D : pose === 'read' ? C.YELLOW : C.CREAM;
    fb.px(flip ? X1 - c : X0 + c, by + 4 + hy, lens);
    if (pose === 'read' && mood !== 'sleepy') fb.px(flip ? X1 - c - 1 : X0 + c + 1, by + 4 + hy, C.AMBER_L);
  }

  // Reviewer's checklist badge on the chest.
  if (role === 'reviewer') {
    const c = 5 + tx, y = by + 10 + ty;
    fb.px(flip ? X1 - c : X0 + c, y, C.WHITE); fb.px(flip ? X1 - c - 1 : X0 + c + 1, y, C.WHITE);
    fb.px(flip ? X1 - c : X0 + c, y + 1, C.WHITE); fb.px(flip ? X1 - c - 1 : X0 + c + 1, y + 1, C.GREEN_L);
  }

  // Face.
  let map = blink ? face.shut : face.open;
  if (!blink && face.alt && (Math.floor(t * 5 + ph * 3) & 1)) map = face.alt;
  if (mood === 'sleepy' && !blink && ((t * 0.21 + ph) % 1) > 0.9) map = face.shut;   // a drowsy peek
  look = look < face.lo ? face.lo : look > face.hi ? face.hi : look;
  const fx0 = 4 + hx + look, fy0 = by + 5 + hy;
  for (let j = 0; j < 4; j++) {
    const row = map[j];
    for (let i = 0; i < 6; i++) {
      const ch = row[i];
      if (ch === '.') continue;
      const c = fx0 + i;
      fb.px(flip ? X1 - c : X0 + c, fy0 + j, ch === 'E' ? fc[0] : ch === 'm' ? fc[1] : C.RED_L);
    }
  }

  if (over) fb.blit(tinted(over, cols), bx, by, opt);

  // Small extras.
  if (pose === 'inspect' && hx === 1) {
    // the eye, enlarged in the lens
    for (let i = 0; i < 2; i++) {
      const x = flip ? X1 - 11 - i : X0 + 11 + i;
      if (!blink) fb.px(x, by + 7, fc[0]);
      fb.px(x, by + 8, fc[0]);
    }
  }
  if (mood === 'worried' || pose === 'panic') {
    // a bead of sweat (coolant?) rolling off the back of the head
    const k = Math.floor(t * 5 + ph * 6) % 5;
    if (k < 3) fb.px(flip ? X1 - 2 : X0 + 2, by + 3 + hy + k, k === 2 ? C.BLUE_L : C.SKY);
  }
  if (pose === 'cheer' && oy < 0) {
    const k = Math.floor(t * 6 + ph * 4) & 1;
    fb.px(flip ? X1 - (k ? 0 : 1) : X0 + (k ? 0 : 1), by + 4 + k, C.YELLOW);
    fb.px(flip ? X1 - (k ? 12 : 13) : X0 + (k ? 12 : 13), by + 5 - k, C.CREAM);
  }
}

// ---------------------------------------------------------------------------------
// Workstations
// ---------------------------------------------------------------------------------

// 16x26 sprites drawn for a resident facing right; facing left is a flipX blit.
// The resident's head covers columns 4..11, rows 8..13; a status bubble covers
// columns 3..13 down to row 2. So: screens and lamps go top right, desks bottom right.
const STATIONS = {
  // Kiosk terminal: CRT on a pole with a keyboard shelf.
  terminal: sprite([
    '........ggggggg.',
    '.......guuuuuuus',
    '.......guuuuuuus',
    '.......guuuuuuus',
    '.......guuuuuuus',
    '.......guuuuuuus',
    '........Yssssss.',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '...........WgWgd',
    '...........ddddd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '..............gd',
    '............dddd',
  ], KEY),
  // Wall shelf with books and a paper stack, a desk lamp over a lectern.
  documents: sprite([
    '................',
    '..R.N...........',
    '.bRvN...ww..BB..',
    '.bRvN..wwww.tB..',
    '.bRvN..pwwp.BB..',
    '.OOOOOOOOOOOOOO.',
    '..F........s.F..',
    '...........s....',
    '...........sAAA.',
    '...........dAAAA',
    '................',
    '................',
    '................',
    '................',
    '................',
    '...........ptwp.',
    '..........OOOOOO',
    '.............OO.',
    '.............OO.',
    '.............OO.',
    '.............OO.',
    '.............OO.',
    '.............OO.',
    '.............OO.',
    '.............OO.',
    '...........FOOOF',
  ], KEY),
  // Bench with a parcel under a hanging lens, pass/fail lamp above.
  inspection: sprite([
    '................',
    '................',
    '................',
    '.............dd.',
    '............dDDd',
    '............dDDd',
    '.............dd.',
    '.............s..',
    '.............s..',
    '.............s..',
    '............BB..',
    '...........BXXB.',
    '...........BXXB.',
    '............BB..',
    '............ppep',
    '............eeee',
    '............wwep',
    '...........ggggg',
    '............d..d',
    '............d..d',
    '............d..d',
    '............d..d',
    '............d..d',
    '............d..d',
    '............d..d',
    '............dddd',
  ], KEY),
};

/**
 * Workstation furniture for one 16px cell, up to STATION_W x STATION_H, anchored
 * bottom-centre at (cx, floorY). The resident is drawn afterwards at the same cx, in
 * front of it, so keep the readable part (screen, papers) visible around a 10x20 figure.
 * @param {'terminal'|'documents'|'inspection'} kind
 *   terminal    programmer: green-screen terminal on a stand, scrolling code when active
 *   documents   researcher: lectern / shelf with stacked papers and a lamp
 *   inspection  reviewer: bench with a finished package under a magnifier arm, pass/fail lamp
 * @param {{active:boolean, facing:1|-1, seed?:number}} opts  facing: which way the user faces
 */
export function drawWorkstation(fb, cx, floorY, kind, t, opts) {
  cx = Math.floor(cx); floorY = Math.floor(floorY);
  const flip = opts.facing < 0;
  const active = !!opts.active;
  const seed = (opts.seed ?? 0) | 0;
  const x = cx - (STATION_W >> 1), y = floorY - STATION_H;
  const X1 = x + STATION_W - 1;
  if (!STATIONS[kind]) kind = 'terminal';
  fb.blit(STATIONS[kind], x, y, flip ? FLIP : undefined);
  // station column c -> screen x
  const sx = (c) => (flip ? X1 - c : x + c);

  if (kind === 'terminal') {
    // screen: columns 8..14, rows 1..5
    fb.px(sx(13), y + 6, active ? C.GREEN_L : C.RED_D);
    if (!active) { fb.px(sx(9), y + 2, C.GREEN_D); fb.px(sx(10), y + 1, C.GREEN_D); return; }
    const n = Math.floor(t * 3 + hash(seed, 3) * 8);
    for (let j = 0; j < 5; j++) {
      const line = n + j;
      if (line & 1) continue;
      const indent = Math.floor(hash(line, seed, 1) * 3);
      const len = 2 + Math.floor(hash(line, seed, 2) * (6 - indent));
      const c = hash(line, seed, 4) < 0.25 ? C.MINT : hash(line, seed, 4) > 0.8 ? C.GREEN : C.GREEN_L;
      const gap = hash(line, seed, 5) < 0.4 ? indent + 1 + Math.floor(hash(line, seed, 6) * (len - 1)) : -1;
      for (let i = indent; i < indent + len && i < 7; i++) if (i !== gap) fb.px(sx(8 + i), y + 1 + j, c);
      // cursor after the newest line
      if (j >= 3 && indent + len < 7 && (Math.floor(t * 4) & 1)) fb.px(sx(8 + indent + len), y + 1 + j, C.MINT);
    }
  } else if (kind === 'documents') {
    // lamp bulb under the shade; when active it glows and lights the papers on the lectern
    const lit = active;
    fb.px(sx(13), y + 10, lit ? C.YELLOW : C.STEEL_D); fb.px(sx(14), y + 10, lit ? C.CREAM : C.STEEL_D);
    if (lit) {
      fb.px(sx(12), y + 11, C.AMBER); fb.px(sx(14), y + 11, C.AMBER); fb.px(sx(15), y + 11, C.AMBER_D);
      fb.px(sx(11), y + 15, C.WHITE); fb.px(sx(12), y + 15, C.CREAM); fb.px(sx(13), y + 15, C.WHITE); fb.px(sx(14), y + 15, C.CREAM);
      // a page flutters now and then
      if (((t * 0.4 + hash(seed, 4)) % 1) < 0.12) { fb.px(sx(13), y + 14, C.WHITE); fb.px(sx(14), y + 13, C.CREAM); }
    }
  } else {
    // pass/fail lamp: columns 13..14, rows 4..5
    let c = C.STEEL_DD, hot = false;
    if (active) {
      const cyc = t * 0.25 + hash(seed, 9);
      const k = Math.floor(cyc), p = cyc - k;
      if (p < 0.2) { c = (Math.floor(t * 8) & 1) ? C.AMBER_L : C.AMBER_D; }
      else { const fail = hash(k, seed, 7) < 0.15; c = fail ? C.RED_L : C.GREEN_L; hot = true; }
    }
    fb.px(sx(13), y + 4, c); fb.px(sx(14), y + 4, c); fb.px(sx(13), y + 5, c); fb.px(sx(14), y + 5, c);
    if (hot) fb.px(sx(13), y + 4, C.WHITE);
    // glint on the lens
    if (active && (Math.floor(t * 2 + hash(seed, 2) * 4) % 4) === 0) fb.px(sx(13), y + 11, C.WHITE);
  }
}

// ---------------------------------------------------------------------------------
// Icons and bubbles
// ---------------------------------------------------------------------------------

const ICON_ART = {
  code: ['.......', '..#.#..', '.#...#.', '#.....#', '.#...#.', '..#.#..', '.......'],
  doc: ['#####..', '#...##.', '#....#.', '#.##.#.', '#....#.', '#.##.#.', '######.'],
  search: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
  check: ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  shell: ['.......', '#......', '.#.....', '..#....', '.#.....', '#..####', '.......'],
  plan: ['.......', '#.####.', '.......', '#.####.', '.......', '#.####.', '.......'],
  think: ['..#.#..', '.#####.', '###.###', '.#...#.', '###.###', '.#####.', '..#.#..'],
  web: ['..###..', '.#.#.#.', '#..#..#', '#######', '#..#..#', '.#.#.#.', '..###..'],
  delegate: ['.....#.', '...####', '..#..#.', '##.....', '..#..#.', '...####', '.....#.'],
  wait: ['#######', '.#####.', '..###..', '...#...', '..#.#..', '.#...#.', '#######'],
  zzz: ['....###', '.....#.', '....###', '####...', '..#....', '.#.....', '####...'],
  alert: ['..###..', '..###..', '..###..', '...#...', '...#...', '.......', '...#...'],
  fire: ['...#...', '..##...', '..###..', '.#####.', '##.#.##', '##...##', '.#####.'],
  power: ['....##.', '...##..', '..##...', '.#####.', '...##..', '..##...', '.##....'],
  done: ['.#.....', '.####..', '.######', '.####..', '.#.....', '.#.....', '###....'],
  hello: ['.......', '.#...#.', '.#...#.', '.......', '#.....#', '.#...#.', '..###..'],
  '?': ['..###..', '.#...#.', '....#..', '...#...', '...#...', '.......', '...#...'],
};
// Pre-flattened pixel offsets: [dx0, dy0, dx1, dy1, ...]
const ICON_PX = {};
for (const [name, rows] of Object.entries(ICON_ART)) {
  const list = [];
  rows.forEach((row, j) => { for (let i = 0; i < 7; i++) if (row[i] === '#') list.push(i, j); });
  ICON_PX[name] = list;
}

/** One 7x7 icon with its top-left at (x, y), in colour c. Names: see ICONS. */
export function drawIcon(fb, x, y, icon, c = C.INK) {
  const list = ICON_PX[icon] ?? ICON_PX['?'];
  for (let i = 0; i < list.length; i += 2) fb.px(x + list[i], y + list[i + 1], c);
}

// Bubble body + tail (13 rows): M = fill, S = inner shadow, T = outline.
const BUBBLE = sprite([
  '..TTTTTTT..',
  '.TMMMMMMMT.',
  'TMMMMMMMMMT',
  'TMMMMMMMMMT',
  'TMMMMMMMMMT',
  'TMMMMMMMMMT',
  'TMMMMMMMMMT',
  'TMMMMMMMMMT',
  'TMMMMMMMMST',
  '.TSSSMSSST.',
  '..TTTMTTT..',
  '....TMT....',
  '.....T.....',
], KEY);
const TONES = {
  normal: { cols: [C.CREAM, C.PACKAGE, C.INK], icon: C.INK },
  warn:   { cols: [C.AMBER_L, C.AMBER, C.INK], icon: C.INK },
  alert:  { cols: [C.RED_L, C.RED, C.INK], icon: C.WHITE },
  alert2: { cols: [C.RED, C.RED_D, C.INK], icon: C.CREAM },
};

/**
 * Status bubble (BUBBLE_W x BUBBLE_H plus a small tail) centred above a resident's head.
 * (cx, y) is the bottom-centre point of the tail, i.e. just above the head.
 * @param {'normal'|'warn'|'alert'} [tone]  bubble tint: cream, amber, red
 */
export function drawBubble(fb, cx, y, icon, t, tone = 'normal') {
  cx = Math.floor(cx); y = Math.floor(y);
  // phase travels with the bubble (not its position), so a moving bubble bobs smoothly
  const ph = (ICONS.indexOf(icon) + 1) * 0.382 % 1;
  let tn = TONES[tone] ?? TONES.normal;
  // gentle bob (upward only, so the tail never dips into the head); alerts pulse and hop faster
  let bob = ((t * 0.7 + ph) % 1) < 0.5 ? 0 : 1;
  if (tone === 'alert') {
    if (Math.floor(t * 3 + ph * 2) & 1) tn = TONES.alert2;
    bob = Math.floor(t * 6 + ph * 2) & 1;
  }
  const x = cx - (BUBBLE_W >> 1), top = y - BUBBLE_H - 2 - bob;
  fb.blit(tinted(BUBBLE, tn.cols), x, top);
  drawIcon(fb, x + 2, top + 2, icon, tn.icon);
}

// ---------------------------------------------------------------------------------
// Token items
// ---------------------------------------------------------------------------------

const CRATE = sprite([
  'KKKKKK',
  'KttctK',
  'KOOOOK',
  'KctccK',
  'KOOOOK',
  'KKKKKK',
], KEY);
const PACKAGE = sprite([
  '.KKKK.',
  'KppepK',
  'KeeeeK',
  'KppepK',
  'KwwepK',
  '.KKKK.',
], KEY);

/**
 * A token item with its top-left at (x, y).
 * @param {'crate'|'package'|'cache'} kind
 *   crate    6x6 wooden data crate (input tokens)
 *   package  6x6 wrapped parcel with tape/label (output tokens)
 *   cache    4x4 glowing teal blob that shimmers with t (cache reads in the recycling loop)
 */
export function drawItem(fb, x, y, kind, t = 0) {
  x |= 0; y |= 0;
  if (kind === 'cache') {
    const f = Math.floor(t * 8 + (x + y) * 0.37) & 3;
    const rim = f === 3 ? C.TEAL : C.CYAN;
    fb.rect(x + 1, y, 2, 4, rim); fb.rect(x, y + 1, 4, 2, rim);
    fb.rect(x + 1, y + 1, 2, 2, C.CYAN_L);
    if (f & 1) { fb.px(x, y, C.TEAL); fb.px(x + 3, y + 3, C.TEAL); } else { fb.px(x + 3, y, C.TEAL); fb.px(x, y + 3, C.TEAL); }
    fb.px(x + 1 + (f === 1 || f === 2 ? 1 : 0), y + 1 + (f >> 1), C.WHITE);
    return;
  }
  fb.blit(kind === 'package' ? PACKAGE : CRATE, x, y);
}
