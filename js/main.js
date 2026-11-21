import { FB, fromDouble, toDouble, parseFixed, formatFixed } from './bigfixed.js?v=1a9f090c';
import { PALETTES, randomPalette } from './palettes.js?v=1a9f090c';
import { LOCATIONS, START } from './locations.js?v=1a9f090c';
import { Renderer, PROBE_MAXW, PROBE_H } from './renderer.js?v=1a9f090c';
import { FRACTALS, FAMILIES } from './fractals.js?v=1a9f090c';
import { muxWebM } from './webm.js?v=1a9f090c';
import { asciiLogoSVG } from './logo.js?v=1a9f090c';

const FORMULAS = FRACTALS;
const JULIA_SCALE = 1.6;
const DF_MIN_SCALE = 1e-10; // float types iterate in double-float past ~10^5x
const MIN_SCALE = 1e-31, MAX_SCALE = 8, BAIL = 1000, HOME_SCALE = 1.25;

// zoom floor: float-only types run out of precision near 10^5x
const minScale = () => (S.f.deep ? MIN_SCALE : (S.f.minScale || DF_MIN_SCALE));
// Lyapunov forcing sequence as bits (B = 1), read from bit 0 upwards
const seqBits = (seq) => [...(seq || 'A')].reduce((acc, ch, i) => acc | ((ch === 'B' ? 1 : 0) << i), 0);

const $ = (s) => document.querySelector(s);
const canvas = $('#c');
$('#splashLogo').innerHTML = asciiLogoSVG();

function fatal(msg) {
  $('#errorMsg').textContent = msg;
  $('#error').classList.remove('hidden');
  $('#splash').classList.add('gone');
}

let R;
try { R = new Renderer(canvas); } catch (e) { fatal(e.message); throw e; }

// ---------------------------------------------------------------- state
const S = {
  f: FORMULAS[0], julia: false, jx: 0n, jy: 0n, saved: null,
  cx: 0n, cy: 0n, scale: HOME_SCALE,
  iterAuto: true, iterManual: 1000,
  pal: 0, palData: PALETTES[0].data,
  density: 0, offset: 0, cycling: false, cycleSpeed: 30,
  mapping: 1, smooth: true, light: true, lightAngle: 45, lightStr: 0.55, edge: 0, inside: 0,
  aa: true, hq: false, autopilot: false, apSpeed: 0.6, flySpeed: 1.4,
};
let retroSaved = null;
let iterFloor = 0; // learned from the probe: how deep the current view really is

const juliaHome = (f = S.f) => {
  const h = f.juliaHome || ['0', '0', JULIA_SCALE];
  return { x: parseFixed(h[0]), y: parseFixed(h[1]), s: h[2] };
};
function setHome(f = S.f) {
  if (S.julia) { const h = juliaHome(f); S.cx = h.x; S.cy = h.y; S.scale = h.s; return; }
  S.cx = parseFixed(f.home[0]); S.cy = parseFixed(f.home[1]); S.scale = f.home[2];
}

function maxIter() {
  if (!S.iterAuto) return S.iterManual;
  const L = Math.max(0, Math.log10(HOME_SCALE / S.scale));
  const h = 250 + 90 * L + 9 * L * L;
  return Math.round(Math.min(200000, Math.max(h, iterFloor)) / 10) * 10;
}

// ---------------------------------------------------------------- reference orbit (worker)
let worker, ref = null, pend = null, reqId = 0;
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./refworker.js?v=1a9f090c', import.meta.url));
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

const refKey = () => `${S.f.code}|${S.julia ? 1 : 0}|${S.julia ? S.jx + ',' + S.jy : ''}`;
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
let cssW = 1, cssH = 1;
const cssPix = () => 2 * S.scale / cssH;
function screenOffset(px, py) {
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
let viewVer = 1, lowVer = 0, fullVer = 0, fullDone = 0, lowW = 1, lowH = 1, haveLow = false;
let lowScale = 0.5, stripRows = 32, aaFactor = 2;
let msPerRow = 0, dtHist = [];
let lastMove = -1e9, colorDirty = true, lastProbe = 0, probedVer = 0;
let saveReq = false, dtSmooth = 1 / 60;

function invalidate(moving) {
  viewVer++;
  if (moving) lastMove = performance.now();
}

let outOverride = null; // { w, h } device pixels while rendering an export at a fixed size
function resize() {
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

function colorParams() {
  return {
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
  };
}

const animating = () => anim.flight || S.autopilot || anim.zoom !== 0 || anim.vx !== 0 || anim.vy !== 0 || pointers.size > 0;

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
  const fullComplete = fullVer === viewVer && fullDone >= R.full.h;
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
    if (lowVer === viewVer && probedVer !== viewVer && now - lastProbe > (S.autopilot ? 180 : 350)) {
      lastProbe = now; probedVer = viewVer;
      analyzeProbe(P);
    }
  }
  if (saveReq && fullComplete) colorDirty = true;
  if (colorDirty && haveLow) {
    R.composite({
      ...colorParams(),
      lowW, lowH, haveFull: fullVer === lowVer && fullDone > 0,
      doneY: Math.ceil((R.full.h - fullDone) / aaFactor),
    });
    colorDirty = false;
    if (saveReq && fullComplete) { saveReq = false; doSave(); }
  }
  if (now - lastStatus > 120) { lastStatus = now; updateStatus(refOk); }
  if (!animating() && now - lastMove > 600 && lastHashVer !== viewVer && now - lastHashT > 500) {
    lastHashVer = viewVer; lastHashT = now; writeHash();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- probe: smarter reference + autopilot steering
let apTarget = null;
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
  if (S.autopilot) {
    if (maxIdx < 0) { if (S.iterAuto && maxIter() < 100000) return; stopAutopilot('Autopilot: swallowed by the set. Zoom out and try again!'); return; }
    if (S.f.chaotic) { autopilotChoose(P, buf, pw, maxEsc, pt); return; }
    // smooth (holomorphic) formulas: deepest escaping pixels near the centre, stay close to the previous target
    const thr = maxEsc - Math.max(2, maxEsc * 0.06);
    const [tx0, ty0] = apTarget ? [toDouble(apTarget.x - S.cx), toDouble(apTarget.y - S.cy)] : [0, 0];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const mu = buf[i * 4];
      if (mu < thr) continue;
      const px = i % pw, py = Math.floor(i / pw);
      if (Math.abs(px + 0.5 - pw / 2) > pw * 0.35 || Math.abs(py + 0.5 - PROBE_H / 2) > PROBE_H * 0.35) continue;
      const [x, y] = pt(i), d = (x - tx0) ** 2 + (y - ty0) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) best = maxIdx;
    const [ox, oy] = pt(best);
    apTarget = { x: S.cx + fromDouble(ox), y: S.cy + fromDouble(oy) };
  }
}

// How chaotic is a probe image? Fraction of neighbouring pixel pairs that jump
// (escape-time discontinuity or inside/outside flip). Low = coherent structure.
function speckle(buf, pw) {
  const H = PROBE_H;
  let jumps = 0, pairs = 0, esc = 0, lo = Infinity, hi = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < pw; x++) {
    const m = buf[(y * pw + x) * 4];
    if (m >= 0) { esc++; lo = Math.min(lo, m); hi = Math.max(hi, m); }
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      if (x + dx >= pw || y + dy >= H) continue;
      const v = buf[((y + dy) * pw + x + dx) * 4];
      pairs++;
      if ((m < 0) !== (v < 0)) jumps++;
      else if (m >= 0 && Math.abs(m - v) > Math.max(3, 0.08 * Math.max(m, v))) jumps++;
    }
  }
  return { sp: jumps / pairs, escFrac: esc / (pw * H), range: hi - lo };
}

// Small black islands (miniature copies of the set) that don't touch the border.
function islands(buf, pw) {
  const H = PROBE_H, n = pw * H, seen = new Uint8Array(n), out = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || buf[s0 * 4] >= 0) continue;
    const stack = [s0]; seen[s0] = 1;
    let size = 0, sx = 0, sy = 0, edge = false;
    while (stack.length) {
      const i = stack.pop(), x = i % pw, y = (i / pw) | 0;
      size++; sx += x; sy += y;
      if (x === 0 || y === 0 || x === pw - 1 || y === H - 1) edge = true;
      for (const j of [i - 1, i + 1, i - pw, i + pw]) {
        if (j < 0 || j >= n || seen[j] || buf[j * 4] >= 0) continue;
        if (Math.abs((j % pw) - x) > 1) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    if (!edge && size <= n * 0.03) out.push({ x: sx / size, y: sy / size, size });
  }
  // lots of tiny specks = chaotic noise, not miniature copies
  if (out.length > 25) return [];
  return out.filter((c) => c.size >= 3);
}

let apLastChoice = 0, apReverseUntil = 0;
function autopilotChoose(P, buf, pw, maxEsc, pt) {
  const now = performance.now();
  if (apTarget && now - apLastChoice < 1200) return;
  apLastChoice = now;
  const H = PROBE_H, n = pw * H;
  const pp = 2 * S.scale / H;
  const toOff = (x, y) => [(x + 0.5 - pw / 2) * pp, (y + 0.5 - H / 2) * pp * S.f.ySign];
  const here = speckle(buf, pw);
  const [tx, ty] = apTarget ? [toDouble(apTarget.x - S.cx), toDouble(apTarget.y - S.cy)] : [0, 0];

  // candidates: miniature copies (islands), deep spread-out pixels, and the current target
  const offs = [];
  const isl = islands(buf, pw)
    .filter((c) => Math.abs(c.x + 0.5 - pw / 2) < pw * 0.42 && Math.abs(c.y + 0.5 - H / 2) < H * 0.42)
    .map((c) => ({ off: toOff(c.x, c.y), island: true }));
  isl.sort((a, b) => ((a.off[0] - tx) ** 2 + (a.off[1] - ty) ** 2) - ((b.off[0] - tx) ** 2 + (b.off[1] - ty) ** 2));
  offs.push(...isl.slice(0, 4));
  let mnEsc = Infinity;
  for (let i = 0; i < n; i++) { const mu = buf[i * 4]; if (mu >= 0 && mu < mnEsc) mnEsc = mu; }
  const thr = mnEsc + 0.5 * (maxEsc - mnEsc);
  const cand = [];
  for (let i = 0; i < n; i++) {
    const mu = buf[i * 4], px = i % pw, py = Math.floor(i / pw);
    if (mu < thr || Math.abs(px + 0.5 - pw / 2) > pw * 0.38 || Math.abs(py + 0.5 - H / 2) > H * 0.38) continue;
    cand.push([mu, px, py, i]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  const picks = [];
  for (const c of cand) {
    if (picks.length >= 6) break;
    if (picks.every((p) => Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) > 7)) picks.push(c);
  }
  offs.push(...picks.map((c) => ({ off: pt(c[3]) })));
  if (apTarget) offs.push({ off: [tx, ty], current: true });
  if (!offs.length) return;

  // look ahead: preview a few times deeper at each candidate; reject chaos, reward structure
  let best = null, bestScore = -Infinity, calm = null, calmSp = Infinity;
  const lw = 48;
  for (const c of offs) {
    const [ox, oy] = c.off;
    const Q = { ...P, refOffX: P.refOffX + ox, refOffY: P.refOffY + oy, centerX: P.centerX + ox, centerY: P.centerY + oy, scale: S.scale / 4 };
    const pb = R.probe(Q, lw);
    const st = speckle(pb, lw);
    if (st.sp < calmSp) { calmSp = st.sp; calm = c.off; }
    if (st.sp > 0.2 || st.escFrac < 0.12 || st.range < 4) continue;
    const nIsl = islands(pb, lw).length;
    const score = -st.sp + (c.island ? 0.3 : 0) + 0.2 * Math.min(nIsl, 4) / 4 + (c.current ? 0.05 : 0);
    if (score > bestScore) { bestScore = score; best = c.off; }
  }
  if (!best) {
    // everything ahead is chaos or swallowed by the set: back out and look for another way in
    apReverseUntil = now + 1600;
    apLastChoice = now + 400 - 1200; // re-evaluate right after backing out
    best = calm && (here.sp > 0.2 || here.escFrac < 0.12) ? [0, 0] : (calm || [0, 0]);
  }
  apTarget = { x: S.cx + fromDouble(best[0]), y: S.cy + fromDouble(best[1]) };
}

// ---------------------------------------------------------------- animation: wheel zoom, inertia, flights, autopilot
const anim = { zoom: 0, ax: 0, ay: 0, vx: 0, vy: 0, flight: null };

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
  if (S.autopilot) { stepAutopilot(dt); moved = true; }
  if (moved) invalidate(true);
}

function stopMotion() {
  anim.zoom = 0; anim.vx = anim.vy = 0; anim.flight = null;
  if (S.autopilot) stopAutopilot();
}

function flyTo(x, y, s) {
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
  f.T = Math.max(0.9, f.S / S.flySpeed);
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

function startAutopilot() {
  anim.flight = null; anim.zoom = 0;
  S.autopilot = true; apTarget = null;
  toast('AUTOPILOT ENGAGED — diving toward the deepest detail');
  syncUI();
}
function stopAutopilot(msg) {
  S.autopilot = false; apTarget = null;
  if (msg) toast(msg);
  syncUI();
}
function stepAutopilot(dt) {
  const f = Math.exp((performance.now() < apReverseUntil ? 1.5 : -1) * S.apSpeed * dt);
  if (S.scale * f < minScale()) { stopAutopilot(S.f.deep ? 'Precision floor reached at 10³⁰× — what a dive!' : 'Zoom limit for this type (10¹⁰×): double-float precision floor'); return; }
  S.scale = Math.min(MAX_SCALE, S.scale * f);
  if (apTarget) {
    const k = 1 - Math.exp(-dt * 1.6);
    S.cx += fromDouble(toDouble(apTarget.x - S.cx) * k);
    S.cy += fromDouble(toDouble(apTarget.y - S.cy) * k);
  }
}

// ---------------------------------------------------------------- actions
function setFormula(f, keepView = false) {
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
const pal = { from: null, to: null, t: 1, d0: 0, d1: 0 };
function applyLook(loc) {
  if (!loc || loc.inJulia || retroSaved) return;
  const i = PALETTES.findIndex((p) => p.name === (loc.pal || 'Ultra'));
  if (i < 0) return;
  const d = loc.d ?? 0;
  if (i === S.pal && Math.abs(d - S.density) < 0.01) return;
  pal.from = new Uint8Array(S.palData); pal.to = PALETTES[i].data; pal.t = 0;
  pal.d0 = S.density; pal.d1 = d;
  S.pal = i; S.palData = PALETTES[i].data; S.smooth = !PALETTES[i].banded;
  if (loc.o != null) S.offset = loc.o;
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
  if (S.f.julia === false && !S.julia) { toast(`${S.f.name} HAS NO JULIA MODE`); return; }
  stopMotion();
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
function goLocation(loc, render = false) {
  const go = (t) => (render ? prerenderJourney(t) : startJourney(t));
  if (loc.inJulia) { go({ name: loc.name, cx: loc.cx, cy: loc.cy, s: loc.s }); return; }
  const f = FORMULAS.find((q) => q.id === loc.f) || FORMULAS[0];
  if (loc.jx != null) {
    // a Julia highlight: show its whole Julia set, then fly in
    if (f !== S.f) setFormula(f);
    if (!S.julia || S.jx !== parseFixed(loc.jx) || S.jy !== parseFixed(loc.jy)) {
      stopMotion(); iterFloor = 0;
      enterJulia(loc, false);
      invalidate(false); syncUI();
    }
  } else if (f !== S.f || S.julia) {
    setFormula(f, true);
    setHome();
  }
  applyLook(loc);
  go({ name: loc.name, cx: parseFixed(loc.x), cy: parseFixed(loc.y), s: loc.s });
}

// Fly (or prerender, then play) from wherever we are to target {name, cx, cy, s}.
function startJourney(t) {
  if (S.hq) { prerenderJourney(t); return; }
  flyTo(t.cx, t.cy, t.s);
  toast(`FLYING TO ${t.name.toUpperCase()}`);
}

const homeScale = () => (S.julia ? juliaHome().s : S.f.home[2]);

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
    retroSaved = { pal: S.pal, palData: S.palData, smooth: S.smooth, light: S.light, mapping: S.mapping, density: S.density, offset: S.offset, edge: S.edge };
    setPalette(1);
    Object.assign(S, { smooth: false, light: false, mapping: 0, density: 0, offset: 0, edge: 0 });
    toast('RETRO MODE: 256 VGA COLORS, ONE PER ITERATION');
  } else {
    const r = retroSaved; retroSaved = null;
    S.pal = r.pal; S.palData = r.palData; R.uploadPalette(S.palData);
    Object.assign(S, { smooth: r.smooth, light: r.light, mapping: r.mapping, density: r.density, offset: r.offset, edge: r.edge });
    toast('MODERN MODE');
  }
  colorDirty = true; syncUI();
}

function resetView() {
  stopMotion();
  if (S.julia) setHome(); else setHome();
  invalidate(false);
}

function save() {
  saveReq = true;
  toast('SAVING… (waiting for the full-quality render)');
}
function doSave() {
  canvas.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `fraczilla-${S.f.id}${S.julia ? '-julia' : ''}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('SAVED PNG');
  }, 'image/png');
}

// ---------------------------------------------------------------- URL hash state
function coordDigits() { return Math.min(60, Math.max(8, Math.ceil(-Math.log10(S.scale)) + 4)); }
function writeHash() {
  const p = new URLSearchParams();
  const d = coordDigits();
  p.set('f', S.f.id);
  p.set('x', formatFixed(S.cx, d)); p.set('y', formatFixed(S.cy, d)); p.set('s', S.scale.toPrecision(6));
  if (S.julia) { p.set('jx', formatFixed(S.jx, 24)); p.set('jy', formatFixed(S.jy, 24)); }
  if (S.pal >= 0) p.set('p', S.pal);
  p.set('d', S.density.toFixed(2)); p.set('o', S.offset.toFixed(1)); p.set('m', S.mapping);
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
    if (p.has('l')) { const l = p.get('l'); S.light = l[0] === '1'; S.smooth = l[1] !== '0'; }
    if (p.has('i')) { S.iterAuto = false; S.iterManual = Math.max(50, +p.get('i') || 1000); }
    return true;
  } catch (e) { console.warn('bad hash', e); return false; }
}

// ---------------------------------------------------------------- input
const pointers = new Map();
let mouse = null, lastMoveT = 0;

canvas.addEventListener('pointerdown', (e) => {
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
  if (hq) { cancelHQ(); return; }
  hideSplash();
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
  if (anim.flight) anim.flight = null;
  if (S.autopilot) stopAutopilot();
  anim.zoom = Math.max(-5, Math.min(5, anim.zoom + d * (e.ctrlKey ? 0.01 : 0.0018)));
  anim.ax = e.offsetX; anim.ay = e.offsetY;
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
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
  if (!$('#help').classList.contains('hidden') && (k === 'Escape' || k === 'h' || k === 'H' || k === 'Enter' || k === 'F1' || k === '?')) {
    $('#help').classList.add('hidden'); return handled();
  }
  switch (k) {
    case ' ': toggleJulia(mouse?.x, mouse?.y); break;
    case 'j': case 'J': setJuliaPreview(!jpv.on); break;
    case 'a': case 'A': S.autopilot ? stopAutopilot('AUTOPILOT OFF') : startAutopilot(); break;
    case 't': case 'T': { const js = currentJourneys(); goLocation(js[(locIdx = (locIdx + 1) % js.length)]); } break;
    case 'c': case 'C': S.cycling = !S.cycling; toast(S.cycling ? 'COLOR CYCLING ON (+/− speed)' : 'COLOR CYCLING OFF'); syncUI(); break;
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
    case 's': case 'S': save(); break;
    case 'v': case 'V': renderOpen() ? closeRender() : openRender(); break;
    case 'l': case 'L': copyLink(); break;
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

async function copyLink() {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); toast('LINK TO THIS VIEW COPIED'); }
  catch { toast('COPY FAILED — use the address bar'); }
}

// ---------------------------------------------------------------- UI
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

let splashGone = false;
function hideSplash() {
  if (splashGone) return;
  splashGone = true;
  $('#splash').classList.add('gone');
  setTimeout(() => $('#splash').remove(), 900);
}
setTimeout(hideSplash, 3500);

const trimNum = (t) => t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;

function fmtC(x, y, d) {
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
  else if (S.autopilot) prog = 'AUTOPILOT';
  $('#stProg').textContent = prog;
  if (S.iterAuto) { $('#iter').value = Math.log10(maxIter()); $('#iterLabel').textContent = `MAX ${maxIter()}`; }
  if (S.cycling) $('#offset').value = S.offset;
}

function buildUI() {
  const fwrap = $('#formulas');
  FORMULAS.filter((f) => f.quick).forEach((f) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = f.name; b.dataset.id = f.id;
    b.onclick = () => { setFormula(f); toast(f.name); };
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
  $('#juliaBtn').onclick = () => toggleJulia(null);
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
  $('#autoBtn').onclick = () => (S.autopilot ? stopAutopilot() : startAutopilot());

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
  bindRange('apSpeed', 'apSpeed');
  bindRange('flySpeed', 'flySpeed');
  $('#mapping').onchange = (e) => { S.mapping = +e.target.value; colorDirty = true; };
  $('#inside').onchange = (e) => { S.inside = +e.target.value; colorDirty = true; };
  $('#smooth').onchange = (e) => { S.smooth = e.target.checked; colorDirty = true; };
  $('#light').onchange = (e) => { S.light = e.target.checked; colorDirty = true; };
  $('#aa').onchange = (e) => { S.aa = e.target.checked; resize(); };
  $('#renderBtn').onclick = () => (renderOpen() ? closeRender() : openRender());
  $('#renderClose').onclick = closeRender;
  $('#outSel').onchange = (e) => { S.out = e.target.value; try { localStorage.setItem('fraczilla.out', S.out); } catch {} updateFrame(); };
  $('#renderVideo').onclick = () => {
    const v = +$('#renderJourney').value, loc = currentJourneys()[v];
    closeRender();
    if (v < 0 || !loc) prerenderJourney({ name: 'Dive to here', cx: S.cx, cy: S.cy, s: S.scale });
    else goLocation(loc, true);
  };
  $('#renderImage').onclick = renderImage;
  $('#renderSaveVideo').onclick = saveVideo;
  $('#shareBtn').onclick = shareJourney;
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
  $('#saveBtn').onclick = save;
  $('#linkBtn').onclick = copyLink;
  $('#resetBtn').onclick = resetView;
  $('#helpBtn').onclick = () => $('#help').classList.remove('hidden');
  $('#helpClose').onclick = () => $('#help').classList.add('hidden');
  $('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };
  $('#menuBtn').onclick = () => $('#panel').classList.toggle('closed');
  if (window.innerWidth < 700) $('#panel').classList.add('closed');
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

function currentJourneys() {
  const spots = LOCATIONS.filter((l) => l.f === S.f.id);
  // in a curated Julia set, its own entry already is "the whole Julia set"
  const curated = S.julia && spots.some((l) => l.jx != null && parseFixed(l.jx) === S.jx && parseFixed(l.jy) === S.jy);
  const list = [...(S.julia ? juliaJourneys().slice(curated ? 1 : 0) : []), ...spots];
  if (!list.length) list.push({ name: `The Whole ${S.f.name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())}`, f: S.f.id, x: S.f.home[0], y: S.f.home[1], s: S.f.home[2] });
  return list;
}
function buildLocations() {
  const key = S.f.id + (S.julia ? `J${S.jx},${S.jy}` : '');
  if (key === shownLocKey) return;
  shownLocKey = key;
  const lwrap = $('#locations');
  lwrap.innerHTML = '';
  currentJourneys().forEach((loc, i) => {
    const b = document.createElement('button');
    const jul = loc.inJulia || loc.jx != null;
    const mag = (jul ? juliaHome().s : HOME_SCALE) / loc.s;
    const here = loc.jx != null && S.julia && S.jx === parseFixed(loc.jx) && S.jy === parseFixed(loc.jy);
    b.innerHTML = `${loc.jx != null ? '<span class="jbadge" title="A Julia set">J</span>' : ''}${loc.name}<span class="tag">${mag < 1e4 ? Math.round(mag) + '×' : '10^' + Math.round(Math.log10(mag))}</span>`;
    if (loc.jx != null) b.title = `Julia set, c = ${loc.jx} ${loc.jy.startsWith('-') ? '−' : '+'} ${loc.jy.replace('-', '')}i`;
    if (here) b.classList.add('here');
    if (loc.name === 'Mirror of c') b.title = 'Near z = c, a Julia set echoes the Mandelbrot set around c';
    b.onclick = () => { locIdx = i; goLocation(loc); };
    lwrap.appendChild(b);
  });
}

function syncUI() {
  buildLocations();
  document.querySelectorAll('#formulas .btn').forEach((b) => b.classList.toggle('on', b.dataset.id === S.f.id || (b.classList.contains('more') && !S.f.quick)));
  const fam = FAMILIES.find((q) => q.id === S.f.family);
  $('#typeNow').textContent = S.f.quick ? '' : `NOW: ${S.f.name} · ${fam ? fam.name.toLowerCase() : ''}`;
  document.querySelectorAll('#palettes .pal').forEach((b, i) => b.classList.toggle('on', i === S.pal));
  $('#juliaBtn').classList.toggle('on', S.julia);
  $('#jpvBtn').classList.toggle('on', jpv.on);
  $('#jpvBtn').disabled = S.f.julia === false;
  const jc = $('#juliaC');
  jc.textContent = S.julia ? `c = ${fmtC(S.jx, S.jy, 8)}  ✎` : (S.f.julia === false ? '' : 'SPACE over any point opens its Julia set');
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
  $('#autoBtn').classList.toggle('on', S.autopilot);
  $('#autoBtn').firstChild.textContent = S.autopilot ? '■ STOP AUTOPILOT ' : '▶ AUTOPILOT DIVE ';
  $('#cycleSpeed').value = S.cycleSpeed;
  $('#density').value = S.density;
  $('#offset').value = S.offset;
  $('#mapping').value = S.mapping;
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

// ---------------------------------------------------------------- prerendered (full-quality) journeys
// A straight dive into the destination, rendered as anti-aliased keyframes one
// octave apart, then composed into a 60 fps video (WebCodecs) that plays back
// perfectly smoothly and can be saved. No keyframe is ever enlarged past its
// native resolution, so every frame is sharp. Without WebCodecs we fall back to
// drawing the keyframes live.
const movie = $('#movie'), movieVideo = $('#movieVideo');
const hqCache = new Map();
let hq = null, lastVideo = null;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const FPS = 60;

async function waitSettled() {
  for (;;) {
    await nextFrame();
    if (!hq || hq.cancel) return false;
    const done = () => ref && ref.key === refKey() && !pend && lowVer === viewVer && fullVer === viewVer && fullDone >= R.full.h && probedVer === viewVer;
    if (done()) { await nextFrame(); await nextFrame(); if (done()) return true; }
  }
}

function cancelHQ() {
  if (!hq) return;
  const job = hq;
  job.cancel = true;
  hq = null;
  hideLoading();
  if (job.phase === 'play') {
    movieVideo.pause();
    if (job.liveScale) { S.cx = job.tx; S.cy = job.ty; S.scale = job.liveScale; invalidate(false); }
  }
  movie.classList.add('hidden'); movieVideo.classList.add('hidden');
  toast(job.phase === 'image' ? 'IMAGE CANCELLED' : 'JOURNEY STOPPED');
}

// ---- loading screen
const bar = (f, n = 28) => { const k = Math.round(Math.max(0, Math.min(1, f)) * n); return '█'.repeat(k) + '░'.repeat(n - k); };
const fmtT = (sec) => (sec < 60 ? `${Math.ceil(sec)} s` : `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`);
function showLoading(job) {
  const img = job.phase === 'image';
  $('#hqTitle').textContent = img ? 'RENDERING IMAGE' : 'PRERENDERING JOURNEY';
  $('#hqLab1').textContent = img ? 'REFINING' : 'KEYFRAMES';
  $('#hqRow2').classList.toggle('hidden', img);
  $('#hqNote').classList.toggle('hidden', img);
  $('#hqName').textContent = `${job.name.toUpperCase()} · ${job.out.w}×${job.out.h}`;
  $('#hqDlg').classList.remove('hidden');
  updateLoading(job);
}
function hideLoading() { $('#hqDlg').classList.add('hidden'); }
function updateLoading(job) {
  if (job.phase === 'image') {
    const f = R.full.h ? fullDone / R.full.h : 0;
    $('#hqBar1').textContent = bar(f);
    $('#hqTxt1').textContent = `${Math.floor(f * 100)}%`;
    $('#hqEta').textContent = `ELAPSED ${fmtT((performance.now() - job.t0) / 1000)}`;
    return;
  }
  const kf = job.k / (job.K + 1), vf = job.vFrames ? job.vDone / job.vFrames : 0;
  $('#hqBar1').textContent = bar(kf);
  $('#hqTxt1').textContent = `${job.k}/${job.K + 1}`;
  $('#hqBar2').textContent = bar(vf);
  $('#hqTxt2').textContent = job.vFrames ? `${Math.floor(vf * 100)}%` : (job.video ? 'WAITING' : 'N/A');
  // ETA: deep keyframes get slower, so extrapolate from the recent keyframe pace
  const now = performance.now();
  let eta = '';
  if (job.phase === 'render' && job.k > 2) {
    const recent = job.kTimes.slice(-6), per = (recent[recent.length - 1] - recent[0]) / Math.max(1, recent.length - 1) / 1000;
    const encode = job.video ? job.T / 1.2 : 0; // encoding runs roughly at real time+
    eta = `≈ ${fmtT(per * (job.K + 1 - job.k) * 1.15 + encode)} LEFT`;
  } else if (job.phase === 'encode' && job.vDone > 30) {
    const per = (now - job.vStart) / job.vDone / 1000;
    eta = `≈ ${fmtT(per * (job.vFrames - job.vDone))} LEFT`;
  }
  $('#hqEta').textContent = `${job.phase === 'render' ? 'RENDERING KEYFRAMES' : job.phase === 'encode' ? 'ENCODING VIDEO' : ''} ${eta}  ·  ELAPSED ${fmtT((now - job.t0) / 1000)}`;
}

function videoConfig(w, h) {
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) return null;
  const bitrate = Math.round(w * h * FPS * 0.22); // fractal detail needs a generous bitrate
  return [
    { codec: 'vp09.00.51.08', id: 'V_VP9' },
    { codec: 'vp09.00.41.08', id: 'V_VP9' },
    { codec: 'vp8', id: 'V_VP8' },
  ].map((c) => ({ id: c.id, cfg: { codec: c.codec, width: w, height: h, bitrate, framerate: FPS } }));
}

async function prerenderJourney(t) {
  stopMotion();
  const o = outputSize(), f = cropFactor(o);
  const s0 = Math.max(homeScale(), t.s * 2), s1 = t.s;
  const K = Math.max(1, Math.ceil(Math.log2(s0 / s1)));
  const r = Math.pow(s0 / s1, 1 / K);
  const scales = Array.from({ length: K + 1 }, (_, k) => s0 / Math.pow(r, k));
  const C = colorParams();
  // octaves per second from the flight-speed slider; ease in and out over `a` seconds
  const speed = 0.85 * S.flySpeed, a = Math.min(1.5, K / speed / 3);
  const T = K / speed + a, vmax = K / (T - a);
  const pos = (x) => Math.max(0, Math.min(K, x < a ? vmax * x * x / (2 * a) : x < T - a ? vmax * (x - a / 2) : K - vmax * (T - x) ** 2 / (2 * a)));
  const key = `${refKey()}|${t.cx}|${t.cy}|${t.s}|${S.pal}|${JSON.stringify(C)}|${o.w}x${o.h}|${S.aa}|${S.flySpeed}`;
  const job = hq = {
    phase: 'render', k: 0, K, tx: t.cx, ty: t.cy, name: t.name, cancel: false, scales, r, T, pos,
    t0: performance.now(), kTimes: [], video: true, vFrames: 0, vDone: 0, out: o,
  };
  const cached = S.pal >= 0 && hqCache.get(key);
  if (cached) { await playVideo(job, cached); return; }

  showLoading(job);
  const tick = setInterval(() => hq === job && updateLoading(job), 250);
  const frames = [];
  let video = null;
  beginOutput(o, f);
  try {
    for (let k = 0; k <= K; k++) {
      S.cx = t.cx; S.cy = t.cy; S.scale = scales[k] * f;
      invalidate(false);
      if (!(await waitSettled()) || job.cancel) return;
      const img = R.colorize(R.full, R.full.w, R.full.h, C);
      const oc = new OffscreenCanvas(img.width, img.height);
      oc.getContext('2d').putImageData(img, 0, 0);
      frames.push(await oc.convertToBlob({ type: 'image/webp', quality: 0.92 }));
      job.k = k + 1; job.kTimes.push(performance.now());
    }
    try { video = await encodeJourney(job, frames); } catch (e) { console.warn('video encoding failed, playing keyframes live', e); }
  } finally {
    clearInterval(tick);
    endOutput(f);
    if (hq === job && job.phase !== 'play') hideLoading();
  }
  if (job.cancel) return;
  hideLoading();
  if (video) {
    if (S.pal >= 0) hqCache.set(key, video);
    await playVideo(job, video);
  } else {
    job.video = false;
    await playKeyframes(job, frames);
  }
}

// Compose the keyframes into a WebM video, frame by frame.
async function encodeJourney(job, frames) {
  const vw = job.out.vw, vh = job.out.vh;
  const opts = videoConfig(vw, vh);
  if (!opts) return null;
  let pick = null;
  for (const o of opts) { if ((await VideoEncoder.isConfigSupported(o.cfg)).supported) { pick = o; break; } }
  if (!pick) return null;

  job.phase = 'encode';
  job.vFrames = Math.ceil((job.T + 0.4) * FPS) + 1; job.vDone = 0; job.vStart = performance.now();
  const chunks = [];
  let failed = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, ts: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => { failed = e; },
  });
  encoder.configure(pick.cfg);
  const oc = new OffscreenCanvas(vw, vh), ctx = oc.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const draw = keyframeDrawer(ctx, vw, vh, frames, job.r);
  try {
    for (let i = 0; i < job.vFrames; i++) {
      if (job.cancel || failed) break;
      const L = job.pos(Math.min(job.T, i / FPS));
      await draw.at(L);
      const vf = new VideoFrame(oc, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      job.vDone = i + 1;
      while (encoder.encodeQueueSize > 4 && !failed) await new Promise((res) => setTimeout(res, 2));
      if (i % 4 === 0) await new Promise((res) => setTimeout(res, 0)); // let the loading screen breathe
    }
    if (!job.cancel && !failed) await encoder.flush();
  } finally {
    draw.close();
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failed) throw failed;
  if (job.cancel) return null;
  const blob = muxWebM(chunks, vw, vh, pick.id, job.vFrames * 1000 / FPS);
  return { blob, url: URL.createObjectURL(blob), name: job.name };
}

// Draws the frame at octave position L from the keyframes, decoding them just ahead.
function keyframeDrawer(ctx, W, H, frames, r) {
  const K = frames.length - 1, bms = [];
  const get = (k) => (bms[k] ||= createImageBitmap(frames[k]));
  return {
    async at(L) {
      const k = Math.min(K - 1, Math.floor(L)), f = L - k, z = Math.pow(r, f);
      for (let j = k; j <= Math.min(K, k + 2); j++) get(j);
      for (let j = 0; j < k; j++) if (bms[j]) { bms[j].then((b) => b.close()); bms[j] = null; }
      // keyframe k covers its view; show its central 1/z
      const bm = await get(k);
      const sw = bm.width / z, sh = bm.height / z;
      ctx.globalAlpha = 1;
      ctx.drawImage(bm, (bm.width - sw) / 2, (bm.height - sh) / 2, sw, sh, 0, 0, W, H);
      if (f > 0.8) { // fade in the next, sharper keyframe over the centre it covers
        const nb = await get(k + 1), dw = W * z / r, dh = H * z / r;
        ctx.globalAlpha = (f - 0.8) / 0.2;
        ctx.drawImage(nb, (W - dw) / 2, (H - dh) / 2, dw, dh);
        ctx.globalAlpha = 1;
      }
    },
    close() { bms.forEach((p) => p && p.then((b) => b.close())); },
  };
}

async function handOver(job) {
  S.cx = job.tx; S.cy = job.ty; S.scale = job.scales[job.K];
  invalidate(false);
  await waitSettled();
}

async function playVideo(job, video) {
  job.phase = 'play';
  lastVideo = video; syncUI();
  movieVideo.src = video.url;
  movieVideo.currentTime = 0;
  await new Promise((res) => { movieVideo.onloadeddata = res; movieVideo.onerror = res; });
  if (job.cancel) return;
  movieVideo.classList.remove('hidden');
  toast(`▶ ${job.name.toUpperCase()} · ESC STOPS · ⬇ SAVE VIDEO IN JOURNEYS`);
  try { await movieVideo.play(); } catch (e) { console.warn(e); }
  // keep the status bar's zoom readout in step with the video
  while (!job.cancel && !movieVideo.ended) {
    await nextFrame();
    const L = job.pos(Math.min(job.T, movieVideo.currentTime));
    const k = Math.min(job.K - 1, Math.floor(L));
    job.liveScale = job.scales[k] / Math.pow(job.r, L - k);
    if (movieVideo.paused && !movieVideo.ended) break; // e.g. autoplay blocked
  }
  if (job.cancel) return;
  await handOver(job);
  if (hq === job) { movieVideo.classList.add('hidden'); hq = null; toast('JOURNEY COMPLETE · ⬇ SAVE VIDEO IN JOURNEYS'); }
}

// Fallback without WebCodecs: draw keyframes live on a 2D canvas.
async function playKeyframes(job, frames) {
  job.phase = 'play';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  movie.width = job.out.vw; movie.height = job.out.vh;
  const ctx = movie.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const draw = keyframeDrawer(ctx, movie.width, movie.height, frames, job.r);
  await draw.at(0);
  movie.classList.remove('hidden');
  const t0 = performance.now();
  for (;;) {
    await nextFrame();
    if (job.cancel) { draw.close(); return; }
    const x = Math.min(job.T, (performance.now() - t0) / 1000), L = job.pos(x);
    await draw.at(L);
    const k = Math.min(job.K - 1, Math.floor(L));
    job.liveScale = job.scales[k] / Math.pow(job.r, L - k);
    if (x >= job.T) break;
  }
  draw.close();
  await handOver(job);
  if (hq === job) { movie.classList.add('hidden'); hq = null; }
}

function saveVideo() {
  if (!lastVideo) return;
  const a = document.createElement('a');
  a.href = lastVideo.url;
  a.download = `fraczilla-${slug(lastVideo.name) || 'journey'}.webm`;
  a.click();
}

// ---------------------------------------------------------------- render panel: output sizes
const OUTS = [
  { id: 'window', name: 'WINDOW' },
  { id: '720p', name: '720p HD', w: 1280, h: 720 },
  { id: '1080p', name: '1080p FULL HD', w: 1920, h: 1080 },
  { id: '1440p', name: '1440p QHD', w: 2560, h: 1440 },
  { id: '4k', name: '4K UHD', w: 3840, h: 2160, note: 'video encoding is slow at 4K' },
  { id: 'square', name: 'SQUARE 1:1', w: 1080, h: 1080 },
  { id: 'portrait', name: 'PORTRAIT 4:5', w: 1080, h: 1350 },
  { id: 'vertical', name: 'VERTICAL 9:16', w: 1080, h: 1920 },
];
try { const o = localStorage.getItem('fraczilla.out'); if (OUTS.some((q) => q.id === o)) S.out = o; } catch {}
S.out ||= 'window';
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// w, h: the render size; vw, vh: the video size (the window is capped near 1080p for encoder speed)
function outputSize(id = S.out) {
  const q = OUTS.find((x) => x.id === id) || OUTS[0];
  if (q.w) return { ...q, vw: q.w, vh: q.h };
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cssW * dpr / 2) * 2, h = Math.round(cssH * dpr / 2) * 2;
  const cap = Math.min(1, Math.sqrt(2.3e6 / (w * h)));
  return { ...q, w, h, vw: Math.round(w * cap / 2) * 2, vh: Math.round(h * cap / 2) * 2 };
}
// the largest rectangle of the output's aspect ratio centred in the window (CSS px)
function cropRect(o) {
  const ar = o.w / o.h;
  let w = cssW, h = cssW / ar;
  if (h > cssH) { h = cssH; w = cssH * ar; }
  return { x: (cssW - w) / 2, y: (cssH - h) / 2, w, h };
}
const cropFactor = (o) => cropRect(o).h / cssH; // output half-height = S.scale × this

function beginOutput(o, f) {
  outOverride = { w: o.w, h: o.h };
  S.scale *= f;
  resize();
}
function endOutput(f) {
  outOverride = null;
  S.scale /= f;
  resize();
}

const renderDlg = $('#renderDlg'), frameBox = $('#frameBox');
const renderOpen = () => !renderDlg.classList.contains('hidden');
function openRender() {
  const sel = $('#outSel');
  sel.innerHTML = '';
  for (const q of OUTS) {
    const o = outputSize(q.id);
    const opt = document.createElement('option');
    opt.value = q.id; opt.textContent = `${q.name} · ${o.w}×${o.h}`;
    sel.appendChild(opt);
  }
  sel.value = S.out;
  const js = $('#renderJourney');
  js.innerHTML = '<option value="-1">DIVE TO THIS VIEW</option>';
  currentJourneys().forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = t.name.toUpperCase();
    js.appendChild(opt);
  });
  renderDlg.classList.remove('hidden');
  updateFrame();
  syncUI();
}
function closeRender() {
  renderDlg.classList.add('hidden');
  frameBox.classList.add('hidden');
}
function updateFrame() {
  const o = outputSize(), r = cropRect(o), g = gcd(o.w, o.h);
  const ar = o.w / g <= 32 ? `${o.w / g}:${o.h / g}` : `${(o.w / o.h).toFixed(2)}:1`;
  frameBox.style.left = `${r.x}px`; frameBox.style.top = `${r.y}px`;
  frameBox.style.width = `${r.w}px`; frameBox.style.height = `${r.h}px`;
  $('#frameLabel').textContent = `${o.w}×${o.h} · ${ar}`;
  frameBox.classList.remove('hidden');
  const video = o.vw === o.w ? `${o.vw}×${o.vh}` : `${o.vw}×${o.vh} (window capped for the encoder)`;
  $('#outInfo').textContent = `IMAGE ${o.w}×${o.h} · VIDEO ${video}${o.note ? ' · ' + o.note : ''}`;
}

async function renderImage() {
  stopMotion();
  const o = outputSize(), f = cropFactor(o);
  const job = hq = { phase: 'image', name: S.f.name, cancel: false, t0: performance.now(), out: o };
  showLoading(job);
  const tick = setInterval(() => hq === job && updateLoading(job), 250);
  beginOutput(o, f);
  try {
    invalidate(false);
    if (!(await waitSettled()) || job.cancel) return;
    // the full-quality target is anti-aliased at a multiple of the output size: scale it down
    const img = R.colorize(R.full, R.full.w, R.full.h, colorParams());
    const bm = await createImageBitmap(img);
    const oc = new OffscreenCanvas(o.w, o.h), ctx = oc.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bm, 0, 0, o.w, o.h);
    bm.close();
    const blob = await oc.convertToBlob({ type: 'image/png' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fraczilla-${S.f.id}${S.julia ? '-julia' : ''}-${o.w}x${o.h}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`SAVED ${o.w}×${o.h} PNG`);
  } finally {
    clearInterval(tick);
    endOutput(f);
    hideLoading();
    if (hq === job) hq = null;
  }
}

// ---------------------------------------------------------------- type browser
const THUMB_W = 240, THUMB_H = 150;
const typeDlg = $('#typeDlg'), typeSearch = $('#typeSearch');
let thumbWorker = null, thumbBusy = false, thumbKey = '', thumbPalData = null;
const thumbCache = new Map();

function buildTypeBrowser() {
  const list = $('#typeList');
  list.innerHTML = '';
  for (const fam of FAMILIES) {
    const types = FORMULAS.filter((f) => f.family === fam.id);
    if (!types.length) continue;
    const sec = document.createElement('section');
    sec.className = 'type-fam';
    sec.innerHTML = `<h3>── ${fam.name} ──</h3><div class="type-grid"></div>`;
    const grid = sec.querySelector('.type-grid');
    for (const f of types) {
      const b = document.createElement('button');
      b.className = 'type-card'; b.dataset.id = f.id;
      b.dataset.search = `${f.name} ${f.id} ${fam.name} ${f.blurb}`.toLowerCase();
      const c = document.createElement('canvas');
      c.width = THUMB_W; c.height = THUMB_H;
      const name = document.createElement('div');
      name.className = 'type-name';
      name.innerHTML = `${f.name}${f.deep ? '<span class="badge" title="Zooms to 10³⁰×">DEEP ZOOM ✓</span>' : ''}`;
      const blurb = document.createElement('div');
      blurb.className = 'type-blurb'; blurb.textContent = f.blurb || '';
      b.append(c, name, blurb);
      b.onclick = () => pickType(f);
      grid.appendChild(b);
    }
    list.appendChild(sec);
  }
  typeSearch.addEventListener('input', filterTypes);
  typeDlg.addEventListener('keydown', typeKeys);
  typeDlg.addEventListener('click', (e) => { if (e.target === typeDlg) closeTypes(); });
  $('#typeClose').onclick = closeTypes;
}

const typesOpen = () => !typeDlg.classList.contains('hidden');
const visibleCards = () => [...typeDlg.querySelectorAll('.type-card')].filter((c) => !c.classList.contains('hidden'));

function openTypes() {
  hideSplash();
  typeDlg.classList.remove('hidden');
  typeSearch.value = '';
  filterTypes();
  typeDlg.querySelectorAll('.type-card').forEach((c) => c.classList.toggle('on', c.dataset.id === S.f.id));
  typeSearch.focus();
  renderThumbs();
}
function closeTypes() {
  typeDlg.classList.add('hidden');
  canvas.focus?.();
}
function pickType(f) {
  closeTypes();
  setFormula(f);
  toast(f.name);
}

function filterTypes() {
  const q = typeSearch.value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  typeDlg.querySelectorAll('.type-card').forEach((c) => {
    c.classList.toggle('hidden', !words.every((w) => c.dataset.search.includes(w)));
  });
  typeDlg.querySelectorAll('.type-fam').forEach((sec) => {
    sec.classList.toggle('hidden', !sec.querySelector('.type-card:not(.hidden)'));
  });
  $('#typeEmpty').classList.toggle('hidden', visibleCards().length > 0);
}

function typeKeys(e) {
  e.stopPropagation(); // keep the main view's shortcuts out of the dialog
  const cards = visibleCards();
  const cur = document.activeElement;
  if (e.key === 'Escape') { e.preventDefault(); closeTypes(); return; }
  if (e.key === 'Enter' && cur === typeSearch) {
    e.preventDefault();
    if (cards[0]) cards[0].click();
    return;
  }
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!(e.key in dirs) || !cards.length) return;
  if (cur === typeSearch) {
    if (e.key !== 'ArrowDown') return; // let the text cursor move
    e.preventDefault(); cards[0].focus(); return;
  }
  const i = cards.indexOf(cur);
  if (i < 0) return;
  e.preventDefault();
  const [dx, dy] = dirs[e.key];
  if (dx) { (cards[i + dx] || cur).focus(); return; }
  // vertical: nearest card in the next row up or down, by geometry
  const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestD = Infinity;
  for (const c of cards) {
    if (c === cur) continue;
    const q = c.getBoundingClientRect(), qy = q.top + q.height / 2;
    if (dy > 0 ? qy <= cy + 4 : qy >= cy - 4) continue;
    const d = Math.abs(qy - cy) * 4 + Math.abs(q.left + q.width / 2 - cx);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best) best.focus();
  else if (dy < 0) typeSearch.focus();
}

function thumbOrbit(f, maxIter) {
  if (!thumbWorker) thumbWorker = new Worker(new URL('./refworker.js?v=1a9f090c', import.meta.url));
  return new Promise((resolve) => {
    const id = Math.random();
    thumbWorker.onmessage = (e) => { if (e.data.id === id) resolve(e.data); };
    thumbWorker.postMessage({
      id, formula: f.code, julia: false, F: 80,
      rx: parseFixed(f.home[0]).toString(), ry: parseFixed(f.home[1]).toString(), jx: '0', jy: '0',
      maxIter, bail2: BAIL * BAIL,
    });
  });
}

// Small offscreen pictures of any view (type f; a Julia set when view.jx is set), with
// their own reference-orbit worker so the main view's reference stays untouched.
let picWorker = null;
const picWait = new Map();
function picOrbit(f, julia, cx, cy, jx, jy, F, maxIter) {
  if (!picWorker) {
    picWorker = new Worker(new URL('./refworker.js?v=1a9f090c', import.meta.url));
    picWorker.onmessage = (e) => { const r = picWait.get(e.data.id); if (r) { picWait.delete(e.data.id); r(e.data); } };
  }
  return new Promise((resolve) => {
    const id = Math.random();
    picWait.set(id, resolve);
    picWorker.postMessage({ id, formula: f.code, julia, F, rx: cx.toString(), ry: cy.toString(), jx: jx.toString(), jy: jy.toString(), maxIter, bail2: BAIL * BAIL });
  });
}
async function picture(f, v, w, h, C = colorParams()) {
  const julia = v.jx != null;
  const cx = typeof v.x === 'bigint' ? v.x : parseFixed(v.x), cy = typeof v.y === 'bigint' ? v.y : parseFixed(v.y);
  const jx = julia ? (typeof v.jx === 'bigint' ? v.jx : parseFixed(v.jx)) : 0n;
  const jy = julia ? (typeof v.jy === 'bigint' ? v.jy : parseFixed(v.jy)) : 0n;
  const L = Math.max(0, Math.log10(HOME_SCALE / v.s));
  const maxIter = v.maxIter || Math.round(Math.min(20000, 300 + 90 * L + 9 * L * L));
  const F = Math.min(FB, Math.max(64, Math.ceil(-Math.log2(v.s)) + 56) + 24);
  const m = f.deep ? await picOrbit(f, julia, cx, cy, jx, jy, F, maxIter + 100) : { lenA: 0, offB: 0, lenB: 0 };
  if (f.deep) R.uploadOrbit(m.data, m.count, R.thumbOrbitTex);
  // C.palData: render with that palette, then put the live one back (the palette is a shared texture)
  if (C.palData) R.uploadPalette(C.palData);
  try { return R.thumbnail({
    formula: f.code, julia, refOffX: 0, refOffY: 0, scale: v.s, ySign: f.ySign,
    maxIter, lenA: m.lenA, offB: m.offB, lenB: m.lenB, bail: f.deep ? BAIL : (f.code === 102 || f.code === 103 ? 100 : 256),
    degree: f.degree, orbitTex: R.thumbOrbitTex,
    cX: julia ? toDouble(jx) : toDouble(cx), cY: julia ? toDouble(jy) : toDouble(cy), crit: f.code === 7 ? 0.5 : 0,
    centerX: toDouble(cx), centerY: toDouble(cy), jcX: toDouble(jx), jcY: toDouble(jy),
    seq: seqBits(f.seq), seqLen: (f.seq || 'A').length,
  }, C, w, h); } finally { if (C.palData) R.uploadPalette(S.palData); }
}

// ---------------------------------------------------------------- live Julia preview
// J: a small inset next to the mouse shows the Julia set of the point under it.
const jpv = { on: false, busy: false, key: '', shown: false, el: $('#jpv'), cv: $('#jpvCanvas'), label: $('#jpvC') };
try { jpv.on = localStorage.getItem('fraczilla.jpreview') === '1'; } catch {}
function setJuliaPreview(on) {
  jpv.on = on;
  try { localStorage.setItem('fraczilla.jpreview', on ? '1' : '0'); } catch {}
  if (!on) hideJuliaPreview();
  toast(on ? 'JULIA PREVIEW: move over the edge of the set, SPACE opens the one you like' : 'JULIA PREVIEW OFF');
  syncUI();
}
function hideJuliaPreview() {
  if (!jpv.shown) return;
  jpv.el.classList.add('hidden'); jpv.shown = false; jpv.key = '';
}
function stepJuliaPreview() {
  if (!jpv.on || !mouse || S.julia || S.f.julia === false || pointers.size || anim.flight || S.autopilot ||
      typesOpen() || hq || renderOpen() || !$('#help').classList.contains('hidden')) { hideJuliaPreview(); return; }
  const W = jpv.el.offsetWidth || 256, H = jpv.el.offsetHeight || 210;
  let x = mouse.x + 28, y = mouse.y + 28;
  const panel = $('#panel'), right = panel.classList.contains('closed') ? cssW : panel.getBoundingClientRect().left;
  if (x + W > right - 8) x = mouse.x - 28 - W;
  if (y + H > cssH - 8) y = mouse.y - 28 - H;
  jpv.el.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  const key = `${S.f.id}|${mouse.x}|${mouse.y}|${viewVer}|${S.pal}|${pal.t}|${S.density.toFixed(2)}|${S.mapping}|${S.smooth}|${S.light}`;
  if (jpv.busy || key === jpv.key) return;
  jpv.busy = true; jpv.key = key;
  const [ox, oy] = screenOffset(mouse.x, mouse.y);
  const jx = S.cx + fromDouble(ox), jy = S.cy + fromDouble(oy), f = S.f, h = juliaHome(f);
  const cv = jpv.cv;
  picture(f, { jx, jy, x: h.x, y: h.y, s: h.s * 1.1, maxIter: 400 }, cv.width, cv.height, { ...colorParams(), offset: S.offset })
    .then((img) => {
      if (!jpv.on || S.julia || f !== S.f) return;
      cv.getContext('2d').putImageData(img, 0, 0);
      jpv.label.textContent = `c = ${fmtC(jx, jy, 5)}`;
      if (!jpv.shown) { jpv.el.classList.remove('hidden'); jpv.shown = true; }
    })
    .catch((e) => console.warn('julia preview', e))
    .finally(() => { jpv.busy = false; });
}

// The palette a type opens with (see setFormula/applyLook), or null to keep the current one.
function lookFor(f) {
  if (retroSaved) return null;
  const loc = (f.start && LOCATIONS.find((l) => l.name === f.start)) || LOCATIONS.find((l) => l.f === f.id);
  if (!loc) return null;
  const p = PALETTES.find((q) => q.name === (loc.pal || 'Ultra'));
  return p && { data: p.data, d: loc.d ?? 0, smooth: !p.banded, o: loc.o };
}

// Render each type's overview with the current palette, one per animation frame.
async function renderThumbs() {
  const key = JSON.stringify(colorParams());
  if (key !== thumbKey || thumbPalData !== S.palData) { thumbCache.clear(); thumbKey = key; thumbPalData = S.palData; }
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    for (const card of typeDlg.querySelectorAll('.type-card')) {
      if (!typesOpen()) break;
      const f = FORMULAS.find((q) => q.id === card.dataset.id);
      const ctx = card.querySelector('canvas').getContext('2d');
      let img = thumbCache.get(f.id);
      const start = f.start && LOCATIONS.find((l) => l.name === f.start);
      // color each card the way the type opens (applyLook), unless retro mode pins the palette
      const look = lookFor(f), C = colorParams();
      if (look) { C.density = Math.pow(2, look.d); C.smooth = look.smooth; C.palData = look.data; if (look.o != null) C.offset = look.o; }
      if (!img && start) {
        // types that open on a Julia set show that picture, not the c-plane
        img = await picture(f, { x: start.x, y: start.y, s: start.s * 1.05, jx: start.jx, jy: start.jy, maxIter: 600 }, THUMB_W, THUMB_H, C);
        thumbCache.set(f.id, img);
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!img) {
        const maxIter = 600;
        const m = f.deep ? await thumbOrbit(f, maxIter) : { lenA: 0, offB: 0, lenB: 0 };
        if (f.deep) R.uploadOrbit(m.data, m.count, R.thumbOrbitTex);
        const hx = parseFloat(f.home[0]), hy = parseFloat(f.home[1]);
        if (C.palData) R.uploadPalette(C.palData);
        img = R.thumbnail({
          formula: f.code, julia: false, refOffX: 0, refOffY: 0, scale: f.home[2] * 1.05, ySign: f.ySign,
          maxIter, lenA: m.lenA, offB: m.offB, lenB: m.lenB, bail: f.deep ? BAIL : (f.code === 102 || f.code === 103 ? 100 : 256),
          degree: f.degree, orbitTex: R.thumbOrbitTex,
          cX: hx, cY: hy, crit: f.code === 7 ? 0.5 : 0, centerX: hx, centerY: hy, seq: seqBits(f.seq), seqLen: (f.seq || 'A').length,
        }, C, THUMB_W, THUMB_H);
        if (C.palData) R.uploadPalette(S.palData);
        thumbCache.set(f.id, img);
        await new Promise((r) => requestAnimationFrame(r));
      }
      ctx.putImageData(img, 0, 0);
    }
  } finally { thumbBusy = false; }
  // palette changed while we were busy? go again
  if (typesOpen() && (JSON.stringify(colorParams()) !== thumbKey || thumbPalData !== S.palData)) renderThumbs();
}

// ---------------------------------------------------------------- boot
// #fly=<journey> starts a flight from the overview, e.g. #fly=the-abyss
const slug = (t) => t.toLowerCase().replace(/\(.*?\)/g, '').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const flyParam = new URLSearchParams(location.hash.slice(1)).get('fly');
if (new URLSearchParams(location.hash.slice(1)).get('hq') === '1') S.hq = true;
const flyLoc = flyParam && LOCATIONS.find((l) => slug(l.name) === slug(flyParam));
if (flyLoc) {
  S.f = FORMULAS.find((q) => q.id === flyLoc.f) || FORMULAS[0];
  setHome();
  setTimeout(() => { hideSplash(); goLocation(flyLoc); }, 1800);
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
}
buildUI();
R.uploadPalette(S.palData);
syncUI();
resize();
requestAnimationFrame(frame);

// handy for debugging from the console
window.fraczilla = { S, R, get params() { return fractalParams(); }, get ref() { return ref; }, get state() { return { viewVer, lowVer, fullVer, fullDone, fullH: R.full.h, probedVer, pend: !!pend, refOk: !!ref && ref.key === refKey() }; }, flyTo: (x, y, s) => flyTo(parseFixed(x), parseFixed(y), s), picture: (id, v, w, h, C) => picture(FORMULAS.find((q) => q.id === id), v, w, h, C), PALETTES, LOCATIONS, colorParams, go: (n) => goLocation(LOCATIONS.find((l) => l.name === n)) };
