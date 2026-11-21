// WebGL2 renderer: perturbation-theory fractal pass into float targets,
// then a cheap coloring pass (so palette cycling never recomputes the fractal).

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const fractalFS = (formula) => `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
#define FORMULA ${formula}
uniform sampler2D uOrbit;
uniform int uLenA, uOffB, uLenB, uMaxIter, uJulia;
uniform vec2 uRefOff, uRes;
uniform float uPix, uYSign, uBail2, uLogBail, uLogDeg;
uniform vec2 uC, uCrit; // lambda: the reference c (or Julia λ); critical point of the formula
out vec4 o;
vec2 gDc = vec2(0.0);   // lambda: this pixel's offset in c

vec2 orb(int i) { return texelFetch(uOrbit, ivec2(i & 2047, i >> 11), 0).xy; }
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
float diffabs(float c, float d) {
  float cd = c + d;
  if (c >= 0.0) return cd >= 0.0 ? d : -(2.0*c + d);
  return cd > 0.0 ? 2.0*c + d : -d;
}
// f(Z + d) - f(Z) without the +c term
vec2 pert(vec2 Z, vec2 d) {
#if FORMULA == 0
  return cmul(2.0*Z + d, d);
#elif FORMULA == 1
  float re = (2.0*Z.x + d.x)*d.x - (2.0*Z.y + d.y)*d.y;
  float im = 2.0*diffabs(Z.x*Z.y, Z.x*d.y + d.x*Z.y + d.x*d.y);
  return vec2(re, im);
#elif FORMULA == 2
  vec2 r = cmul(2.0*Z + d, d); return vec2(r.x, -r.y);
#elif FORMULA == 3
  float re = diffabs(Z.x*Z.x - Z.y*Z.y, (2.0*Z.x + d.x)*d.x - (2.0*Z.y + d.y)*d.y);
  float im = 2.0*(Z.x*d.y + d.x*Z.y + d.x*d.y);
  return vec2(re, im);
#elif FORMULA == 4
  return cmul(d, 3.0*cmul(Z, Z) + 3.0*cmul(Z, d) + cmul(d, d));
#elif FORMULA == 5
  vec2 Z2 = cmul(Z, Z), d2 = cmul(d, d);
  return cmul(d, 4.0*cmul(Z2, Z) + 6.0*cmul(Z2, d) + 4.0*cmul(Z, d2) + cmul(d2, d));
#elif FORMULA == 6
  vec2 Z2 = cmul(Z, Z), Z3 = cmul(Z2, Z), d2 = cmul(d, d), d3 = cmul(d2, d);
  return cmul(d, 5.0*cmul(Z3, Z) + 10.0*cmul(Z3, d) + 10.0*cmul(Z2, d2) + 5.0*cmul(Z, d3) + cmul(d3, d));
#elif FORMULA == 7
  // c·z(1-z): with W = Z(1-Z) and dW = d(1 - 2Z - d), dz' = C·dW + dc·(W + dW)
  vec2 W = cmul(Z, vec2(1.0, 0.0) - Z), dW = cmul(d, vec2(1.0, 0.0) - 2.0*Z - d);
  return cmul(uC, dW) + cmul(gDc, W + dW);
#elif FORMULA == 8
  float re = diffabs(Z.x*Z.x - Z.y*Z.y, (2.0*Z.x + d.x)*d.x - (2.0*Z.y + d.y)*d.y);
  float im = 2.0*diffabs(Z.x*Z.y, Z.x*d.y + d.x*Z.y + d.x*d.y);
  return vec2(re, im);
#elif FORMULA == 9
  float re = (2.0*Z.x + d.x)*d.x - (2.0*Z.y + d.y)*d.y;
  float im = -2.0*(Z.x*diffabs(Z.y, d.y) + d.x*abs(Z.y + d.y));
  return vec2(re, im);
#else
  float re = (2.0*Z.x + d.x)*d.x - (2.0*Z.y + d.y)*d.y;
  float im = -2.0*(diffabs(Z.x, d.x)*Z.y + abs(Z.x + d.x)*d.y);
  return vec2(re, im);
#endif
}
vec2 dfz(vec2 z, vec2 der) {
#if FORMULA == 4
  return 3.0*cmul(cmul(z, z), der);
#elif FORMULA == 5
  return 4.0*cmul(cmul(cmul(z, z), z), der);
#elif FORMULA == 6
  vec2 z2 = cmul(z, z);
  return 5.0*cmul(cmul(z2, z2), der);
#elif FORMULA == 7
  return cmul(cmul(uC + gDc, vec2(1.0, 0.0) - 2.0*z), der);
#elif FORMULA == 2
  vec2 r = 2.0*cmul(z, der); return vec2(r.x, -r.y);
#else
  return 2.0*cmul(z, der);
#endif
}
float amax(vec2 v) { return max(abs(v.x), abs(v.y)); }

void main() {
  vec2 p = gl_FragCoord.xy - 0.5*uRes;
  p.y *= uYSign;
  vec2 dc = (uRefOff + p) * uPix;
  bool julia = uJulia == 1;
  vec2 dz = julia ? dc : vec2(0.0);
  vec2 dcT = julia ? vec2(0.0) : dc;
  vec2 der = julia ? vec2(uPix, 0.0) : vec2(0.0);
  float derAdd = julia ? 0.0 : uPix;
#if FORMULA == 7
  gDc = dcT; dcT = vec2(0.0); // lambda folds dc into pert()
#endif
  int m = 0, off = 0, len = uLenA;
  vec2 z = orb(0) + dz;
  float r2 = dot(z, z);
  int i = 0;
  bool esc = false;
  for (; i < uMaxIter; i++) {
    der = dfz(z, der) + vec2(derAdd, 0.0);
    dz = pert(orb(off + m), dz) + dcT;
    m++;
    z = orb(off + m) + dz;
    r2 = dot(z, z);
    if (r2 > uBail2) { esc = true; break; }
    // Zhuoran's rebasing: hop to the critical orbit when we get closer to it
    if (m >= len - 1 || amax(z - uCrit) < amax(dz)) { dz = z - uCrit; m = 0; off = uOffB; len = uLenB; }
  }
  if (esc) {
    float lz = 0.5*log(r2);
    float mu = float(i) + 1.0 - log(lz / uLogBail) / uLogDeg;
    float dl = length(der);
    bool ok = dl > 0.0 && dl < 1e37;
    float de = ok ? sqrt(r2) * lz / dl : 0.0;
    vec2 u = vec2(0.0);
#if FORMULA != 1 && FORMULA != 3 && FORMULA < 8
    if (ok) { u = vec2(dot(z, der), z.y*der.x - z.x*der.y); u /= max(length(u), 1e-30); }
#endif
    o = vec4(max(mu, 0.0), de, u);
  } else {
    o = vec4(-1.0, r2, 0.0, 0.0);
  }
}`;

// Direct float32 iteration for formulas without a deep-zoom path (codes >= 100).
// Same output layout as the deep shader: (mu, DE, normal.x, normal.y); mu < 0 = inside.
// Basin types put 10 + rootIndex into .w so the color pass can tint each root.
const shallowFS = (formula) => `#version 300 es
precision highp float; precision highp int;
#define FORMULA ${formula}
uniform vec2 uRes, uCenter, uCenterLo, uJC;
uniform float uPix, uYSign, uBail2;
uniform int uMaxIter, uJulia, uSeq, uSeqLen;
out vec4 o;
const float PI = 3.14159265358979;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / dot(b, b); }
vec2 csin(vec2 z) { return vec2(sin(z.x)*cosh(z.y), cos(z.x)*sinh(z.y)); }
vec2 ccos(vec2 z) { return vec2(cos(z.x)*cosh(z.y), -sin(z.x)*sinh(z.y)); }
vec2 cexp(vec2 z) { return exp(z.x) * vec2(cos(z.y), sin(z.y)); }
const vec2 ONE = vec2(1.0, 0.0);
// smooth convergence count: 0..1 extra depending on how far below eps the last step went
float conv(int i, float step, float eps) { return float(i) + 1.0 - clamp(log2(log(max(step, 1e-30)) / log(eps)), 0.0, 1.0); }
float esc(int i, vec2 z, float deg) { float lz = 0.5*log(dot(z, z)); return max(0.0, float(i) + 1.0 - log(lz / (0.5*log(uBail2))) / log(deg)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f*f*(3.0 - 2.0*f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 p = gl_FragCoord.xy - 0.5*uRes;
  p.y *= uYSign;
  vec2 pt = uCenter + (uCenterLo + p*uPix);
  bool julia = uJulia == 1;
  o = vec4(-1.0, 0.0, 0.0, 0.0);
#if FORMULA == 100
  // Newton's method for z^3 - 1: three basins, one per cube root of unity
  vec2 z = pt;
  for (int i = 0; i < uMaxIter; i++) {
    vec2 z2 = cmul(z, z);
    vec2 dz = cdiv(cmul(z2, z) - ONE, 3.0*z2);
    z -= dz;
    float st = length(dz);
    if (st < 1e-5) {
      float root = mod(floor(atan(z.y, z.x) / (2.0*PI/3.0) + 0.5) + 3.0, 3.0);
      o = vec4(conv(i, st, 1e-5), 0.0, 0.0, 10.0 + root);
      return;
    }
  }
#elif FORMULA == 101
  // Nova: z - (z^3-1)/(3z^2) + c, from the critical point z = 1
  vec2 c = julia ? uJC : pt, z = julia ? pt : ONE;
  for (int i = 0; i < uMaxIter; i++) {
    vec2 z2 = cmul(z, z);
    vec2 nz = z - cdiv(cmul(z2, z) - ONE, 3.0*z2) + c;
    float st = length(nz - z);
    z = nz;
    if (st < 1e-5) { o = vec4(conv(i, st, 1e-5), 0.0, 0.0, 0.0); return; }
    if (dot(z, z) > 1e8) return;
  }
#elif FORMULA == 102 || FORMULA == 103
  // Magnet I / II (renormalisation of the Ising model); converging to 1 counts as inside
  vec2 c = julia ? uJC : pt, z = julia ? pt : vec2(0.0);
  vec2 c1 = c - ONE, c2 = c - 2.0*ONE, c12 = cmul(c1, c2);
  for (int i = 0; i < uMaxIter; i++) {
#if FORMULA == 102
    vec2 q = cdiv(cmul(z, z) + c1, 2.0*z + c2);
#else
    vec2 z2 = cmul(z, z);
    vec2 q = cdiv(cmul(z2, z) + 3.0*cmul(c1, z) + c12, 3.0*z2 + 3.0*cmul(c2, z) + c12 + ONE);
#endif
    z = cmul(q, q);
    if (dot(z, z) > uBail2) { o = vec4(esc(i, z, 2.0), 0.0, 0.0, 0.0); return; }
    float st = length(z - ONE);
    if (st < 1e-5) { o = vec4(conv(i, st, 1e-5) * 3.0, 0.0, 0.0, 0.0); return; } // settled on the fixed point 1
  }
#elif FORMULA == 104
  // Spider: z = z^2 + c; c = c/2 + z
  vec2 z = pt, c = julia ? uJC : pt;
  for (int i = 0; i < uMaxIter; i++) {
    z = cmul(z, z) + c;
    c = 0.5*c + z;
    if (dot(z, z) > uBail2) { o = vec4(esc(i, z, 2.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 105
  // Barnsley M1: (z -+ 1)·c depending on the sign of Re z
  vec2 c = julia ? uJC : pt, z = pt;
  for (int i = 0; i < uMaxIter; i++) {
    z = cmul(z.x >= 0.0 ? z - ONE : z + ONE, c);
    if (dot(z, z) > uBail2) { o = vec4(esc(i, z, 2.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 106
  // c·sin(z) from the critical point pi/2; escapes when |Im z| gets large
  vec2 c = julia ? uJC : pt, z = julia ? pt : vec2(PI/2.0, 0.0);
  for (int i = 0; i < uMaxIter; i++) {
    z = cmul(c, csin(z));
    if (abs(z.y) > 50.0) { o = vec4(float(i) + 1.0 - clamp(log2(abs(z.y) / 50.0) / 5.0, 0.0, 1.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 109
  // Phoenix: z' = z^2 + c + p·z_prev with p = -0.5 (Julia mode: the classic Phoenix at c = 0.5667)
  vec2 c = julia ? uJC : pt, z = julia ? pt : vec2(0.0), zp = vec2(0.0);
  for (int i = 0; i < uMaxIter; i++) {
    vec2 nz = cmul(z, z) + c - 0.5*zp;
    zp = z; z = nz;
    if (dot(z, z) > uBail2) { o = vec4(esc(i, z, 2.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 110
  // Manowar: z' = z^2 + z_prev + c, starting from z = z_prev = 0
  vec2 c = julia ? uJC : pt, z = julia ? pt : vec2(0.0), zp = z;
  for (int i = 0; i < uMaxIter; i++) {
    vec2 nz = cmul(z, z) + zp + c;
    zp = z; z = nz;
    if (dot(z, z) > uBail2) { o = vec4(esc(i, z, 2.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 111
  // Halley's method for z^5 - 1: z -= 2ff' / (2f'^2 - ff''); five basins
  vec2 z = pt;
  for (int i = 0; i < uMaxIter; i++) {
    vec2 z2 = cmul(z, z), z3 = cmul(z2, z), z4 = cmul(z2, z2);
    vec2 f = cmul(z4, z) - ONE, f1 = 5.0*z4, f2 = 20.0*z3;
    vec2 dz = cdiv(2.0*cmul(f, f1), 2.0*cmul(f1, f1) - cmul(f, f2));
    z -= dz;
    float st = length(dz);
    if (st < 1e-5) {
      float root = mod(floor(atan(z.y, z.x) / (2.0*PI/5.0) + 0.5) + 5.0, 5.0);
      o = vec4(conv(i, st, 1e-5), 0.0, 0.0, 10.0 + root*0.6); // 0.6 = 3/5: spread over the palette
      return;
    }
  }
#elif FORMULA == 112
  // cos(z) + c from the critical point 0; escapes when |Im z| gets large
  vec2 c = julia ? uJC : pt, z = julia ? pt : vec2(0.0);
  for (int i = 0; i < uMaxIter; i++) {
    z = ccos(z) + c;
    if (abs(z.y) > 50.0) { o = vec4(float(i) + 1.0 - clamp(log2(abs(z.y) / 50.0) / 5.0, 0.0, 1.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 113
  // c·exp(z) from the asymptotic value 0; escapes when Re z gets large
  vec2 c = julia ? uJC : pt, z = julia ? pt : vec2(0.0);
  for (int i = 0; i < uMaxIter; i++) {
    z = cmul(c, cexp(z));
    if (z.x > 50.0) { o = vec4(float(i) + 1.0 - clamp(log2(z.x / 50.0) / 5.0, 0.0, 1.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 107
  // Lyapunov exponent of the logistic map, forcing sequence of a (bit 0) and b (bit 1)
  float a = pt.x, b = pt.y;
  if (a <= 0.0 || a > 4.0 || b <= 0.0 || b > 4.0) return;
  float x = 0.5, sum = 0.0;
  int n = min(uMaxIter, 2000), k = 0;
  for (int i = 0; i < 60; i++) { float r = ((uSeq >> k) & 1) == 1 ? b : a; x = r*x*(1.0 - x); k = k + 1 == uSeqLen ? 0 : k + 1; }
  for (int i = 0; i < n; i++) {
    float r = ((uSeq >> k) & 1) == 1 ? b : a;
    x = r*x*(1.0 - x);
    sum += log(max(abs(r*(1.0 - 2.0*x)), 1e-30));
    k = k + 1 == uSeqLen ? 0 : k + 1;
  }
  float lambda = sum / float(n);
  if (lambda < 0.0) o = vec4(-lambda * 60.0, 0.0, 0.0, 0.0);
  else o = vec4(-1.0, lambda, 0.0, 0.0); // chaos
#elif FORMULA == 108
  // Plasma: fractal value noise, octaves down to the pixel size (cycle the colors!)
  float n = 0.0, amp = 0.5, freq = 1.5;
  for (int i = 0; i < 26; i++) {
    n += amp * (vnoise(pt * freq + float(i) * 17.17) - 0.5);
    freq *= 2.0; amp *= 0.55;
    if (1.0 / freq < uPix) break;
  }
  o = vec4((n + 0.5) * 384.0, 0.0, 0.0, 0.0);
#endif
}`;

// Double-float version of the float formulas: every coordinate is an unevaluated sum
// hi + lo of two float32s (~48 bits), which takes these types from ~10^5x to ~10^11x.
// Used only when the view is deep enough to need it, since it costs several times more.
// Complex numbers are vec4(re.hi, re.lo, im.hi, im.lo).
const shallowDF = (formula) => `#version 300 es
precision highp float; precision highp int;
#define FORMULA ${formula}
uniform vec2 uRes, uCenter, uCenterLo, uJC;
uniform float uPix, uYSign, uBail2, uOne;
uniform int uMaxIter, uJulia, uSeq, uSeqLen;
out vec4 o;
const float PI = 3.14159265358979;
// --- double-float arithmetic. Each rounded result is multiplied by uOne (1.0, unknown at
// compile time), or the compiler simplifies (a + b) - a to b and the error terms vanish.
vec2 two(float a, float b) {
  float s = (a + b) * uOne, v = (s - a) * uOne, w = (s - v) * uOne;
  return vec2(s, (a - w) + (b - v));
}
vec2 qtwo(float a, float b) { float s = (a + b) * uOne; return vec2(s, b - (s - a) * uOne); }
vec2 split(float a) { float h = uintBitsToFloat(floatBitsToUint(a) & 0xFFFFF000u); return vec2(h, a - h); }
vec2 prod(float a, float b) {
  float p = (a * b) * uOne; vec2 A = split(a), B = split(b);
  return vec2(p, (((A.x*B.x - p) * uOne + A.x*B.y) * uOne + A.y*B.x) * uOne + A.y*B.y);
}
vec2 dadd(vec2 a, vec2 b) { vec2 s = two(a.x, b.x); s.y += a.y + b.y; return qtwo(s.x, s.y); }
vec2 dsub(vec2 a, vec2 b) { return dadd(a, -b); }
vec2 dmul(vec2 a, vec2 b) { vec2 p = prod(a.x, b.x); p.y += a.x*b.y + a.y*b.x; return qtwo(p.x, p.y); }
vec2 dmulf(vec2 a, float b) { b *= uOne; vec2 p = prod(a.x, b); p.y += a.y*b; return qtwo(p.x, p.y); }
vec2 ddivf(vec2 a, float b) { b *= uOne; float q = a.x / b; vec2 r = dsub(a, prod(q, b)); return qtwo(q, r.x / b); }
vec2 ddiv(vec2 a, vec2 b) { float q = a.x / b.x; vec2 r = dsub(a, dmulf(b, q)); return qtwo(q, r.x / b.x); }
// --- complex double-float
#define CF(x, y) vec4(x, 0.0, y, 0.0)
vec2 hi(vec4 z) { return z.xz; }
vec4 cadd(vec4 a, vec4 b) { return vec4(dadd(a.xy, b.xy), dadd(a.zw, b.zw)); }
vec4 csub(vec4 a, vec4 b) { return vec4(dsub(a.xy, b.xy), dsub(a.zw, b.zw)); }
vec4 cmul(vec4 a, vec4 b) { return vec4(dsub(dmul(a.xy, b.xy), dmul(a.zw, b.zw)), dadd(dmul(a.xy, b.zw), dmul(a.zw, b.xy))); }
vec4 csq(vec4 a) { return vec4(dsub(dmul(a.xy, a.xy), dmul(a.zw, a.zw)), 2.0*dmul(a.xy, a.zw)); }
vec4 cscale(vec4 a, float f) { return vec4(dmulf(a.xy, f), dmulf(a.zw, f)); }
vec4 cdiv(vec4 a, vec4 b) {
  vec2 d = dadd(dmul(b.xy, b.xy), dmul(b.zw, b.zw));
  return vec4(ddiv(dadd(dmul(a.xy, b.xy), dmul(a.zw, b.zw)), d), ddiv(dsub(dmul(a.zw, b.xy), dmul(a.xy, b.zw)), d));
}
// literal constants also go through uOne: the driver mis-folds df operations on them
#define D1 vec2(uOne, 0.0)
#define ONE vec4(uOne, 0.0, 0.0, 0.0)
// --- transcendentals: e^a (and e^a - 1 without cancellation), sin and cos
#define LN2 (uOne * vec2(0.693147182, -1.90465421e-9))
#define TWOPI (uOne * vec2(6.28318548, -1.74845553e-7))
vec2 dexp(vec2 a, out vec2 em1) {
  float k = floor(a.x / LN2.x + 0.5);
  vec2 r = 0.00390625 * dsub(a, dmulf(LN2, k)); // |r| < 0.0014
  vec2 t = r, s = r;
  for (int n = 2; n <= 5; n++) { t = ddivf(dmul(t, r), float(n)); s = dadd(s, t); }
  for (int n = 0; n < 8; n++) s = dadd(2.0*s, dmul(s, s)); // (1+s)^2 - 1, eight times: ^256
  vec2 e = dadd(D1, s);
  float m = intBitsToFloat((int(k) + 127) << 23); // exactly 2^k
  em1 = k == 0.0 ? s : dsub(m*e, D1);
  return m * e;
}
vec4 dsincos(vec2 a) { // (sin, cos)
  float k = floor(a.x / TWOPI.x + 0.5);
  vec2 r = 0.125 * dsub(a, dmulf(TWOPI, k)), r2 = dmul(r, r); // |r| < pi/8
  vec2 ts = r, s = r, tc = D1, c = tc;
  for (int n = 1; n <= 7; n++) {
    tc = -ddivf(dmul(tc, r2), float((2*n - 1) * (2*n)));
    ts = -ddivf(dmul(ts, r2), float((2*n) * (2*n + 1)));
    c = dadd(c, tc); s = dadd(s, ts);
  }
  for (int n = 0; n < 3; n++) { vec2 s2 = 2.0*dmul(s, c); c = dsub(D1, 2.0*dmul(s, s)); s = s2; }
  return vec4(s, c);
}
vec4 dcoshsinh(vec2 a) { // (cosh, sinh); sinh from e^a - 1 so it stays exact near 0
  vec2 em1, e = dexp(a, em1);
  vec2 ie = ddiv(D1, e);
  return vec4(0.5*dadd(e, ie), 0.5*dmul(em1, dadd(D1, ie)));
}
vec4 csin(vec4 z) { vec4 sc = dsincos(z.xy), ch = dcoshsinh(z.zw); return vec4(dmul(sc.xy, ch.xy), dmul(sc.zw, ch.zw)); }
vec4 ccos(vec4 z) { vec4 sc = dsincos(z.xy), ch = dcoshsinh(z.zw); return vec4(dmul(sc.zw, ch.xy), -dmul(sc.xy, ch.zw)); }
vec4 cexp(vec4 z) { vec2 em1, e = dexp(z.xy, em1); vec4 sc = dsincos(z.zw); return vec4(dmul(e, sc.zw), dmul(e, sc.xy)); }

float conv(int i, float step, float eps) { return float(i) + 1.0 - clamp(log2(log(max(step, 1e-30)) / log(eps)), 0.0, 1.0); }
float esc(int i, vec2 z, float deg) { float lz = 0.5*log(dot(z, z)); return max(0.0, float(i) + 1.0 - log(lz / (0.5*log(uBail2))) / log(deg)); }
float escIm(int i, float y) { return float(i) + 1.0 - clamp(log2(y / 50.0) / 5.0, 0.0, 1.0); }

void main() {
  vec2 p = gl_FragCoord.xy - 0.5*uRes;
  p.y *= uYSign;
  vec4 pt = vec4(dadd(vec2(uCenter.x, uCenterLo.x), prod(p.x, uPix)), dadd(vec2(uCenter.y, uCenterLo.y), prod(p.y, uPix)));
  vec4 jc = CF(uJC.x, uJC.y);
  bool julia = uJulia == 1;
  o = vec4(-1.0, 0.0, 0.0, 0.0);
#if FORMULA == 100 || FORMULA == 111
  vec4 z = pt;
  for (int i = 0; i < uMaxIter; i++) {
    vec4 z2 = csq(z);
#if FORMULA == 100
    vec4 dz = cdiv(csub(cmul(z2, z), ONE), cscale(z2, 3.0));
    const float NR = 3.0;
#else
    vec4 z3 = cmul(z2, z), z4 = csq(z2);
    vec4 f = csub(cmul(z4, z), ONE), f1 = cscale(z4, 5.0), f2 = cscale(z3, 20.0);
    vec4 dz = cdiv(cscale(cmul(f, f1), 2.0), csub(cscale(csq(f1), 2.0), cmul(f, f2)));
    const float NR = 5.0;
#endif
    z = csub(z, dz);
    float st = length(hi(dz));
    if (st < 1e-5) {
      float root = mod(floor(atan(z.z, z.x) / (2.0*PI/NR) + 0.5) + NR, NR);
      o = vec4(conv(i, st, 1e-5), 0.0, 0.0, 10.0 + root*3.0/NR);
      return;
    }
  }
#elif FORMULA == 101
  vec4 c = julia ? jc : pt, z = julia ? pt : ONE;
  for (int i = 0; i < uMaxIter; i++) {
    vec4 z2 = csq(z);
    vec4 nz = cadd(csub(z, cdiv(csub(cmul(z2, z), ONE), cscale(z2, 3.0))), c);
    float st = length(hi(nz) - hi(z));
    z = nz;
    if (st < 1e-5) { o = vec4(conv(i, st, 1e-5), 0.0, 0.0, 0.0); return; }
    if (dot(hi(z), hi(z)) > 1e8) return;
  }
#elif FORMULA == 102 || FORMULA == 103
  vec4 c = julia ? jc : pt, z = julia ? pt : vec4(0.0);
  vec4 c1 = csub(c, ONE), c2 = csub(c, 2.0*ONE), c12 = cmul(c1, c2);
  for (int i = 0; i < uMaxIter; i++) {
#if FORMULA == 102
    vec4 q = cdiv(cadd(csq(z), c1), cadd(cscale(z, 2.0), c2));
#else
    vec4 z2 = csq(z);
    vec4 q = cdiv(cadd(cadd(cmul(z2, z), cscale(cmul(c1, z), 3.0)), c12),
                  cadd(cadd(cadd(cscale(z2, 3.0), cscale(cmul(c2, z), 3.0)), c12), ONE));
#endif
    z = csq(q);
    vec2 h = hi(z);
    if (dot(h, h) > uBail2) { o = vec4(esc(i, h, 2.0), 0.0, 0.0, 0.0); return; }
    float st = length(h - D1);
    if (st < 1e-5) { o = vec4(conv(i, st, 1e-5) * 3.0, 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 104 || FORMULA == 105 || FORMULA == 109 || FORMULA == 110
  vec4 c = julia ? jc : pt;
#if FORMULA == 104
  vec4 z = pt;
#elif FORMULA == 105
  vec4 z = pt;
#else
  vec4 z = julia ? pt : vec4(0.0), zp = z;
#endif
  for (int i = 0; i < uMaxIter; i++) {
#if FORMULA == 104
    z = cadd(csq(z), c);
    c = cadd(cscale(c, 0.5), z);
#elif FORMULA == 105
    z = cmul(z.x >= 0.0 ? csub(z, ONE) : cadd(z, ONE), c);
#elif FORMULA == 109
    vec4 nz = csub(cadd(csq(z), c), cscale(zp, 0.5));
    zp = z; z = nz;
#else
    vec4 nz = cadd(cadd(csq(z), zp), c);
    zp = z; z = nz;
#endif
    vec2 h = hi(z);
    if (dot(h, h) > uBail2) { o = vec4(esc(i, h, 2.0), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 106 || FORMULA == 112
  vec4 c = julia ? jc : pt;
#if FORMULA == 106
  vec4 z = julia ? pt : uOne * vec4(1.57079637, -4.37113883e-8, 0.0, 0.0);
#else
  vec4 z = julia ? pt : vec4(0.0);
#endif
  for (int i = 0; i < uMaxIter; i++) {
#if FORMULA == 106
    z = cmul(c, csin(z));
#else
    z = cadd(ccos(z), c);
#endif
    if (abs(z.z) > 50.0) { o = vec4(escIm(i, abs(z.z)), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 113
  vec4 c = julia ? jc : pt, z = julia ? pt : vec4(0.0);
  for (int i = 0; i < uMaxIter; i++) {
    z = cmul(c, cexp(z));
    if (z.x > 50.0) { o = vec4(escIm(i, z.x), 0.0, 0.0, 0.0); return; }
  }
#elif FORMULA == 107
  vec2 a = pt.xy, b = pt.zw;
  if (a.x <= 0.0 || a.x > 4.0 || b.x <= 0.0 || b.x > 4.0) return;
  vec2 x = vec2(0.5, 0.0);
  float sum = 0.0;
  int n = min(uMaxIter, 2000), k = 0;
  for (int i = 0; i < 60; i++) { vec2 r = ((uSeq >> k) & 1) == 1 ? b : a; x = dmul(dmul(r, x), dsub(D1, x)); k = k + 1 == uSeqLen ? 0 : k + 1; }
  for (int i = 0; i < n; i++) {
    vec2 r = ((uSeq >> k) & 1) == 1 ? b : a;
    x = dmul(dmul(r, x), dsub(D1, x));
    sum += log(max(abs(r.x*(1.0 - 2.0*x.x)), 1e-30));
    k = k + 1 == uSeqLen ? 0 : k + 1;
  }
  float lambda = sum / float(n);
  if (lambda < 0.0) o = vec4(-lambda * 60.0, 0.0, 0.0, 0.0);
  else o = vec4(-1.0, lambda, 0.0, 0.0);
#endif
}`;

const COLOR_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uLow, uFull, uPal;
uniform vec2 uLowRes, uFullRes, uOut;
uniform float uDoneY, uDensity, uOffset, uLightStr, uEdge;
uniform int uHaveFull, uMapping, uSmooth, uLight, uInside;
uniform vec2 uLightDir;
uniform vec3 uInsideColor;
out vec4 o;

vec3 pal(float idx) {
  if (uSmooth == 1) return texture(uPal, vec2(idx / 256.0, 0.5)).rgb;
  return texture(uPal, vec2((floor(mod(idx, 256.0)) + 0.5) / 256.0, 0.5)).rgb;
}
vec3 shade(vec4 d) {
  if (d.x < 0.0) {
    if (uInside == 0) return uInsideColor;
    return pal(sqrt(d.y) * 96.0 * uDensity + uOffset) * 0.85;
  }
  float n = uSmooth == 1 ? d.x : floor(d.x);
  float f = uMapping == 0 ? n : (uMapping == 1 ? sqrt(n) * 16.0 : log2(1.0 + n) * 32.0);
  if (d.w >= 9.5) { // root basins: each root gets its own third of the palette, iterations shade within it
    float root = d.w - 10.0;
    vec3 b = pal(root * 85.333 + uOffset + f * uDensity * 0.35);
    return b * (0.35 + 0.65 * exp(-0.08 * n));
  }
  vec3 c = pal(f * uDensity + uOffset);
  if (uLight == 1 && d.z * d.z + d.w * d.w > 0.25) {
    float h = 1.25;
    float t = clamp((dot(d.zw, uLightDir) + h) / (1.0 + h), 0.0, 1.0);
    float spec = pow(t, 24.0) * 0.35;
    c = mix(c, c * (0.25 + 1.0 * t) + spec, uLightStr);
  }
  if (uEdge > 0.0) {
    float e = smoothstep(0.0, 1.5, d.y);
    c *= mix(1.0 - uEdge, 1.0, e);
  }
  return c;
}
vec3 fetchShade(sampler2D t, ivec2 p, vec2 res) {
  p = clamp(p, ivec2(0), ivec2(res) - 1);
  return shade(texelFetch(t, p, 0));
}
vec3 sampleTex(sampler2D t, vec2 res) {
  vec2 ratio = res / uOut;
  if (ratio.y > 0.99) {
    int k = int(ratio.y + 0.5);
    ivec2 b = ivec2(floor(gl_FragCoord.xy)) * k;
    vec3 acc = vec3(0.0);
    for (int j = 0; j < k; j++)
      for (int i = 0; i < k; i++) acc += fetchShade(t, b + ivec2(i, j), res);
    return acc / float(k * k);
  }
  vec2 pos = gl_FragCoord.xy * ratio - 0.5;
  vec2 f = fract(pos);
  ivec2 i0 = ivec2(floor(pos));
  vec3 a = fetchShade(t, i0, res), b = fetchShade(t, i0 + ivec2(1, 0), res);
  vec3 c = fetchShade(t, i0 + ivec2(0, 1), res), d = fetchShade(t, i0 + ivec2(1, 1), res);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec3 c = (uHaveFull == 1 && gl_FragCoord.y >= uDoneY) ? sampleTex(uFull, uFullRes) : sampleTex(uLow, uLowRes);
  o = vec4(c, 1.0);
}`;

export const PROBE_MAXW = 192, PROBE_H = 64;

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false, alpha: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU/browser cannot render to float textures (EXT_color_buffer_float).');
    this.gl = gl;
    this.canvas = canvas;
    this.vao = gl.createVertexArray();
    this.progs = {};
    this.colorProg = this.link(VS, COLOR_FS);

    this.orbitTex = this.makeTex(gl.NEAREST);
    this.thumbOrbitTex = this.makeTex(gl.NEAREST);
    this.palTex = this.makeTex(gl.LINEAR, gl.REPEAT);
    this.low = this.makeTarget(1, 1);
    this.full = this.makeTarget(1, 1);
    this.probeT = this.makeTarget(PROBE_MAXW, PROBE_H);
    this.probeBuf = new Float32Array(PROBE_MAXW * PROBE_H * 4);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.timers = [];
  }

  link(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    p.loc = {};
    p.u = (name) => (name in p.loc ? p.loc[name] : (p.loc[name] = gl.getUniformLocation(p, name)));
    return p;
  }

  fractalProg(code, df = false) {
    const key = df ? code + 1000 : code;
    return this.progs[key] || (this.progs[key] = this.link(VS, df ? shallowDF(code) : code >= 100 ? shallowFS(code) : fractalFS(code)));
  }

  // float formulas switch to double-float once a pixel is too small for float32 to resolve
  static needsDF(P, pix) {
    if (P.formula < 100 || P.formula === 108) return false;
    return pix < 4e-7 * Math.max(1, Math.abs(P.centerX || 0), Math.abs(P.centerY || 0));
  }

  makeTex(filter, wrap) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const t = { tex: this.makeTex(gl.NEAREST), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    this.sizeTarget(t, w, h);
    return t;
  }

  sizeTarget(t, w, h) {
    if (t.w === w && t.h === h) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    t.w = w; t.h = h;
  }

  resize(W, H, aa) {
    this.canvas.width = W; this.canvas.height = H;
    this.sizeTarget(this.low, W, H);
    this.sizeTarget(this.full, W * aa, H * aa);
  }

  uploadOrbit(data, count, tex = this.orbitTex) {
    const gl = this.gl, w = 2048, h = Math.max(1, Math.ceil(count / w));
    const buf = new Float32Array(w * h * 2);
    buf.set(data.subarray(0, count * 2));
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, buf);
  }

  uploadPalette(rgba) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  // P: { formula, julia, refOffX, refOffY (complex units), scale, ySign, maxIter, lenA, offB, lenB, bail, degree }
  drawFractal(target, rw, rh, P, y0 = 0, y1 = rh) {
    const pix = 2 * P.scale / rh;
    const gl = this.gl, prog = this.fractalProg(P.formula, Renderer.needsDF(P, pix)), u = prog.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y0, rw, y1 - y0);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, P.orbitTex || this.orbitTex);
    gl.uniform1f(u('uOne'), 1);
    gl.uniform1i(u('uOrbit'), 0);
    gl.uniform1i(u('uLenA'), P.lenA);
    gl.uniform1i(u('uOffB'), P.offB);
    gl.uniform1i(u('uLenB'), P.lenB);
    gl.uniform1i(u('uMaxIter'), P.maxIter);
    gl.uniform1i(u('uJulia'), P.julia ? 1 : 0);
    gl.uniform2f(u('uRefOff'), P.refOffX / pix, P.refOffY / pix);
    gl.uniform2f(u('uRes'), rw, rh);
    gl.uniform1f(u('uPix'), pix);
    gl.uniform1f(u('uYSign'), P.ySign);
    gl.uniform1f(u('uBail2'), P.bail * P.bail);
    gl.uniform1f(u('uLogBail'), Math.log(P.bail));
    gl.uniform1f(u('uLogDeg'), Math.log(P.degree));
    gl.uniform2f(u('uC'), P.cX || 0, P.cY || 0);
    gl.uniform2f(u('uCrit'), P.crit || 0, 0);
    // float path: center split into hi + lo so nearby pixels keep their spacing
    const hx = Math.fround(P.centerX || 0), hy = Math.fround(P.centerY || 0);
    gl.uniform2f(u('uCenter'), hx, hy);
    gl.uniform2f(u('uCenterLo'), (P.centerX || 0) - hx, (P.centerY || 0) - hy);
    gl.uniform2f(u('uJC'), P.jcX || 0, P.jcY || 0);
    gl.uniform1i(u('uSeq'), P.seq || 0);
    gl.uniform1i(u('uSeqLen'), P.seqLen || 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  probe(P, pw) {
    const gl = this.gl;
    this.drawFractal(this.probeT, pw, PROBE_H, P);
    gl.readPixels(0, 0, pw, PROBE_H, gl.RGBA, gl.FLOAT, this.probeBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.probeBuf;
  }

  // C: { lowW, lowH, haveFull, doneY, density, offset, mapping, smooth, light, lightAngle, lightStr, edge, inside, insideColor }
  composite(C, out = null) {
    const gl = this.gl, prog = this.colorProg, u = prog.u;
    const ow = out ? out.w : this.canvas.width, oh = out ? out.h : this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.viewport(0, 0, ow, oh);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, C.lowTex || this.low.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.full.tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.uniform1i(u('uLow'), 0); gl.uniform1i(u('uFull'), 1); gl.uniform1i(u('uPal'), 2);
    gl.uniform2f(u('uLowRes'), C.lowW, C.lowH);
    gl.uniform2f(u('uFullRes'), this.full.w, this.full.h);
    gl.uniform2f(u('uOut'), ow, oh);
    gl.uniform1f(u('uDoneY'), C.doneY);
    gl.uniform1i(u('uHaveFull'), C.haveFull ? 1 : 0);
    gl.uniform1f(u('uDensity'), C.density);
    gl.uniform1f(u('uOffset'), C.offset);
    gl.uniform1i(u('uMapping'), C.mapping);
    gl.uniform1i(u('uSmooth'), C.smooth ? 1 : 0);
    gl.uniform1i(u('uLight'), C.light ? 1 : 0);
    const a = C.lightAngle * Math.PI / 180;
    gl.uniform2f(u('uLightDir'), Math.cos(a), Math.sin(a));
    gl.uniform1f(u('uLightStr'), C.lightStr);
    gl.uniform1f(u('uEdge'), C.edge);
    gl.uniform1i(u('uInside'), C.inside);
    gl.uniform3fv(u('uInsideColor'), C.insideColor);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Color a float data target into an RGBA8 offscreen target and read it back (top-down ImageData).
  colorize(src, w, h, C) {
    const gl = this.gl;
    if (!this.outT) {
      this.outT = { tex: this.makeTex(gl.NEAREST), fbo: gl.createFramebuffer(), w: 0, h: 0 };
    }
    const o = this.outT;
    if (o.w !== w || o.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, o.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, o.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.tex, 0);
      o.w = w; o.h = h;
    }
    this.composite({ ...C, lowTex: src.tex, lowW: w, lowH: h, haveFull: false, doneY: h }, o);
    const px = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, o.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const img = new ImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return img;
  }

  // Render a small fully colored picture offscreen and return it as ImageData.
  // P must carry orbitTex: this.thumbOrbitTex (so the main reference stays intact).
  thumbnail(P, C, w, h) {
    if (!this.thumbData) this.thumbData = this.makeTarget(w, h);
    this.sizeTarget(this.thumbData, w, h);
    this.drawFractal(this.thumbData, w, h, P);
    return this.colorize(this.thumbData, w, h, C);
  }

  // GPU timing (EXT_disjoint_timer_query_webgl2), so refinement can be sized by real GPU cost.
  timeStart() {
    if (!this.timerExt || this.timers.length > 4) return null;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    return q;
  }
  timeEnd(q, units) {
    if (!q) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    this.timers.push({ q, units });
  }
  // -> array of milliseconds per unit for finished measurements
  timePoll() {
    const gl = this.gl, out = [];
    if (!this.timerExt) return out;
    const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
    while (this.timers.length) {
      const t = this.timers[0];
      if (!gl.getQueryParameter(t.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(t.q, gl.QUERY_RESULT);
      gl.deleteQuery(t.q);
      this.timers.shift();
      if (!disjoint) out.push(ns / 1e6 / t.units);
    }
    return out;
  }
}
