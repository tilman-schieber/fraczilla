// The type browser (F): cards with live thumbnails, search and keyboard navigation.
import { parseFixed } from './bigfixed.js?v=5ec78ad7';
import { FAMILIES } from './fractals.js?v=5ec78ad7';
import { LOCATIONS } from './locations.js?v=5ec78ad7';
import { PALETTES } from './palettes.js?v=5ec78ad7';
import { picture } from './jpreview.js?v=5ec78ad7';
import { BAIL, FORMULAS, R, S, canvas, colorParams, crossfade, hideSplash, maxIter, phoneClosePanel, pushHistory, retroSaved, seqBits, setFormula, styleOf, toast } from './main.js?v=5ec78ad7';
import { stopTour } from './tour.js?v=5ec78ad7';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- type browser
const THUMB_W = 240, THUMB_H = 150;
const typeDlg = $('#typeDlg'), typeSearch = $('#typeSearch');
let thumbWorker = null, thumbBusy = false, thumbKey = '', thumbPalData = null;
const thumbCache = new Map();

export function buildTypeBrowser() {
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

export const typesOpen = () => !typeDlg.classList.contains('hidden');
const visibleCards = () => [...typeDlg.querySelectorAll('.type-card')].filter((c) => !c.classList.contains('hidden'));

export function openTypes() {
  hideSplash(); stopTour();
  typeDlg.classList.remove('hidden');
  typeSearch.value = '';
  filterTypes();
  typeDlg.querySelectorAll('.type-card').forEach((c) => c.classList.toggle('on', c.dataset.id === S.f.id));
  typeSearch.focus();
  renderThumbs();
}
export function closeTypes() {
  typeDlg.classList.add('hidden');
  canvas.focus?.();
}
function pickType(f) {
  closeTypes(); phoneClosePanel();
  pushHistory(); crossfade();
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
  if (!thumbWorker) thumbWorker = new Worker(new URL('./refworker.js?v=5ec78ad7', import.meta.url));
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

// The palette a type opens with (see setFormula/applyLook), or null to keep the current one.
function lookFor(f) {
  if (retroSaved) return null;
  const loc = (f.start && LOCATIONS.find((l) => l.name === f.start)) || LOCATIONS.find((l) => l.f === f.id);
  if (!loc) return null;
  const p = PALETTES.find((q) => q.name === (loc.pal || 'Ultra'));
  return p && { data: p.data, d: loc.d ?? 0, smooth: !p.banded, o: loc.o, k: loc.k || 0 };
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
      C.colorMode = styleOf(f, look ? look.k : S.colorMode);
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
          colorMode: C.colorMode,
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
