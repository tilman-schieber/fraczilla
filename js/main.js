import { FB, fromDouble, toDouble, parseFixed, formatFixed } from './bigfixed.js?v=6c511792';
import { PALETTES, randomPalette } from './palettes.js?v=6c511792';
import { LOCATIONS, START } from './locations.js?v=6c511792';
import { Renderer, PROBE_MAXW, PROBE_H } from './renderer.js?v=6c511792';
import { FRACTALS, FAMILIES } from './fractals.js?v=6c511792';
import { asciiLogoSVG } from './logo.js?v=6c511792';
import { b64, bindFavs, cleanFav, favLoc, favs, jTab, openSaveFav } from './favorites.js?v=6c511792';
import { jpv, picture, setJuliaPreview, stepJuliaPreview } from './jpreview.js?v=6c511792';
import { FPS, OUTS, cancelHQ, closeRender, hq, lastVideo, movie, movieVideo, openRender, outOverride, prerenderJourney, renderImage, renderOpen, saveVideo, updateFrame } from './render.js?v=6c511792';
import { TOUR_KEEPS, startTour, stepTour, stopTour, tour } from './tour.js?v=6c511792';
import { buildTypeBrowser, closeTypes, openTypes, typesOpen } from './types.js?v=6c511792';

export const FORMULAS = FRACTALS;
const JULIA_SCALE = 1.6;
const DF_MIN_SCALE = 1e-10; // float types iterate in double-float past ~10^5x
export const MIN_SCALE = 1e-31, MAX_SCALE = 8, BAIL = 1000, HOME_SCALE = 1.25;

// zoom floor: float-only types run out of precision near 10^5x
const minScale = () => (S.f.deep ? MIN_SCALE : (S.f.minScale || DF_MIN_SCALE));
// Lyapunov forcing sequence as bits (B = 1), read from bit 0 upwards
export const seqBits = (seq) => [...(seq || 'A')].reduce((acc, ch, i) => acc | ((ch === 'B' ? 1 : 0) << i), 0);

const $ = (s) => document.querySelector(s);
export const canvas = $('#c');
$('#splashLogo').innerHTML = asciiLogoSVG();

function fatal(msg) {
  $('#errorMsg').textContent = msg;
  $('#error').classList.remove('hidden');
  $('#splash').classList.add('gone');
}

export let R;
try { R = new Renderer(canvas); } catch (e) { fatal(e.message); throw e; }

// ---------------------------------------------------------------- state
export const S = {
  f: FORMULAS[0], julia: false, jx: 0n, jy: 0n, saved: null,
  cx: 0n, cy: 0n, scale: HOME_SCALE,
  iterAuto: true, iterManual: 1000,
  pal: 0, palData: PALETTES[0].data,
  density: 0, offset: 0, cycling: false, cycleSpeed: 30,
  mapping: 1, smooth: true, light: true, lightAngle: 45, lightStr: 0.55, edge: 0, inside: 0,
  colorMode: 0, // STYLE: 0 classic escape time, 1 stripes, 2 orbit trap
  aa: true, hq: false, flySpeed: 1.4,
};
// the render panel's output size (OUTS lives in render.js)
try { const o = localStorage.getItem('fraczilla.out'); if (OUTS.some((q) => q.id === o)) S.out = o; } catch {}
S.out ||= 'window';
export let retroSaved = null;
let iterFloor = 0; // learned from the probe: how deep the current view really is

export const juliaHome = (f = S.f) => {
  const h = f.juliaHome || ['0', '0', JULIA_SCALE];
  return { x: parseFixed(h[0]), y: parseFixed(h[1]), s: h[2] };
};
function setHome(f = S.f) {
  if (S.julia) { const h = juliaHome(f); S.cx = h.x; S.cy = h.y; S.scale = h.s; return; }
  S.cx = parseFixed(f.home[0]); S.cy = parseFixed(f.home[1]); S.scale = f.home[2];
}

export function maxIter() {
  if (!S.iterAuto) return S.iterManual;
  const L = Math.max(0, Math.log10(HOME_SCALE / S.scale));
  const h = 250 + 90 * L + 9 * L * L;
  return Math.round(Math.min(200000, Math.max(h, iterFloor)) / 10) * 10;
}

// ---------------------------------------------------------------- reference orbit (worker)
export let worker, ref = null, pend = null, reqId = 0;
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./refworker.js?v=6c511792', import.meta.url));
  worker.onmessage = (e) => {
    const m = e.data;
    if (!pend || m.id !== pend.id) return;
    const next = { ...pend, lenA: m.lenA, offB: m.offB, lenB: m.lenB, escaped: m.escapedA, ms: m.ms, data: m.data, count: m.count };
    pend = null;
    // an "improvement" that turned out no better than the best we had: go back to that one
    const life = (r) => (r.escaped ? r.lenA : Infinity);
    if (next.improve && refEpoch.best && refEpoch.best.key === next.key && life(next) <= life(refEpoch.best) * 1.05) {
      if (ref !== refEpoch.best) { ref = refEpoch.best; R.uploadOrbit(ref.data, ref.count); invalidate(false); }
      return;
    }
    R.uploadOrbit(m.data, m.count);
    ref = next;
    if (!refEpoch.best || ref.key !== refEpoch.best.key || life(ref) > life(refEpoch.best)) refEpoch.best = ref;
    invalidate(false);
  };
  worker.onerror = (e) => console.error('ref worker', e);
  pend = null;
}
startWorker();

export const refKey = () => `${S.f.code}|${S.julia ? 1 : 0}|${S.julia ? S.jx + ',' + S.jy : ''}`;
const bitsNeeded = () => Math.max(64, Math.ceil(-Math.log2(S.scale)) + 56);

// Probe-driven "find a longer-lived reference" attempts are limited per view, so two
// candidates that each escape early can't take turns forever (that flickered).
const refEpoch = { cx: 0n, cy: 0n, scale: 0, tries: 0, best: null };
function refEpochCheck() {
  const moved = Math.hypot(toDouble(S.cx - refEpoch.cx), toDouble(S.cy - refEpoch.cy)) > S.scale * 0.5;
  const zoomed = !(S.scale > refEpoch.scale / 1.5 && S.scale < refEpoch.scale * 1.5);
  if (moved || zoomed) { refEpoch.cx = S.cx; refEpoch.cy = S.cy; refEpoch.scale = S.scale; refEpoch.tries = 0; refEpoch.best = ref; }
}

function requestRef(x, y, improve = false) {
  const F = Math.min(FB, bitsNeeded() + 24);
  const mi = Math.ceil(maxIter() * 1.5) + 100;
  pend = { id: ++reqId, key: refKey(), x, y, F, maxIter: mi, improve };
  worker.postMessage({
    id: pend.id, formula: S.f.code, julia: S.julia, F,
    rx: x.toString(), ry: y.toString(), jx: S.jx.toString(), jy: S.jy.toString(),
    maxIter: mi, bail2: BAIL * BAIL,
  });
}

function refReason() {
  if (!ref) return 'none';
  if (ref.key !== refKey()) return 'key';
  if (!ref.escaped && ref.maxIter < maxIter()) return 'iter';
  if (ref.F < bitsNeeded()) return 'prec';
  const d = Math.hypot(toDouble(S.cx - ref.x), toDouble(S.cy - ref.y));
  if (d > S.scale * 4) return 'far';
  return null;
}

function ensureRef() {
  if (!S.f.deep || !refReason()) return;
  if (pend) {
    if (pend.key === refKey()) return;
    startWorker();
  }
  requestRef(S.cx, S.cy);
}

// ---------------------------------------------------------------- view helpers
export let cssW = 1, cssH = 1;
const cssPix = () => 2 * S.scale / cssH;
export function screenOffset(px, py) {
  const k = cssPix();
  return [(px - cssW / 2) * k, (cssH / 2 - py) * k * S.f.ySign];
}
function zoomAt(px, py, factor) {
  const ns = Math.min(MAX_SCALE, Math.max(minScale(), S.scale * factor));
  const nf = ns / S.scale;
  const [ox, oy] = screenOffset(px, py);
  S.cx += fromDouble(ox * (1 - nf));
  S.cy += fromDouble(oy * (1 - nf));
  S.scale = ns;
}
function pan(dx, dy) {
  const k = cssPix();
  S.cx -= fromDouble(dx * k);
  S.cy += fromDouble(dy * k * S.f.ySign);
}

// ---------------------------------------------------------------- render scheduling
export let viewVer = 1, lowVer = 0, fullVer = 0, fullDone = 0, lowW = 1, lowH = 1, haveLow = false;
let lowScale = 0.5, stripRows = 32, aaFactor = 2;
let msPerRow = 0, dtHist = [];
export let lastMove = -1e9, colorDirty = true, lastProbe = 0, probedVer = 0;
let dtSmooth = 1 / 60;

export function invalidate(moving) {
  viewVer++;
  if (moving) lastMove = performance.now();
}


export function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = canvas.clientWidth; cssH = canvas.clientHeight;
  const W = outOverride ? outOverride.w : Math.max(16, Math.round(cssW * dpr));
  const H = outOverride ? outOverride.h : Math.max(16, Math.round(cssH * dpr));
  aaFactor = S.aa && W * H * 4 <= 16e6 ? 2 : 1;
  R.resize(W, H, aaFactor);
  invalidate(false);
  if (renderOpen()) updateFrame();
}
new ResizeObserver(resize).observe(canvas);

const compositeArgs = () => ({
  ...colorParams(),
  lowW, lowH, haveFull: fullVer === lowVer && fullDone > 0,
  doneY: Math.ceil((R.full.h - fullDone) / aaFactor),
});
// Crossfade: call right before a cut (another type, Julia set or overview); the
// picture on screen then fades out over the new one instead of vanishing at once.
const FADE_MS = 650;
const fade = { t: 1, t0: 0 };
export function crossfade() {
  if (!haveLow || hq || outOverride) return;
  R.snapshot(compositeArgs());
  fade.t = 0; fade.t0 = performance.now();
}

// Browser history: every jump (journey, saved view, Julia switch, type, reset) gets
// its own entry, so Back and Forward step through them. Zooming and panning only
// update the current entry (writeHash).
let histMute = false;
export function pushHistory() {
  if (histMute || hq) return;
  writeHash();
  history.pushState(null, '', location.hash);
}
addEventListener('popstate', () => {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('f')) return;
  const l = p.get('l') || '11';
  const fv = cleanFav({
    name: 'that view', f: p.get('f'), x: p.get('x'), y: p.get('y'), s: +p.get('s'),
    jx: p.get('jx') ?? undefined, jy: p.get('jy') ?? undefined,
    pal: PALETTES[+p.get('p')]?.name, d: +p.get('d') || 0, o: +p.get('o') || 0, m: +p.get('m'),
    light: l[0] === '1', smooth: l[1] !== '0', k: +p.get('k') || 0, i: p.has('i') ? +p.get('i') : undefined,
  });
  if (!fv) return;
  if (fv.pal == null && S.pal < 0) fv.pd = b64(S.palData); // a random palette never was in the link: keep it
  stopTour(); histMute = true;
  try { goLocation(favLoc(fv)); } finally { histMute = false; }
});

// STYLE needs an escaping orbit: not for root finders, Magnet, Lyapunov or Plasma
const STYLE_OFF = new Set([100, 101, 102, 103, 107, 108, 111]);
const STYLES = ['CLASSIC', 'STRIPES', 'ORBIT TRAP'];
export const styleOf = (f = S.f, mode = S.colorMode) => (STYLE_OFF.has(f.code) ? 0 : mode);
function setStyle(k) {
  if (S.colorMode === k) return;
  S.colorMode = k;
  invalidate(false); colorDirty = true; syncUI();
}
export function colorParams() {
  return {
    colorMode: styleOf(),
    density: Math.pow(2, S.density), offset: S.offset, mapping: S.mapping, smooth: S.smooth,
    light: S.light, lightAngle: S.lightAngle, lightStr: S.lightStr, edge: S.edge,
    inside: S.inside, insideColor: [0, 0, 0],
  };
}

function fractalParams() {
  const deep = S.f.deep && ref;
  return {
    formula: S.f.code, julia: S.julia,
    refOffX: deep ? toDouble(S.cx - ref.x) : 0, refOffY: deep ? toDouble(S.cy - ref.y) : 0,
    scale: S.scale, ySign: S.f.ySign, maxIter: maxIter(),
    lenA: deep ? ref.lenA : 0, offB: deep ? ref.offB : 0, lenB: deep ? ref.lenB : 0,
    bail: S.f.deep ? BAIL : (S.f.code === 102 || S.f.code === 103 ? 100 : 256), degree: S.f.degree,
    // lambda needs the reference's c (Mandelbrot mode) or λ (Julia mode); critical point 1/2
    cX: S.julia ? toDouble(S.jx) : deep ? toDouble(ref.x) : 0,
    cY: S.julia ? toDouble(S.jy) : deep ? toDouble(ref.y) : 0,
    crit: S.f.code === 7 ? 0.5 : 0,
    // float path
    centerX: toDouble(S.cx), centerY: toDouble(S.cy), jcX: toDouble(S.jx), jcY: toDouble(S.jy),
    seq: seqBits(S.f.seq), seqLen: (S.f.seq || 'A').length,
    colorMode: styleOf(),
  };
}

const animating = () => anim.flight || anim.zoom !== 0 || anim.vx !== 0 || anim.vy !== 0 || pointers.size > 0;

let lastT = performance.now(), fpsCount = 0, fpsT = 0, fps = 0, lastStatus = 0, lastHashVer = 0, lastHashT = 0;

function frame(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  dtSmooth += (dt - dtSmooth) * 0.2;
  dtHist.push(dt); if (dtHist.length > 90) dtHist.shift();
  for (const ms of R.timePoll()) msPerRow = msPerRow ? msPerRow * 0.5 + ms * 0.5 : ms;
  fpsCount++;
  if (now - fpsT > 500) { fps = Math.round(fpsCount * 1000 / (now - fpsT)); fpsCount = 0; fpsT = now; }

  animate(dt);
  stepJuliaPreview();
  if (S.cycling) {
    S.offset = ((S.offset + S.cycleSpeed * dt) % 256 + 256) % 256;
    colorDirty = true;
  }

  ensureRef();
  const refOk = !S.f.deep || (ref && ref.key === refKey());
  if (refOk) {
    const moving = now - lastMove < 160 || animating();
    const P = fractalParams();
    if (lowVer !== viewVer) {
      if (moving) {
        if (dtSmooth > 1 / 38) lowScale *= 0.9;
        else if (dtSmooth < 1 / 52) lowScale *= 1.04;
        lowScale = Math.min(1, Math.max(0.12, lowScale));
      }
      lowW = Math.max(8, Math.round(R.canvas.width * lowScale));
      lowH = Math.max(8, Math.round(R.canvas.height * lowScale));
      R.drawFractal(R.low, lowW, lowH, P);
      lowVer = viewVer; fullVer = viewVer; fullDone = 0; haveLow = true; colorDirty = true;
    } else if (!moving && fullDone < R.full.h) {
      // size the strip by measured GPU time when we can, else by frame pacing
      const budget = hq ? 70 : 14; // ms of GPU work per frame
      if (msPerRow > 0) stripRows = Math.max(1, Math.floor(budget / msPerRow));
      else {
        const base = Math.min(...dtHist);
        if (dt > base * 1.6 + 0.008) stripRows = Math.max(2, Math.floor(stripRows * 0.7));
        else if (dt < base * 1.25 + 0.003) stripRows = Math.ceil(stripRows * 1.3);
      }
      const rows = Math.max(1, Math.min(stripRows, R.full.h - fullDone));
      const y1 = R.full.h - fullDone;
      const q = R.timeStart();
      R.drawFractal(R.full, R.full.w, R.full.h, P, y1 - rows, y1);
      R.timeEnd(q, rows);
      fullDone += rows; colorDirty = true;
    }
    if (lowVer === viewVer && probedVer !== viewVer && now - lastProbe > 350) {
      lastProbe = now; probedVer = viewVer;
      analyzeProbe(P);
    }
  }
  if (fade.t < 1) {
    fade.t = Math.min(1, (now - fade.t0) / FADE_MS);
    colorDirty = true;
  }
  if (colorDirty && haveLow) {
    R.composite(compositeArgs());
    colorDirty = false;
    if (fade.t < 1 && !R.drawFade(1 - fade.t * fade.t * (3 - 2 * fade.t))) fade.t = 1;
  }
  if (now - lastStatus > 120) { lastStatus = now; updateStatus(refOk); }
  if (!animating() && now - lastMove > 600 && lastHashVer !== viewVer && now - lastHashT > 500) {
    lastHashVer = viewVer; lastHashT = now; writeHash();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- probe: smarter reference, auto iterations
function analyzeProbe(P) {
  const pw = Math.min(PROBE_MAXW, Math.max(16, Math.round(PROBE_H * R.canvas.width / R.canvas.height)));
  const buf = R.probe(P, pw);
  const n = pw * PROBE_H;
  const pp = 2 * S.scale / PROBE_H;
  const pt = (i) => {
    const px = i % pw, py = Math.floor(i / pw);
    return [(px + 0.5 - pw / 2) * pp, (py + 0.5 - PROBE_H / 2) * pp * S.f.ySign];
  };
  let maxEsc = -1, maxIdx = -1, interiorIdx = -1, interiorD = Infinity, interior = 0;
  for (let i = 0; i < n; i++) {
    const mu = buf[i * 4];
    if (mu < 0) {
      interior++;
      const [x, y] = pt(i), d = x * x + y * y;
      if (d < interiorD) { interiorD = d; interiorIdx = i; }
    } else if (mu > maxEsc) { maxEsc = mu; maxIdx = i; }
  }
  // auto iterations: the slowest-escaping visible pixel tells us how deep we are
  if (S.iterAuto) {
    let mn = Infinity;
    for (let i = 0; i < n; i++) { const mu = buf[i * 4]; if (mu >= 0 && mu < mn) mn = mu; }
    const before = maxIter();
    if (maxIdx < 0) iterFloor = Math.min(100000, Math.max(iterFloor, before * 2));
    else iterFloor = Math.min(200000, 2.5 * mn + 500);
    if (Math.abs(maxIter() - before) > before * 0.15) invalidate(false);
  }
  // pick a longer-lived reference if the current one escapes too early
  if (S.f.deep && ref) refEpochCheck();
  if (S.f.deep && ref && ref.escaped && ref.lenA < maxIter() && !pend && refEpoch.tries < 2) {
    const idx = interiorIdx >= 0 ? interiorIdx : (maxEsc > ref.lenA * 1.1 + 2 ? maxIdx : -1);
    if (idx >= 0) {
      refEpoch.tries++;
      const [ox, oy] = pt(idx);
      requestRef(S.cx + fromDouble(ox), S.cy + fromDouble(oy), true);
    }
  }
}

// ---------------------------------------------------------------- animation: wheel zoom, inertia, flights
export const anim = { zoom: 0, ax: 0, ay: 0, vx: 0, vy: 0, flight: null };

function animate(dt) {
  let moved = false;
  if (anim.zoom !== 0) {
    if (Math.abs(anim.zoom) < 1e-4) anim.zoom = 0;
    else {
      const step = anim.zoom * (1 - Math.exp(-dt * 12));
      anim.zoom -= step;
      zoomAt(anim.ax, anim.ay, Math.exp(step));
      moved = true;
    }
  }
  if (pointers.size === 0 && (anim.vx || anim.vy)) {
    if (Math.hypot(anim.vx, anim.vy) < 4) anim.vx = anim.vy = 0;
    else {
      pan(anim.vx * dt, anim.vy * dt);
      const k = Math.exp(-dt * 4.5);
      anim.vx *= k; anim.vy *= k;
      moved = true;
    }
  }
  if (anim.flight) { stepFlight(dt); moved = true; }
  stepLook(dt);
  stepTour();
  if (moved) invalidate(true);
}

export function stopMotion() {
  anim.zoom = 0; anim.vx = anim.vy = 0; anim.flight = null;
}

export function flyTo(x, y, s, speed = S.flySpeed) {
  stopMotion();
  const dx = toDouble(x - S.cx), dy = toDouble(y - S.cy);
  const u1 = Math.hypot(dx, dy), w0 = S.scale, w1 = s, rho = 1.5;
  const f = { sx: S.cx, sy: S.cy, tx: x, ty: y, dx, dy, u1, w0, w1, rho, t: 0 };
  if (u1 < 1e-9 * Math.max(w0, w1)) {
    f.pure = true;
    f.S = Math.abs(Math.log(w1 / w0)) / rho;
  } else {
    f.dirx = dx / u1; f.diry = dy / u1;
    const r2 = rho * rho, r4 = r2 * r2;
    const b0 = (w1 * w1 - w0 * w0 + r4 * u1 * u1) / (2 * w0 * r2 * u1);
    const b1 = (w1 * w1 - w0 * w0 - r4 * u1 * u1) / (2 * w1 * r2 * u1);
    f.r0 = -Math.asinh(b0); f.r1 = -Math.asinh(b1);
    f.S = (f.r1 - f.r0) / rho;
  }
  f.T = Math.max(0.9, f.S / speed);
  anim.flight = f;
}

function stepFlight(dt) {
  const f = anim.flight;
  f.t = Math.min(1, f.t + dt / f.T);
  if (f.t >= 1) {
    S.cx = f.tx; S.cy = f.ty; S.scale = f.w1; anim.flight = null;
    return;
  }
  const e = f.t - Math.sin(2 * Math.PI * f.t) / (2 * Math.PI);
  const s = e * f.S;
  if (f.pure) {
    S.scale = f.w0 * Math.exp(Math.log(f.w1 / f.w0) * e);
    if (e < 0.5) { S.cx = f.sx + fromDouble(f.dx * e); S.cy = f.sy + fromDouble(f.dy * e); }
    else { S.cx = f.tx - fromDouble(f.dx * (1 - e)); S.cy = f.ty - fromDouble(f.dy * (1 - e)); }
    return;
  }
  const k = f.w0 / (f.rho * f.rho), A = f.rho * s + f.r0;
  S.scale = Math.max(minScale(), f.w0 * Math.cosh(f.r0) / Math.cosh(A));
  const u = k * Math.sinh(f.rho * s) / Math.cosh(A);
  if (u < f.u1 / 2) {
    S.cx = f.sx + fromDouble(f.dirx * u); S.cy = f.sy + fromDouble(f.diry * u);
  } else {
    const rem = k * Math.cosh(f.r0) * Math.sinh(f.rho * (f.S - s)) / (Math.cosh(f.rho * f.S + f.r0) * Math.cosh(A));
    S.cx = f.tx - fromDouble(f.dirx * rem); S.cy = f.ty - fromDouble(f.diry * rem);
  }
}

// ---------------------------------------------------------------- actions
export function setFormula(f, keepView = false) {
  stopMotion();
  iterFloor = 0;
  S.f = f; S.julia = false; S.saved = null;
  if (!keepView) {
    // some types are best known by one Julia set (the Phoenix bird): open on that
    const start = f.start && LOCATIONS.find((l) => l.name === f.start);
    if (start) enterJulia(start, true);
    else setHome();
    applyLook(start || LOCATIONS.find((l) => l.f === f.id));
  }
  invalidate(false); syncUI();
}

// Switch to the Julia set of a curated spot. cut: show its view at once instead of the whole set.
function enterJulia(loc, cut) {
  const jx = parseFixed(loc.jx), jy = parseFixed(loc.jy);
  if (!S.julia) S.saved = S.saved || { cx: S.cx, cy: S.cy, scale: S.scale };
  if (S.f.id !== loc.f) S.saved = null;
  S.julia = true; S.jx = jx; S.jy = jy;
  if (cut) { S.cx = parseFixed(loc.x); S.cy = parseFixed(loc.y); S.scale = loc.s; }
  else setHome();
}

// A curated spot can carry its own palette (pal: name), density (d) and offset (o).
export const pal = { from: null, to: null, t: 1, d0: 0, d1: 0 };
// loc.pal names a palette; a saved view may instead carry palData (a random palette)
// and its own mapping, light and smooth settings.
function applyLook(loc) {
  if (!loc || loc.inJulia || retroSaved) return;
  let i = -1, data = loc.palData, banded = false;
  if (!data) {
    i = PALETTES.findIndex((p) => p.name === (loc.pal || 'Ultra'));
    if (i < 0) return;
    data = PALETTES[i].data; banded = PALETTES[i].banded;
  }
  const d = loc.d ?? 0;
  if (!((i >= 0 ? i === S.pal : data === S.palData) && Math.abs(d - S.density) < 0.01)) {
    pal.from = new Uint8Array(S.palData); pal.to = data; pal.t = 0;
    pal.d0 = S.density; pal.d1 = d;
    S.pal = i; S.palData = data; S.smooth = !banded;
  }
  if (loc.o != null) S.offset = loc.o;
  if (loc.m != null) S.mapping = loc.m;
  if (loc.light != null) S.light = loc.light;
  if (loc.smooth != null) S.smooth = loc.smooth;
  setStyle(loc.k || 0); // curated spots are classic unless they say otherwise
  colorDirty = true; syncUI();
}
// crossfade palette and density over ~0.8 s
function stepLook(dt) {
  if (pal.t >= 1) return;
  pal.t = Math.min(1, pal.t + dt / 0.8);
  const e = pal.t * pal.t * (3 - 2 * pal.t);
  const mix = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) mix[i] = pal.from[i] + (pal.to[i] - pal.from[i]) * e;
  R.uploadPalette(pal.t >= 1 ? pal.to : mix);
  S.density = pal.d0 + (pal.d1 - pal.d0) * e;
  colorDirty = true;
  if (pal.t >= 1) syncUI();
}

function toggleJulia(px, py) {
  stopTour();
  if (S.f.julia === false && !S.julia) { toast(`${S.f.name} HAS NO JULIA MODE`); return; }
  stopMotion(); pushHistory(); crossfade();
  if (!S.julia) {
    const [ox, oy] = px != null ? screenOffset(px, py) : [0, 0];
    S.jx = S.cx + fromDouble(ox); S.jy = S.cy + fromDouble(oy);
    S.saved = { cx: S.cx, cy: S.cy, scale: S.scale };
    S.julia = true; setHome();
    toast(`JULIA SET  c = ${fmtC(S.jx, S.jy, 8)}`);
  } else {
    S.julia = false;
    if (S.saved) { S.cx = S.saved.cx; S.cy = S.saved.cy; S.scale = S.saved.scale; } else setHome();
    toast(S.f.name);
  }
  invalidate(false); syncUI();
}

function setJulia(jx, jy) {
  stopMotion();
  if (!S.julia) S.saved = { cx: S.cx, cy: S.cy, scale: S.scale };
  S.julia = true; S.jx = jx; S.jy = jy; setHome();
  invalidate(false); syncUI();
}

let locIdx = 0;

// Fly to a journey destination (or prerender the flight as a video when render is set).
export function goLocation(loc, render = false, fromTour = false) {
  if (!fromTour) stopTour();
  if (!render && !fromTour) pushHistory();
  const go = (t) => (render ? prerenderJourney(t) : fromTour ? flyTo(t.cx, t.cy, t.s) : startJourney(t));
  if (loc.inJulia) { go({ name: loc.name, cx: loc.cx, cy: loc.cy, s: loc.s }); return; }
  const f = FORMULAS.find((q) => q.id === loc.f) || FORMULAS[0];
  if (loc.jx != null) {
    // a Julia highlight: show its whole Julia set, then fly in
    if (!render && (f !== S.f || !S.julia || S.jx !== parseFixed(loc.jx) || S.jy !== parseFixed(loc.jy))) crossfade();
    if (f !== S.f) setFormula(f);
    if (!S.julia || S.jx !== parseFixed(loc.jx) || S.jy !== parseFixed(loc.jy)) {
      stopMotion(); iterFloor = 0;
      enterJulia(loc, false);
      invalidate(false); syncUI();
    }
  } else if (f !== S.f || S.julia) {
    if (!render) crossfade();
    setFormula(f, true);
    setHome();
  }
  applyLook(loc);
  if (loc.fav) { S.iterAuto = !loc.i; if (loc.i) S.iterManual = loc.i; }
  go({ name: loc.name, cx: parseFixed(loc.x), cy: parseFixed(loc.y), s: loc.s });
}

// Fly (or prerender, then play) from wherever we are to target {name, cx, cy, s}.
function startJourney(t) {
  if (S.hq) { prerenderJourney(t); return; }
  flyTo(t.cx, t.cy, t.s);
  toast(histMute ? 'BACK TO THAT VIEW' : `FLYING TO ${t.name.toUpperCase()}`);
}

export const homeScale = () => (S.julia ? juliaHome().s : S.f.home[2]);

// A link that replays a dive from the overview to the current view, with the current colors.
function journeyLink() {
  writeHash();
  return `${location.href.split('#')[0]}${location.hash}&dive=1${S.hq ? '&hq=1' : ''}`;
}
async function shareJourney() {
  const url = journeyLink();
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Fraczilla dive', url });
    else { await navigator.clipboard.writeText(url); toast('LINK COPIED: IT REPLAYS THE DIVE TO THIS VIEW'); }
  } catch { toast('COPY FAILED — use COPY LINK'); }
}

function setPalette(i, data) {
  S.pal = i;
  S.palData = data || PALETTES[i].data;
  R.uploadPalette(S.palData);
  if (i >= 0) S.smooth = !PALETTES[i].banded;
  colorDirty = true; syncUI();
}

function toggleRetro() {
  if (!retroSaved) {
    retroSaved = { pal: S.pal, palData: S.palData, smooth: S.smooth, light: S.light, mapping: S.mapping, density: S.density, offset: S.offset, edge: S.edge, colorMode: S.colorMode };
    setPalette(1); setStyle(0);
    Object.assign(S, { smooth: false, light: false, mapping: 0, density: 0, offset: 0, edge: 0 });
    toast('RETRO MODE: 256 VGA COLORS, ONE PER ITERATION');
  } else {
    const r = retroSaved; retroSaved = null;
    S.pal = r.pal; S.palData = r.palData; R.uploadPalette(S.palData);
    Object.assign(S, { smooth: r.smooth, light: r.light, mapping: r.mapping, density: r.density, offset: r.offset, edge: r.edge });
    setStyle(r.colorMode);
    toast('MODERN MODE');
  }
  colorDirty = true; syncUI();
}

function resetView() {
  stopTour(); stopMotion(); pushHistory(); crossfade();
  if (S.julia) setHome(); else setHome();
  invalidate(false);
}

// ---------------------------------------------------------------- URL hash state
export function coordDigits() { return Math.min(60, Math.max(8, Math.ceil(-Math.log10(S.scale)) + 4)); }
function writeHash() {
  const p = new URLSearchParams();
  const d = coordDigits();
  p.set('f', S.f.id);
  p.set('x', formatFixed(S.cx, d)); p.set('y', formatFixed(S.cy, d)); p.set('s', S.scale.toPrecision(6));
  if (S.julia) { p.set('jx', formatFixed(S.jx, 24)); p.set('jy', formatFixed(S.jy, 24)); }
  if (S.pal >= 0) p.set('p', S.pal);
  p.set('d', S.density.toFixed(2)); p.set('o', S.offset.toFixed(1)); p.set('m', S.mapping);
  if (S.colorMode) p.set('k', S.colorMode);
  p.set('l', (S.light ? 1 : 0) + '' + (S.smooth ? 1 : 0));
  if (!S.iterAuto) p.set('i', S.iterManual);
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() {
  if (location.hash.length < 3) return false;
  try {
    const p = new URLSearchParams(location.hash.slice(1));
    S.f = FORMULAS.find((q) => q.id === p.get('f')) || FORMULAS[0];
    const h = S.f.home;
    S.cx = parseFixed(p.get('x') || h[0]);
    S.cy = parseFixed(p.get('y') || h[1]);
    S.scale = Math.min(MAX_SCALE, Math.max(minScale(), parseFloat(p.get('s')) || h[2]));
    if (p.has('jx')) { S.julia = true; S.jx = parseFixed(p.get('jx')); S.jy = parseFixed(p.get('jy') || '0'); }
    if (p.has('p')) { const i = +p.get('p'); if (PALETTES[i]) { S.pal = i; S.palData = PALETTES[i].data; } }
    if (p.has('d')) S.density = +p.get('d') || 0;
    if (p.has('o')) S.offset = +p.get('o') || 0;
    if (p.has('m')) S.mapping = +p.get('m') || 0;
    S.colorMode = [1, 2].includes(+p.get('k')) ? +p.get('k') : 0;
    if (p.has('l')) { const l = p.get('l'); S.light = l[0] === '1'; S.smooth = l[1] !== '0'; }
    if (p.has('i')) { S.iterAuto = false; S.iterManual = Math.max(50, +p.get('i') || 1000); }
    return true;
  } catch (e) { console.warn('bad hash', e); return false; }
}

// ---------------------------------------------------------------- input
export const pointers = new Map();
export let mouse = null, lastMoveT = 0;

canvas.addEventListener('pointerdown', (e) => {
  stopTour();
  if (hq) { cancelHQ(); return; }
  hideSplash();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  stopMotion();
  canvas.classList.add('grabbing');
});
canvas.addEventListener('pointermove', (e) => {
  mouse = { x: e.offsetX, y: e.offsetY };
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const now = performance.now();
  if (pointers.size === 1) {
    const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
    pan(dx, dy);
    const dtm = Math.max(1, now - lastMoveT) / 1000;
    anim.vx = anim.vx * 0.6 + (dx / dtm) * 0.4;
    anim.vy = anim.vy * 0.6 + (dy / dtm) * 0.4;
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const other = a === p ? b : a;
    const d0 = Math.hypot(p.x - other.x, p.y - other.y);
    const d1 = Math.hypot(e.offsetX - other.x, e.offsetY - other.y);
    const mx0 = (p.x + other.x) / 2, my0 = (p.y + other.y) / 2;
    const mx1 = (e.offsetX + other.x) / 2, my1 = (e.offsetY + other.y) / 2;
    if (d0 > 0 && d1 > 0) zoomAt(mx1, my1, d0 / d1);
    pan(mx1 - mx0, my1 - my0);
    anim.vx = anim.vy = 0;
  }
  lastMoveT = now;
  p.x = e.offsetX; p.y = e.offsetY;
  invalidate(true);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    canvas.classList.remove('grabbing');
    if (performance.now() - lastMoveT > 90) anim.vx = anim.vy = 0;
  } else anim.vx = anim.vy = 0;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!pointers.size) mouse = null; });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  stopTour();
  if (hq) { cancelHQ(); return; }
  hideSplash();
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
  if (anim.flight) anim.flight = null;
  anim.zoom = Math.max(-5, Math.min(5, anim.zoom + d * (e.ctrlKey ? 0.01 : 0.0018)));
  anim.ax = e.offsetX; anim.ay = e.offsetY;
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  stopTour();
  anim.flight = null;
  anim.zoom += e.shiftKey ? Math.log(4) : -Math.log(4);
  anim.ax = e.offsetX; anim.ay = e.offsetY;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  hideSplash();
  if (typesOpen()) { if (e.key === 'Escape') closeTypes(); return; }
  if (hq) { if (e.key === 'Escape') cancelHQ(); e.preventDefault(); return; }
  if (renderOpen() && e.key === 'Escape') { closeRender(); e.preventDefault(); return; }
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.target.tagName === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const handled = () => e.preventDefault();
  if (tour.on && !TOUR_KEEPS.has(k)) stopTour();
  if (!$('#help').classList.contains('hidden') && (k === 'Escape' || k === 'h' || k === 'H' || k === 'Enter' || k === 'F1' || k === '?')) {
    $('#help').classList.add('hidden'); return handled();
  }
  switch (k) {
    case ' ': toggleJulia(mouse?.x, mouse?.y); break;
    case 'j': case 'J':
      if (S.julia) toast('JULIA PREVIEW works on the c-plane: SPACE goes back there');
      else if (S.f.julia === false) toast(`${S.f.name} HAS NO JULIA MODE`);
      else setJuliaPreview(!jpv.on);
      break;
    case 'a': case 'A': tour.on ? stopTour() : startTour(); break;
    case 'm': case 'M': openSaveFav(); break;
    case 'g': case 'G':
      if (STYLE_OFF.has(S.f.code)) { toast(`${S.f.name} HAS ONLY THE CLASSIC STYLE`); break; }
      setStyle((S.colorMode + 1) % 3); toast(`STYLE: ${STYLES[S.colorMode]}`); break;
    case 't': case 'T': { const js = currentJourneys(); goLocation(js[(locIdx = (locIdx + 1) % js.length)]); } break;
    case 'c': case 'C': S.cycling = !S.cycling; if (tour.on) tour.saved.cycling = S.cycling; toast(S.cycling ? 'COLOR CYCLING ON (+/− speed)' : 'COLOR CYCLING OFF'); syncUI(); break;
    case '+': case '=': S.cycleSpeed = Math.min(120, S.cycleSpeed + 10); S.cycling = true; toast(`CYCLE SPEED ${S.cycleSpeed}`); syncUI(); break;
    case '-': case '_': S.cycleSpeed = Math.max(-120, S.cycleSpeed - 10); S.cycling = true; toast(`CYCLE SPEED ${S.cycleSpeed}`); syncUI(); break;
    case 'p': setPalette((Math.max(0, S.pal) + 1) % PALETTES.length); toast(`PALETTE: ${PALETTES[S.pal].name.toUpperCase()}`); break;
    case 'P': setPalette(-1, randomPalette().data); toast('RANDOM PALETTE'); break;
    case '[': S.density = Math.max(-4, S.density - 0.15); colorDirty = true; syncUI(); break;
    case ']': S.density = Math.min(4, S.density + 0.15); colorDirty = true; syncUI(); break;
    case ',': case '<': S.iterAuto = false; S.iterManual = Math.max(50, Math.round(maxIter() / 1.4)); invalidate(false); syncUI(); toast(`MAX ITER ${S.iterManual}`); break;
    case '.': case '>': S.iterAuto = false; S.iterManual = Math.min(200000, Math.round(maxIter() * 1.4)); invalidate(false); syncUI(); toast(`MAX ITER ${S.iterManual}`); break;
    case 'f': case 'F': openTypes(); break;
    case 'b': case 'B': S.smooth = !S.smooth; colorDirty = true; syncUI(); break;
    case 'd': case 'D': S.light = !S.light; colorDirty = true; syncUI(); break;
    case 'r': case 'R': toggleRetro(); break;
    case 's': case 'S': if (!hq) renderImage(); break; // at the render panel's size (WINDOW by default)
    case 'v': case 'V': renderOpen() ? closeRender() : openRender(); break;
    case 'l': case 'L': copyLink(); break;
    case 'z': case 'Z': toggleFullscreen(); break;
    case 'Home': resetView(); break;
    case 'Tab': $('#panel').classList.toggle('closed'); break;
    case 'h': case 'H': case 'F1': case '?': $('#help').classList.toggle('hidden'); break;
    case 'Escape': stopMotion(); $('#help').classList.add('hidden'); break;
    case 'ArrowLeft': anim.vx = 700; break;
    case 'ArrowRight': anim.vx = -700; break;
    case 'ArrowUp': anim.vy = 700; break;
    case 'ArrowDown': anim.vy = -700; break;
    case 'PageUp': anim.zoom -= Math.log(2); anim.ax = cssW / 2; anim.ay = cssH / 2; break;
    case 'PageDown': anim.zoom += Math.log(2); anim.ax = cssW / 2; anim.ay = cssH / 2; break;
    default: return;
  }
  handled();
});

const coarse = () => matchMedia('(pointer: coarse)').matches;
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function toggleFullscreen() {
  if (!document.fullscreenEnabled) { toast('FULLSCREEN IS NOT AVAILABLE IN THIS BROWSER'); return; }
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast('FULLSCREEN WAS REFUSED'));
}
async function copyLink() {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); toast('LINK TO THIS VIEW COPIED'); }
  catch { toast('COPY FAILED — use the address bar'); }
}

// ---------------------------------------------------------------- UI
// on a phone the open panel covers the picture: get out of the way once something was chosen
const phone = () => window.innerWidth < 700;
export function phoneClosePanel() { if (phone()) $('#panel').classList.add('closed'); }
let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

let splashGone = false;
export function hideSplash() {
  if (splashGone) return;
  splashGone = true;
  $('#splash').classList.add('gone');
  setTimeout(() => $('#splash').remove(), 900);
}
setTimeout(hideSplash, 3500);

const trimNum = (t) => t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;

export function fmtC(x, y, d) {
  const ys = formatFixed(y < 0n ? -y : y, d);
  return `${formatFixed(x, d)} ${y < 0n ? '−' : '+'} ${ys}i`;
}

function updateStatus(refOk) {
  const d = Math.min(40, coordDigits());
  $('#stType').textContent = S.f.name + (S.julia ? ' JULIA' : '');
  $('#stX').textContent = formatFixed(S.cx, d);
  $('#stY').textContent = formatFixed(S.cy, d);
  const mag = HOME_SCALE / (hq && hq.phase === 'play' && hq.liveScale ? hq.liveScale : S.scale);
  $('#stZoom').textContent = (mag < 1e5 ? mag.toFixed(mag < 10 ? 2 : 0) : mag.toExponential(2).replace('e+', '·10^')) + '×';
  $('#stIter').textContent = maxIter();
  $('#stFps').textContent = `${fps} FPS`;
  let prog = '';
  if (hq) prog = hq.phase === 'render' ? `PRERENDERING ${hq.k}/${hq.K + 1} · ESC CANCELS` : hq.phase === 'encode' ? `ENCODING VIDEO ${Math.floor(100 * hq.vDone / Math.max(1, hq.vFrames))}%` : 'FULL-QUALITY JOURNEY · ESC STOPS';
  else   if (!refOk) prog = 'COMPUTING REFERENCE…';
  else if (fullVer === viewVer && fullDone < R.full.h && lowVer === viewVer) prog = `REFINING ${Math.floor(100 * fullDone / R.full.h)}%`;
  $('#stProg').textContent = prog;
  if (S.iterAuto) { $('#iter').value = Math.log10(maxIter()); $('#iterLabel').textContent = `MAX ${maxIter()}`; }
  if (S.cycling) $('#offset').value = S.offset;
}

function buildUI() {
  const fwrap = $('#formulas');
  FORMULAS.filter((f) => f.quick).forEach((f) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = f.name; b.dataset.id = f.id;
    b.onclick = () => { stopTour(); pushHistory(); crossfade(); setFormula(f); toast(f.name); phoneClosePanel(); };
    fwrap.appendChild(b);
  });
  const more = document.createElement('button');
  more.className = 'btn more'; more.innerHTML = 'MORE… <kbd>F</kbd>'; more.title = 'Browse all fractal types (F)';
  more.onclick = openTypes;
  fwrap.appendChild(more);
  buildTypeBrowser();

  $('#juliaC').onclick = () => {
    if (!S.julia) return;
    const row = $('#jcRow');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) { syncUI(); $('#jcRe').focus(); $('#jcRe').select(); }
  };
  const NUM = /^\s*[-+−]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
  const readNum = (el) => {
    const v = el.value.replace('−', '-').trim() || '0';
    const ok = NUM.test(v) && !/e/i.test(v);
    el.classList.toggle('bad', !ok);
    return ok ? parseFixed(v) : null;
  };
  const applyC = () => {
    const re = readNum($('#jcRe')), im = readNum($('#jcIm'));
    if (re == null || im == null) { toast('C MUST BE PLAIN DECIMAL NUMBERS, e.g. 0.5667'); return; }
    if (S.f.julia === false) { toast(`${S.f.name} HAS NO JULIA MODE`); return; }
    document.activeElement.blur();
    $('#jcRow').classList.add('hidden');
    setJulia(re, im);
    toast(`JULIA SET  c = ${fmtC(S.jx, S.jy, 8)}`);
  };
  $('#jcSet').onclick = applyC;
  for (const id of ['#jcRe', '#jcIm']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyC(); }
      else if (e.key === 'Escape') { e.target.blur(); $('#jcRow').classList.add('hidden'); syncUI(); }
    });
  }
  $('#juliaBtn').onclick = () => { toggleJulia(null); phoneClosePanel(); };
  $('#jpvBtn').onclick = () => setJuliaPreview(!jpv.on);

  const pwrap = $('#palettes');
  PALETTES.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pal'; b.title = p.name;
    const c = document.createElement('canvas'); c.width = 256; c.height = 1;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.data), 256, 1), 0, 0);
    const s = document.createElement('span'); s.textContent = p.name.toUpperCase();
    b.append(c, s);
    b.onclick = () => setPalette(i);
    pwrap.appendChild(b);
  });
  $('#randPal').onclick = () => setPalette(-1, randomPalette().data);
  $('#cycleBtn').onclick = () => { S.cycling = !S.cycling; syncUI(); };
  $('#retroBtn').onclick = toggleRetro;

  const bindRange = (id, key, after) => {
    const el = $('#' + id);
    el.addEventListener('input', () => { S[key] = parseFloat(el.value); colorDirty = true; after && after(); });
  };
  bindRange('cycleSpeed', 'cycleSpeed');
  bindRange('density', 'density');
  bindRange('offset', 'offset');
  bindRange('lightAngle', 'lightAngle');
  bindRange('lightStr', 'lightStr');
  bindRange('edge', 'edge');
  bindRange('flySpeed', 'flySpeed');
  $('#mapping').onchange = (e) => { S.mapping = +e.target.value; colorDirty = true; };
  $('#style').onchange = (e) => setStyle(+e.target.value);
  $('#inside').onchange = (e) => { S.inside = +e.target.value; colorDirty = true; };
  $('#smooth').onchange = (e) => { S.smooth = e.target.checked; colorDirty = true; };
  $('#light').onchange = (e) => { S.light = e.target.checked; colorDirty = true; };
  $('#aa').onchange = (e) => { S.aa = e.target.checked; resize(); };
  $('#renderBtn').onclick = () => (renderOpen() ? closeRender() : openRender());
  $('#renderClose').onclick = closeRender;
  $('#outSel').onchange = (e) => { S.out = e.target.value; try { localStorage.setItem('fraczilla.out', S.out); } catch {} updateFrame(); };
  $('#renderVideo').onclick = () => {
    const val = $('#renderJourney').value, v = +val;
    const loc = val[0] === 'f' ? favLoc(favs[+val.slice(1)]) : currentJourneys()[v];
    closeRender();
    if (v < 0 || !loc) prerenderJourney({ name: 'Dive to here', cx: S.cx, cy: S.cy, s: S.scale });
    else goLocation(loc, true);
  };
  $('#renderImage').onclick = renderImage;
  $('#renderSaveVideo').onclick = saveVideo;
  $('#shareBtn').onclick = shareJourney;
  const fine = $('#fine');
  try { fine.open = localStorage.getItem('fraczilla.fine') === '1'; } catch {}
  fine.addEventListener('toggle', () => { try { localStorage.setItem('fraczilla.fine', fine.open ? '1' : '0'); } catch {} });
  bindFavs();
  $('#tourBtn').onclick = () => (tour.on ? stopTour() : startTour());
  $('#videoBtn').onclick = saveVideo;
  $('#hqCancel').onclick = cancelHQ;
  movieVideo.onclick = cancelHQ;
  movie.onclick = cancelHQ;
  $('#iterAuto').onchange = (e) => {
    S.iterAuto = e.target.checked;
    if (!S.iterAuto) S.iterManual = maxIter();
    invalidate(false); syncUI();
  };
  $('#iter').addEventListener('input', (e) => {
    S.iterAuto = false;
    S.iterManual = Math.round(Math.pow(10, +e.target.value) / 10) * 10;
    $('#iterAuto').checked = false;
    $('#iterLabel').textContent = `MAX ${S.iterManual}`;
    invalidate(false);
  });
  $('#linkBtn').onclick = copyLink;
  $('#fsBtn').onclick = toggleFullscreen;
  $('#fsBtn').classList.toggle('hidden', !document.fullscreenEnabled);
  document.addEventListener('fullscreenchange', () => { $('#fsBtn').firstChild.textContent = document.fullscreenElement ? '⛶ EXIT FULL ' : '⛶ FULLSCREEN '; });
  if (coarse()) $('.splash-hint').textContent = 'tap to start · pinch to zoom · MENU for everything';
  $('#resetBtn').onclick = resetView;
  $('#helpBtn').onclick = () => $('#help').classList.remove('hidden');
  $('#helpClose').onclick = () => $('#help').classList.add('hidden');
  $('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };
  $('#menuBtn').onclick = () => $('#panel').classList.toggle('closed');
  if (phone()) $('#panel').classList.add('closed');
}

let shownLocKey = '';
// Distance from c to the (multi)brot set, in plain doubles; 0 if c seems to be inside.
function setDistance(cx, cy, p) {
  let x = 0, y = 0, dx = 0, dy = 0;
  for (let i = 0; i < 20000; i++) {
    // dz = p z^(p-1) dz + 1 ; z = z^p + c
    let px = 1, py = 0;
    for (let k = 0; k < p - 1; k++) [px, py] = [px * x - py * y, px * y + py * x];
    [dx, dy] = [p * (px * dx - py * dy) + 1, p * (px * dy + py * dx)];
    const zx = px * x - py * y, zy = px * y + py * x;
    x = zx + cx; y = zy + cy;
    const r2 = x * x + y * y;
    if (r2 > 1e12) { const r = Math.sqrt(r2); return r * Math.log(r) / Math.hypot(dx, dy); }
  }
  return 0;
}

// Flights inside the current Julia set (these work for any c).
function juliaJourneys() {
  const h = juliaHome();
  const list = [{ name: 'The Whole Julia Set', inJulia: true, cx: h.x, cy: h.y, s: h.s }];
  if (S.f.family === 'mandel' && !S.f.chaotic && S.f.code !== 7) {
    // Near z = c, the Julia set mirrors the Mandelbrot set around c (Tan Lei).
    const d = setDistance(toDouble(S.jx), toDouble(S.jy), S.f.degree);
    if (d > 0) list.push({ name: 'Mirror of c', inJulia: true, cx: S.jx, cy: S.jy, s: Math.max(1e-13, Math.min(0.05, d * 20)) });
  }
  return list;
}

// The journey list in groups, so it is clear which entries stay in the current
// picture and which switch to another Julia set or back to the type's own map.
function journeyGroups() {
  const spots = LOCATIONS.filter((l) => l.f === S.f.id);
  const plane = spots.filter((l) => l.jx == null), jul = spots.filter((l) => l.jx != null);
  if (!plane.length) plane.push({ name: `The Whole ${S.f.name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())}`, f: S.f.id, x: S.f.home[0], y: S.f.home[1], s: S.f.home[2] });
  if (!S.julia) return [{ title: S.f.name, items: plane }, { title: 'JULIA SETS', items: jul }];
  // in a curated Julia set, its own entry is "the whole Julia set"
  const isHere = (l) => parseFixed(l.jx) === S.jx && parseFixed(l.jy) === S.jy;
  const own = jul.filter(isHere);
  const these = own.length ? [...own, ...juliaJourneys().slice(1)] : juliaJourneys();
  return [
    { title: 'THIS JULIA SET', items: these },
    { title: 'OTHER JULIA SETS', items: jul.filter((l) => !isHere(l)) },
    { title: `BACK TO ${S.f.name}`, items: plane },
  ];
}
export const currentJourneys = () => journeyGroups().flatMap((g) => g.items);
function buildLocations() {
  const key = S.f.id + (S.julia ? `J${S.jx},${S.jy}` : '');
  if (key === shownLocKey) return;
  shownLocKey = key;
  const lwrap = $('#locations');
  lwrap.innerHTML = '';
  let i = -1;
  for (const g of journeyGroups()) {
    if (!g.items.length) continue;
    const h = document.createElement('div');
    h.className = 'lhead'; h.textContent = g.title;
    lwrap.appendChild(h);
    for (const loc of g.items) addJourney(loc, ++i);
  }
  function addJourney(loc, i) {
    const b = document.createElement('button');
    const jul = loc.inJulia || loc.jx != null;
    const mag = (jul ? juliaHome().s : HOME_SCALE) / loc.s;
    const here = loc.jx != null && S.julia && S.jx === parseFixed(loc.jx) && S.jy === parseFixed(loc.jy);
    b.innerHTML = `${loc.jx != null ? '<span class="jbadge" title="A Julia set">J</span>' : ''}${loc.name}<span class="tag">${mag < 1e4 ? Math.round(mag) + '×' : '10^' + Math.round(Math.log10(mag))}</span>`;
    if (loc.jx != null) b.title = `Julia set, c = ${loc.jx} ${loc.jy.startsWith('-') ? '−' : '+'} ${loc.jy.replace('-', '')}i`;
    if (here) b.classList.add('here');
    if (loc.name === 'Mirror of c') b.title = 'Near z = c, a Julia set echoes the Mandelbrot set around c';
    b.onclick = () => { locIdx = i; goLocation(loc); phoneClosePanel(); };
    lwrap.appendChild(b);
  }
}

export function syncUI() {
  $('#tourBtn').classList.toggle('on', tour.on);
  $('#tourBtn').firstChild.textContent = tour.on ? '■ STOP TOUR ' : jTab === 'mine' ? '▶ TOUR MINE ' : '▶ TOUR ';
  $('#tourBtn').disabled = !tour.on && jTab === 'mine' && favs.length < 2;
  buildLocations();
  document.querySelectorAll('#formulas .btn').forEach((b) => b.classList.toggle('on', b.dataset.id === S.f.id || (b.classList.contains('more') && !S.f.quick)));
  const fam = FAMILIES.find((q) => q.id === S.f.family);
  $('#typeNow').textContent = S.f.quick ? '' : `NOW: ${S.f.name} · ${fam ? fam.name.toLowerCase() : ''}`;
  document.querySelectorAll('#palettes .pal').forEach((b, i) => b.classList.toggle('on', i === S.pal));
  $('#juliaBtn').classList.toggle('on', S.julia);
  $('#jpvBtn').classList.toggle('on', jpv.on && !S.julia);
  // the preview shows Julia sets of points in the c-plane: nothing to preview inside a Julia set
  $('#jpvBtn').disabled = S.f.julia === false || S.julia;
  $('#jpvBtn').title = S.julia ? 'Julia preview works on the c-plane (SPACE goes back there)' : 'J: show the Julia set of the point under the mouse';
  const jc = $('#juliaC');
  jc.textContent = S.julia ? `c = ${fmtC(S.jx, S.jy, 8)}  ✎` : (S.f.julia === false ? '' : coarse() ? 'MANDEL ⇄ JULIA opens the Julia set at the centre' : 'SPACE over any point opens its Julia set');
  jc.classList.toggle('editable', S.julia);
  jc.title = S.julia ? 'Click to type a different c' : '';
  if (!S.julia) $('#jcRow').classList.add('hidden');
  const re = $('#jcRe'), im = $('#jcIm');
  if (document.activeElement !== re && document.activeElement !== im) {
    const c = S.julia ? [S.jx, S.jy] : null;
    re.value = c ? trimNum(formatFixed(c[0], 10)) : ''; im.value = c ? trimNum(formatFixed(c[1], 10)) : '';
    re.placeholder = '0.5667'; im.placeholder = '0';
    re.classList.remove('bad'); im.classList.remove('bad');
  }
  $('#cycleBtn').classList.toggle('on', S.cycling);
  $('#retroBtn').classList.toggle('on', !!retroSaved);
  $('#cycleSpeed').value = S.cycleSpeed;
  $('#density').value = S.density;
  $('#offset').value = S.offset;
  $('#mapping').value = S.mapping;
  $('#style').value = styleOf();
  $('#style').disabled = STYLE_OFF.has(S.f.code);
  $('#inside').value = S.inside;
  $('#smooth').checked = S.smooth;
  $('#light').checked = S.light;
  $('#lightAngle').value = S.lightAngle;
  $('#lightStr').value = S.lightStr;
  $('#edge').value = S.edge;
  $('#iterAuto').checked = S.iterAuto;
  $('#videoBtn').classList.toggle('hidden', !lastVideo);
  $('#renderSaveVideo').classList.toggle('hidden', !lastVideo);
  $('#iter').value = Math.log10(maxIter());
  $('#iterLabel').textContent = `MAX ${maxIter()}`;
}

canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fatal('The GPU context was lost (driver reset). Reload the page to continue.'); });

// ---------------------------------------------------------------- boot
// #fly=<journey> starts a flight from the overview, e.g. #fly=the-abyss
export const slug = (t) => t.toLowerCase().replace(/\(.*?\)/g, '').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const flyParam = new URLSearchParams(location.hash.slice(1)).get('fly');
if (new URLSearchParams(location.hash.slice(1)).get('hq') === '1') S.hq = true;
const flyLoc = flyParam && LOCATIONS.find((l) => slug(l.name) === slug(flyParam));
if (flyLoc) {
  S.f = FORMULAS.find((q) => q.id === flyLoc.f) || FORMULAS[0];
  setHome();
  setTimeout(() => { hideSplash(); goLocation(flyLoc); }, 1800);
} else if (new URLSearchParams(location.hash.slice(1)).get('tour') === '1') {
  // kiosk / screensaver link: #tour=1
  setHome();
  setTimeout(startTour, 1800);
} else if (new URLSearchParams(location.hash.slice(1)).get('dive') === '1' && readHash()) {
  // shared dive: start at the overview and journey to the linked view
  const t = { name: 'shared dive', cx: S.cx, cy: S.cy, s: S.scale };
  setHome();
  setTimeout(() => { hideSplash(); startJourney(t); }, 1800);
} else if (!readHash()) {
  // a fresh visit: open on one of the showpieces, at random
  const pick = START[Math.floor(Math.random() * START.length)];
  const loc = LOCATIONS.find((l) => l.name === pick);
  S.f = FORMULAS.find((q) => q.id === loc.f) || FORMULAS[0];
  if (loc.jx != null) enterJulia(loc, true);
  S.cx = parseFixed(loc.x); S.cy = parseFixed(loc.y); S.scale = loc.s;
  const pi = PALETTES.findIndex((p) => p.name === (loc.pal || 'Ultra'));
  if (pi >= 0) { S.pal = pi; S.palData = PALETTES[pi].data; S.smooth = !PALETTES[pi].banded; }
  S.density = loc.d ?? 0;
  S.colorMode = loc.k || 0;
}
buildUI();
R.uploadPalette(S.palData);
syncUI();
resize();
requestAnimationFrame(frame);

// handy for debugging from the console
window.fraczilla = { S, R, get params() { return fractalParams(); }, get ref() { return ref; }, get state() { return { viewVer, lowVer, fullVer, fullDone, fullH: R.full.h, probedVer, pend: !!pend, refOk: !!ref && ref.key === refKey() }; }, flyTo: (x, y, s) => flyTo(parseFixed(x), parseFixed(y), s), picture: (id, v, w, h, C) => picture(FORMULAS.find((q) => q.id === id), v, w, h, C), PALETTES, LOCATIONS, colorParams, go: (n) => goLocation(LOCATIONS.find((l) => l.name === n)) };
