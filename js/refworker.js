// Reference orbit worker: iterates one point at arbitrary precision (BigInt
// fixed point) so the GPU only has to track tiny float32 deltas around it.
// Formula codes must match the shader: 0 mandel, 1 burning ship, 2 tricorn,
// 3 celtic, 4 z^3, 5 z^4.

const CENTER_BITS = 192;

function orbit(formula, x, y, cx, cy, F, maxIter, bail2) {
  const Fn = BigInt(F);
  const inv = Math.pow(2, -F);
  const out = new Float32Array((maxIter + 2) * 2);
  out[0] = Number(x) * inv; out[1] = Number(y) * inv;
  let n = 1, escaped = false;
  const abs = (v) => (v < 0n ? -v : v);
  for (let i = 0; i < maxIter; i++) {
    const x2 = (x * x) >> Fn, y2 = (y * y) >> Fn;
    let nx, ny;
    switch (formula) {
      case 0: { const xy = (x * y) >> Fn; nx = x2 - y2 + cx; ny = 2n * xy + cy; break; }
      case 1: { const xy = (x * y) >> Fn; nx = x2 - y2 + cx; ny = 2n * abs(xy) + cy; break; }
      case 2: { const xy = (x * y) >> Fn; nx = x2 - y2 + cx; ny = -2n * xy + cy; break; }
      case 3: { const xy = (x * y) >> Fn; nx = abs(x2 - y2) + cx; ny = 2n * xy + cy; break; }
      case 4: {
        nx = ((x * (x2 - 3n * y2)) >> Fn) + cx;
        ny = ((y * (3n * x2 - y2)) >> Fn) + cy;
        break;
      }
      default: {
        const a = x2 - y2, b = (2n * x * y) >> Fn;
        nx = ((a * a - b * b) >> Fn) + cx;
        ny = ((2n * a * b) >> Fn) + cy;
      }
    }
    x = nx; y = ny;
    const xd = Number(x) * inv, yd = Number(y) * inv;
    out[2 * n] = xd; out[2 * n + 1] = yd; n++;
    if (xd * xd + yd * yd > bail2) { escaped = true; break; }
  }
  return { data: out.subarray(0, n * 2), len: n, escaped };
}

self.onmessage = (e) => {
  const m = e.data;
  const t0 = performance.now();
  const F = m.F;
  const sh = BigInt(CENTER_BITS - F);
  const toF = (s) => BigInt(s) >> sh;
  const rx = toF(m.rx), ry = toF(m.ry);
  let A, B = null;
  if (m.julia) {
    const jx = toF(m.jx), jy = toF(m.jy);
    A = orbit(m.formula, rx, ry, jx, jy, F, m.maxIter, m.bail2);
    B = orbit(m.formula, 0n, 0n, jx, jy, F, m.maxIter, m.bail2);
  } else {
    A = orbit(m.formula, 0n, 0n, rx, ry, F, m.maxIter, m.bail2);
  }
  const total = A.len + (B ? B.len : 0);
  const data = new Float32Array(total * 2);
  data.set(A.data, 0);
  if (B) data.set(B.data, A.len * 2);
  self.postMessage({
    id: m.id, data, count: total,
    lenA: A.len, escapedA: A.escaped,
    offB: B ? A.len : 0, lenB: B ? B.len : A.len,
    ms: performance.now() - t0,
  }, [data.buffer]);
};
