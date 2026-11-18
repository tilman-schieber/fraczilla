// 256-entry palettes. Gradients wrap around, so color cycling is seamless.

const hex = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function gradient(stops) {
  const s = stops.map(([p, c]) => [p, typeof c === 'string' ? hex(c) : c]).sort((a, b) => a[0] - b[0]);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 256;
    let k = s.length - 1;
    for (let j = 0; j < s.length; j++) if (s[j][0] <= t) k = j;
    const a = s[k], b = s[(k + 1) % s.length];
    let span = b[0] - a[0]; if (span <= 0) span += 1;
    let f = t - a[0]; if (f < 0) f += 1;
    f = Math.min(1, f / span);
    f = f * f * (3 - 2 * f);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function fromFn(fn) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i);
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255].map(Math.round);
}

// The default 256-color VGA palette, as seen in countless DOS fractal programs.
function vga() {
  const ega = ['000', '00a', '0a0', '0aa', 'a00', 'a0a', 'a50', 'aaa', '555', '55f', '5f5', '5ff', 'f55', 'f5f', 'ff5', 'fff'];
  const gray = [0, 5, 8, 11, 14, 17, 20, 24, 28, 32, 36, 40, 45, 50, 56, 63];
  const cols = ega.map(hex);
  gray.forEach((g) => cols.push([g, g, g].map((v) => Math.round(v * 255 / 63))));
  for (const [hi, lo] of [[63, 0], [63, 31], [63, 45], [28, 0], [28, 14], [28, 20], [16, 0], [16, 8], [16, 11]]) {
    const v = [0, 1, 2, 3, 4].map((k) => Math.round(lo + (hi - lo) * k / 4));
    const seq = [];
    for (let k = 0; k < 4; k++) seq.push([v[k], lo, hi]);
    for (let k = 0; k < 4; k++) seq.push([hi, lo, v[4 - k]]);
    for (let k = 0; k < 4; k++) seq.push([hi, v[k], lo]);
    for (let k = 0; k < 4; k++) seq.push([v[4 - k], hi, lo]);
    for (let k = 0; k < 4; k++) seq.push([lo, hi, v[k]]);
    for (let k = 0; k < 4; k++) seq.push([lo, v[4 - k], hi]);
    seq.forEach((c) => cols.push(c.map((x) => Math.round(x * 255 / 63))));
  }
  while (cols.length < 256) cols.push([0, 0, 0]);
  return fromFn((i) => cols[i]);
}

export const PALETTES = [
  { name: 'Ultra', data: gradient([[0, '#000764'], [0.16, '#206bcb'], [0.42, '#edffff'], [0.6425, '#ffaa00'], [0.8575, '#000200']]) },
  { name: 'Classic VGA', data: vga(), banded: true },
  { name: 'Inferno', data: gradient([[0, '#000004'], [0.18, '#420a68'], [0.36, '#932667'], [0.52, '#dd513a'], [0.68, '#fca50a'], [0.82, '#fcffa4'], [0.92, '#6b1b4a']]) },
  { name: 'Ocean', data: gradient([[0, '#010b1f'], [0.25, '#0a3d6b'], [0.48, '#1fa4b8'], [0.66, '#d4f5ec'], [0.82, '#2a7ab0']]) },
  { name: 'Neon', data: gradient([[0, '#0a0014'], [0.2, '#ff00a8'], [0.4, '#1a0033'], [0.6, '#00f0ff'], [0.8, '#2b0057']]) },
  { name: 'Sunset', data: gradient([[0, '#1a0533'], [0.22, '#7b1fa2'], [0.42, '#ff4f81'], [0.6, '#ffb347'], [0.76, '#fff1a8'], [0.9, '#5a1a6e']]) },
  { name: 'Gold', data: gradient([[0, '#0b0700'], [0.3, '#5e3b00'], [0.55, '#d9a21b'], [0.7, '#fff4c2'], [0.85, '#a86b00']]) },
  { name: 'Glacier', data: gradient([[0, '#ffffff'], [0.25, '#7fd4ff'], [0.55, '#0b2f6b'], [0.78, '#000814'], [0.9, '#3a7bd5']]) },
  { name: 'Forest', data: gradient([[0, '#06140a'], [0.3, '#1f5e2c'], [0.55, '#a6d96a'], [0.72, '#f6f2c0'], [0.88, '#4a3a1a']]) },
  { name: 'Vaporwave', data: gradient([[0, '#ff71ce'], [0.2, '#01cdfe'], [0.4, '#05ffa1'], [0.6, '#b967ff'], [0.8, '#fffb96']]) },
  { name: 'Rainbow', data: fromFn((i) => hsl(i * 360 / 256, 0.95, 0.55)) },
  { name: 'Psychedelic', data: fromFn((i) => hsl(i * 360 * 3 / 256, 1, 0.5 + 0.35 * Math.sin(i * Math.PI * 16 / 256))) },
  { name: 'Lava', data: gradient([[0, '#000000'], [0.15, '#3b0000'], [0.3, '#ff2a00'], [0.38, '#ffe066'], [0.46, '#ff2a00'], [0.62, '#1a0000']]) },
  { name: 'Zebra', data: fromFn((i) => { const v = (i >> 3) & 1 ? 235 : 18; return [v, v, v + (v > 100 ? 10 : 30)].map((x) => Math.min(255, x)); }) },
  { name: 'Mono', data: gradient([[0, '#000000'], [0.5, '#ffffff']]) },
];

export function randomPalette() {
  const n = 4 + Math.floor(Math.random() * 4);
  const base = Math.random() * 360;
  const harmony = [30, 60, 120, 150, 180][Math.floor(Math.random() * 5)];
  const stops = [];
  for (let i = 0; i < n; i++) {
    const dark = i % 2 === 0;
    const h = base + (Math.random() < 0.5 ? 0 : harmony) + (Math.random() - 0.5) * 40;
    const s = 0.45 + Math.random() * 0.55;
    const l = dark ? 0.04 + Math.random() * 0.22 : 0.5 + Math.random() * 0.42;
    stops.push([(i + Math.random() * 0.6) / n, hsl(h, s, l)]);
  }
  return { name: 'Random', data: gradient(stops) };
}
