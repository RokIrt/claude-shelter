// The scene: everything in the shelter that is not alive. Rock, surface, shaft, rooms,
// belts, pipes, power wiring, machines, the power plant and in-world gauges (drawBack);
// relighting for pit stop, emergency power, firelight and brown-outs (drawLight); and
// the emissive layer: fire, smoke, steam, sparks, beacons, power pulses and lit signs
// (drawFront). It also plays the limit-reached bursts and the cool-down -> repair ->
// restart sequence after a limit resets, keeping its own timers so a sequence finishes
// even though the state has already gone back to normal.
//
// No DOM, no Node APIs, no Math.random, no Date: time comes from c.t / c.dt and all
// randomness from hash(). Static per-layout geometry lives in scene-layout.mjs.
import { C, LIGHT } from '../gfx/palette.mjs';
import { hash } from '../gfx/fb.mjs';
import * as G from '../gfx/geom.mjs';
import { drawRock, drawSurface, drawRoom, drawShaft, drawBelt, drawPipe, drawCable } from '../gfx/env.mjs';
import { drawMachine, MACHINE_ANCHORS } from '../gfx/machines.mjs';
import { drawReactor, REACTOR_ANCHORS, drawSwitchboard, drawGenerator } from '../gfx/power.mjs';
import { drawFire, drawSmoke, drawSparks, drawSteam, drawBeacon, drawPulse, drawGlow } from '../gfx/fx.mjs';
import { formatCountdown, formatDuration } from '../shared/forecast.mjs';
import { beltSpeed } from './layout.mjs';
import { buildSceneLayout, pointOn } from './scene-layout.mjs';
import { LEVEL_COL, drawPlate, drawPlateRow, drawSign, drawBurst, drawWeld, drawSteamCloud, drawHaloRing, smokePuff } from './scene-fx.mjs';

const { NORMAL, AMBER, EMERGENCY, DARK } = LIGHT;   // brightness order: NORMAL < AMBER < EMERGENCY < DARK

// Reset sequence: cool-down, repair, restart (lights flick back on).
const COOL = 2.2, REPAIR = 2.2, RESTART = 1.6, SEQ_T = COOL + REPAIR + RESTART;
const BURST_T = 1.5;
// Restart flicker: windows (seconds into the restart) where the lights are back on.
const FLICK = [0.14, 0.26, 0.42, 0.5, 0.72, 0.95];
const FLICK_ON = 1.1;
function flickOn(u) {
  if (u >= FLICK_ON) return true;
  for (let i = 0; i < FLICK.length; i += 2) if (u >= FLICK[i] && u < FLICK[i + 1]) return true;
  return false;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const max = (a, b) => (a > b ? a : b);
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);
const cd = (ms) => (ms == null ? '--' : formatCountdown(ms).toUpperCase());
/** One-unit duration: '2H', '45M', '3D'. */
const d1 = (ms) => (ms == null ? '--' : formatDuration(ms).replace(/^(\d+) (\w).*$/, '$1$2').toUpperCase());
const pctText = (v) => `${Math.round(v.percent)}%${v.stale ? '?' : ''}`;
const inBox = (b, x, y) => !!b && x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;
const boxCopy = (b) => (b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null);
const ANCHOR = (design) => MACHINE_ANCHORS[design] ?? MACHINE_ANCHORS.generic ?? Object.values(MACHINE_ANCHORS)[0];
const PT = [0, 0];
// Base colours of the generator's run lamp and fuel bar, which glow through room lighting.
const LIT_LAMPS = new Uint8Array(64);
for (const c of [C.GREEN_L, C.MINT]) LIT_LAMPS[c] = 1;
const IS_SMOKE = new Uint8Array(64);
for (const c of [C.SMOKE_D, C.SMOKE, C.SMOKE_L]) IS_SMOKE[c] = 1;

/**
 * x of the generator's exhaust: the painter exports no anchors, so find its own puffs in
 * the rows just above the box (where they rise) and return their mean x, or -1.
 */
function findExhaust(fb, g) {
  let sum = 0, n = 0;
  const x0 = Math.max(0, g.x), x1 = Math.min(fb.w, g.x + g.w);
  for (let y = Math.max(0, g.y - 9); y < g.y; y++) {
    for (let x = x0; x < x1; x++) if (IS_SMOKE[fb.buf[y * fb.w + x] & 63]) { sum += x; n++; }
  }
  return n ? Math.round(sum / n) : -1;
}

/** Restore full brightness to pixels of the given base colours (emissive bits). */
function unlight(fb, x, y, w, h, set) {
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(fb.w, (x + w) | 0), y1 = Math.min(fb.h, (y + h) | 0);
  const b = fb.buf;
  for (let yy = y0; yy < y1; yy++) {
    for (let o = yy * fb.w + x0, e = yy * fb.w + x1; o < e; o++) if (set[b[o] & 63]) b[o] &= 63;
  }
}

/** Gauge text for a machine's own allowance. */
function machineLines(v) {
  if (!v) return { n: 1, texts: ['SHARED'], cols: [C.STEEL_L] };
  const lv = LEVEL_COL[v.level] ?? C.STEEL_LL;
  let l3, c3;
  if (v.level === 'exhausted') { l3 = 'DOWN'; c3 = C.RED_L; }
  else if (v.survives === true) { l3 = 'OK'; c3 = C.GREEN_L; }
  else if (v.exhaustInMs != null) { l3 = `ETA ${d1(v.exhaustInMs)}`; c3 = v.level === 'ok' ? C.AMBER_L : lv; }
  else { l3 = 'ETA --'; c3 = C.STEEL_L; }
  return { n: 3, texts: [pctText(v), `RST ${cd(v.resetInMs)}`, l3], cols: [lv, C.STEEL_LL, c3] };
}

/** Gauge text for the weekly allowance (reactor): does it reach the reset? */
function reactorLines(v) {
  if (!v) return { n: 1, texts: ['NO DATA'], cols: [C.STEEL_L] };
  const lv = LEVEL_COL[v.level] ?? C.STEEL_LL;
  let l3, c3;
  if (v.level === 'exhausted') { l3 = 'DOWN'; c3 = C.RED_L; }
  else if (v.survives === true) { l3 = 'OK'; c3 = C.GREEN_L; }
  else if (v.survives === false && v.shortfallMs != null) { l3 = `SHORT ${d1(v.shortfallMs)}`; c3 = v.level === 'ok' ? C.AMBER_L : lv; }
  else if (v.exhaustInMs != null) { l3 = `ETA ${d1(v.exhaustInMs)}`; c3 = C.AMBER_L; }
  else { l3 = 'ETA --'; c3 = C.STEEL_L; }
  return { n: 3, texts: [pctText(v), `RST ${cd(v.resetInMs)}`, l3], cols: [lv, C.STEEL_LL, c3] };
}

/** One-row gauge text for the session allowance (switchboard). */
function sessionRow(v) {
  if (!v) return { n: 1, texts: ['NO DATA'], cols: [C.STEEL_L] };
  return { n: 2, texts: [pctText(v), `RST ${cd(v.resetInMs)}`], cols: [LEVEL_COL[v.level] ?? C.STEEL_LL, C.STEEL_LL] };
}

export function createScene() {
  // ---- per-layout cache --------------------------------------------------------------
  let SL = null, lastL = null;
  function geo(L) {
    if (L !== lastL || !SL || SL.key !== L.key) {
      if (!SL || SL.key !== L.key) SL = buildSceneLayout(L);
      lastL = L;
    }
    return SL;
  }

  // ---- per-state cache (machine lookup and gauge texts) ------------------------------
  let textState = null;
  const mByKey = new Map();
  const mText = new Map();
  let rText = null, sText = null, sessionReset = '', sessionCd = '', weeklyReset = '';
  function refresh(s) {
    if (s === textState) return;
    textState = s;
    mByKey.clear(); mText.clear();
    for (const m of s.machines) { mByKey.set(m.modelKey, m); mText.set(m.modelKey, machineLines(m.limit)); }
    rText = reactorLines(s.reactor.limit);
    sText = sessionRow(s.switchboard.limit);
    sessionCd = cd(s.switchboard.limit?.resetInMs ?? null);
    sessionReset = `RESET ${sessionCd}`;
    weeklyReset = `RESET ${cd(s.reactor.limit?.resetInMs ?? null)}`;
  }

  // ---- motion ------------------------------------------------------------------------
  const kin = new Map();      // modelKey -> {phase, speed, belt}
  const looks = new Map();    // modelKey -> reusable MachineLook
  let exhaustX = -1;
  let dockBelt = 0, genPhase = 0, genSpeed = 0, reactorPhase = 0, reactorSpeed = 0;
  let travelFeed = 0, travelDist = 0, travelGen = 0;
  const sbLook = { status: 'ok', percent: null };
  const rLook = { heat: 0, status: 'ok', phase: 0, speed: 0, percent: null };
  const gLook = { present: false, running: false, utilization: null, phase: 0 };
  const roomOpts = new Map();  // room id -> drawRoom opts (reused)

  // ---- events: bursts and reset sequences --------------------------------------------
  /** key: 'model:<k>' | 'session' | 'weekly' -> {key, scope, modelKey, t0} */
  const seqs = new Map();
  const bursts = [];
  let prevM = new Map(), prevSb = null, prevR = null, prevSrc = null;

  const keyOf = (scope, modelKey) => (scope === 'model' ? `model:${modelKey}` : scope);
  /** Is a sequence still holding its target dark (before the restart flicker turns it on)? */
  const holding = (q, t) => !!q && !(t - q.t0 >= COOL + REPAIR && flickOn(t - q.t0 - COOL - REPAIR));
  const coolOrRepair = (q, t) => !!q && t - q.t0 < COOL + REPAIR;

  function startSeq(scope, modelKey, t) {
    const key = keyOf(scope, modelKey);
    if (!seqs.has(key)) seqs.set(key, { key, scope, modelKey, t0: t });
  }
  function burst(scope, modelKey, t) {
    seqs.delete(keyOf(scope, modelKey));
    bursts.push({ scope, modelKey, t0: t, seed: (Math.floor(t * 97) ^ (modelKey ? modelKey.length * 31 : 7)) | 0 });
  }

  /** Status the machine is drawn with while a sequence overrides it, or null. */
  function override(m, t) {
    const q = seqs.get(`model:${m.modelKey}`);
    if (q) {
      if (t - q.t0 < COOL) return 'fire';
      if (holding(q, t)) return 'pitstop';
    }
    if (m.status === 'fire') return null;
    if (holding(seqs.get('weekly'), t)) return 'emergency';
    if (holding(seqs.get('session'), t)) return 'pitstop';
    return null;
  }

  function distLive(s, t) {
    return (s.power === 'normal' || s.generator.running) && !holding(seqs.get('session'), t) && !holding(seqs.get('weekly'), t);
  }
  function feedLive(s, t) { return s.power !== 'emergency' && !holding(seqs.get('weekly'), t); }
  function runLive(r, s, t, dist) {
    if (r.net === 'feed') return feedLive(s, t);
    if (!dist) return false;
    if (r.room && r.room.startsWith('machine:')) {
      const key = r.room.slice(8), m = mByKey.get(key);
      return !!m && m.status !== 'fire' && !holding(seqs.get(`model:${key}`), t);
    }
    return true;
  }

  // ---- lighting ----------------------------------------------------------------------
  function underMode(s, t) {
    let mode = s.power === 'emergency' ? EMERGENCY : NORMAL;
    const w = seqs.get('weekly');
    if (w) {
      const u = t - w.t0;
      mode = max(mode, u < COOL + REPAIR ? EMERGENCY : flickOn(u - COOL - REPAIR) ? NORMAL : DARK);
    }
    return mode;
  }
  function dipMode(s, t) {
    const rs = s.reactor.status;
    if (rs !== 'hot' && rs !== 'critical') return NORMAL;
    const slot = Math.floor(t * 9);
    const p = Math.min(0.09, Math.max(0.012, (s.reactor.heat - 0.5) * 0.17));
    if (hash(slot, 7, 503) >= p) return NORMAL;
    return hash(slot, 8, 504) < 0.55 ? AMBER : DARK;
  }
  function roomMode(sp, s, t, under, dip) {
    const rm = sp.rm, i = sp.index;
    let mode = max(under, dip);
    if (s.power === 'pitstop' && rm.kind !== 'reactor') mode = max(mode, AMBER);
    for (const q of seqs.values()) {
      if (q.scope === 'model' ? rm.id !== `machine:${q.modelKey}` : q.scope === 'session' && rm.kind === 'reactor') continue;
      const u = t - q.t0;
      const m = u < COOL + REPAIR ? (q.scope === 'model' ? DARK : q.scope === 'session' ? AMBER : EMERGENCY)
        : flickOn(u - COOL - REPAIR) ? NORMAL : DARK;
      mode = max(mode, m);
    }
    if (rm.kind === 'machine') {
      const m = mByKey.get(rm.modelKey);
      if (m && m.status === 'fire' && !seqs.has(`model:${rm.modelKey}`)) {
        const r = hash(Math.floor(t * 11 + i * 0.37), i, 501);
        if (r < 0.11) mode = DARK; else if (r < 0.3) mode = max(mode, AMBER);
      }
    }
    if (s.power === 'emergency' && hash(Math.floor(t * 7 + i * 0.53), i, 502) < 0.07) mode = DARK;
    return mode;
  }

  // ---- drawing helpers ---------------------------------------------------------------
  function lookOf(m, k, t) {
    let lk = looks.get(m.modelKey);
    if (!lk) looks.set(m.modelKey, lk = { heat: 0, status: 'idle', powered: false, phase: 0, speed: 0, style: null });
    const o = override(m, t);
    lk.status = o ?? m.status;
    lk.powered = o ? false : m.powered;
    lk.heat = o === 'fire' ? 1 : m.heat;
    lk.phase = k ? k.phase : 0;
    lk.speed = k ? k.speed : 0;
    lk.style = m.style;
    return lk;
  }

  /** Pulses along a run; none inside the shaft (the buried run passes under the car's surface stop). */
  function drawPulses(fb, r, travel, density, col, t, seed, sh) {
    const gap = 26, lo = r.s0, hi = r.s0 + r.len;
    const n0 = Math.ceil((travel - hi) / gap), n1 = Math.floor((travel - lo) / gap);
    for (let n = n0; n <= n1; n++) {
      const sl = travel - n * gap - lo;
      if (sl < 0 || sl >= r.len) continue;
      if (hash(n, seed, 77) >= density) continue;
      pointOn(r, sl, PT);
      if (PT[0] >= sh.x - 2 && PT[0] < sh.x + sh.w + 2) continue;
      drawPulse(fb, PT[0], PT[1], t + (n & 7) * 0.05, col);
    }
  }

  function junction(fb, x, y, kind, live) {
    if (kind === 'ceil') {
      fb.rect(x - 2, y, 5, 3, C.STEEL_D); fb.hline(x - 2, y, 5, C.STEEL);
      fb.px(x, y + 1, live ? C.AMBER_L : C.STEEL_DD);
    } else if (kind === 'wall') {
      fb.rect(x - 2, y - 2, 5, 5, C.STEEL); fb.frame(x - 2, y - 2, 5, 5, C.INK);
      fb.px(x, y, live ? C.AMBER_L : C.STEEL_DD);
    } else {
      fb.rect(x - 1, y, 3, 2, C.BRASS); fb.px(x - 1, y + 1, C.AMBER_D);
    }
  }

  /** Beacon housing with a small wall bracket (back layer: relit with the room). */
  function beaconFixture(fb, x, y, t) {
    fb.rect(x - 1, y + 3, 3, 1, C.STEEL_D); fb.px(x, y + 4, C.STEEL_DD);
    drawBeacon(fb, x, y, t, 'off');
  }

  /** Smoke rising out of the reactor hall: a layer under the ceiling and up the shaft. */
  function hallSmoke(fb, L, S, t, I) {
    const H = L.reactor, sh = L.shaft;
    // a drifting layer under the hall ceiling, spreading out from the core
    fb.setClip(H.x + G.WALL_T, H.y + G.CEIL_T, H.w - 2 * G.WALL_T, H.h);
    const shaftCx = sh.x + (sh.w >> 1);
    const towardShaft = shaftCx < S.hcx - 40;           // compact: the shaft is off to the left
    const reachL = towardShaft ? S.hcx - shaftCx : Math.min(150, S.hcx - (H.x + 20));
    const reachR = Math.min(150, H.x + H.w - 20 - S.hcx);
    // puffs flow outward along the ceiling, billowing and thinning as they go
    const T = Math.floor(t * 12) / 12;
    for (let side = -1; side <= 1; side += 2) {
      const reach = side < 0 ? reachL : reachR;
      const n = Math.max(3, Math.round(reach / 9));
      for (let k = 0; k < n; k++) {
        const p = (T / (2.2 + reach / 40) + k / n + hash(k, side + 2, 611) * 0.08) % 1;
        const q = p;
        const fade = side < 0 && towardShaft ? 1 - 0.35 * q : 1 - q * q;
        const x = Math.round(S.hcx + side * (8 + p * reach));
        const y = H.y + 7 + Math.round(Math.sin(p * 9 + k * 1.3) * 1.5 + q * 2);
        const r = 3.5 + 3.5 * Math.min(1, q * 2) + hash(k, side, 612) * 1.5;
        smokePuff(fb, x, y, r, I * fade * 0.95);
      }
    }
    // up the shaft: in the full layout it sits right over the core; in compact it is at
    // the hall's left end, where the ceiling layer drifts into it
    if (sh.y < H.y) {
      fb.setClip(sh.x, sh.y, sh.w, H.y - sh.y + 8);
      const span = H.y + 12 - sh.y;
      for (let b = 0, y = H.y + 12; y > sh.y - 20; b++, y -= 24) {
        const fade = Math.max(0.3, 1 - (H.y + 12 - y) / (span + 30));
        drawSmoke(fb, shaftCx - 5 + (b & 1) * 3, y, 34, t + b * 0.61, I * fade, 80 + b);
        drawSmoke(fb, shaftCx + 5 - (b & 1) * 3, y + 10, 30, t + b * 0.43 + 0.3, I * fade * 0.85, 180 + b);
      }
    }
    fb.clearClip();
  }

  // =====================================================================================
  return {
    /** @param {import('./world.mjs').Ctx} c */
    update(c) {
      const s = c.state, t = c.t, dt = c.dt;
      if (c.relaid) { SL = null; lastL = null; }
      geo(c.layout);
      refresh(s);

      // a new data source: nothing carries over
      const src = `${s.source}|${s.scenario}`;
      if (prevSrc !== null && src !== prevSrc) { seqs.clear(); bursts.length = 0; prevM = new Map(); prevSb = null; prevR = null; }

      // events first, then state transitions the events did not cover
      const handled = new Set();
      for (const e of c.events) {
        if (e.type !== 'limit_reached' && e.type !== 'limit_reset') continue;
        const key = keyOf(e.scope, e.modelKey);
        handled.add(key);
        if (e.type === 'limit_reached') burst(e.scope, e.modelKey, t);
        else {
          const was = e.scope === 'model' ? prevM.get(e.modelKey) === 'fire'
            : e.scope === 'session' ? prevSb === 'tripped' : prevR === 'meltdown';
          if (was) startSeq(e.scope, e.modelKey, t);
        }
      }
      if (prevSb !== null) {
        for (const m of s.machines) {
          const p = prevM.get(m.modelKey), key = `model:${m.modelKey}`;
          if (p === undefined || handled.has(key)) continue;
          if (p === 'fire' && m.status !== 'fire') startSeq('model', m.modelKey, t);
          else if (p !== 'fire' && m.status === 'fire') burst('model', m.modelKey, t);
        }
        const sb = s.switchboard.status, rs = s.reactor.status;
        if (!handled.has('session')) {
          if (prevSb === 'tripped' && sb !== 'tripped') startSeq('session', null, t);
          else if (prevSb !== 'tripped' && sb === 'tripped') burst('session', null, t);
        }
        if (!handled.has('weekly')) {
          if (prevR === 'meltdown' && rs !== 'meltdown') startSeq('weekly', null, t);
          else if (prevR !== 'meltdown' && rs === 'meltdown') burst('weekly', null, t);
        }
      }
      prevSrc = src;
      prevM.clear();
      for (const m of s.machines) prevM.set(m.modelKey, m.status);
      prevSb = s.switchboard.status; prevR = s.reactor.status;
      for (const [k, q] of seqs) if (t - q.t0 >= SEQ_T) seqs.delete(k);
      for (let i = bursts.length - 1; i >= 0; i--) if (t - bursts[i].t0 >= BURST_T) bursts.splice(i, 1);

      // motion: machines spin up and down smoothly; belts follow beltSpeed exactly
      for (const m of s.machines) {
        let k = kin.get(m.modelKey);
        if (!k) kin.set(m.modelKey, k = { phase: hash(m.modelKey.length, m.modelKey.charCodeAt(0)) * 4, speed: 0, belt: 0 });
        const on = m.powered && !override(m, t);
        k.speed += ((on ? m.speed : 0) - k.speed) * ease(dt, on ? 0.6 : 0.45);
        if (k.speed < 1e-4) k.speed = 0;
        k.phase += dt * k.speed * 1.2;
        k.belt += dt * beltSpeed(m);
      }
      dockBelt += dt * beltSpeed({ powered: s.speed > 0, speed: s.speed });
      genSpeed += ((s.generator.running ? 1 : 0) - genSpeed) * ease(dt, 0.5);
      genPhase += dt * genSpeed * 1.5;
      const rTarget = holding(seqs.get('weekly'), t) ? 0 : s.reactor.speed;
      reactorSpeed += (rTarget - reactorSpeed) * ease(dt, 0.8);
      reactorPhase += dt * reactorSpeed;
      travelFeed += dt * (16 + 46 * s.reactor.speed);
      travelDist += dt * (16 + 50 * (s.speed > 0 ? s.speed : s.generator.running ? 0.35 : 0));
      travelGen += dt * 24;
    },

    /** Rock, surface, shaft, rooms, belts, pipes, cables, machines, power plant, in-world gauges. */
    drawBack(fb, c) {
      const L = c.layout, s = c.state, t = c.t;
      const S = geo(L);
      refresh(s);
      drawRock(fb, 0, 0, L.w, L.h, 0);
      drawSurface(fb, L.surface.x, L.surface.y, L.surface.w, L.surface.h, t, { shaftX: L.shaft.x, shaftW: L.shaft.w, emergency: s.power === 'emergency' || coolOrRepair(seqs.get('weekly'), t) });
      for (const row of L.rows) drawShaft(fb, L.shaft.x, row.y, L.shaft.w, G.ROOM_H, t);

      const wq = seqs.get('weekly'), sq = seqs.get('session');
      for (const sp of S.rooms) {
        const rm = sp.rm;
        const m = rm.modelKey ? mByKey.get(rm.modelKey) : null;
        let o = roomOpts.get(rm.id);
        if (!o) roomOpts.set(rm.id, o = { doorL: rm.doorL, doorR: rm.doorR, label: rm.kind, accent: undefined, seed: sp.index });
        o.doorL = rm.doorL; o.doorR = rm.doorR;
        o.label = rm.kind === 'machine' ? String(m ? m.label : rm.modelKey).slice(0, 10) : rm.kind;
        o.accent = m ? m.style?.accent : undefined;
        drawRoom(fb, rm.x, rm.y, rm.w, rm.h, rm.kind, t, o);

        if (rm.kind === 'machine') {
          const k = kin.get(rm.modelKey);
          const bp = k ? k.belt : 0;
          drawBelt(fb, rm.x + G.BELT_IN[0], rm.y + G.BELT_Y, G.BELT_IN[1] - G.BELT_IN[0], bp);
          drawBelt(fb, rm.x + G.BELT_OUT[0], rm.y + G.BELT_Y, G.BELT_OUT[1] - G.BELT_OUT[0], bp);
          drawPipe(fb, sp.loop, 'cache');
          if (m) drawMachine(fb, sp.cx, rm.floorY, m.design, t, lookOf(m, k, t));
        } else if (rm.kind === 'dock') {
          drawBelt(fb, rm.x + G.DOCK.belt[0], rm.y + G.DOCK.beltY, G.DOCK.belt[1] - G.DOCK.belt[0], dockBelt);
        } else if (rm.kind === 'power') {
          sbLook.status = coolOrRepair(sq, t) ? 'tripped' : s.switchboard.status;
          sbLook.percent = s.switchboard.limit?.percent ?? null;
          drawSwitchboard(fb, S.sbCx, S.sbFloor, t, sbLook);
          gLook.present = s.generator.present; gLook.running = s.generator.running;
          gLook.utilization = s.generator.utilization; gLook.phase = genPhase;
          drawGenerator(fb, S.gnCx, S.sbFloor, t, gLook);
        } else if (rm.kind === 'reactor') {
          const held = coolOrRepair(wq, t);
          rLook.status = held ? 'meltdown' : s.reactor.status;
          rLook.heat = held ? 1 : s.reactor.heat;
          rLook.phase = reactorPhase; rLook.speed = reactorSpeed;
          rLook.percent = s.reactor.limit?.percent ?? null;
          drawReactor(fb, rm.x, rm.y, rm.w, rm.h, t, rLook);
        }
      }

      // power wiring: dead runs first so live trunks win where runs meet
      const dist = distLive(s, t);
      for (let pass = 0; pass < 2; pass++) {
        for (const r of S.runs) if (runLive(r, s, t, dist) === (pass === 1)) drawCable(fb, r.pts, pass === 1);
      }
      if (s.generator.present) drawCable(fb, S.gen.pts, s.generator.running);
      const fl = feedLive(s, t);
      for (const [x, y, kind] of S.boxes) junction(fb, x, y, kind, kind === 'clamp' || (kind === 'wall' && y > S.sbFloor) ? fl : dist);

      // fixtures and gauges
      for (const sp of S.rooms) {
        const rm = sp.rm;
        if (sp.beacon) beaconFixture(fb, sp.beacon[0], sp.beacon[1], t);
        if (rm.kind === 'machine') {
          const m = mByKey.get(rm.modelKey);
          if (!m) continue;
          const a = ANCHOR(m.design);
          if (a && a.lamp) drawBeacon(fb, sp.cx + a.lamp[0], rm.floorY + a.lamp[1], t, 'off');
          const tx = mText.get(m.modelKey);
          const p = sp.plate;
          drawPlate(fb, p.x, p.y, p.w, tx.n, tx.texts, tx.cols);
        }
      }
      for (const lp of REACTOR_ANCHORS.lamps ?? []) drawBeacon(fb, S.hcx + lp[0], S.hFloor + lp[1], t, 'off');
      drawPlate(fb, S.rPlate.x, S.rPlate.y, S.rPlate.w, rText.n, rText.texts, rText.cols);
      drawPlateRow(fb, S.sPlate.x, S.sPlate.y, S.sPlate.w, sText.texts, sText.cols, sText.n);
    },

    /** Relight rooms after everything unlit is drawn: amber pit stop, red emergency, flicker. */
    drawLight(fb, c) {
      const L = c.layout, s = c.state, t = c.t;
      const S = geo(L);
      refresh(s);
      const under = underMode(s, t), dip = dipMode(s, t);
      if (under !== NORMAL) fb.relight(0, G.SURFACE_H, L.w, L.h - G.SURFACE_H, under);
      for (const sp of S.rooms) {
        const mode = roomMode(sp, s, t, under, dip);
        if (mode !== under) fb.relight(sp.rm.x, sp.rm.y, sp.rm.w, sp.rm.h, mode);
      }
    },

    /** Emissive things drawn over the lighting: fire, smoke, sparks, beacons, pulses, lit signs. */
    drawFront(fb, c) {
      const L = c.layout, s = c.state, t = c.t;
      const S = geo(L);
      refresh(s);
      const H = L.reactor, P = L.byId.power;
      const wq = seqs.get('weekly'), sq = seqs.get('session');

      // -- power pulses along live cables -------------------------------------------
      const dist = distLive(s, t);
      const rs = s.reactor.status;
      const feedCol = rs === 'critical' ? C.ORANGE : rs === 'hot' ? C.YELLOW : C.CREAM;
      const distCol = s.power !== 'normal' && s.generator.running ? C.YELLOW : C.CREAM;
      for (const r of S.runs) {
        if (!runLive(r, s, t, dist)) continue;
        if (r.net === 'feed') drawPulses(fb, r, travelFeed, 0.2 + 0.55 * s.reactor.speed, feedCol, t, 1, L.shaft);
        else drawPulses(fb, r, travelDist, 0.08 + 0.5 * Math.max(s.speed, s.generator.running ? 0.35 : 0), distCol, t, 2, L.shaft);
      }
      if (s.generator.present && s.generator.running) drawPulses(fb, S.gen, travelGen, 1, C.YELLOW, t, 3, L.shaft);

      // -- backup generator: lit lamp and exhaust --------------------------------------
      if (s.generator.present && s.generator.running) {
        const g = S.genBox;
        // the painter's run lamp and gauges glow through the room lighting
        unlight(fb, g.x, g.y, g.w, g.h, LIT_LAMPS);
        // exhaust keeps rising above the painter's own puffs at its stack
        const ex = findExhaust(fb, g);
        if (ex >= 0) exhaustX = ex - g.x;
        if (exhaustX >= 0) {
          fb.setClip(P.x, P.y, P.w, P.h);
          drawSmoke(fb, g.x + exhaustX + 1, g.y - 7, 13, t, 0.4, 23);
          fb.clearClip();
        }
      }

      // -- machines: overheating, fire, repair -----------------------------------------
      for (const sp of S.machineRooms) {
        const rm = sp.rm, m = mByKey.get(rm.modelKey);
        if (!m) continue;
        const a = ANCHOR(m.design);
        if (!a) continue;
        const cx = sp.cx, fy = rm.floorY, seed = sp.index * 13 + 1;
        const fx = cx + a.fire[0], fyy = fy + a.fire[1], sx = cx + a.smoke[0], sy = fy + a.smoke[1];
        const lx = cx + a.lamp[0], ly = fy + a.lamp[1];
        const smokeH = Math.max(10, sy - rm.y + 8);
        const q = seqs.get(`model:${m.modelKey}`);
        fb.setClip(rm.x, rm.y, rm.w, rm.h);
        if (q) {
          const u = t - q.t0;
          if (u < COOL) {
            const k = u / COOL, fi = 0.6 * Math.max(0, 1 - k * 1.8);
            drawSmoke(fb, sx, sy, smokeH, t, 0.8 * (1 - k), seed);
            drawSteamCloud(fb, fx, fyy, 30, Math.max(14, fyy - rm.y - 2), t, Math.min(1, 0.45 + k * 1.4), seed);
            if (fi > 0) drawFire(fb, fx, fyy, 30, 22, t, fi, seed);
            drawBeacon(fb, lx, ly, t, 'red', 2);
          } else if (u < COOL + REPAIR) {
            const k = (u - COOL) / REPAIR;
            drawSteamCloud(fb, fx, fyy, 26, Math.max(12, fyy - rm.y - 4), t, 0.55 * (1 - k), seed);
            a.sparks.forEach((p, i) => drawWeld(fb, cx + p[0], fy + p[1], t + i * 0.31, seed + i * 3, (k * 2 + i) % 2 < 1.15 ? 1 : 0.35));
          } else if (!flickOn(u - COOL - REPAIR) && u - COOL - REPAIR < 0.6) {
            drawSparks(fb, cx + a.sparks[0][0], fy + a.sparks[0][1], t, 0.6, seed + 9);
          }
        } else if (m.status === 'fire') {
          drawGlow(fb, fx, fyy - 6, 13, C.RED_D, t);
          drawSmoke(fb, sx, sy, smokeH, t, 0.85, seed);
          drawFire(fb, fx, fyy, 30, 22, t, 0.6, seed);
          a.sparks.forEach((p, i) => drawSparks(fb, cx + p[0], fy + p[1], t, 1, seed + i * 5));
          drawBeacon(fb, lx, ly, t, 'red', 3);
          drawSign(fb, sp.limit.x, sp.limit.y, 'LIMIT', null, C.RED_L, C.RED_D, t, 'left', 2);
        } else if (m.status === 'hot' && !override(m, t)) {
          const urg = clamp01((m.heat - 0.55) / 0.45);
          drawBeacon(fb, lx, ly, t, 'amber', 1.2 + 3.5 * urg);
          drawSteam(fb, sx - 12, sy, 12 + Math.round(10 * urg), t, 0.4 + 0.6 * urg, seed);
          drawSteam(fb, sx + 14, sy + 2, 10 + Math.round(8 * urg), t, 0.3 + 0.6 * urg, seed + 4);
        }
        fb.clearClip();
      }

      // -- switchboard: tripped breaker, repair -----------------------------------------
      {
        const jx = S.sbCx, jy = S.sbFloor - 30;
        fb.setClip(P.x, P.y, P.w, P.h);
        if (sq) {
          const u = t - sq.t0;
          if (u < COOL) {
            const k = u / COOL;
            drawSparks(fb, jx, jy, t, 1 - k, 41);
            drawSmoke(fb, jx, jy - 2, 16, t, 0.6 * (1 - k), 42);
            drawSteamCloud(fb, jx, jy - 4, 14, 16, t, 0.3 + 0.5 * k, 43);
          } else if (u < COOL + REPAIR) {
            drawWeld(fb, jx, jy, t, 44, 1);
            drawWeld(fb, jx - 7, jy + 8, t + 0.4, 45, 0.5);
          }
        } else if (s.switchboard.status === 'tripped') {
          drawSparks(fb, jx, jy, t, 1, 41);
          drawSparks(fb, jx - 7, jy - 6, t, 0.7, 43);
          drawSparks(fb, jx + 6, jy + 9, t, 0.6, 47);
        }
        fb.clearClip();
      }

      // -- pit stop: a lit reset countdown in every amber room --------------------------
      if (s.power === 'pitstop' || (coolOrRepair(sq, t) && s.power !== 'emergency')) {
        const pit = s.power === 'pitstop';
        const text = pit ? sessionReset : 'REPAIRING';
        for (const sp of S.rooms) {
          if (!sp.sign) continue;
          const tt = t + sp.index * 0.1;
          if (sp.rm.kind === 'machine') {
            const m = mByKey.get(sp.rm.modelKey);
            if (!m || m.status === 'fire' || seqs.has(`model:${m.modelKey}`)) continue;
            drawSign(fb, sp.limit.x, sp.limit.y, pit ? 'RESET' : 'REPAIR', pit ? sessionCd : null, C.AMBER_L, C.AMBER_D, tt, 'left', 0.8);
          } else if (sp.rm.kind === 'power') {
            // the session gauge itself lights up as the countdown sign (no room for another)
            const p = S.sPlate;
            drawPlateRow(fb, p.x, p.y, p.w, sText.texts, sText.cols, sText.n);
            fb.frame(p.x, p.y, p.w, p.h, (tt * 0.8) % 1 < 0.62 ? C.AMBER_L : C.AMBER_D);
          } else {
            drawSign(fb, sp.sign.x, sp.sign.y, text, null, C.AMBER_L, C.AMBER_D, tt, sp.sign.align, 0.8);
          }
        }
      }

      // -- reactor hall --------------------------------------------------------------------
      const RA = REACTOR_ANCHORS;
      const vents = RA.vents ?? RA.smoke ?? [];
      const heat = s.reactor.heat;
      const urg = clamp01((heat - 0.55) / 0.45);
      if (wq) {
        const u = t - wq.t0;
        if (u < COOL) {
          const k = u / COOL;
          hallSmoke(fb, L, S, t, 0.9 * (1 - k));
          fb.setClip(H.x, H.y, H.w, H.h);
          RA.fire.forEach((f, i) => {
            drawSteamCloud(fb, S.hcx + f[0], S.hFloor + f[1], i ? 18 : 34, i ? 22 : 30, t, Math.min(1, 0.5 + k * 1.3), 90 + i);
            const fi = (i ? 0.75 : 1) * Math.max(0, 1 - k * 1.7);
            if (fi > 0) drawFire(fb, S.hcx + f[0], S.hFloor + f[1], i ? 20 : 40, i ? 20 : 32, t, fi, 70 + i);
          });
        } else if (u < COOL + REPAIR) {
          const k = (u - COOL) / REPAIR;
          fb.setClip(H.x, H.y, H.w, H.h);
          RA.fire.forEach((f, i) => {
            drawSteamCloud(fb, S.hcx + f[0], S.hFloor + f[1], 20, 22, t, 0.5 * (1 - k), 95 + i);
            drawWeld(fb, S.hcx + f[0] + (i ? 0 : -8), S.hFloor + f[1] + (i ? 4 : 6), t + i * 0.27, 100 + i, (i + Math.floor(k * 3)) % 3 === 0 ? 1 : 0.45);
          });
        }
        fb.clearClip();
      } else if (rs === 'meltdown') {
        hallSmoke(fb, L, S, t, 1);
        fb.setClip(H.x, H.y, H.w, H.h);
        RA.smoke.forEach((p, i) => { if (i) drawSmoke(fb, S.hcx + p[0], S.hFloor + p[1], Math.max(12, S.hFloor + p[1] - H.y), t, 1, 60 + i); });
        drawGlow(fb, S.hcx, S.hFloor - 6, 30, C.RED_D, t);
        RA.fire.forEach((f, i) => drawFire(fb, S.hcx + f[0], S.hFloor + f[1], i ? 20 : 44, i ? 22 : 34, t, i ? 0.8 : 1, 70 + i));
        RA.fire.forEach((f, i) => drawSparks(fb, S.hcx + f[0] + (i ? -f[0] * 0.25 : 14), S.hFloor + f[1] - 6, t, 1, 120 + i));
        drawSparks(fb, S.hcx - 20, S.hFloor - 52, t + 0.3, 1, 130);
        fb.clearClip();
      } else if (rs === 'hot' || rs === 'critical') {
        fb.setClip(H.x, H.y, H.w, H.h);
        drawHaloRing(fb, S.hcx, S.hFloor - (S.coreBox.h >> 1), (S.coreBox.w >> 1) + 12, (S.coreBox.w >> 1) + 22, rs === 'critical' ? C.ORANGE : C.AMBER, t, 0.5 + 0.7 * urg);
        vents.forEach((v, i) => {
          const vx = S.hcx + v[0], vy = S.hFloor + v[1], h = Math.max(8, vy - H.y - 2);
          if (rs === 'critical') drawSteamCloud(fb, vx, vy, 10, h, t, 0.4 + 0.6 * urg, 140 + i);
          else drawSteam(fb, vx, vy, h, t, 0.5 + 0.5 * urg, 140 + i);
        });
        fb.clearClip();
      }

      // -- warning beacons: reactor lamps and shelter-wide room beacons ---------------
      let bMode = 'off', bRate = 0;
      if (coolOrRepair(wq, t)) { bMode = 'red'; bRate = 2; }
      else if (rs === 'meltdown') { bMode = 'red'; bRate = 4; }
      else if (rs === 'critical') { bMode = 'red'; bRate = 2.2 + 2.5 * urg; }
      else if (rs === 'hot') { bMode = 'amber'; bRate = 1 + 2.2 * urg; }
      if (bMode !== 'off') {
        for (const lp of RA.lamps ?? []) drawBeacon(fb, S.hcx + lp[0], S.hFloor + lp[1], t, bMode, bRate * 1.25);
        for (const sp of S.rooms) if (sp.beacon) drawBeacon(fb, sp.beacon[0], sp.beacon[1], t + sp.index * 0.11, bMode, bRate);
      }

      // -- surface: siren and the emergency power sign ----------------------------------
      if (rs === 'meltdown' || coolOrRepair(wq, t)) {
        const sh = L.shaft;
        drawBeacon(fb, sh.x + (sh.w >> 1), 4, t, 'red', 3);
        const signX = sh.x + sh.w + 14;
        drawSign(fb, signX, 4, 'EMERGENCY POWER', wq ? 'REPAIRING' : weeklyReset, C.RED_L, C.RED_D, t, 'left', 2);
        fb.vline(signX + 6, 19, 5, C.STEEL_D); fb.vline(signX + 56, 19, 5, C.STEEL_D);
        const ctl = S.byId.control;
        if (ctl && rs === 'meltdown') drawSign(fb, ctl.rm.x + ctl.rm.w - 4, ctl.rm.y + 15, 'EMERGENCY', weeklyReset, C.RED_L, C.RED_D, t + 0.25, 'right', 2);
      }

      // -- limit-reached bursts --------------------------------------------------------
      for (const b of bursts) {
        const age = t - b.t0;
        if (b.scope === 'model') {
          const sp = S.byId[`machine:${b.modelKey}`], m = mByKey.get(b.modelKey);
          if (!sp || !m) continue;
          const a = ANCHOR(m.design);
          drawBurst(fb, sp.cx + a.fire[0], sp.rm.floorY + a.fire[1] - 6, age, b.seed, 1);
          a.sparks.forEach((p, i) => drawBurst(fb, sp.cx + p[0], sp.rm.floorY + p[1], age - 0.08 * (i + 1), b.seed + i + 1, 0.6));
        } else if (b.scope === 'session') {
          drawBurst(fb, S.sbCx, S.sbFloor - 30, age, b.seed, 1);
        } else {
          drawBurst(fb, S.hcx, S.hFloor - 40, age, b.seed, 1.7);
          RA.fire.forEach((f, i) => { if (i) drawBurst(fb, S.hcx + f[0], S.hFloor + f[1], age - 0.1 * i, b.seed + i, 0.8); });
        }
      }
      fb.clearClip();
    },

    /** @returns {import('./world.mjs').Pick|null} machine / reactor / switchboard / generator at (x, y) */
    pick(x, y, c) {
      const S = geo(c.layout);
      refresh(c.state);
      for (const sp of S.machineRooms) {
        if (!mByKey.has(sp.rm.modelKey)) continue;
        if (inBox(sp.machineBox, x, y) || inBox(sp.plate, x, y)) return { type: 'machine', modelKey: sp.rm.modelKey };
      }
      if (inBox(S.coreBox, x, y) || inBox(S.rPlate, x, y)) return { type: 'reactor' };
      if (inBox(S.sbBox, x, y) || inBox(S.sPlate, x, y)) return { type: 'switchboard' };
      if (c.state.generator.present && inBox(S.genBox, x, y)) return { type: 'generator' };
      return null;
    },

    /** Bounding box {x, y, w, h} of a machine / reactor / switchboard / generator pick, or null. */
    locate(pick, c) {
      if (!pick) return null;
      const S = geo(c.layout);
      refresh(c.state);
      if (pick.type === 'machine') {
        const sp = S.byId[`machine:${pick.modelKey}`];
        return sp && mByKey.has(pick.modelKey) ? boxCopy(sp.machineBox) : null;
      }
      if (pick.type === 'reactor') return boxCopy(S.coreBox);
      if (pick.type === 'switchboard') return boxCopy(S.sbBox);
      if (pick.type === 'generator') return c.state.generator.present ? boxCopy(S.genBox) : null;
      return null;
    },
  };
}
