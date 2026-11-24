// Saved views (★ MINE): capture, name, list, rename, delete with undo, links, export/import.
import { formatFixed, parseFixed, toDouble } from './bigfixed.js?v=6c511792';
import { LOCATIONS } from './locations.js?v=6c511792';
import { PALETTES } from './palettes.js?v=6c511792';
import { FORMULAS, HOME_SCALE, S, canvas, coordDigits, goLocation, juliaHome, phoneClosePanel, syncUI, toast } from './main.js?v=6c511792';
import { stopTour } from './tour.js?v=6c511792';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- saved views (★ MINE)
// Kept in localStorage. Each one is a curated-spot-like object plus its full color state,
// so goLocation, the tour and the render panel can use it like any destination.
const FAV_KEY = 'fraczilla.favorites';
const DEC = /^-?\d+(\.\d+)?$/;
export let favs = [], jTab = 'cur', favPending = null, favUndo = null;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const niceName = (f) => f.name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const fmtMag = (mag) => (mag < 1e4 ? Math.round(mag) + '×' : '10^' + Math.round(Math.log10(mag)));
export const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (str) => Uint8Array.from(atob(str), (ch) => ch.charCodeAt(0));
const palCache = new Map();
// Untrusted input (storage or an imported file): keep only well-formed fields.
export function cleanFav(o) {
  if (!o || typeof o !== 'object') return null;
  const f = FORMULAS.find((q) => q.id === o.f);
  if (!f || !DEC.test(o.x) || !DEC.test(o.y)) return null;
  const sc = +o.s;
  if (!(sc > 0 && sc < 1000)) return null;
  const out = { id: typeof o.id === 'string' ? o.id.slice(0, 24) : newId(), name: String(o.name || 'Untitled').trim().slice(0, 60) || 'Untitled', t: +o.t || Date.now(), f: f.id, x: o.x, y: o.y, s: sc };
  if (o.jx != null || o.jy != null) {
    if (!DEC.test(o.jx) || !DEC.test(o.jy)) return null;
    out.jx = o.jx; out.jy = o.jy;
  }
  if (typeof o.pal === 'string' && PALETTES.some((q) => q.name === o.pal)) out.pal = o.pal;
  else if (typeof o.pd === 'string' && /^[A-Za-z0-9+/]{1366}==$/.test(o.pd)) out.pd = o.pd;
  if (Number.isFinite(o.d)) out.d = Math.max(-4, Math.min(4, o.d));
  if (Number.isFinite(o.o)) out.o = Math.max(0, Math.min(256, o.o));
  if ([0, 1, 2].includes(o.m)) out.m = o.m;
  if ([1, 2].includes(o.k)) out.k = o.k;
  if (typeof o.light === 'boolean') out.light = o.light;
  if (typeof o.smooth === 'boolean') out.smooth = o.smooth;
  if (Number.isFinite(o.i) && o.i >= 50 && o.i <= 200000) out.i = Math.round(o.i);
  return out;
}
function loadFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    favs = Array.isArray(a) ? a.map(cleanFav).filter(Boolean) : [];
  } catch { favs = []; }
}
function storeFavs() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); return true; }
  catch { toast('NOT SAVED: browser storage is full or blocked'); return false; }
}
export function favLoc(fv) {
  let palData = null;
  if (fv.pd) { palData = palCache.get(fv.pd); if (!palData) { palData = unb64(fv.pd); palCache.set(fv.pd, palData); } }
  return { ...fv, fav: true, palData };
}
const favMag = (fv) => (fv.jx != null ? juliaHome(FORMULAS.find((q) => q.id === fv.f)).s : HOME_SCALE) / fv.s;
// the current view, with everything needed to come back to it
function captureView() {
  const d = coordDigits();
  const o = { id: newId(), name: '', t: Date.now(), f: S.f.id, x: formatFixed(S.cx, d), y: formatFixed(S.cy, d), s: +S.scale.toPrecision(6) };
  if (S.julia) { o.jx = formatFixed(S.jx, 24); o.jy = formatFixed(S.jy, 24); }
  if (S.pal >= 0) o.pal = PALETTES[S.pal].name; else o.pd = b64(S.palData);
  o.d = +S.density.toFixed(2); o.o = +S.offset.toFixed(1); o.m = S.mapping; o.light = S.light; o.smooth = S.smooth;
  if (S.colorMode) o.k = S.colorMode;
  if (!S.iterAuto) o.i = S.iterManual;
  return o;
}
// "Seahorse Valley 2" near a curated spot, else "Mandelbrot · 10^5"
function suggestName() {
  let best = null;
  for (const l of LOCATIONS) {
    if (l.f !== S.f.id || (l.jx != null) !== S.julia) continue;
    if (S.julia && (parseFixed(l.jx) !== S.jx || parseFixed(l.jy) !== S.jy)) continue;
    const r = Math.max(l.s, S.scale);
    const d = Math.hypot(toDouble(parseFixed(l.x) - S.cx), toDouble(parseFixed(l.y) - S.cy)) / r;
    if (d < 3 && Math.abs(Math.log10(S.scale / l.s)) < 2.5 && (!best || d < best.d)) best = { d, name: l.name };
  }
  const base = best ? best.name : `${niceName(S.f)}${S.julia ? ' Julia' : ''} · ${fmtMag((S.julia ? juliaHome().s : HOME_SCALE) / S.scale)}`;
  return uniqueName(base);
}
function uniqueName(base) {
  const taken = new Set(favs.map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`)) return `${base} ${k}`;
}
function setTab(t) {
  jTab = t;
  try { localStorage.setItem('fraczilla.jtab', t); } catch {}
  $('#tabCur').classList.toggle('on', t === 'cur');
  $('#tabMine').classList.toggle('on', t === 'mine');
  $('#locations').classList.toggle('hidden', t !== 'cur');
  $('#mine').classList.toggle('hidden', t !== 'mine');
  if (t !== 'mine') closeSaveFav();
  syncUI();
}
// M: grab the view now (it may move on), then ask for a name in the panel
export function openSaveFav() {
  stopTour();
  favPending = captureView();
  $('#panel').classList.remove('closed');
  setTab('mine');
  $('#favForm').classList.remove('hidden');
  const inp = $('#favInput');
  inp.value = suggestName();
  inp.focus(); inp.select();
}
function closeSaveFav() {
  favPending = null;
  $('#favForm').classList.add('hidden');
}
function commitSaveFav() {
  if (!favPending) return;
  favPending.name = $('#favInput').value.trim().slice(0, 60) || suggestName();
  favs.unshift(favPending);
  if (!storeFavs()) { favs.shift(); return; }
  toast(`SAVED: ${favPending.name.toUpperCase()}`);
  closeSaveFav(); buildFavs(); syncUI();
  canvas.focus?.();
}
function favUrl(fv) {
  const p = new URLSearchParams();
  p.set('f', fv.f); p.set('x', fv.x); p.set('y', fv.y); p.set('s', fv.s);
  if (fv.jx != null) { p.set('jx', fv.jx); p.set('jy', fv.jy); }
  const pi = PALETTES.findIndex((q) => q.name === fv.pal);
  if (pi >= 0) p.set('p', pi);
  if (fv.d != null) p.set('d', fv.d); if (fv.o != null) p.set('o', fv.o); if (fv.m != null) p.set('m', fv.m);
  p.set('l', (fv.light === false ? 0 : 1) + '' + (fv.smooth === false ? 0 : 1));
  if (fv.i) p.set('i', fv.i);
  if (fv.k) p.set('k', fv.k);
  return `${location.href.split('#')[0]}#${p}`;
}
function deleteFav(i) {
  const [fv] = favs.splice(i, 1);
  storeFavs();
  favUndo = { fv, i };
  setTimeout(() => { if (favUndo && favUndo.fv === fv) { favUndo = null; buildFavs(); } }, 10000);
  buildFavs(); syncUI();
}
function renameFav(row, fv) {
  const inp = document.createElement('input');
  inp.value = fv.name; inp.maxLength = 60;
  row.replaceChildren(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (save && v) { fv.name = v.slice(0, 60); storeFavs(); }
    buildFavs();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); };
  inp.onblur = () => finish(true);
}
function buildFavs() {
  const list = $('#favList');
  list.replaceChildren();
  $('#favEmpty').classList.toggle('hidden', favs.length > 0 || !!favUndo);
  $('#favExport').disabled = !favs.length;
  if (favUndo) {
    const u = document.createElement('button');
    u.className = 'undo';
    u.textContent = `↶ UNDO: DELETE ${favUndo.fv.name.toUpperCase()}`;
    u.onclick = () => { favs.splice(Math.min(favUndo.i, favs.length), 0, favUndo.fv); favUndo = null; storeFavs(); buildFavs(); syncUI(); };
    list.appendChild(u);
  }
  favs.forEach((fv, i) => {
    const row = document.createElement('div');
    row.className = 'fav';
    const go = document.createElement('button');
    go.className = 'fgo';
    if (fv.jx != null) { const j = document.createElement('span'); j.className = 'jbadge'; j.textContent = 'J'; go.appendChild(j); }
    go.appendChild(document.createTextNode(fv.name));
    const tag = document.createElement('span');
    tag.className = 'tag'; tag.textContent = fmtMag(favMag(fv));
    go.appendChild(tag);
    const f = FORMULAS.find((q) => q.id === fv.f);
    go.title = `${niceName(f)}${fv.jx != null ? ' Julia set' : ''} · ${fmtMag(favMag(fv))} · saved ${new Date(fv.t).toLocaleDateString()}`;
    go.onclick = () => { goLocation(favLoc(fv)); phoneClosePanel(); };
    const acts = document.createElement('span');
    acts.className = 'acts';
    const act = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'act'; b.textContent = label; b.title = title; b.onclick = fn;
      acts.appendChild(b);
    };
    act('✎', 'Rename', () => renameFav(row, fv));
    act('🔗', 'Copy a link to this view', async () => {
      try { await navigator.clipboard.writeText(favUrl(fv)); toast(fv.pd ? 'LINK COPIED (a random palette does not travel in links)' : 'LINK COPIED'); }
      catch { toast('COPY FAILED'); }
    });
    act('✕', 'Delete', () => deleteFav(i));
    row.append(go, acts);
    list.appendChild(row);
  });
}
function exportFavs() {
  const blob = new Blob([JSON.stringify({ app: 'fraczilla', version: 1, favorites: favs }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fraczilla-views-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`EXPORTED ${favs.length} VIEW${favs.length === 1 ? '' : 'S'}`);
}
async function importFavs(file) {
  try {
    if (file.size > 5e6) throw new Error('too big');
    const data = JSON.parse(await file.text());
    const arr = Array.isArray(data) ? data : data && Array.isArray(data.favorites) ? data.favorites : null;
    if (!arr) throw new Error('no list');
    const key = (v) => [v.f, v.x, v.y, v.s, v.jx, v.jy].join('|');
    const have = new Set(favs.map(key));
    let added = 0, dup = 0, bad = 0;
    for (const raw of arr.slice(0, 2000)) {
      const fv = cleanFav(raw);
      if (!fv) { bad++; continue; }
      if (have.has(key(fv))) { dup++; continue; }
      fv.id = newId(); fv.name = uniqueName(fv.name);
      favs.push(fv); have.add(key(fv)); added++;
    }
    if (added && !storeFavs()) { favs.splice(favs.length - added, added); return; }
    buildFavs(); syncUI();
    toast(`IMPORTED ${added}${dup ? ` · ${dup} ALREADY THERE` : ''}${bad ? ` · ${bad} UNREADABLE` : ''}`);
  } catch { toast('IMPORT FAILED: not a Fraczilla views file'); }
}
export function bindFavs() {
  loadFavs();
  $('#tabCur').onclick = () => setTab('cur');
  $('#tabMine').onclick = () => setTab('mine');
  $('#favSave').onclick = openSaveFav;
  $('#favOk').onclick = commitSaveFav;
  $('#favInput').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitSaveFav(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSaveFav(); canvas.focus?.(); }
    e.stopPropagation();
  };
  $('#favExport').onclick = exportFavs;
  $('#favImport').onclick = () => $('#favFile').click();
  $('#favFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFavs(f); };
  let t = 'cur';
  try { t = localStorage.getItem('fraczilla.jtab') === 'mine' ? 'mine' : 'cur'; } catch {}
  buildFavs();
  setTab(t);
}
