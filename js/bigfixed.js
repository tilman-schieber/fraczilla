// Arbitrary precision fixed-point helpers (BigInt with FB fractional bits).
// Used for the view center so we can zoom far beyond double precision.

export const FB = 192;
const FBn = BigInt(FB);
const ONE = 1n << FBn;
const INV = Math.pow(2, -FB);

/** Exact conversion of a JS double into fixed point. */
export function fromDouble(v) {
  if (!v || !isFinite(v)) return 0n;
  const e = Math.floor(Math.log2(Math.abs(v)));
  const shift = 52 - e;                      // v * 2^shift ~ 2^52 (integer)
  const m = BigInt(Math.round(v * Math.pow(2, shift)));
  const s = FB - shift;
  return s >= 0 ? m << BigInt(s) : m >> BigInt(-s);
}

export function toDouble(b) {
  return Number(b) * INV;
}

export function parseFixed(str) {
  str = String(str).trim();
  let neg = false;
  if (str[0] === '-') { neg = true; str = str.slice(1); }
  else if (str[0] === '+') str = str.slice(1);
  if (/e/i.test(str)) return (neg ? -1n : 1n) * fromDouble(parseFloat(str));
  const [ip, fp = ''] = str.split('.');
  let v = BigInt(ip || '0') << FBn;
  if (fp.length) v += (BigInt(fp) << FBn) / (10n ** BigInt(fp.length));
  return neg ? -v : v;
}

export function formatFixed(v, digits) {
  const neg = v < 0n;
  if (neg) v = -v;
  let ip = v >> FBn;
  const frac = v & (ONE - 1n);
  const p = 10n ** BigInt(digits);
  let fd = (frac * p + (ONE >> 1n)) >> FBn;
  if (fd >= p) { fd -= p; ip += 1n; }
  return (neg ? '-' : '') + ip.toString() + '.' + fd.toString().padStart(digits, '0');
}
