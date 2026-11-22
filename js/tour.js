// The lean-back tour (A): curated spots of every type, or your saved views, one after another.
import { parseFixed } from './bigfixed.js?v=5ec78ad7';
import { LOCATIONS } from './locations.js?v=5ec78ad7';
import { favLoc, favs, jTab } from './favorites.js?v=5ec78ad7';
import { R, S, anim, flyTo, fullDone, fullVer, goLocation, hideSplash, juliaHome, lowVer, pend, reduceMotion, ref, refKey, syncUI, toast, viewVer } from './main.js?v=5ec78ad7';
import { closeRender, hq } from './render.js?v=5ec78ad7';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- tour
// A: a lean-back show. Flies from curated spot to curated spot across all types,
// waits for the full-quality render, holds, and moves on. Any navigation stops it.
const TOUR_HOLD = 6000, TOUR_MAX_WAIT = 25000;
// keys that only change the look keep the tour running
export const TOUR_KEEPS = new Set(['z', 'Z', 'a', 'A', 'Tab', 'h', 'H', 'F1', '?', 'c', 'C', '+', '=', '-', '_', 'p', 'P', '[', ']', 'b', 'B', 'd', 'D', 'r', 'R', 'j', 'J', 'l', 'L', 'Shift']);
export const tour = { on: false, list: [], next: null, phase: 'idle', t0: 0, settledAt: 0, saved: null };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// up to two spots per type, types in random order (never the type we are on first)
function tourPlaylist() {
  if (tour.mine) return shuffle(favs.map(favLoc));
  const byType = new Map();
  for (const l of LOCATIONS) {
    if (l.f === 'plasma' || l.tour === false || l.name.startsWith('The Whole')) continue;
    if (!byType.has(l.f)) byType.set(l.f, []);
    byType.get(l.f).push(l);
  }
  const types = shuffle([...byType.keys()]);
  if (types[0] === S.f.id && types.length > 1) types.push(types.shift());
  return types.flatMap((t) => shuffle(byType.get(t)).slice(0, 2));
}
const tourSettled = () => (!S.f.deep || (ref && ref.key === refKey())) && !pend && lowVer === viewVer && fullVer === viewVer && fullDone >= R.full.h;
// a different type or Julia set than the one on screen
const tourCut = (l) => l.f !== S.f.id || (l.jx != null) !== S.julia || (l.jx != null && (parseFixed(l.jx) !== S.jx || parseFixed(l.jy) !== S.jy));
export function startTour(mine = jTab === 'mine') {
  if (hq) return;
  if (mine && favs.length < 2) { toast('SAVE AT LEAST TWO VIEWS (M) FOR A TOUR OF YOURS'); return; }
  tour.mine = mine;
  hideSplash(); closeRender(); $('#help').classList.add('hidden');
  tour.on = true; tour.list = tourPlaylist();
  tour.saved = { cycling: S.cycling, panelClosed: $('#panel').classList.contains('closed') };
  if (!reduceMotion.matches) S.cycling = true; // the system asked for less motion: hold the colors still
  $('#panel').classList.add('closed');
  toast(mine ? 'TOUR OF YOUR SAVED VIEWS: any zoom, drag or key ends it' : 'TOUR: sit back. Any zoom, drag or key ends it');
  tourAdvance();
  syncUI();
}
export function stopTour() {
  if (!tour.on) return;
  tour.on = false; tour.phase = 'idle';
  S.cycling = tour.saved.cycling;
  $('#panel').classList.toggle('closed', tour.saved.panelClosed);
  showCaption(null);
  toast('TOUR ENDED');
  syncUI();
}
function tourAdvance() {
  if (!tour.list.length) tour.list = tourPlaylist();
  tour.next = tour.list.shift();
  showCaption(null);
  const h = S.julia ? juliaHome() : { x: parseFixed(S.f.home[0]), y: parseFixed(S.f.home[1]), s: S.f.home[2] };
  if (tourCut(tour.next) && S.scale < h.s * 0.5) {
    // pull back to the overview first, so the cut to the next type happens from afar
    tour.phase = 'out';
    flyTo(h.x, h.y, h.s, S.flySpeed * 2.5);
  } else tourGo();
}
function tourGo() {
  tour.phase = 'fly';
  goLocation(tour.next, false, true);
}
export function stepTour() {
  if (!tour.on || hq || anim.flight) return;
  const now = performance.now();
  if (tour.phase === 'out') { tourGo(); return; }
  if (tour.phase === 'fly') {
    tour.phase = 'hold'; tour.t0 = now; tour.settledAt = 0;
    const l = tour.next;
    showCaption(l.name, l.jx != null ? `${S.f.name} · JULIA SET` : S.f.name);
    return;
  }
  if (tour.phase === 'hold') {
    if (!tour.settledAt && tourSettled()) tour.settledAt = now;
    if ((tour.settledAt && now - tour.settledAt > TOUR_HOLD) || now - tour.t0 > TOUR_MAX_WAIT) tourAdvance();
  }
}
function showCaption(title, sub) {
  const c = $('#caption');
  if (!title) { c.classList.remove('show'); return; }
  c.querySelector('b').textContent = title.toUpperCase();
  c.querySelector('span').textContent = sub || '';
  c.classList.add('show');
}
