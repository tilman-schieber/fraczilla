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
out vec4 o;

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
#else
  vec2 Z2 = cmul(Z, Z), d2 = cmul(d, d);
  return cmul(d, 4.0*cmul(Z2, Z) + 6.0*cmul(Z2, d) + 4.0*cmul(Z, d2) + cmul(d2, d));
#endif
}
vec2 dfz(vec2 z, vec2 der) {
#if FORMULA == 4
  return 3.0*cmul(cmul(z, z), der);
#elif FORMULA == 5
  return 4.0*cmul(cmul(cmul(z, z), z), der);
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
    if (m >= len - 1 || amax(z) < amax(dz)) { dz = z; m = 0; off = uOffB; len = uLenB; }
  }
  if (esc) {
    float lz = 0.5*log(r2);
    float mu = float(i) + 1.0 - log(lz / uLogBail) / uLogDeg;
    float dl = length(der);
    bool ok = dl > 0.0 && dl < 1e37;
    float de = ok ? sqrt(r2) * lz / dl : 0.0;
    vec2 u = vec2(0.0);
#if FORMULA != 1 && FORMULA != 3
    if (ok) { u = vec2(dot(z, der), z.y*der.x - z.x*der.y); u /= max(length(u), 1e-30); }
#endif
    o = vec4(max(mu, 0.0), de, u);
  } else {
    o = vec4(-1.0, r2, 0.0, 0.0);
  }
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

  fractalProg(code) {
    return this.progs[code] || (this.progs[code] = this.link(VS, fractalFS(code)));
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
    const gl = this.gl, prog = this.fractalProg(P.formula), u = prog.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y0, rw, y1 - y0);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, P.orbitTex || this.orbitTex);
    const pix = 2 * P.scale / rh;
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

  // Render a small fully colored picture offscreen and return it as ImageData.
  // P must carry orbitTex: this.thumbOrbitTex (so the main reference stays intact).
  thumbnail(P, C, w, h) {
    const gl = this.gl;
    if (!this.thumbData) {
      this.thumbData = this.makeTarget(w, h);
      const tex = this.makeTex(gl.NEAREST), fbo = gl.createFramebuffer();
      this.thumbOut = { tex, fbo, w: 0, h: 0 };
    }
    this.sizeTarget(this.thumbData, w, h);
    const o = this.thumbOut;
    if (o.w !== w || o.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, o.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, o.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.tex, 0);
      o.w = w; o.h = h;
    }
    this.drawFractal(this.thumbData, w, h, P);
    this.composite({ ...C, lowTex: this.thumbData.tex, lowW: w, lowH: h, haveFull: false, doneY: h }, o);
    const px = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, o.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL rows are bottom-up; ImageData is top-down
    const img = new ImageData(w, h), row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return img;
  }
}
