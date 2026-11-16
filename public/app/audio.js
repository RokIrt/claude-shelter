// Sound (WebAudio): a soundscape synthesised from oscillators, noise and filters.
// No audio files. Starts muted; the AudioContext is created and resumed only in
// unlock() (called from a user gesture) and only while sound is on. Every method is a
// no-op, and never throws, when audio is unavailable.
//
//   one-shots ─► sfx ─┐
//   bed layers ─► bed ┴► master ─► limiter ─► analyser ─► speakers
//
// The bed follows ShelterState through smoothed parameter glides; anything rhythmic
// (thumps, clicks, ticks, beeps, klaxon, crackle) runs on a small look-ahead scheduler
// against ctx.currentTime, because state only arrives four times a second.

const MASTER = 0.3;            // master volume, before the limiter
const MAX_SHOTS = 10;          // one-shot voices alive at once
const MAX_BED_NOTES = 24;      // scheduled bed notes alive at once
const LOOKAHEAD = 0.12;        // seconds of rhythm scheduled ahead
const TICK_MS = 30;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function createAudio() {
  let ctx = null, master = null, limiter = null, analyser = null, bed = null, sfx = null;
  let noise = null;
  let muted = true;
  let failed = false;
  let state = null;
  let suspendTimer = 0;
  const shots = [];             // end times of live one-shot voices
  const bedNotes = [];          // end times of live scheduled bed notes
  const lastShot = new Map();   // rate limiting: key -> ctx time of the last one
  const layers = new Map();     // modelKey -> machine layer
  const clocks = {};            // rhythm name -> next note time
  let hum = null, fx = null;

  // ── plumbing ─────────────────────────────────────────────────────────────
  function init() {
    if (ctx) return true;
    if (failed) return false;
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) { failed = true; return false; }
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0;
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 4;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.2;
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      bed = gain(0.9);
      sfx = gain(1);
      bed.connect(master);
      sfx.connect(master);
      master.connect(limiter);
      limiter.connect(analyser);
      analyser.connect(ctx.destination);
      noise = makeNoise();
      buildBed();
      setInterval(tick, TICK_MS);
      return true;
    } catch {
      failed = true;
      try { ctx?.close(); } catch { /* ignore */ }
      ctx = null;
      return false;
    }
  }

  const running = () => !!ctx && !muted && ctx.state === 'running';
  const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  function filter(type, freq, q = 0.7) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  }
  function osc(type, freq) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; return o; }
  function glide(param, value, tc = 0.25) {
    try { param.setTargetAtTime(value, ctx.currentTime, tc); } catch { /* ignore */ }
  }
  function makeNoise() {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function noiseSrc(loop = false) {
    const s = ctx.createBufferSource();
    s.buffer = noise; s.loop = loop;
    return s;
  }
  /** Reserve a voice slot until `end`; false when the cap is reached. */
  function claim(list, cap, end) {
    const now = ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) if (list[i] <= now) list.splice(i, 1);
    if (list.length >= cap) return false;
    list.push(end);
    return true;
  }
  /** Envelope gain: silent -> peak in `a`, held for `hold`, exponential fall over `d`. */
  function envGain(t, peak, a, d, hold = 0, dest = sfx) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    if (hold > 0) g.gain.setValueAtTime(Math.max(0.0002, peak), t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
    g.connect(dest);
    return g;
  }
  /** Start sources at t, stop them at end, and disconnect the whole voice afterwards. */
  function play(sources, nodes, t, end) {
    let left = sources.length;
    for (const s of sources) {
      s.onended = () => {
        if (--left > 0) return;
        for (const n of [...sources, ...nodes]) { try { n.disconnect(); } catch { /* ignore */ } }
      };
      if (s.buffer) s.start(t, Math.random() * 1.5); else s.start(t);
      s.stop(end);
    }
  }
  /** A pitched blip: oscillator (with optional pitch sweep) through an envelope. */
  function blip(t, { type = 'sine', f0, f1 = f0, sweep = 0.1, peak, a = 0.004, d = 0.15, hold = 0, dest = sfx, lp = 0 }) {
    const end = t + a + hold + d + 0.03;
    const g = envGain(t, peak, a, d, hold, dest);
    const o = osc(type, f0);
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + sweep);
    const nodes = [g];
    if (lp) { const f = filter('lowpass', lp); o.connect(f); f.connect(g); nodes.push(f); } else o.connect(g);
    play([o], nodes, t, end);
    return end;
  }
  /** A noise burst through a filter (optionally sweeping) and an envelope. */
  function burst(t, { type = 'bandpass', f0, f1 = f0, sweep = 0.1, q = 1, peak, a = 0.002, d = 0.05, hold = 0, dest = sfx }) {
    const end = t + a + hold + d + 0.03;
    const g = envGain(t, peak, a, d, hold, dest);
    const f = filter(type, f0, q);
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + sweep);
    const s = noiseSrc();
    s.connect(f); f.connect(g);
    play([s], [f, g], t, end);
    return end;
  }

  // ── the continuous bed ───────────────────────────────────────────────────
  function lfo(rate, depth, target, type = 'sine') {
    const o = osc(type, rate), g = gain(depth);
    o.connect(g); g.connect(target); o.start();
    return [o, g];
  }

  function buildBed() {
    // Shelter hum: two slightly detuned saws and an octave sine, lowpassed.
    const humOut = gain(0), humLp = filter('lowpass', 160, 0.8);
    const h1 = osc('sawtooth', 55), h2 = osc('sawtooth', 55.35), h3 = osc('sine', 110);
    const h3g = gain(0.5);
    h1.connect(humLp); h2.connect(humLp); h3.connect(h3g); h3g.connect(humLp);
    humLp.connect(humOut); humOut.connect(bed);
    for (const o of [h1, h2, h3]) o.start();
    hum = { out: humOut, lp: humLp, oscs: [h1, h2, h3] };

    // Fire: a low roar plus scheduled crackles, both through one bus.
    const fireBus = gain(0); fireBus.connect(bed);
    const roar = noiseSrc(true), roarF = filter('bandpass', 380, 0.6), roarG = gain(0.35);
    roar.connect(roarF); roarF.connect(roarG); roarG.connect(fireBus); roar.start();

    // Switchboard strain: a mains buzz with a nervous flutter.
    const buzzOut = gain(0), buzzAm = gain(0.7), buzzBp = filter('bandpass', 900, 0.6), buzzHp = filter('highpass', 160);
    const b1 = osc('sawtooth', 100), b2 = osc('square', 150);
    const b2g = gain(0.25);
    b1.connect(buzzHp); b2.connect(b2g); b2g.connect(buzzHp);
    buzzHp.connect(buzzBp); buzzBp.connect(buzzAm); buzzAm.connect(buzzOut); buzzOut.connect(bed);
    b1.start(); b2.start();
    lfo(7.3, 0.3, buzzAm.gain, 'square');

    // Emergency: a slow siren and a deep rumble.
    const sirenOut = gain(0), sirenBp = filter('bandpass', 760, 0.7);
    const siren = osc('triangle', 640);
    siren.connect(sirenBp); sirenBp.connect(sirenOut); sirenOut.connect(bed); siren.start();
    lfo(0.21, 230, siren.frequency);
    const rumbleOut = gain(0), rumbleMod = gain(0.8), rumbleLp = filter('lowpass', 75, 1.2);
    const rumble = noiseSrc(true);
    rumble.connect(rumbleLp); rumbleLp.connect(rumbleMod); rumbleMod.connect(rumbleOut); rumbleOut.connect(bed); rumble.start();
    lfo(0.13, 0.35, rumbleMod.gain);

    // Backup generator: a low chugging engine.
    const genOut = gain(0), genAm = gain(0.55), genLp = filter('lowpass', 240, 1);
    const eng = osc('sawtooth', 46);
    eng.connect(genLp); genLp.connect(genAm); genAm.connect(genOut); genOut.connect(bed); eng.start();
    lfo(8.5, 0.45, genAm.gain, 'square');

    fx = { fireBus, buzzOut, sirenOut, rumbleOut, genOut, hot: 0, fire: 0, klaxon: 0, amber: false };
  }

  // One signature layer per machine design, mixed by the machine's speed.
  function makeLayer(design) {
    const out = gain(0);
    out.connect(bed);
    const L = { design, out, level: 0, base: 0.05, nodes: [], interval: null, play: null, step: 0, whirr: null };
    if (design === 'fable') {
      // glassy shimmer: high partials, each breathing on its own slow tremolo
      L.base = 0.045;
      const hp = filter('highpass', 700);
      hp.connect(out);
      L.nodes.push(hp);
      for (const [f, r] of [[1046.5, 0.31], [1568, 0.47], [2093 * 1.003, 0.71], [2637.0, 0.23], [3136 * 0.998, 0.59]]) {
        const o = osc('sine', f), g = gain(0.22);
        o.connect(g); g.connect(hp); o.start();
        L.nodes.push(o, g, ...lfo(r, 0.2, g.gain));
      }
    } else if (design === 'opus') {
      L.base = 0.55;                                   // slow heavy thumps
      L.interval = () => 1.5 - 0.7 * L.level;
      L.play = (t) => thump(t, out);
    } else if (design === 'sonnet') {
      L.base = 0.4;                                    // rhythmic servo clicks
      L.interval = () => 0.24 - 0.08 * L.level;
      L.play = (t) => servo(t, L);
    } else if (design === 'haiku') {
      L.base = 0.3;                                    // quick light ticks
      L.interval = () => 0.16 - 0.07 * L.level;
      L.play = (t) => tickBlip(t, L);
    } else {
      L.base = 0.05;                                   // a plain whirr
      const bp = filter('bandpass', 650, 0.9);
      bp.connect(out);
      const o1 = osc('sawtooth', 110), o2 = osc('sawtooth', 110.9);
      o1.connect(bp); o2.connect(bp); o1.start(); o2.start();
      L.whirr = [o1, o2];
      L.nodes.push(bp, o1, o2, ...lfo(5.5, 1.6, o1.frequency), ...lfo(4.9, 1.4, o2.frequency));
    }
    L.retire = () => {
      glide(out.gain, 0, 0.12);
      L.level = 0; L.play = null;
      setTimeout(() => {
        for (const n of L.nodes) { try { n.stop?.(); } catch { /* ignore */ } try { n.disconnect(); } catch { /* ignore */ } }
        try { out.disconnect(); } catch { /* ignore */ }
      }, 1500);
    };
    return L;
  }

  function thump(t, dest) {
    if (!claim(bedNotes, MAX_BED_NOTES, t + 0.7)) return;
    blip(t, { f0: 80, f1: 34, sweep: 0.32, peak: 0.9, a: 0.01, d: 0.55, dest });
    burst(t, { type: 'lowpass', f0: 220, peak: 0.25, d: 0.12, dest });
  }
  function servo(t, L) {
    const pattern = [1, 0, 1, 0, 1, 1, 0, 1];
    const step = L.step++ % pattern.length;
    if (!pattern[step] || !claim(bedNotes, MAX_BED_NOTES, t + 0.2)) return;
    burst(t, { f0: 2600, q: 3, peak: 0.5, d: 0.018, dest: L.out });
    if (step === 4) blip(t, { type: 'square', f0: 360, f1: 620, sweep: 0.1, peak: 0.08, a: 0.01, d: 0.12, lp: 1400, dest: L.out });
  }
  function tickBlip(t, L) {
    const step = L.step++;
    if (Math.random() < 0.18 || !claim(bedNotes, MAX_BED_NOTES, t + 0.05)) return;
    blip(t, { f0: step % 2 ? 4100 : 3300, peak: 0.45, a: 0.002, d: 0.016, dest: L.out });
  }

  function applyBed() {
    if (!ctx || !state || !hum) return;
    const s = state;
    const gen = !!s.generator?.running;
    const power = s.power;
    const live = power === 'normal' || gen;
    const speed = clamp01(s.speed ?? 0);
    glide(hum.out.gain, live ? 0.035 + 0.11 * speed : power === 'pitstop' ? 0.007 : 0, 0.5);
    glide(hum.lp.frequency, 130 + 520 * speed, 0.6);
    glide(hum.oscs[0].frequency, 52 + 6 * speed, 0.8);
    glide(hum.oscs[1].frequency, 52.35 + 6 * speed, 0.8);

    const seen = new Set();
    for (const m of s.machines ?? []) {
      seen.add(m.modelKey);
      let L = layers.get(m.modelKey);
      if (!L || L.design !== m.design) { L?.retire(); L = makeLayer(m.design); layers.set(m.modelKey, L); }
      L.level = m.powered ? clamp01(m.speed) : 0;
      glide(L.out.gain, L.level * L.base, 0.35);
      if (L.whirr) for (const o of L.whirr) glide(o.frequency, 85 + 70 * L.level, 0.5);
    }
    for (const [k, L] of layers) if (!seen.has(k)) { L.retire(); layers.delete(k); }

    fx.hot = (s.machines ?? []).filter((m) => m.status === 'hot').length;
    fx.fire = (s.machines ?? []).filter((m) => m.status === 'fire').length;
    glide(fx.fireBus.gain, fx.fire ? 0.14 + 0.05 * Math.min(2, fx.fire - 1) : 0, 0.5);
    glide(fx.buzzOut.gain, s.switchboard?.status === 'warn' && live ? 0.03 : 0, 0.3);
    const r = s.reactor;
    fx.klaxon = r && (r.status === 'hot' || r.status === 'critical') && power !== 'emergency' ? clamp01(r.heat) : 0;
    const emergency = power === 'emergency';
    glide(fx.sirenOut.gain, emergency ? 0.035 : 0, 0.7);
    glide(fx.rumbleOut.gain, emergency ? 0.5 : 0, 0.9);
    fx.amber = power === 'pitstop' && !gen;
    glide(fx.genOut.gain, gen ? 0.06 : 0, 0.6);
  }

  // Look-ahead scheduler for everything rhythmic.
  function rhythm(name, on, interval, playAt) {
    if (!on) { clocks[name] = 0; return; }
    const now = ctx.currentTime;
    if (!clocks[name] || clocks[name] < now) clocks[name] = now + 0.05;
    while (clocks[name] < now + LOOKAHEAD) {
      playAt(clocks[name]);
      clocks[name] += Math.max(0.02, interval());
    }
  }
  function tick() {
    if (!running() || !fx) return;
    try {
      for (const [k, L] of layers) if (L.play) rhythm(`m:${k}`, L.level > 0.01, L.interval, L.play);
      rhythm('hot', fx.hot > 0, () => 2.4, hotBeep);
      rhythm('crackle', fx.fire > 0, () => 0.025 + Math.random() * 0.14 / Math.min(3, fx.fire), crackle);
      rhythm('klaxon', fx.klaxon > 0, () => 1.9 - 1.2 * clamp01((fx.klaxon - 0.6) / 0.4), klaxon);
      rhythm('amber', fx.amber, () => 1.05, amberTick);
    } catch { /* never let the scheduler die */ }
  }

  function hotBeep(t) {
    if (!claim(bedNotes, MAX_BED_NOTES, t + 0.6)) return;
    blip(t, { f0: 1320, peak: 0.06, a: 0.01, hold: 0.07, d: 0.09, dest: bed });
    if (fx.hot > 1) blip(t + 0.24, { f0: 990, peak: 0.05, a: 0.01, hold: 0.07, d: 0.09, dest: bed });
  }
  function crackle(t) {
    if (!claim(bedNotes, MAX_BED_NOTES, t + 0.05)) return;
    burst(t, { type: 'highpass', f0: 1200 + Math.random() * 3000, q: 0.8, peak: 0.08 + Math.random() * 0.3, d: 0.004 + Math.random() * 0.018, dest: fx.fireBus });
  }
  function klaxon(t) {
    if (!claim(bedNotes, MAX_BED_NOTES, t + 0.6)) return;
    const peak = 0.04 + 0.05 * fx.klaxon;
    blip(t, { type: 'square', f0: 160, f1: 205, sweep: 0.22, peak, a: 0.04, hold: 0.26, d: 0.14, lp: 700, dest: bed });
    blip(t, { type: 'square', f0: 120, f1: 154, sweep: 0.22, peak: peak * 0.7, a: 0.04, hold: 0.26, d: 0.14, lp: 500, dest: bed });
  }
  function amberTick(t) {
    if (!claim(bedNotes, MAX_BED_NOTES, t + 0.05)) return;
    burst(t, { f0: 1800, q: 2, peak: 0.07, d: 0.008, dest: bed });
    blip(t, { f0: 1150, peak: 0.02, d: 0.01, dest: bed });
  }

  // ── one-shots ────────────────────────────────────────────────────────────
  /** When to play a one-shot of this key (rate limited, short queue), or null to drop it. */
  function slot(key, gap, maxAhead = 0) {
    const now = ctx.currentTime;
    const last = lastShot.get(key) ?? -Infinity;
    const t = Math.max(now + 0.01, last + gap);
    if (t - now > maxAhead + 0.011) return null;
    lastShot.set(key, t);
    return t;
  }
  function shot(key, gap, dur, maxAhead, fn) {
    const t = slot(key, gap, maxAhead);
    if (t == null || !claim(shots, MAX_SHOTS, t + dur)) return;
    fn(t);
  }

  function ding(t, pitch = 1) {     // elevator bell: a few inharmonic partials
    const f = 1318.5 * pitch;
    for (const [m, p, d] of [[1, 0.2, 1.4], [2.0, 0.05, 0.8], [2.76, 0.07, 0.6], [5.4, 0.025, 0.3]]) {
      blip(t, { f0: f * m, peak: p, a: 0.003, d });
    }
  }
  function chime(t) {               // soft descending pair
    blip(t, { type: 'triangle', f0: 784, peak: 0.08, a: 0.01, d: 0.6 });
    blip(t + 0.15, { type: 'triangle', f0: 587.3, peak: 0.07, a: 0.01, d: 0.8 });
  }
  function clunk(t, weight = 1) {   // heavy lever: thud + metal click, then the catch
    burst(t, { type: 'lowpass', f0: 380 * weight, peak: 0.45 * weight, d: 0.09 });
    blip(t, { f0: 140, f1: 55, sweep: 0.08, peak: 0.35 * weight, d: 0.12 });
    burst(t, { f0: 3000, q: 4, peak: 0.16, d: 0.015 });
    burst(t + 0.11, { type: 'lowpass', f0: 600, peak: 0.2 * weight, d: 0.05 });
    burst(t + 0.11, { f0: 2400, q: 4, peak: 0.1, d: 0.012 });
  }
  function chirp(t) {
    for (const dt of [0, 0.14]) blip(t + dt, { type: 'square', f0: 900, f1: 1550, sweep: 0.08, peak: 0.07, a: 0.005, d: 0.09, lp: 3200 });
  }
  function popWhoosh(t) {           // a machine blows: pop, then a whoosh of flame
    burst(t, { type: 'highpass', f0: 700, peak: 0.45, d: 0.06 });
    blip(t, { f0: 240, f1: 48, sweep: 0.12, peak: 0.45, d: 0.16 });
    burst(t + 0.03, { f0: 380, f1: 2600, sweep: 0.35, q: 1.3, peak: 0.28, a: 0.25, d: 0.9 });
  }
  function breakerDown(t) {         // breaker clunk, then the power-down whine
    clunk(t, 1.4);
    blip(t + 0.12, { type: 'sawtooth', f0: 900, f1: 50, sweep: 1.6, peak: 0.1, a: 0.02, d: 1.7, lp: 1600 });
  }
  function explosion(t) {           // reactor meltdown
    burst(t, { type: 'highpass', f0: 900, peak: 0.5, d: 0.09 });
    burst(t, { type: 'lowpass', f0: 2400, f1: 60, sweep: 2.4, q: 0.9, peak: 0.95, a: 0.015, d: 3.0 });
    blip(t, { f0: 58, f1: 26, sweep: 2.0, peak: 0.6, a: 0.02, d: 2.6 });
  }
  function resetJingle(t) {         // cooling hiss, then a bright power-up arpeggio
    burst(t, { type: 'highpass', f0: 6000, f1: 1800, sweep: 1.0, q: 0.7, peak: 0.12, a: 0.06, d: 1.0 });
    const notes = [523.3, 659.3, 784, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      const last = i === notes.length - 1;
      blip(t + 0.9 + i * 0.085, { type: 'square', f0: f, peak: 0.06, a: 0.004, d: last ? 0.5 : 0.16, lp: 3600 });
      blip(t + 0.9 + i * 0.085, { type: 'triangle', f0: f / 2, peak: 0.05, a: 0.004, d: last ? 0.5 : 0.16 });
    });
  }
  function sputter(t, starting = true) {   // engine catching (or dying)
    const gaps = starting ? [0.24, 0.3, 0.17, 0.2, 0.12, 0.1, 0.08, 0.07, 0.06, 0.06, 0.06] : [0.08, 0.1, 0.14, 0.2, 0.3];
    let at = t;
    gaps.forEach((g, i) => {
      if (!(starting && i === 2)) {      // one misfire
        const p = (starting ? 0.18 + 0.02 * i : 0.3 - 0.05 * i) * (0.8 + Math.random() * 0.4);
        burst(at, { type: 'lowpass', f0: 260, peak: p, d: 0.05 });
        blip(at, { f0: 62, f1: 45, sweep: 0.05, peak: p * 0.8, d: 0.07 });
      }
      at += g;
    });
  }

  function playEvent(e) {
    const scope = e.scope ?? '';
    switch (e.type) {
      case 'agent_arrived': return shot('arrive', 0.16, 1.5, 0.35, (t) => ding(t, 1 + 0.06 * ((lastShot.size + Math.floor(t * 7)) % 3)));
      case 'agent_left': return shot('left', 0.2, 1.1, 0.3, chime);
      case 'agent_model_changed': return shot('model', 0.25, 0.3, 0.25, (t) => clunk(t));
      case 'limit_warning': return shot(`warn:${scope}:${e.modelKey ?? ''}`, 1, 0.4, 0, chirp);
      case 'limit_reached':
        if (scope === 'weekly') return shot('reach:weekly', 2, 3.2, 0, explosion);
        if (scope === 'session') return shot('reach:session', 2, 2, 0, breakerDown);
        return shot(`reach:model:${e.modelKey ?? ''}`, 1, 1.3, 0, popWhoosh);
      case 'limit_reset': return shot(`reset:${scope}:${e.modelKey ?? ''}`, 1.5, 1.9, 0, resetJingle);
      case 'generator_started': return shot('gen', 1.5, 2, 0, (t) => sputter(t, true));
      case 'generator_stopped': return shot('gen', 1.5, 1, 0, (t) => sputter(t, false));
      default: return undefined;
    }
  }

  // ── public interface ─────────────────────────────────────────────────────
  const api = {
    /** Call from a user gesture: browsers only allow audio to start after one. Safe to repeat. */
    unlock() {
      try {
        if (muted || !init()) return;          // while muted the context stays absent or suspended
        clearTimeout(suspendTimer);
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        applyBed();
        glide(master.gain, MASTER, 0.3);
      } catch { /* never throw */ }
    },

    setMuted(m) {
      try {
        muted = !!m;
        if (!ctx) return;                      // nothing exists yet: unlock() builds it
        clearTimeout(suspendTimer);
        if (muted) {
          master.gain.cancelScheduledValues(ctx.currentTime);
          glide(master.gain, 0, 0.03);
          suspendTimer = setTimeout(() => { if (muted && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 300);
        } else {
          if (ctx.state !== 'running') ctx.resume().catch(() => {});
          applyBed();
          glide(master.gain, MASTER, 0.3);
        }
      } catch { /* never throw */ }
    },

    /** Continuous soundscape from the latest ShelterState (machine hum, alarms, sirens). */
    update(next) {
      state = next ?? null;
      try { if (running()) applyBed(); } catch { /* never throw */ }
    },

    /** One-shot sounds for a ShelterEvent (arrival chime, breaker trip, reset jingle...). */
    event(e) {
      if (!e || !running()) return;            // dropped while muted: nothing bursts out on unmute
      try { playEvent(e); } catch { /* never throw */ }
    },
  };

  // Debug handle (console): __shelterAudio.stats() reports level and voices;
  // __shelterAudio.test({type:'limit_reached', scope:'weekly'}) plays a one-shot.
  try {
    Object.defineProperty(globalThis, '__shelterAudio', {
      configurable: true,
      value: {
        stats() {
          if (!ctx) return { context: 'none', muted, failed };
          const buf = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(buf);
          let peak = 0, sum = 0;
          for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
          const now = ctx.currentTime;
          return {
            context: ctx.state, muted, master: Math.round(master.gain.value * 1000) / 1000,
            peak: Math.round(peak * 1000) / 1000, rms: Math.round(Math.sqrt(sum / buf.length) * 1000) / 1000,
            limiterDb: Math.round((limiter.reduction ?? 0) * 10) / 10,
            shots: shots.filter((x) => x > now).length, bedNotes: bedNotes.filter((x) => x > now).length,
            layers: [...layers].map(([k, L]) => `${k}:${L.design}:${L.level.toFixed(2)}`),
            fx: fx && { hot: fx.hot, fire: fx.fire, klaxon: Math.round(fx.klaxon * 100) / 100, amber: fx.amber },
          };
        },
        test(e) { if (running()) playEvent(e); },
      },
    });
  } catch { /* ignore */ }

  return api;
}
