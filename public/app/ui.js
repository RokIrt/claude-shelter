// HUD (DOM): status bar, allowance meters, alerts, inspector, raw token telemetry,
// what-if preview and controls, laid out around the canvas.
// Built once, then patched in place on every update (about four times a second).
// The interface (createUI and the methods on what it returns) is the contract with main.js.
import { h, text, attr, show, style, keyed } from './ui-dom.js';
import * as T from './ui-text.js';
import { SCENARIO_INFO } from '/src/shared/scenarios.mjs';
import { computeLayout } from '/src/world/layout.mjs';
import { C, css } from '/src/gfx/palette.mjs';

const HOUR = 3_600_000;
const LOG_MIN = -2, LOG_MAX = 2;   // what-if slider works on log2(multiplier): x0.25 .. x4

// Full-mode chrome geometry. arrange() does its sums with these numbers and hands them
// to the stylesheet as custom properties, so the layout and the sums always agree.
const TOP_H = 38;                  // status bar
const CARD_H = 60;                 // one allowance meter card
const CARD_MIN_W = 156;
const CARD_GAP = 4;
const METERS_CHROME = 34;          // meters panel: borders 4 + caption 22 + gaps 8
const SIDE_MIN = 300, SIDE_MAX = 460;
const STAGE_MIN_W = 620;           // keep clear of main.js's compact threshold (stage < 560 px)
const STAGE_MIN_ASPECT = 0.85;     // ... and of its aspect threshold (0.8)
const DOCK_MIN = 170;              // stacked arrangement: room kept for the panels under the stage

const LEVEL_RANK = { ok: 0, warn: 1, critical: 2, exhausted: 3 };
const ALERT_WORD = { critical: 'CRITICAL', warn: 'WARNING', info: 'INFO' };
const LIVE_TEXT = { ok: 'connected', connecting: 'connecting…', lost: 'connection lost', unavailable: 'no server' };
const LIVE_SHORT = { ok: '●', connecting: '…', lost: '✕', unavailable: '✕' };
const POWER_TEXT = {
  normal: ['Power: normal', 'Pwr OK'],
  pitstop: ['Pit stop: session limit', 'Pit stop'],
  emergency: ['Emergency power', 'Emergency'],
};
const MACHINE_STATUS = {
  idle: ['Idle', 'Idle: powered, nobody working on it', 'dim'],
  running: ['Running', 'Running', 'good'],
  hot: ['Hot', 'Running hot: its allowance is getting low', 'warn'],
  fire: ['On fire', 'On fire: its allowance is used up', 'bad'],
  pitstop: ['Pit stop', 'Stopped: the switchboard tripped (session limit)', 'warn'],
  emergency: ['No power', 'Stopped: the reactor is down (weekly limit)', 'bad'],
};
const REACTOR_STATUS = {
  ok: ['Stable', 'good'], hot: ['Running hot', 'warn'], critical: ['Critical', 'bad'], meltdown: ['Meltdown', 'bad'],
};
const SWITCH_STATUS = {
  ok: ['Closed', 'Closed: power is flowing', 'good'],
  warn: ['Under strain', 'Under strain: the session allowance is getting low', 'warn'],
  tripped: ['Tripped', 'Tripped: pit stop until the session resets', 'bad'],
};
const ACTIVITY = {
  code: 'Writing code', shell: 'Running shell commands', research: 'Researching the code',
  web: 'Browsing the web', review: 'Reviewing', plan: 'Planning', delegate: 'Delegating to subagents',
  think: 'Thinking', idle: 'Idle',
};
const RES_STATUS = { working: ['Working', 'good'], waiting: ['Waiting for input', 'dim'], done: ['Finished', 'dim'] };

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const samePick = (a, b) => !!a && !!b && a.type === b.type && a.id === b.id && a.modelKey === b.modelKey;

/** Expose the game's exact palette to the stylesheet as --black, --amber-l, --red-l ... */
function paintPalette() {
  const st = document.documentElement.style;
  for (const [name, idx] of Object.entries(C)) st.setProperty(`--${name.toLowerCase().replace(/_/g, '-')}`, css(idx));
}

/** A segmented allowance bar: used fill plus a hatched projection up to the reset. */
function limitBar(cls = '') {
  const proj = h('span', { class: 'bar-proj' });
  const fill = h('span', { class: 'bar-fill' });
  const el = h('span', { class: `bar ${cls}`, 'aria-hidden': 'true' }, proj, fill);
  return {
    el,
    set(lim) {
      if (!lim) { style(fill, 'width', '0%'); style(proj, 'width', '0%'); el.dataset.level = 'none'; return; }
      const p = clamp(Number(lim.percent) || 0, 0, 100);
      let atReset = null;
      if (lim.level !== 'exhausted' && lim.ratePctPerHour != null && lim.resetInMs != null) {
        atReset = lim.percent + (lim.ratePctPerHour * lim.resetInMs) / HOUR;
      }
      style(fill, 'width', `${p}%`);
      style(proj, 'width', `${atReset == null ? p : clamp(atReset, p, 100)}%`);
      el.dataset.level = lim.level;
      el.dataset.over = atReset != null && atReset >= 100 ? 'true' : 'false';
    },
  };
}

/**
 * @param {{root: HTMLElement, actions: {
 *   setWhatIf(mult:number):void,
 *   setSource(src:{kind:'live'}|{kind:'sim', name:string}):void,
 *   setMuted(muted:boolean):void,
 *   setLayout(mode:'auto'|'full'|'compact'):void,
 *   select(pick:object|null):void,
 * }}} opts
 */
export function createUI({ root, actions }) {
  paintPalette();
  const doc = document.documentElement;
  const app = root.closest('#app') ?? root.parentElement ?? document.body;
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('screen');
  const params = new URLSearchParams(location.search);

  let state = null;
  let liveStatus = 'connecting';
  let src = null;
  let selection = null;
  let lastResident = null;          // {r, now}: last sighting of the inspected resident
  let whatIf = 1;
  // createUI is not told the initial settings: mirror main.js's URL rules.
  let muted = params.get('sound') !== 'on';
  let layoutPref = params.get('layout') ?? 'auto';
  let compact = doc.dataset.layout === 'compact';
  let drawerOpen = false;
  let knownAlerts = null;           // alert ids already seen (null: next update is a fresh baseline)
  let meterCount = 5;
  let reveal = false;               // scroll the selection into view on the next track()
  let tagW = 0;
  let tickerPick = null;

  // ── status bar ───────────────────────────────────────────────────────────
  const srcLong = h('span', { class: 'long' }), srcShort = h('span', { class: 'short' });
  const srcBadge = h('span', { class: 'src-badge' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), srcLong, srcShort);
  const pwrLong = h('span', { class: 'long' }), pwrShort = h('span', { class: 'short' });
  const powerChip = h('span', { class: 'power-chip' }, h('span', { class: 'lamp', 'aria-hidden': 'true' }), pwrLong, pwrShort);
  const tickLvl = h('span', { class: 'tick-lvl' }), tickText = h('span', { class: 'tick-text' }), tickMore = h('span', { class: 'tick-more' });
  const ticker = h('button', { type: 'button', class: 'ticker', hidden: true, onclick: () => tickerPick && actions.select(tickerPick) }, tickLvl, tickText, tickMore);
  const sndLong = h('span', { class: 'long' }), sndShort = h('span', { class: 'short' });
  const soundBtn = h('button', { type: 'button', class: 'btn sound-btn', 'aria-label': 'Sound', onclick: () => setSound(muted) },
    h('span', { 'aria-hidden': 'true' }, '♪'), sndLong, sndShort);
  const menuBtn = h('button', { type: 'button', class: 'btn menu-btn', 'aria-controls': 'hud-side', 'aria-expanded': 'false', onclick: () => setDrawer(!drawerOpen) }, 'Menu');
  const brand = h('h1', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), h('span', { class: 'brand-text' }, 'Token Shelter'));
  const mini = h('div', { class: 'mini-meters' });
  const miniMsg = h('div', { class: 'mini-msg', hidden: true });
  const linePrev = h('span', { class: 'line-preview', hidden: true });
  const lineLvl = h('span', { class: 'line-lvl' });
  const lineText = h('span', { class: 'line-text' });
  const lineMore = h('span', { class: 'line-more' });
  const alertLine = h('button', { type: 'button', class: 'alert-line', 'aria-controls': 'hud-side', onclick: () => setDrawer(true, pAlerts) }, linePrev, lineLvl, lineText, lineMore);
  const top = h('header', { class: 'hud-top' },
    h('div', { class: 'top-row' }, brand, srcBadge, powerChip, ticker, h('span', { class: 'spacer' }), soundBtn, menuBtn),
    h('div', { class: 'mini-row' }, mini, miniMsg),
    alertLine);

  // ── allowance meters ─────────────────────────────────────────────────────
  const prevBadge = h('span', { class: 'preview-badge', hidden: true });
  const prevNote = h('span', { class: 'preview-note', hidden: true }, 'forecast preview only: actual consumption is unchanged');
  const staleTag = h('span', { class: 'stale-tag', hidden: true });
  const meterMsg = h('div', { class: 'meter-msg', hidden: true });
  const meterList = h('div', { class: 'meter-list' });
  const meters = h('section', { class: 'panel hud-meters', 'aria-labelledby': 'cap-meters' },
    h('div', { class: 'cap' },
      h('h2', { id: 'cap-meters' }, 'Allowance'), h('span', { class: 'cap-sub' }, 'plan usage per limit'),
      prevBadge, prevNote, h('span', { class: 'spacer' }), staleTag),
    meterMsg, meterList);

  // ── side panels ──────────────────────────────────────────────────────────
  const capOf = (id, title, ...extra) => h('div', { class: 'cap' }, h('h2', { id: `cap-${id}` }, title), ...extra);
  const section = (id, ...kids) => h('section', { class: `panel p-${id}`, 'aria-labelledby': `cap-${id}` }, ...kids);

  const alertCount = h('span', { class: 'cap-count' });
  const alertEmpty = h('p', { class: 'empty' }, 'All systems nominal.');
  const alertList = h('ul', { class: 'alert-list' });
  const pAlerts = section('alerts', capOf('alerts', 'Alerts', alertCount), alertEmpty, alertList);

  const iKind = h('span', { class: 'i-kind' });
  const iChip = h('span', { class: 'chip' });
  const iClose = h('button', { type: 'button', class: 'btn i-close', 'aria-label': 'Close inspector', title: 'Close (Esc)', onclick: () => actions.select(null) }, 'Close ✕');
  const iTitle = h('h2', { class: 'i-title', id: 'cap-inspector' });
  const iNote = h('p', { class: 'i-note', hidden: true });
  const iBar = limitBar('big');
  const iBarLegend = h('span', { class: 'bar-legend' }, h('i', { class: 'lg-used' }), 'used', h('i', { class: 'lg-proj' }), 'projected by the reset');
  const iBarWrap = h('div', { class: 'i-bar', hidden: true }, iBar.el, iBarLegend);
  const iRows = h('dl', { class: 'i-rows' });
  const pInspector = h('section', { class: 'panel p-inspector', hidden: true, 'aria-labelledby': 'cap-inspector' },
    h('div', { class: 'cap' }, h('span', { class: 'cap-title' }, 'Inspector'), iKind, h('span', { class: 'spacer' }), iClose),
    h('div', { class: 'i-head' }, iTitle, iChip), iNote, iBarWrap, iRows);

  const td = () => h('td');
  const tRate = { input: td(), output: td(), cacheRead: td() };
  const tTot = { input: td(), output: td(), cacheRead: td(), cacheWrite: td() };
  const tMachines = h('tbody', { class: 'per-machine' });
  const th = (t, scope = 'col') => h('th', { scope }, t);
  const pTelemetry = section('telemetry',
    capOf('telemetry', 'Token telemetry', h('span', { class: 'cap-sub' }, 'raw counts, not allowance')),
    h('p', { class: 'fine' }, 'Plan limits are not a fixed token tank: these raw counts do not convert into allowance %.'),
    h('table', { class: 'tele' },
      h('caption', {}, 'Throughput per minute'),
      h('thead', {}, h('tr', {}, th(''), th('In'), th('Out'), th('Cache rd'))),
      h('tbody', {}, h('tr', { class: 'total' }, th('Shelter', 'row'), tRate.input, tRate.output, tRate.cacheRead)),
      tMachines),
    h('table', { class: 'tele' },
      h('caption', {}, 'Running totals'),
      h('thead', {}, h('tr', {}, th(''), th('In'), th('Out'), th('Cache rd'), th('Cache wr'))),
      h('tbody', {}, h('tr', { class: 'total' }, th('Shelter', 'row'), tTot.input, tTot.output, tTot.cacheRead, tTot.cacheWrite))));

  const slider = h('input', { type: 'range', id: 'whatif-slider', class: 'slider', min: LOG_MIN, max: LOG_MAX, step: '0.05', value: '0', 'aria-describedby': 'whatif-help' });
  const wiOut = h('output', { class: 'wi-out', for: 'whatif-slider' }, 'x1');
  const wiState = h('span', { class: 'wi-state' });
  const wiReset = h('button', { type: 'button', class: 'btn', onclick: () => setWhatIfLocal(1) }, 'Reset to x1');
  const pWhatIf = section('whatif',
    capOf('whatif', 'What-if', h('span', { class: 'cap-sub' }, 'usage-rate preview')),
    h('label', { class: 'wi-label', for: 'whatif-slider' }, 'Preview usage at ', wiOut, ' the current rate'),
    slider,
    h('div', { class: 'wi-ticks', 'aria-hidden': 'true' }, ...['x0.25', 'x0.5', 'x1', 'x2', 'x4'].map((t) => h('span', {}, t))),
    h('div', { class: 'wi-foot' }, wiState, wiReset),
    h('p', { class: 'fine', id: 'whatif-help' }, 'Recomputes forecasts and machine heat as if usage ran at this multiple. It is only a preview: it does not change actual consumption.'));
  slider.addEventListener('input', () => setWhatIfLocal(sliderMult(Number(slider.value)), true));

  const srcSel = h('select', { id: 'src-select', class: 'sel' });
  srcSel.addEventListener('change', () => {
    const v = srcSel.value;
    actions.setSource(v === 'live' ? { kind: 'live' } : { kind: 'sim', name: v.slice(4) });
  });
  const srcBlurb = h('p', { class: 'fine src-blurb' });
  const layoutInputs = ['auto', 'full', 'compact'].map((mode) => {
    const inp = h('input', { type: 'radio', name: 'hud-layout', value: mode });
    inp.addEventListener('change', () => { if (inp.checked) { layoutPref = mode; actions.setLayout(mode); } });
    return inp;
  });
  const sound2 = h('button', { type: 'button', class: 'btn sound-btn', 'aria-label': 'Sound', onclick: () => setSound(muted) });
  const pControls = section('controls',
    capOf('controls', 'Controls'),
    h('div', { class: 'ctl' }, h('label', { for: 'src-select' }, 'Data source'), srcSel),
    srcBlurb,
    h('fieldset', { class: 'seg' }, h('legend', {}, 'Layout'),
      ...layoutInputs.map((inp, i) => h('label', {}, inp, h('span', {}, ['Auto', 'Full', 'Compact'][i])))),
    h('div', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Sound'), sound2));

  const drawerHead = h('div', { class: 'drawer-head' }, h('span', {}, 'Shelter menu'),
    h('button', { type: 'button', class: 'btn', onclick: () => setDrawer(false) }, 'Close ✕'));
  const side = h('aside', { class: 'hud-side', id: 'hud-side', 'aria-label': 'Shelter details' },
    drawerHead, pAlerts, pInspector, pTelemetry, pWhatIf, pControls);
  const sheet = h('div', { class: 'hud-sheet' });
  const toasts = h('div', { class: 'hud-toasts', role: 'status', 'aria-live': 'polite' });
  const announcer = h('div', { class: 'sr-only', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  const tag = h('div', { class: 'sel-tag', hidden: true, 'aria-hidden': 'true' });

  root.append(top, meters, side, sheet, toasts, announcer);
  stage?.append(tag);

  // ── settings mirrors ─────────────────────────────────────────────────────
  function syncSound() {
    for (const b of [soundBtn, sound2]) {
      attr(b, 'aria-pressed', muted ? 'false' : 'true');
      b.dataset.on = muted ? 'false' : 'true';
    }
    text(sndLong, muted ? 'Sound off' : 'Sound on');
    text(sndShort, muted ? 'Off' : 'On');
    text(sound2, muted ? '♪ Off: click to turn on' : '♪ On: click to mute');
    attr(soundBtn, 'title', muted ? 'Turn sound on' : 'Turn sound off');
  }
  function setSound(on) {
    muted = !on;
    syncSound();
    actions.setMuted(muted);
  }
  function syncLayout() { for (const inp of layoutInputs) inp.checked = inp.value === layoutPref; }

  function sliderMult(v) {
    if (Math.abs(v) < 0.04) return 1;
    const m = 2 ** clamp(v, LOG_MIN, LOG_MAX);
    return m >= 1 ? Math.round(m * 10) / 10 : Math.round(m * 20) / 20;   // friendly stops: x1.7, x0.85
  }
  function setWhatIfLocal(m, fromSlider = false) {
    whatIf = m;
    if (!fromSlider) slider.value = String(clamp(Math.log2(m), LOG_MIN, LOG_MAX));
    actions.setWhatIf(m);          // re-derives synchronously and calls update() when data exists
    renderWhatIf();
  }

  function setDrawer(open, scrollTo) {
    drawerOpen = !!open && compact;
    app.dataset.drawer = drawerOpen ? 'open' : 'closed';
    attr(menuBtn, 'aria-expanded', drawerOpen ? 'true' : 'false');
    text(menuBtn, drawerOpen ? 'Close' : 'Menu');
    if (drawerOpen && scrollTo) scrollTo.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && drawerOpen) setDrawer(false); });

  // ── layout: full (wide | tall | stack) or compact ────────────────────────
  // main.js picks full/compact from #stage's size, so the stage this HUD leaves must
  // never push it across its thresholds (stage < 560 px wide or aspect < 0.8),
  // otherwise the two would flip each other back and forth.
  let fullKey = null, fullDims = { w: 480, h: 312 };
  function fullSize() {
    const keys = state?.machines?.map((m) => m.modelKey) ?? [];
    const k = keys.join(',');
    if (k !== fullKey) {
      fullKey = k;
      try { const L = computeLayout('full', keys); fullDims = { w: L.w, h: L.h }; } catch { /* keep the last */ }
    }
    return fullDims;
  }
  function metersRow(width) {
    const n = Math.max(1, meterCount);
    const cols = Math.max(1, Math.floor((width - 16 + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
    const rows = Math.ceil(n / cols);
    return { h: METERS_CHROME + rows * CARD_H + (rows - 1) * CARD_GAP, cols: Math.min(cols, n) };
  }
  let arrSig = '';
  function arrange() {
    compact = doc.dataset.layout === 'compact';
    if (compact) { app.dataset.arr = 'compact'; arrSig = 'compact'; return; }
    const vw = window.innerWidth, vh = window.innerHeight;
    const { w, h: wh } = fullSize();
    const gut = stage ? Math.max(0, stage.offsetWidth - stage.clientWidth) : 16;
    const m = metersRow(vw);
    const fit = (sw, sh) => Math.max(1, Math.floor(Math.min((sw - gut) / w, sh / wh)));
    const swSide = vw - SIDE_MIN;
    const shWide = vh - TOP_H - m.h, shTall = vh - TOP_H, shStack = vh - TOP_H - m.h - DOCK_MIN;
    const cands = [];
    if (swSide >= STAGE_MIN_W && swSide / shWide >= STAGE_MIN_ASPECT) cands.push({ arr: 'wide', s: fit(swSide, shWide), sh: shWide });
    if (swSide >= STAGE_MIN_W && swSide / shTall >= STAGE_MIN_ASPECT) cands.push({ arr: 'tall', s: fit(swSide, shTall), sh: shTall });
    cands.push({ arr: 'stack', s: fit(vw, shStack), sh: shStack });
    let best = cands[0];
    for (const c of cands) if (c.s > best.s) best = c;      // ties keep the earlier (roomier) one

    let sideW = SIDE_MIN, stageMin = 0, dockMax = 0;
    if (best.arr === 'stack') {
      stageMin = clamp(best.s * wh, 160, Math.max(160, vh - TOP_H - m.h - 120));
      dockMax = Math.max(120, vh - TOP_H - m.h - stageMin);
    } else {
      sideW = clamp(vw - best.s * w - gut - 2, SIDE_MIN, SIDE_MAX);
      sideW = Math.max(SIDE_MIN, Math.min(sideW, vw - Math.max(STAGE_MIN_W, Math.ceil(STAGE_MIN_ASPECT * best.sh))));
    }
    app.dataset.arr = best.arr;
    style(app, '--top-h', `${TOP_H}px`);
    style(app, '--card-h', `${CARD_H}px`);
    style(app, '--meters-h', `${m.h}px`);
    style(app, '--meter-cols', String(m.cols));
    style(app, '--side-w', `${Math.round(sideW)}px`);
    style(app, '--stage-min', `${Math.round(stageMin)}px`);
    style(app, '--dock-max', `${Math.round(dockMax)}px`);
    arrSig = `${best.arr}:${m.cols}:${meterCount}`;
  }

  function applyMode() {
    compact = doc.dataset.layout === 'compact';
    if (compact) {
      side.insertBefore(meters, pAlerts.nextSibling);
      sheet.append(pInspector);
    } else {
      root.insertBefore(meters, side);
      side.insertBefore(pInspector, pAlerts.nextSibling);
    }
    setDrawer(false);
    arrange();
    render();
  }
  new MutationObserver(() => { if ((doc.dataset.layout === 'compact') !== compact || !app.dataset.arr) applyMode(); })
    .observe(doc, { attributes: true, attributeFilter: ['data-layout'] });
  if (canvas) new MutationObserver(() => arrange()).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  window.addEventListener('resize', () => arrange());
  new ResizeObserver(() => style(app, '--strip-h', `${top.offsetHeight}px`)).observe(top);

  // ── rendering ────────────────────────────────────────────────────────────
  function render() {
    renderTop();
    renderMeters();
    renderMini();
    renderAlerts();
    renderTelemetry();
    renderWhatIf();
    renderInspector();
    app.dataset.power = state?.power ?? 'normal';
    const sig = compact ? 'compact' : `${app.dataset.arr}:${metersRow(window.innerWidth).cols}:${meterCount}`;
    if (sig !== arrSig || fullKey !== (state?.machines?.map((m) => m.modelKey) ?? []).join(',')) arrange();
  }

  function renderTop() {
    const kind = src?.kind ?? (state?.source === 'simulation' ? 'sim' : 'live');
    srcBadge.dataset.kind = kind;
    if (kind === 'sim') {
      const name = src?.name ?? state?.scenario ?? 'tour';
      const info = SCENARIO_INFO[name];
      const label = info?.label ?? name;
      text(srcLong, `Simulation: ${label}`);
      text(srcShort, `Sim: ${label}`);
      srcBadge.dataset.status = 'sim';
      attr(srcBadge, 'title', `Simulated data, not your real usage. ${info?.blurb ?? ''}`.trim());
    } else {
      const ls = liveStatus ?? 'connecting';
      text(srcLong, `Live · ${LIVE_TEXT[ls] ?? ls}`);
      text(srcShort, `Live ${LIVE_SHORT[ls] ?? ''}`);
      srcBadge.dataset.status = ls;
      attr(srcBadge, 'title', 'Live telemetry from your AI coding activity');
    }

    const power = state?.power ?? 'normal';
    const gen = !!state?.generator?.running;
    powerChip.dataset.power = state ? power : 'unknown';
    const [pl, ps] = POWER_TEXT[power] ?? POWER_TEXT.normal;
    text(pwrLong, state ? (gen ? `${power === 'normal' ? 'Power: normal' : ps} · backup gen` : pl) : 'Power: --');
    text(pwrShort, state ? ps + (gen ? '+gen' : '') : '--');

    const alerts = state?.alerts ?? [];
    const lead = alerts.find((a) => a.level === 'critical') ?? alerts.find((a) => a.level === 'warn') ?? null;
    show(ticker, !!lead);
    app.dataset.alarm = alerts.some((a) => a.level === 'critical') ? 'critical' : lead ? 'warn' : 'none';
    if (lead) {
      ticker.dataset.level = lead.level;
      text(tickLvl, ALERT_WORD[lead.level]);
      text(tickText, lead.text);
      const more = alerts.filter((a) => a.level === lead.level).length - 1;
      text(tickMore, more > 0 ? `+${more}` : '');
      tickerPick = alertTarget(lead);
      attr(ticker, 'title', tickerPick ? `${lead.text} (click for details)` : lead.text);
    }
  }

  // Allowance cards: one per limit, the backup generator, and machines without an allowance.
  function meterItems(s) {
    const items = [];
    if (s.switchboard.limit) items.push({ kind: 'limit', key: s.switchboard.limit.id, lim: s.switchboard.limit, pick: { type: 'switchboard' } });
    if (s.reactor.limit) items.push({ kind: 'limit', key: s.reactor.limit.id, lim: s.reactor.limit, pick: { type: 'reactor' } });
    for (const m of s.machines) {
      if (m.limit) items.push({ kind: 'limit', key: m.limit.id, lim: m.limit, pick: { type: 'machine', modelKey: m.modelKey } });
    }
    if (s.generator.present) items.push({ kind: 'gen', key: 'gen', pick: { type: 'generator' } });
    const bare = s.machines.filter((m) => !m.limit);
    if (bare.length) items.push({ kind: 'bare', key: 'bare', machines: bare });
    return items;
  }

  function createMeter(it) {
    if (it.kind === 'bare') {
      const chips = h('span', { class: 'chips' });
      const el = h('div', { class: 'meter bare' },
        h('span', { class: 'm-head' }, h('span', { class: 'm-name' }, 'No own allowance')),
        chips,
        h('span', { class: 'm-foot' }, h('span', { class: 'm-fine' }, 'plan reports no separate limit')));
      el.__chips = chips;
      return el;
    }
    const name = h('span', { class: 'm-name' }), sub = h('span', { class: 'm-sub' });
    const pct = h('span', { class: 'm-pct' }), lvl = h('span', { class: 'm-lvl' });
    const bar = limitBar();
    // wide and narrow wordings; a container query on the card picks one
    const pair = (cls) => { const w = h('span', { class: 'wt' }), n = h('span', { class: 'nt' }); return { el: h('span', { class: cls }, w, n), w, n }; };
    const left = pair('m-reset'), fc = pair('m-fc'), fcx = h('span', { class: 'm-fcx' });
    const el = h('button', { type: 'button', class: `meter ${it.kind === 'gen' ? 'gen' : ''}` },
      h('span', { class: 'm-head' }, name, sub, h('span', { class: 'spacer' }), pct, lvl),
      bar.el,
      h('span', { class: 'm-foot' }, left.el, h('span', { class: 'spacer' }), fc.el, fcx));
    el.__p = { name, sub, pct, lvl, bar, left, fc, fcx };
    el.addEventListener('click', () => el.__pick && actions.select(el.__pick));
    return el;
  }

  function patchMeter(el, it, s) {
    if (it.kind === 'bare') {
      keyed(el.__chips, it.machines, (m) => m.modelKey, (m) => {
        const b = h('button', { type: 'button', class: 'chip-btn' });
        b.addEventListener('click', () => actions.select({ type: 'machine', modelKey: b.__key }));
        return b;
      }, (b, m) => {
        b.__key = m.modelKey;
        text(b, m.label);
        attr(b, 'title', `The plan reports no separate allowance for ${m.label}: it draws on the shared session and weekly limits. Click for details.`);
      });
      return;
    }
    const p = el.__p;
    el.__pick = it.pick;
    if (it.kind === 'gen') {
      const g = s.generator;
      const util = g.utilization != null ? g.utilization * 100 : null;
      const level = util == null ? 'ok' : util >= 100 ? 'exhausted' : util >= 92 ? 'critical' : util >= 80 ? 'warn' : 'ok';
      el.dataset.level = level;
      el.dataset.running = g.running ? 'true' : 'false';
      text(p.name, 'Backup gen'); text(p.sub, 'extra credits');
      text(p.pct, util == null ? '--' : T.pct(util));
      text(p.lvl, g.running ? 'RUNNING' : 'STANDBY'); p.lvl.dataset.level = g.running ? 'warn' : 'ok';
      p.bar.set(util == null ? null : { percent: util, level, ratePctPerHour: null, resetInMs: null });
      text(p.left.w, creditsText(g)); text(p.left.n, creditsText(g));
      text(p.fc.w, ''); text(p.fc.n, ''); text(p.fcx, '');
      attr(el, 'aria-label', `Backup generator (extra usage credits): ${g.running ? 'running' : 'on standby'}, ${creditsText(g)}. Open details.`);
      attr(el, 'title', 'Extra usage credits: keeps machines running once an included allowance is used up');
      return;
    }
    const L = it.lim;
    el.dataset.level = L.level;
    el.dataset.stale = L.stale ? 'true' : 'false';
    text(p.name, T.shortLabel(L));
    text(p.sub, T.metaphor(L));
    text(p.pct, T.pct(L.percent));
    text(p.lvl, T.levelWord(L)); p.lvl.dataset.level = L.level;
    p.bar.set(L);
    const cd = T.formatCountdown(L.resetInMs);
    const out = L.level === 'exhausted';
    text(p.left.w, L.resetInMs == null ? 'no reset time' : `${out ? 'back in' : 'reset'} ${cd}`);
    text(p.left.n, L.resetInMs == null ? 'no reset' : `${out ? 'back' : 'rst'} ${cd}`);
    const f = T.forecastShort(L);
    text(p.fc.w, f.main); text(p.fc.n, f.short ?? f.main); p.fc.el.dataset.tone = f.tone;
    text(p.fcx, f.extra);
    const resetSay = L.resetInMs != null && L.level !== 'exhausted' ? ` Resets in ${T.formatDuration(L.resetInMs)}.` : '';
    attr(el, 'aria-label', `${L.label} (${T.metaphor(L)}): ${T.pct(L.percent)} used, ${T.levelWord(L)}. ${L.forecast}.${resetSay}${L.stale ? ' Reading is stale.' : ''} Open details.`.replace('..', '.'));
    attr(el, 'title', `${L.label}: ${L.forecast}\nSolid: used. Hatched: projected use by the reset.`);
  }

  function renderMeters() {
    const s = state;
    let msg = null;
    if (!s) msg = waitingText();
    else if (!s.telemetry.known) msg = s.telemetry.error ? `No allowance data yet: ${s.telemetry.error}` : 'No allowance data yet: waiting for the first reading from your plan.';
    show(meterMsg, !!msg);
    if (msg) text(meterMsg, msg);
    const items = msg ? [] : meterItems(s);
    keyed(meterList, items, (it) => `${it.kind}:${it.key}`, createMeter, (el, it) => patchMeter(el, it, s));
    meterCount = Math.max(1, items.length);

    const stale = !!s && s.telemetry.known && s.telemetry.stale;
    show(staleTag, stale);
    meters.dataset.stale = stale ? 'true' : 'false';
    if (stale) text(staleTag, s.telemetry.at != null ? `Stale: last reading ${T.formatDuration(s.now - s.telemetry.at)} ago` : 'Stale readings');
  }

  function waitingText() {
    if (src?.kind === 'live' || (!src && state == null)) {
      if (liveStatus === 'lost') return 'Live telemetry connection lost: waiting to reconnect…';
      return 'Connecting to live telemetry…';
    }
    return 'Waiting for data…';
  }

  function renderMini() {
    if (!compact) return;
    const s = state;
    const max = window.innerWidth < 380 ? 3 : 4;
    let msg = null;
    const items = [];
    if (!s) msg = waitingText();
    else if (!s.telemetry.known) msg = 'No allowance data yet';
    else {
      if (s.switchboard.limit) items.push({ lim: s.switchboard.limit, pick: { type: 'switchboard' }, label: 'Session' });
      if (s.reactor.limit) items.push({ lim: s.reactor.limit, pick: { type: 'reactor' }, label: 'Weekly' });
      const ms = s.machines.filter((m) => m.limit)
        .sort((a, b) => LEVEL_RANK[b.limit.level] - LEVEL_RANK[a.limit.level] || b.limit.percent - a.limit.percent);
      for (const m of ms) { if (items.length >= max) break; items.push({ lim: m.limit, pick: { type: 'machine', modelKey: m.modelKey }, label: m.label }); }
    }
    show(miniMsg, !!msg);
    if (msg) text(miniMsg, msg);
    keyed(mini, items, (it) => it.lim.id, () => {
      const name = h('span', { class: 'mini-name' }), pct = h('span', { class: 'mini-pct' });
      const bar = limitBar('thin');
      const b = h('button', { type: 'button', class: 'mini' }, h('span', { class: 'mini-head' }, name, pct), bar.el);
      b.__p = { name, pct, bar };
      b.addEventListener('click', () => b.__pick && actions.select(b.__pick));
      return b;
    }, (b, it) => {
      const L = it.lim;
      b.__pick = it.pick;
      b.dataset.level = L.level;
      b.dataset.stale = L.stale ? 'true' : 'false';
      text(b.__p.name, it.label);
      text(b.__p.pct, L.level === 'exhausted' ? T.levelWord(L) : T.pct(L.percent));
      b.__p.bar.set(L);
      attr(b, 'aria-label', `${L.label}: ${T.pct(L.percent)} used, ${T.levelWord(L)}. ${L.forecast}`);
      attr(b, 'title', L.forecast);
    });

    const alerts = s?.alerts ?? [];
    const a = alerts[0] ?? null;
    alertLine.dataset.level = a?.level ?? (s ? 'ok' : 'none');
    text(lineLvl, a ? ALERT_WORD[a.level] : s ? 'OK' : '--');
    text(lineText, a ? a.text : s ? 'All systems nominal' : waitingText());
    text(lineMore, alerts.length > 1 ? `+${alerts.length - 1}` : '');
    attr(alertLine, 'aria-label', a ? `${ALERT_WORD[a.level]}: ${a.text}${alerts.length > 1 ? `, and ${alerts.length - 1} more` : ''}. Open the menu.` : 'No alerts. Open the menu.');
  }

  function alertTarget(a) {
    if (a.scope === 'model' && a.modelKey) return { type: 'machine', modelKey: a.modelKey };
    if (a.scope === 'session') return { type: 'switchboard' };
    if (a.scope === 'weekly') return { type: 'reactor' };
    if (a.scope === 'generator') return { type: 'generator' };
    return null;
  }

  function renderAlerts() {
    const alerts = state?.alerts ?? [];
    show(alertEmpty, alerts.length === 0);
    text(alertEmpty, state ? 'All systems nominal.' : waitingText());
    text(alertCount, alerts.length ? String(alerts.length) : '');
    alertCount.dataset.level = alerts[0]?.level ?? 'none';
    const baseline = knownAlerts == null;
    const seen = new Set();
    keyed(alertList, alerts, (a) => a.id, (a) => {
      const target = alertTarget(a);
      const lvl = h('span', { class: 'a-lvl' });
      const msg = h('span', { class: 'a-text' });
      const inner = target
        ? h('button', { type: 'button', class: 'alert' }, lvl, msg, h('span', { class: 'a-go', 'aria-hidden': 'true' }, '›'))
        : h('div', { class: 'alert' }, lvl, msg);
      if (target) inner.addEventListener('click', () => actions.select(inner.__pick));
      inner.__pick = target;
      const li = h('li', { class: 'alert-item' }, inner);
      li.__p = { inner, lvl, msg };
      return li;
    }, (li, a, fresh) => {
      const p = li.__p;
      p.inner.dataset.level = a.level;
      text(p.lvl, ALERT_WORD[a.level]);
      text(p.msg, a.text);
      if (fresh && !baseline) {
        li.classList.add('is-new');
        setTimeout(() => li.classList.remove('is-new'), 2400);
      }
    });
    for (const a of alerts) {
      seen.add(a.id);
      if (!baseline && !knownAlerts.has(a.id) && a.level !== 'info') announce(`${ALERT_WORD[a.level]}: ${a.text}`);
    }
    if (state) knownAlerts = seen;
  }

  function announce(msg) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = msg; }, 30);
  }

  function renderTelemetry() {
    const s = state;
    const r = s?.rate, t = s?.tokens;
    text(tRate.input, r ? T.formatTokens(r.input) : '--');
    text(tRate.output, r ? T.formatTokens(r.output) : '--');
    text(tRate.cacheRead, r ? T.formatTokens(r.cacheRead) : '--');
    for (const k of Object.keys(tTot)) text(tTot[k], t ? T.formatTokens(t[k]) : '--');
    keyed(tMachines, s?.machines ?? [], (m) => m.modelKey, () => {
      const cells = [h('th', { scope: 'row' }), td(), td(), td()];
      const tr = h('tr', {}, ...cells);
      tr.__c = cells;
      return tr;
    }, (tr, m) => {
      const [n, i, o, c] = tr.__c;
      text(n, m.label);
      text(i, T.formatTokens(m.rate.input));
      text(o, T.formatTokens(m.rate.output));
      text(c, T.formatTokens(m.rate.cacheRead));
      tr.dataset.idle = m.rate.output + m.rate.input + m.rate.cacheRead > 0 ? 'false' : 'true';
    });
  }

  function renderWhatIf() {
    if (state && Number.isFinite(state.whatIf)) whatIf = state.whatIf;
    if (document.activeElement !== slider) {
      const v = String(clamp(Math.log2(whatIf), LOG_MIN, LOG_MAX));
      if (slider.value !== v) slider.value = v;
    }
    const label = T.multLabel(whatIf);
    text(wiOut, label);
    attr(slider, 'aria-valuetext', `${label} the current usage rate (preview)`);
    const on = Math.abs(whatIf - 1) > 1e-6;
    text(wiState, on ? `PREVIEW ${label}: forecasts only` : 'Showing actual usage');
    wiState.dataset.on = on ? 'true' : 'false';
    show(prevBadge, on); show(prevNote, on);
    text(prevBadge, `Preview ${label}`);
    show(linePrev, on);
    text(linePrev, `Preview ${label}`);
    app.dataset.preview = on ? 'true' : 'false';
  }

  // ── inspector ────────────────────────────────────────────────────────────
  const row = (k, label, value, tone) => ({ k, label, value: value ?? '--', tone });
  const tokensLine = (tk) => `in ${T.formatTokens(tk.input)} · out ${T.formatTokens(tk.output)} · cache rd ${T.formatTokens(tk.cacheRead)} · cache wr ${T.formatTokens(tk.cacheWrite)}`;
  const rateLine = (rt) => `in ${T.perMin(rt.input)} · out ${T.perMin(rt.output)} · cache rd ${T.perMin(rt.cacheRead)}`;
  const toneOf = (lim) => (lim ? T.LEVEL_TONE[lim.level] : undefined);

  function limitRows(L, s) {
    return [
      row('allow', 'Allowance', `${T.pct(L.percent)} used · ${T.levelWord(L)}${L.stale ? ' (stale)' : ''}`, toneOf(L)),
      row('reset', 'Resets in', T.resetText(L, s.now)),
      row('reach', 'Reaches reset?', T.reachesText(L), L.survives === false ? 'bad' : L.survives === true ? 'good' : undefined),
      row('exh', 'Runs out', T.exhaustText(L), L.survives === false ? 'bad' : undefined),
      row('fc', 'Forecast', L.forecast),
      row('burn', 'Burn rate', T.burnText(L, s.whatIf)),
    ];
  }

  function noDataRows(s, what) {
    if (!s.telemetry.known) return [row('allow', 'Allowance', 'No allowance data yet', 'dim')];
    return [row('allow', 'Allowance', `The plan reports no ${what}`, 'dim')];
  }

  function residentView(s, id) {
    let r = s.residents.find((x) => x.id === id) ?? null;
    let gone = false;
    if (r) lastResident = { r, now: s.now };
    else if (lastResident?.r.id === id) { r = lastResident.r; gone = true; }
    if (!r) return { kind: 'Resident', title: 'Unknown resident', note: 'This resident is not in the shelter.', noteTone: 'dim', rows: [], tag: '' };
    const now = gone ? lastResident.now : s.now;
    const machine = s.machines.find((m) => m.modelKey === r.modelKey) ?? null;
    let note = null, noteTone = 'dim';
    if (gone) { note = `${r.name} has left the shelter. Showing the last reading.`; noteTone = 'warn'; }
    else if (r.status === 'done') note = `${r.name} has finished and is clocking out.`;
    else if (r.blocked && machine) {
      const why = {
        fire: `the ${machine.label} machine is on fire: its allowance is used up`,
        pitstop: 'the switchboard tripped (session limit): pit stop',
        emergency: 'the reactor is down (weekly limit): emergency power',
      }[machine.status] ?? `the ${machine.label} machine is not running`;
      note = `Blocked: ${why}.`;
      noteTone = 'bad';
    }
    const [st, stTone] = RES_STATUS[r.status] ?? [r.status, undefined];
    const rows = [
      row('role', 'Role', `${cap(r.role)} · ${r.kind === 'main' ? 'main agent' : 'subagent'}${r.agentType ? ` (${r.agentType})` : ''}`),
      row('task', 'Doing', r.task || '--'),
      row('act', 'Activity', `${ACTIVITY[r.activity] ?? r.activity}${r.tool ? ` · last tool: ${r.tool}` : ''}`),
    ];
    const parentHere = r.parentId && s.residents.some((x) => x.id === r.parentId);
    if (!r.parentId) rows.push(row('parent', 'Parent', 'None: a main agent'));
    else if (parentHere) rows.push({ k: 'parent', label: 'Parent', kind: 'link', value: r.parentName ?? r.parentId, pick: { type: 'resident', id: r.parentId } });
    else rows.push(row('parent', 'Parent', `${r.parentName ?? r.parentId} (not in the shelter)`));
    if (machine) rows.push({ k: 'model', label: 'Model', kind: 'link', value: `${machine.label} · ${r.model}`, pick: { type: 'machine', modelKey: machine.modelKey } });
    else rows.push(row('model', 'Model', r.model));
    rows.push(
      row('status', 'Status', gone ? 'Left the shelter' : `${st}${r.blocked ? ' · blocked' : ''}${r.stale ? ' · stale: no activity for over an hour' : ''} · mood: ${r.mood}`, gone || r.stale ? 'dim' : r.blocked ? 'bad' : stTone),
      row('proj', 'Project', r.project ?? '--'),
      row('run', 'Running for', T.elapsed(now - r.startedAt)),
      row('last', 'Last active', r.status === 'working' && !r.stale && !gone ? 'now' : `${T.elapsed(now - r.lastActiveAt)} ago`),
      row('tok', 'Tokens so far', tokensLine(r.tokens)),
      row('rate', 'Token rate', gone ? '--' : rateLine(r.rate)),
    );
    const kids = gone ? [] : s.residents.filter((x) => x.parentId === r.id);
    if (r.kind === 'main' && !gone) {
      rows.push({
        k: 'kids', label: `Subagents (${kids.length})`, kind: 'list', empty: 'None right now',
        items: kids.map((x) => ({ id: x.id, label: x.name, sub: x.status === 'done' ? 'finished' : ACTIVITY[x.activity] ?? x.activity, pick: { type: 'resident', id: x.id } })),
      });
    }
    return {
      kind: r.kind === 'main' ? 'Resident · main agent' : 'Resident · subagent', title: r.name,
      chip: gone ? 'Gone' : st, chipTone: gone ? 'dim' : r.blocked ? 'bad' : stTone,
      note, noteTone, rows, tag: r.name,
    };
  }

  function machineView(s, key) {
    const m = s.machines.find((x) => x.modelKey === key);
    if (!m) return { kind: 'Machine', title: cap(key), note: 'This machine is not in the shelter right now.', noteTone: 'dim', rows: [], tag: cap(key) };
    const [chip, long, tone] = MACHINE_STATUS[m.status] ?? [m.status, m.status, undefined];
    const rows = [row('status', 'Status', long, tone)];
    if (m.limit && s.telemetry.known) rows.push(...limitRows(m.limit, s), row('heat', 'Heat', `${Math.round(m.heat * 100)}%`, toneOf(m.limit)));
    else rows.push(...noDataRows(s, `separate allowance for ${m.label}: it draws on the shared session and weekly limits`));
    rows.push(
      row('thru', 'Throughput', rateLine(m.rate)),
      row('tot', 'Tokens so far', tokensLine(m.tokens)),
    );
    const here = m.residentIds.map((id) => s.residents.find((r) => r.id === id)).filter(Boolean);
    rows.push({
      k: 'res', label: `Working here (${here.length})`, kind: 'list', empty: 'Nobody at this machine right now',
      items: here.map((r) => ({ id: r.id, label: r.name, sub: r.blocked ? 'blocked' : ACTIVITY[r.activity] ?? r.activity, pick: { type: 'resident', id: r.id } })),
    });
    return {
      kind: `Machine · ${m.design}`, title: `${m.label} machine`, chip, chipTone: tone,
      limit: s.telemetry.known ? m.limit : null, rows, tag: m.label,
    };
  }

  function reactorView(s) {
    const R = s.reactor, L = R.limit;
    const [chip, tone] = REACTOR_STATUS[R.status] ?? [R.status, undefined];
    const rows = [row('status', 'Reactor', chip, tone)];
    if (L && s.telemetry.known) rows.push(...limitRows(L, s), row('heat', 'Heat', `${Math.round(R.heat * 100)}%`, toneOf(L)));
    else rows.push(...noDataRows(s, 'weekly allowance'));
    rows.push(
      row('power', 'Shelter power', POWER_TEXT[s.power]?.[0] ?? s.power, s.power === 'normal' ? 'good' : 'bad'),
      row('thru', 'Shelter throughput', rateLine(s.rate)),
    );
    let note = null;
    if (L && L.level === 'exhausted') note = 'Weekly allowance used up: the shelter is on emergency power until the reset.';
    else if (L && L.survives === false) note = `At this rate the shelter will NOT reach the weekly reset (${T.formatDuration(L.shortfallMs)} short).`;
    else if (L && L.survives === true) note = 'At this rate the shelter reaches the weekly reset.';
    return {
      kind: 'Weekly limit · all models', title: 'Central reactor', chip, chipTone: tone,
      note, noteTone: L?.survives === false ? 'bad' : 'good', limit: s.telemetry.known ? L : null, rows, tag: 'Reactor',
    };
  }

  function switchboardView(s) {
    const L = s.switchboard.limit;
    const [chip, long, tone] = SWITCH_STATUS[s.switchboard.status] ?? [s.switchboard.status, s.switchboard.status, undefined];
    const rows = [row('status', 'Switchboard', long, tone)];
    if (L && s.telemetry.known) rows.push(...limitRows(L, s));
    else rows.push(...noDataRows(s, 'session allowance'));
    const note = L?.level === 'exhausted' ? 'Session allowance used up: pit stop. Machines wait for the session reset.' : null;
    return {
      kind: 'Session limit', title: 'Power switchboard', chip, chipTone: tone,
      note, noteTone: 'warn', limit: s.telemetry.known ? L : null, rows, tag: 'Switchboard',
    };
  }

  function generatorView(s) {
    const g = s.generator;
    if (!g.present) {
      return {
        kind: 'Extra usage', title: 'Backup generator', chip: 'Not installed', chipTone: 'dim',
        note: 'Extra usage credits are not enabled, so there is no backup generator: when an allowance runs out, the machines stop.',
        noteTone: 'dim', rows: [], tag: 'Generator',
      };
    }
    const util = g.utilization != null ? g.utilization * 100 : null;
    const level = util == null ? 'ok' : util >= 100 ? 'exhausted' : util >= 92 ? 'critical' : util >= 80 ? 'warn' : 'ok';
    return {
      kind: 'Extra usage credits', title: 'Backup generator', chip: g.running ? 'Running' : 'Standby', chipTone: g.running ? 'warn' : 'good',
      note: g.running ? 'An included allowance is used up: the machines run on extra usage credits.' : 'Standing by: it starts when an included allowance is used up.',
      noteTone: g.running ? 'warn' : 'dim',
      limit: util == null ? null : { percent: util, level, ratePctPerHour: null, resetInMs: null },
      rows: [
        row('used', 'Credits used', creditsText(g)),
        row('util', 'Monthly limit used', util == null ? 'unknown' : T.pct(util), T.LEVEL_TONE[level]),
        row('cur', 'Currency', g.currency ?? 'not reported'),
      ],
      tag: 'Generator',
    };
  }

  // The plan reports credit amounts in minor units of `currency` (cents for USD).
  function money(minor, currency) {
    if (minor == null || !Number.isFinite(minor)) return '--';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
    } catch {
      return `${(minor / 100).toFixed(2)} ${currency}`;
    }
  }

  function creditsText(g) {
    if (g.usedCredits == null && g.monthlyLimit == null) return 'credits: unknown';
    if (g.currency) return `${money(g.usedCredits, g.currency)} / ${money(g.monthlyLimit, g.currency)}`;
    return `${T.num(g.usedCredits)} / ${g.monthlyLimit != null ? T.num(g.monthlyLimit) : '--'} credits`;
  }

  function viewFor(pick, s) {
    if (!s) return { kind: 'Inspector', title: '…', note: waitingText(), noteTone: 'dim', rows: [], tag: '' };
    switch (pick.type) {
      case 'resident': return residentView(s, pick.id);
      case 'machine': return machineView(s, pick.modelKey);
      case 'reactor': return reactorView(s);
      case 'switchboard': return switchboardView(s);
      case 'generator': return generatorView(s);
      default: return { kind: 'Inspector', title: String(pick.type), rows: [], tag: '' };
    }
  }

  function createRow(r) {
    const dt = h('dt'), dd = h('dd');
    const el = h('div', { class: 'i-row' }, dt, dd);
    el.__p = { dt, dd };
    if (r.kind === 'link') {
      const b = h('button', { type: 'button', class: 'link' });
      b.addEventListener('click', () => el.__pick && actions.select(el.__pick));
      dd.append(b);
      el.__p.btn = b;
    } else if (r.kind === 'list') {
      const ul = h('ul', { class: 'i-list' }), empty = h('span', { class: 'dim' });
      dd.append(empty, ul);
      Object.assign(el.__p, { ul, empty });
    }
    return el;
  }

  function patchRow(el, r) {
    const p = el.__p;
    text(p.dt, r.label);
    el.dataset.tone = r.tone ?? '';
    if (r.kind === 'link') { text(p.btn, r.value); el.__pick = r.pick; return; }
    if (r.kind === 'list') {
      show(p.empty, r.items.length === 0);
      text(p.empty, r.empty ?? 'None');
      keyed(p.ul, r.items, (it) => it.id, () => {
        const b = h('button', { type: 'button', class: 'link' }), sub = h('span', { class: 'sub' });
        const li = h('li', {}, b, sub);
        b.addEventListener('click', () => li.__pick && actions.select(li.__pick));
        li.__p = { b, sub };
        return li;
      }, (li, it) => { text(li.__p.b, it.label); text(li.__p.sub, it.sub ?? ''); li.__pick = it.pick; });
      return;
    }
    text(p.dd, r.value);
  }

  function renderInspector() {
    if (!selection) { show(pInspector, false); show(tag, false); return; }
    show(pInspector, true);
    const v = viewFor(selection, state);
    text(iKind, v.kind);
    text(iTitle, v.title);
    show(iChip, !!v.chip);
    text(iChip, v.chip ?? '');
    iChip.dataset.tone = v.chipTone ?? '';
    show(iNote, !!v.note);
    text(iNote, v.note ?? '');
    iNote.dataset.tone = v.noteTone ?? 'dim';
    show(iBarWrap, !!v.limit);
    if (v.limit) {
      iBar.set(v.limit);
      show(iBarLegend, v.limit.ratePctPerHour != null && v.limit.level !== 'exhausted');
    }
    keyed(iRows, v.rows, (r) => `${r.k}:${r.kind ?? 'text'}`, createRow, patchRow);
    if (tag.__text !== (v.tag || v.title)) tagW = 0;
    text(tag, v.tag || v.title);
  }

  // ── public interface ─────────────────────────────────────────────────────
  syncSound();
  syncLayout();
  arrange();
  render();

  return {
    /** New state (about 4 times a second). meta.liveStatus: connecting | ok | lost | unavailable. */
    update(next, meta) {
      state = next ?? null;
      if (meta?.liveStatus) liveStatus = meta.liveStatus;
      render();
    },

    /** The data source changed. info = {kind:'live'|'sim', name?, liveStatus, scenarios: string[]}. */
    setSource(info) {
      src = info ?? null;
      state = null;
      knownAlerts = null;
      if (info?.liveStatus) liveStatus = info.liveStatus;
      const names = info?.scenarios ?? Object.keys(SCENARIO_INFO);
      const sig = names.join(',');
      if (srcSel.__sig !== sig) {
        srcSel.__sig = sig;
        srcSel.replaceChildren(
          h('option', { value: 'live' }, 'Live telemetry'),
          h('optgroup', { label: 'Simulation' }, ...names.map((n) => h('option', { value: `sim:${n}` }, SCENARIO_INFO[n]?.label ?? n))));
      }
      srcSel.value = info?.kind === 'sim' ? `sim:${info.name}` : 'live';
      text(srcBlurb, info?.kind === 'sim'
        ? `${SCENARIO_INFO[info.name]?.blurb ?? ''} Simulated: not your real usage.`
        : 'Reads your real AI coding activity from the local telemetry server.');
      render();
    },

    /** Show details for a picked thing, or close with null. */
    inspect(pick) {
      const same = samePick(pick, selection);
      selection = pick ?? null;
      if (!same) { lastResident = null; reveal = !!selection; }
      renderInspector();
      if (selection && !same && !compact) {
        // Bring the inspector into view inside the side column, without moving the page.
        const box = side.getBoundingClientRect(), r = pInspector.getBoundingClientRect();
        if (r.top < box.top || r.top > box.bottom - 80) side.scrollTop += r.top - box.top - 4;
      }
    },

    /** Every frame while something is selected: its on-canvas box, for the name tag. */
    track(box, view) {
      const c = view?.canvas ?? canvas;
      if (!selection || !box || !c || !tag.textContent) { show(tag, false); return; }
      const s = view?.scale || 1;
      show(tag, true);
      if (!tagW) tagW = tag.offsetWidth;
      const left = c.offsetLeft, topY = c.offsetTop;
      const cx = left + (box.x + box.w / 2) * s;
      const above = box.y * s > 22;
      const y = topY + (above ? box.y * s - 5 : (box.y + box.h) * s + 5);
      const half = tagW / 2;
      const x = clamp(cx, left + half, Math.max(left + half, left + c.offsetWidth - half));
      tag.dataset.below = above ? 'false' : 'true';
      style(tag, 'transform', `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, ${above ? '-100%' : '0'})`);
      if (reveal && stage) {
        // Keep a fresh selection visible: the stage may scroll, and in compact mode the
        // inspector sheet covers its lower part.
        reveal = false;
        const covered = compact ? sheet.offsetHeight : 0;
        const y0 = topY + box.y * s, y1 = topY + (box.y + box.h) * s;
        const visTop = stage.scrollTop, visBottom = stage.scrollTop + stage.clientHeight - covered;
        if (y0 < visTop || y1 > visBottom) stage.scrollTo({ top: Math.max(0, y0 - 40) });
      }
    },

    /** Show a short transient message. */
    notify(msg) {
      const t = h('div', { class: 'toast' }, String(msg));
      toasts.append(t);
      while (toasts.children.length > 3) toasts.firstChild.remove();
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 5000);
    },
  };
}
