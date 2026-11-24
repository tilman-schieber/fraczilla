// Offscreen pictures of any view, and the live Julia preview (J) next to the mouse.
import { FB, fromDouble, parseFixed, toDouble } from './bigfixed.js?v=6c511792';
import { BAIL, HOME_SCALE, R, S, anim, colorParams, cssH, cssW, fmtC, juliaHome, maxIter, mouse, pal, pointers, screenOffset, seqBits, styleOf, syncUI, toast, viewVer } from './main.js?v=6c511792';
import { hq, renderOpen } from './render.js?v=6c511792';
import { tour } from './tour.js?v=6c511792';
import { typesOpen } from './types.js?v=6c511792';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- live Julia preview
// Small offscreen pictures of any view (type f; a Julia set when view.jx is set), with
// their own reference-orbit worker so the main view's reference stays untouched.
let picWorker = null;
const picWait = new Map();
function picOrbit(f, julia, cx, cy, jx, jy, F, maxIter) {
  if (!picWorker) {
    picWorker = new Worker(new URL('./refworker.js?v=6c511792', import.meta.url));
    picWorker.onmessage = (e) => { const r = picWait.get(e.data.id); if (r) { picWait.delete(e.data.id); r(e.data); } };
  }
  return new Promise((resolve) => {
    const id = Math.random();
    picWait.set(id, resolve);
    picWorker.postMessage({ id, formula: f.code, julia, F, rx: cx.toString(), ry: cy.toString(), jx: jx.toString(), jy: jy.toString(), maxIter, bail2: BAIL * BAIL });
  });
}
export async function picture(f, v, w, h, C = colorParams()) {
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
    seq: seqBits(f.seq), seqLen: (f.seq || 'A').length, colorMode: C.colorMode = styleOf(f, C.colorMode ?? 0),
  }, C, w, h); } finally { if (C.palData) R.uploadPalette(S.palData); }
}

// J: a small inset next to the mouse shows the Julia set of the point under it.
export const jpv = { on: false, busy: false, key: '', shown: false, el: $('#jpv'), cv: $('#jpvCanvas'), label: $('#jpvC') };
try { jpv.on = localStorage.getItem('fraczilla.jpreview') === '1'; } catch {}
export function setJuliaPreview(on) {
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
export function stepJuliaPreview() {
  if (!jpv.on || !mouse || S.julia || S.f.julia === false || pointers.size || anim.flight || tour.on ||
      typesOpen() || hq || renderOpen() || !$('#help').classList.contains('hidden')) { hideJuliaPreview(); return; }
  const W = jpv.el.offsetWidth || 256, H = jpv.el.offsetHeight || 210;
  let x = mouse.x + 28, y = mouse.y + 28;
  const panel = $('#panel'), right = panel.classList.contains('closed') ? cssW : panel.getBoundingClientRect().left;
  if (x + W > right - 8) x = mouse.x - 28 - W;
  if (y + H > cssH - 8) y = mouse.y - 28 - H;
  jpv.el.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  const key = `${S.f.id}|${mouse.x}|${mouse.y}|${viewVer}|${S.pal}|${pal.t}|${S.density.toFixed(2)}|${S.mapping}|${S.smooth}|${S.light}|${S.colorMode}`;
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
