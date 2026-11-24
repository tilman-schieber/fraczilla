// Full-quality output: prerendered journeys as WebM video, and the render panel (sizes, frame, images).
import { muxWebM } from './webm.js?v=6c511792';
import { favs } from './favorites.js?v=6c511792';
import { R, S, colorParams, cssH, cssW, currentJourneys, fullDone, fullVer, homeScale, invalidate, lowVer, pend, probedVer, ref, refKey, resize, slug, stopMotion, syncUI, toast, viewVer } from './main.js?v=6c511792';
import { stopTour } from './tour.js?v=6c511792';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- prerendered (full-quality) journeys
export let outOverride = null; // { w, h } device pixels while rendering an export at a fixed size
// A straight dive into the destination, rendered as anti-aliased keyframes one
// octave apart, then composed into a 60 fps video (WebCodecs) that plays back
// perfectly smoothly and can be saved. No keyframe is ever enlarged past its
// native resolution, so every frame is sharp. Without WebCodecs we fall back to
// drawing the keyframes live.
export const movie = $('#movie'), movieVideo = $('#movieVideo');
const hqCache = new Map();
export let hq = null, lastVideo = null;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
export const FPS = 60;

async function waitSettled() {
  for (;;) {
    await nextFrame();
    if (!hq || hq.cancel) return false;
    const done = () => (!S.f.deep || (ref && ref.key === refKey())) && !pend && lowVer === viewVer && fullVer === viewVer && fullDone >= R.full.h && probedVer === viewVer;
    if (done()) { await nextFrame(); await nextFrame(); if (done()) return true; }
  }
}

export function cancelHQ() {
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

export async function prerenderJourney(t) {
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

export function saveVideo() {
  if (!lastVideo) return;
  const a = document.createElement('a');
  a.href = lastVideo.url;
  a.download = `fraczilla-${slug(lastVideo.name) || 'journey'}.webm`;
  a.click();
}

// ---------------------------------------------------------------- render panel: output sizes
export const OUTS = [
  { id: 'window', name: 'WINDOW' },
  { id: '720p', name: '720p HD', w: 1280, h: 720 },
  { id: '1080p', name: '1080p FULL HD', w: 1920, h: 1080 },
  { id: '1440p', name: '1440p QHD', w: 2560, h: 1440 },
  { id: '4k', name: '4K UHD', w: 3840, h: 2160, note: 'video encoding is slow at 4K' },
  { id: 'square', name: 'SQUARE 1:1', w: 1080, h: 1080 },
  { id: 'portrait', name: 'PORTRAIT 4:5', w: 1080, h: 1350 },
  { id: 'vertical', name: 'VERTICAL 9:16', w: 1080, h: 1920 },
];
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
export const renderOpen = () => !renderDlg.classList.contains('hidden');
export function openRender() {
  stopTour();
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
  if (favs.length) {
    const g = document.createElement('optgroup');
    g.label = '★ MINE';
    favs.forEach((fv, i) => {
      const opt = document.createElement('option');
      opt.value = 'f' + i; opt.textContent = fv.name.toUpperCase();
      g.appendChild(opt);
    });
    js.appendChild(g);
  }
  renderDlg.classList.remove('hidden');
  updateFrame();
  syncUI();
}
export function closeRender() {
  renderDlg.classList.add('hidden');
  frameBox.classList.add('hidden');
}
export function updateFrame() {
  const o = outputSize(), r = cropRect(o), g = gcd(o.w, o.h);
  const ar = o.w / g <= 32 ? `${o.w / g}:${o.h / g}` : `${(o.w / o.h).toFixed(2)}:1`;
  frameBox.style.left = `${r.x}px`; frameBox.style.top = `${r.y}px`;
  frameBox.style.width = `${r.w}px`; frameBox.style.height = `${r.h}px`;
  $('#frameLabel').textContent = `${o.w}×${o.h} · ${ar}`;
  frameBox.classList.remove('hidden');
  const video = o.vw === o.w ? `${o.vw}×${o.vh}` : `${o.vw}×${o.vh} (window capped for the encoder)`;
  $('#outInfo').textContent = `IMAGE ${o.w}×${o.h} · VIDEO ${video}${o.note ? ' · ' + o.note : ''}`;
}

export async function renderImage() {
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
