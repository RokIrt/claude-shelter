// Token Shelter: browser entry point. Wires data source -> derive -> world / HUD / audio.
import { Framebuffer } from '/src/gfx/fb.mjs';
import { createWorld } from '/src/world/world.mjs';
import { derive, diffStates } from '/src/shared/derive.mjs';
import { scenarioSnapshot, SCENARIOS } from '/src/shared/scenarios.mjs';
import { createPresenter } from './present.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const canvas = document.getElementById('screen');
const presenter = createPresenter(canvas);

// ── settings ────────────────────────────────────────────────────────────────
const settings = {
  whatIf: 1,                                    // usage-rate multiplier for forecasts and heat
  layout: params.get('layout') ?? 'auto',       // auto | full | compact
  muted: params.get('sound') !== 'on',
  source: params.get('sim') ? { kind: 'sim', name: params.get('sim') } : { kind: 'live' },
};

const world = createWorld({ layout: 'full' });
const audio = createAudio();
audio.setMuted(settings.muted);

// ── data source: live telemetry over SSE, or the built-in simulation ────────
let snapshot = null;          // latest Snapshot from the current source
let state = null;             // latest ShelterState
let prevState = null;         // previous one, for diffing (null after a source change)
let pendingEvents = [];
let live = null;              // EventSource
let liveStatus = 'connecting';// connecting | ok | lost | unavailable
let simStart = performance.now();

function stopLive() { if (live) { live.close(); live = null; } }

function startSource(src) {
  settings.source = src.kind === 'sim' ? { kind: 'sim', name: SCENARIOS.includes(src.name) ? src.name : 'tour' } : { kind: 'live' };
  snapshot = null; state = null; prevState = null; pendingEvents = [];
  if (selection) select(null);   // what was selected belongs to the old source
  stopLive();
  if (settings.source.kind === 'sim') {
    simStart = performance.now();
  } else {
    liveStatus = 'connecting';
    live = new EventSource('/api/events');
    live.onmessage = (e) => {
      try { snapshot = JSON.parse(e.data); liveStatus = 'ok'; } catch { /* ignore a bad frame */ }
    };
    live.onerror = () => {
      // Never connected: there is no telemetry server behind this page.
      if (liveStatus === 'connecting' && !snapshot) { liveStatus = 'unavailable'; stopLive(); startSource({ kind: 'sim', name: 'tour' }); ui.notify('No live telemetry server: showing the simulation.'); }
      else liveStatus = 'lost';
    };
  }
  ui.setSource({ ...settings.source, liveStatus, scenarios: SCENARIOS });
  const url = new URL(location.href);
  if (settings.source.kind === 'sim') url.searchParams.set('sim', settings.source.name); else url.searchParams.delete('sim');
  history.replaceState(null, '', url);
}

function refreshState() {
  if (settings.source.kind === 'sim') {
    snapshot = scenarioSnapshot(settings.source.name, (performance.now() - simStart) / 1000, Date.now());
  }
  if (!snapshot) return;
  state = derive(snapshot, { now: Date.now(), whatIf: settings.whatIf });
  const events = diffStates(prevState, state);
  // The first state after a (re)connect is not news: do not replay arrivals as sound.
  if (prevState) for (const e of events) audio.event(e);
  pendingEvents.push(...events);
  prevState = state;
  audio.update(state);
  ui.update(state, { liveStatus });
}

// ── HUD ─────────────────────────────────────────────────────────────────────
let selection = null;
function select(pick) {
  selection = pick;
  world.setSelection(pick);
  ui.inspect(pick);
}

const ui = createUI({
  root: document.getElementById('hud'),
  actions: {
    setWhatIf(mult) { settings.whatIf = Math.max(0.1, Math.min(10, Number(mult) || 1)); refreshState(); },
    setSource(src) { startSource(src); },
    setMuted(muted) { settings.muted = !!muted; audio.setMuted(settings.muted); if (!settings.muted) audio.unlock(); },
    setLayout(mode) { settings.layout = mode; fit(); },
    select,
  },
});

// ── canvas sizing: integer scale, layout chosen from the stage's shape ──────
let scale = 1;
function fit() {
  const availW = stage.clientWidth, availH = stage.clientHeight;
  const want = settings.layout === 'auto' ? (availW < 560 || availW / Math.max(1, availH) < 0.8 ? 'compact' : 'full') : settings.layout;
  if (world.layout !== want) world.setLayout(want);
  const { w, h } = world.size;
  // Fit the width; a tall shelter may scroll vertically inside the stage.
  scale = Math.max(1, Math.floor(Math.min(availW / w, Math.max(availH / h, 1))));
  if (w * scale > availW && scale > 1) scale--;
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
  document.documentElement.dataset.layout = want;
}
new ResizeObserver(fit).observe(stage);

function toLogical(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.floor(((ev.clientX - r.left) / r.width) * canvas.width), y: Math.floor(((ev.clientY - r.top) / r.height) * canvas.height) };
}
canvas.addEventListener('click', (ev) => {
  audio.unlock();
  const { x, y } = toLogical(ev);
  select(world.pick(x, y));
});
canvas.addEventListener('mousemove', (ev) => {
  const { x, y } = toLogical(ev);
  canvas.style.cursor = world.pick(x, y) ? 'pointer' : 'default';
});
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') select(null); });
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

// ── main loop ───────────────────────────────────────────────────────────────
let fb = new Framebuffer(world.size.w, world.size.h);
let last = performance.now();
let sinceRefresh = 1;

function frame(nowMs) {
  const dt = Math.min(0.1, (nowMs - last) / 1000);
  last = nowMs;
  sinceRefresh += dt;
  if (sinceRefresh >= 0.25) { sinceRefresh = 0; refreshState(); }

  world.update(dt, state, pendingEvents);
  pendingEvents = [];
  const { w, h } = world.size;
  if (fb.w !== w || fb.h !== h) { fb = new Framebuffer(w, h); fit(); }
  world.render(fb);
  presenter.present(fb);
  if (selection) ui.track?.(world.locate(selection), { scale, canvas });
  requestAnimationFrame(frame);
}

startSource(settings.source);
fit();
requestAnimationFrame(frame);

// Handy for debugging from the console.
window.shelter = { world, get state() { return state; }, get snapshot() { return snapshot; }, settings, select };
