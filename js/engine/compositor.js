// GPU compositor: the program canvas is a single WebGL2 context. Every layer is a textured quad drawn
// with its transform in the vertex shader and premultiplied-alpha blending; colour grading (3D LUT,
// brightness, contrast, saturation, sepia, vignette) runs in the same fragment shader. Blur is a separable
// Gaussian at reduced resolution. Text and stickers are rasterised once into textures and re-rasterised
// only when they change. Video textures are uploaded only when the element has a new frame.
//
// Picture quality:
// - The frame is always composed at the sequence resolution. When the monitor shows it smaller, the
//   composed frame is downsampled with a separable Lanczos-3 filter instead of letting the browser
//   shrink the canvas with plain bilinear sampling (which aliases).
// - Media drawn larger than its source (720p in a 1080p frame) is sampled with Catmull-Rom bicubic.
// - Enhance (per clip): an edge-preserving, block-aware bilateral pass removes compression blocking and
//   mosquito noise, then contrast-adaptive sharpening restores edges. Runs once per decoded frame.
// - Smooth motion (per clip): two consecutive source frames are kept and blended by the exact position
//   of the output frame between them.
// - Output sharpening (4K upscale export): contrast-adaptive sharpening of the final frame.
import { buildLut } from './luts.js';
import { drawSticker } from './stickers.js';
import { trackLayers, transitionMods } from '../core/ops.js';

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform vec2 uSize;
uniform vec2 uRot;
uniform vec4 uUvRect;
out vec2 vUv;
out vec2 vLocal;
void main() {
  vec2 p = aPos * uSize;
  p = vec2(p.x * uRot.x - p.y * uRot.y, p.x * uRot.y + p.y * uRot.x) + uCenter;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  vec2 t = vec2(aPos.x + 0.5, 0.5 - aPos.y);
  vUv = mix(uUvRect.xy, uUvRect.zw, t);
  vLocal = aPos + 0.5;
}`;

const LAYER_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
in vec2 vLocal;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uTexPrev;
uniform sampler3D uLut;
uniform vec2 uTexSize;
uniform float uBicubic, uMix;
uniform float uOpacity, uGrade, uLutSize, uLutAmt, uBright, uContrast, uSat, uSepia, uVig;

// Catmull-Rom bicubic in 9 bilinear taps (sharper than bilinear when magnifying).
vec4 bicubic(sampler2D tex, vec2 uv) {
  vec2 sp = uv * uTexSize;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (t1 - 1.0) / uTexSize;
  vec2 t3 = (t1 + 2.0) / uTexSize;
  vec2 t12 = (t1 + w2 / w12) / uTexSize;
  vec4 r = texture(tex, vec2(t0.x, t0.y)) * w0.x * w0.y + texture(tex, vec2(t12.x, t0.y)) * w12.x * w0.y + texture(tex, vec2(t3.x, t0.y)) * w3.x * w0.y
         + texture(tex, vec2(t0.x, t12.y)) * w0.x * w12.y + texture(tex, vec2(t12.x, t12.y)) * w12.x * w12.y + texture(tex, vec2(t3.x, t12.y)) * w3.x * w12.y
         + texture(tex, vec2(t0.x, t3.y)) * w0.x * w3.y + texture(tex, vec2(t12.x, t3.y)) * w12.x * w3.y + texture(tex, vec2(t3.x, t3.y)) * w3.x * w3.y;
  r = max(r, 0.0);
  return vec4(min(r.rgb, vec3(r.a)), r.a);
}
vec4 tap(sampler2D tex, vec2 uv) { return uBicubic > 0.5 ? bicubic(tex, uv) : texture(tex, uv); }

void main() {
  vec4 c = tap(uTex, vUv);
  if (uMix < 0.999) c = mix(tap(uTexPrev, vUv), c, uMix);
  if (uGrade > 0.5 && c.a > 0.0005) {
    vec3 rgb = c.rgb / c.a;
    if (uLutAmt > 0.0) {
      vec3 l = texture(uLut, clamp(rgb, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
      rgb = mix(rgb, l, uLutAmt);
    }
    rgb *= 1.0 + uBright;
    rgb = (rgb - 0.5) * (1.0 + uContrast) + 0.5;
    float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(y), rgb, 1.0 + uSat);
    vec3 sep = vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131)));
    rgb = mix(rgb, sep, uSepia);
    if (uVig > 0.0) {
      float r = length(vLocal - 0.5) * 1.41421;
      rgb *= mix(1.0, 1.0 - smoothstep(0.32, 1.12, r), uVig);
    }
    c = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
  }
  o = c * uOpacity;
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec4 uClamp;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / 36.0);
    acc += texture(uTex, clamp(vUv + uDir * x, uClamp.xy, uClamp.zw)) * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

// Separable Lanczos-3 resampler. uScale = source pixels per output pixel along uDir (>= 1 widens the
// kernel so every source pixel contributes: a proper anti-aliased downscale).
const RESAMPLE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
uniform vec2 uDir;
uniform float uScale;
float lanczos3(float x) {
  x = abs(x);
  if (x < 1e-4) return 1.0;
  if (x >= 3.0) return 0.0;
  float px = 3.14159265 * x;
  return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}
void main() {
  vec2 sp = vUv * uSrcSize;
  float center = dot(sp, uDir) - 0.5;
  float s = max(uScale, 1.0);
  int r = int(ceil(3.0 * s));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -40; i <= 40; i++) {
    if (i < -r || i > r) continue;
    float idx = floor(center) + float(i);
    float w = lanczos3((idx - center) / s);
    vec2 p = uDir.x > 0.5 ? vec2(idx + 0.5, sp.y) : vec2(sp.x, idx + 0.5);
    acc += texture(uTex, p / uSrcSize) * w;
    wsum += w;
  }
  o = max(acc / wsum, 0.0);
}`;

// Edge-preserving bilateral filter, stronger across 8x8 coding-block seams (where H.264 blocking sits).
const BILATERAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uSigmaR, uSigmaS, uBlock;
void main() {
  vec2 px = vUv * uSize;
  vec4 c0 = texture(uTex, vUv);
  vec2 cell = mod(floor(px), 8.0);
  float seam = (cell.x < 0.5 || cell.x > 6.5 || cell.y < 0.5 || cell.y > 6.5) ? 1.0 + uBlock : 1.0;
  float sr = uSigmaR * seam;
  float inv2r = 1.0 / (2.0 * sr * sr);
  float inv2s = 1.0 / (2.0 * uSigmaS * uSigmaS);
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 d = vec2(float(i), float(j));
      vec4 c = texture(uTex, (px + d) / uSize);
      vec3 diff = c.rgb - c0.rgb;
      float w = exp(-dot(d, d) * inv2s - dot(diff, diff) * inv2r);
      acc += c.rgb * w;
      ws += w;
    }
  }
  o = vec4(acc / ws, c0.a);
}`;

// Contrast-adaptive sharpening (after AMD FidelityFX CAS): sharpens most where local contrast is low,
// so edges get crisper without halos and flat areas do not grain up.
const CAS_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSharp;
void main() {
  vec4 e4 = texture(uTex, vUv);
  vec3 e = e4.rgb;
  vec3 b = texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 d = texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb;
  vec3 f = texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 h = texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb;
  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 w = amp * mix(-0.125, -0.2, uSharp);
  vec3 r = (b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w);
  o = vec4(clamp(r, 0.0, 1.0), e4.a);
}`;

const roundUp = (v, m = 128) => Math.ceil(v / m) * m;
/** Enhance presets: [range sigma, spatial sigma, seam boost, sharpening]. */
const ENHANCE = { 1: [0.05, 1.1, 1.0, 0.35], 2: [0.085, 1.5, 2.2, 0.65] };

export class Compositor {
  static create(canvas, renderer) {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: true, depth: false, stencil: false, premultipliedAlpha: true,
        preserveDrawingBuffer: true, powerPreference: 'high-performance',
      });
      if (!gl) return null;
      return new Compositor(canvas, gl, renderer);
    } catch (err) {
      console.warn('WebGL2 compositor unavailable, falling back to Canvas 2D', err);
      return null;
    }
  }

  constructor(canvas, gl, renderer) {
    this.canvas = canvas;
    this.gl = gl;
    this.r = renderer;
    this.lost = false;
    this.customLuts = new Map();
    this.postSharpen = 0; // set by the exporter for upscaled exports
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.#init(); this.lost = false; this.r.store.emit('project', { live: true }); });
    this.#init();
  }

  #init() {
    const gl = this.gl;
    this.media = new Map();    // key -> { slots: [cur, prev], serial, hold, uploads }
    this.overlays = new Map(); // clipId -> { tex, sig, padX, padY }
    this.luts = new Map();
    this.fbo = [null, null];   // blur scratch
    this.targets = new Map();  // exact-size render targets by name
    this.used = new Set();
    const common = ['uRes', 'uCenter', 'uSize', 'uRot', 'uUvRect', 'uTex'];
    this.layer = this.#program(LAYER_FS, [...common, 'uTexPrev', 'uLut', 'uTexSize', 'uBicubic', 'uMix', 'uOpacity', 'uGrade', 'uLutSize', 'uLutAmt', 'uBright', 'uContrast', 'uSat', 'uSepia', 'uVig']);
    this.blur = this.#program(BLUR_FS, [...common, 'uDir', 'uClamp']);
    this.resample = this.#program(RESAMPLE_FS, [...common, 'uSrcSize', 'uDir', 'uScale']);
    this.bilateral = this.#program(BILATERAL_FS, [...common, 'uSize', 'uSigmaR', 'uSigmaS', 'uBlock']);
    this.cas = this.#program(CAS_FS, [...common, 'uTexel', 'uSharp']);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.identity = this.#lutTexture(2, new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]));
    this.overlayCanvas = new OffscreenCanvas(16, 16);
    this.octx = this.overlayCanvas.getContext('2d');
    this.target = null;
  }

  #program(fs, names) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  #lutTexture(size, data) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return { tex, size };
  }

  registerCustomLut(id, size, data) {
    this.customLuts.set(id, { size, data });
    const old = this.luts.get(id);
    if (old) { this.gl.deleteTexture(old.tex); this.luts.delete(id); }
  }

  #lut(id) {
    if (!id || id === 'none') return null;
    let e = this.luts.get(id);
    if (e) return e;
    const src = id.startsWith('custom:') ? this.customLuts.get(id) : { size: 33, data: buildLut(id, 33) };
    if (!src) return null;
    e = this.#lutTexture(src.size, src.data);
    this.luts.set(id, e);
    return e;
  }

  #newTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  #setMinFilter(tex, mip) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  }

  /** Upload a frame into a texture; returns its size or null. */
  #upload(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { return null; }
    return [source.videoWidth || source.naturalWidth || source.width || 1, source.videoHeight || source.naturalHeight || source.height || 1];
  }

  /** Render target of an exact size (texture uv covers 0..1). */
  #exactTarget(name, w, h) {
    const gl = this.gl;
    let t = this.targets.get(name);
    if (t && t.w === w && t.h === h) return t;
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const tex = this.#newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fb, w, h };
    this.targets.set(name, t);
    return t;
  }

  #fbo(i, w, h) {
    const gl = this.gl;
    let f = this.fbo[i];
    if (f && f.fw >= w && f.fh >= h && f.fw <= roundUp(w) * 2 && f.fh <= roundUp(h) * 2) return f;
    if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
    const fw = roundUp(w), fh = roundUp(h);
    const tex = this.#newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    f = { tex, fb, fw, fh };
    this.fbo[i] = f;
    return f;
  }

  /** Bind the frame being composed (the canvas, or the full-resolution master when resampling after). */
  #bindTarget() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target ? this.target.fb : null);
    gl.viewport(0, 0, this.W, this.H);
  }

  #quad(prog, { res, cx, cy, w, h, rot = 0, uv = [0, 0, 1, 1] }) {
    const gl = this.gl;
    const u = prog.u;
    gl.uniform2f(u.uRes, res[0], res[1]);
    gl.uniform2f(u.uCenter, cx, cy);
    gl.uniform2f(u.uSize, w, h);
    gl.uniform2f(u.uRot, Math.cos(rot), Math.sin(rot));
    gl.uniform4f(u.uUvRect, uv[0], uv[1], uv[2], uv[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Full-screen pass of `prog` from texture `src` into target `dst` (null = canvas). */
  #pass(prog, src, dst, w, h, setUniforms, uv = [0, 0, 1, 1]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(prog.u.uTex, 0);
    setUniforms?.(prog.u);
    this.#quad(prog, { res: [w, h], cx: w / 2, cy: h / 2, w, h, uv });
  }

  #setGrade(fx, on) {
    const gl = this.gl;
    const u = this.layer.u;
    gl.uniform1f(u.uGrade, on ? 1 : 0);
    const lut = on ? this.#lut(fx?.lut) || this.identity : this.identity;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut.tex);
    gl.uniform1i(u.uLut, 1);
    gl.uniform1f(u.uLutSize, lut.size);
    gl.uniform1f(u.uLutAmt, on && lut !== this.identity ? (fx.lutAmount ?? 100) / 100 : 0);
    gl.uniform1f(u.uBright, on ? ((fx.brightness || 0) / 100) * 0.75 : 0);
    gl.uniform1f(u.uContrast, on ? Math.max(-0.95, (fx.contrast || 0) / 100) : 0);
    gl.uniform1f(u.uSat, on ? (fx.saturation || 0) / 100 : 0);
    gl.uniform1f(u.uSepia, on ? (fx.sepia || 0) / 100 : 0);
    gl.uniform1f(u.uVig, on ? (fx.vignette || 0) / 100 : 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Bind the layer program's two image inputs and the sampling mode. */
  #bindLayerTextures(tex, prevTex, mix, texW, texH, bicubic) {
    const gl = this.gl;
    const u = this.layer.u;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, prevTex || tex);
    gl.uniform1i(u.uTexPrev, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.uMix, prevTex ? mix : 1);
    gl.uniform2f(u.uTexSize, texW || 1, texH || 1);
    gl.uniform1f(u.uBicubic, bicubic ? 1 : 0);
  }

  /** Two-pass blur of a texture into FBO 1; returns the texture and its used uv rect. */
  #blurInto(srcTex, outW, outH, sigma) {
    const gl = this.gl;
    const s = sigma > 18 ? 0.25 : sigma > 7 ? 0.5 : 1;
    const bw = Math.max(1, Math.round(outW * s)), bh = Math.max(1, Math.round(outH * s));
    const a = this.#fbo(0, bw, bh), b = this.#fbo(1, bw, bh);
    const { p, u } = this.blur;
    gl.useProgram(p);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uTex, 0);
    const pass = (fb, tex, dir, uv, clampRect) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fb);
      gl.viewport(0, 0, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform2f(u.uDir, dir[0], dir[1]);
      gl.uniform4f(u.uClamp, clampRect[0], clampRect[1], clampRect[2], clampRect[3]);
      this.#quad(this.blur, { res: [bw, bh], cx: bw / 2, cy: bh / 2, w: bw, h: bh, uv });
    };
    const stepX = sigma / outW / 6, stepY = sigma / outH / 6;
    pass(a, srcTex, [stepX, 0], [0, 0, 1, 1], [0, 0, 1, 1]);
    const ua = [0, 0, bw / a.fw, bh / a.fh];
    // In FBO A one output-pixel step is (bh / outH) texels, i.e. stepY * bh / fh in uv.
    pass(b, a.tex, [0, (stepY * bh) / a.fh], ua, [0.5 / a.fw, 0.5 / a.fh, (bw - 0.5) / a.fw, (bh - 0.5) / a.fh]);
    return { tex: b.tex, uv: [0, 0, bw / b.fw, bh / b.fh] };
  }

  // ---------- media: upload, enhance, frame pairs ----------

  #newSlot() { return { raw: this.#newTexture(), w: 0, h: 0, mt: null, out: null, enh: null, ready: false, level: 0, mip: false }; }

  #freeSlot(s) {
    if (!s) return;
    const gl = this.gl;
    gl.deleteTexture(s.raw);
    if (s.enh) for (const t of s.enh) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
  }

  /** Run the enhance chain on a slot's raw frame (bilateral then CAS), at source resolution. */
  #enhance(slot, level) {
    const p = ENHANCE[level];
    if (!p) { slot.out = slot.raw; return; }
    const gl = this.gl;
    const { w, h } = slot;
    if (!slot.enh || slot.enh[0].w !== w || slot.enh[0].h !== h) {
      if (slot.enh) for (const t of slot.enh) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      slot.enh = [0, 1].map(() => {
        const tex = this.#newTexture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { tex, fb, w, h };
      });
    }
    const [A, B] = slot.enh;
    // The raw texture may carry a mipmapped min filter; sample level 0 exactly for the filters.
    this.#setMinFilter(slot.raw, false);
    this.#pass(this.bilateral, slot.raw, A, w, h, (u) => {
      gl.uniform2f(u.uSize, w, h);
      gl.uniform1f(u.uSigmaR, p[0]);
      gl.uniform1f(u.uSigmaS, p[1]);
      gl.uniform1f(u.uBlock, p[2]);
    });
    this.#pass(this.cas, A.tex, B, w, h, (u) => { gl.uniform2f(u.uTexel, 1 / w, 1 / h); gl.uniform1f(u.uSharp, p[3]); });
    slot.out = B.tex;
  }

  /** Make a slot's output texture (raw or enhanced) ready to draw at the given minification. */
  #finishSlot(slot, level, mip) {
    this.#enhance(slot, level);
    this.#setMinFilter(slot.out, mip);
    slot.level = level;
    slot.mip = mip;
    slot.ready = true;
  }

  #entry(key) {
    this.used.add(key);
    let e = this.media.get(key);
    if (!e) { e = { slots: [this.#newSlot(), null], serial: -1, uploads: 0, hold: false }; this.media.set(key, e); }
    return e;
  }

  /**
   * Texture(s) for a media clip at time t: { cur, prev, mix, w, h }. For video, a new upload happens only
   * when the element has a new frame. With smooth motion, the previous frame is kept and blended.
   */
  #mediaFor(clip, asset, drawnW, t) {
    const key = clip.kind === 'video' ? clip.id : `img:${asset.id}`;
    const e = this.#entry(key);
    const level = clip.fx?.enhance | 0;
    const minify = drawnW < (asset.width || drawnW) * 0.75;
    if (clip.kind !== 'video') {
      const s = e.slots[0];
      if (!s.ready || s.level !== level || s.mip !== minify) {
        const src = asset.img || asset.poster;
        const size = src && this.#upload(s.raw, src);
        if (!size) return null;
        [s.w, s.h] = size;
        e.uploads++;
        this.#finishSlot(s, level, minify);
      }
      return { cur: s.out, prev: null, mix: 1, w: s.w, h: s.h };
    }
    const v = this.r.playback.videoFor(clip.id);
    const smooth = !!this.r.playback.smoothActive?.(clip);
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      const st = v._cr || {};
      // Upload only when the element has a new frame. If frame callbacks are unavailable, or have gone
      // quiet while the video plays (some platforms throttle them), upload every frame instead.
      const trusted = st.rvfcOk && (v.paused || performance.now() - st.lastFrameAt < 250);
      const serial = trusted ? st.frameSerial : -2;
      const cur0 = e.slots[0];
      const isNewFrame = serial !== e.serial || serial === -2;
      if (isNewFrame || !cur0.ready || cur0.level !== level || cur0.mip !== minify) {
        // Smooth motion keeps the outgoing frame: rotate the slots, then fill the freed one.
        if (smooth && isNewFrame && !e.hold && cur0.ready) {
          if (!e.slots[1]) e.slots[1] = this.#newSlot();
          e.slots.reverse();
        }
        if (isNewFrame) e.hold = false;
        const s = e.slots[0];
        const size = this.#upload(s.raw, v);
        if (size) {
          [s.w, s.h] = size;
          s.mt = (this.r.store.exporting ? st.frameTime : null) ?? st.mediaTime ?? v.currentTime;
          e.serial = serial;
          e.uploads++;
          this.#finishSlot(s, level, minify);
        }
      }
    }
    const cur = e.slots[0];
    if (!cur.ready) return null;
    let prev = null, mix = 1;
    const p = e.slots[1];
    if (smooth && p?.ready && cur.mt != null && p.mt != null && cur.mt > p.mt + 1e-4) {
      const srcT = clip.in + (t - clip.start) * clip.speed;
      mix = Math.max(0, Math.min(1, (srcT - p.mt) / (cur.mt - p.mt)));
      if (!(this.r.playback.playing || this.r.store.exporting)) mix = 1;
      if (mix < 0.999) {
        if (p.level !== level) this.#finishSlot(p, level, minify);
        else if (p.mip !== minify) { this.#setMinFilter(p.out, minify); p.mip = minify; }
        prev = p.out;
      }
    } else if (!smooth && p) {
      this.#freeSlot(p);
      e.slots[1] = null;
    }
    return { cur: cur.out, prev, mix, w: cur.w, h: cur.h };
  }

  /**
   * Export support for smooth motion: the element currently shows the earlier of two source frames.
   * Keep it as the "previous" frame; the next upload (after the seek to the later frame) becomes "current".
   */
  captureFrame(clip, frameTime) {
    const v = this.r.playback.videoFor(clip.id);
    if (!v || v.readyState < 2) return false;
    const e = this.#entry(clip.id);
    if (!e.slots[1]) e.slots[1] = this.#newSlot();
    const s = e.slots[1];
    const size = this.#upload(s.raw, v);
    if (!size) return false;
    [s.w, s.h] = size;
    s.mt = frameTime;
    this.#finishSlot(s, clip.fx?.enhance | 0, false);
    e.hold = true; // the next upload replaces "current" without rotating
    return true;
  }

  /** Move "current" into "previous" (stepping forward one source frame during export). */
  promoteFrame(clip) {
    const e = this.media.get(clip.id);
    if (!e?.slots[0]?.ready) return false;
    if (!e.slots[1]) e.slots[1] = this.#newSlot();
    e.slots.reverse();
    e.hold = true;
    return true;
  }

  /** Source times of the frames held for a clip: { prev, cur } (export uses this to skip seeks). */
  framePair(clip) {
    const e = this.media.get(clip.id);
    return { prev: e?.slots[1]?.ready ? e.slots[1].mt : null, cur: e?.slots[0]?.ready ? e.slots[0].mt : null };
  }

  /** Text / sticker texture, re-rasterised only when its signature changes. */
  #overlayEntry(clip, L, reveal) {
    this.used.add(`ov:${clip.id}`);
    const s = Math.max(0.05, clip.transform.scale ?? 1);
    const pad = clip.kind === 'text' ? L.metrics.px * 0.35 : Math.max(L.bw, L.bh) * 0.08;
    const revealN = reveal >= 1 ? -1 : Math.floor(reveal * 1e4);
    const sig = JSON.stringify([clip.kind === 'text' ? clip.text : clip.sticker, L.bw.toFixed(2), L.bh.toFixed(2), s.toFixed(3), revealN]);
    let e = this.overlays.get(clip.id);
    if (e && e.sig === sig) return e;
    const cw = Math.min(4096, Math.ceil((L.bw + pad * 2) * s));
    const ch = Math.min(4096, Math.ceil((L.bh + pad * 2) * s));
    if (cw < 1 || ch < 1) return null;
    const oc = this.overlayCanvas;
    if (oc.width !== cw || oc.height !== ch) { oc.width = cw; oc.height = ch; } else this.octx.clearRect(0, 0, cw, ch);
    const ctx = this.octx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.scale(cw / (L.bw + pad * 2), ch / (L.bh + pad * 2));
    ctx.translate(pad + L.bw / 2, pad + L.bh / 2);
    if (clip.kind === 'text') this.r.drawTextTo(ctx, clip.text, L.metrics, reveal);
    else drawSticker(ctx, clip.sticker, L.bw, L.bh);
    ctx.restore();
    if (!e) { e = { tex: this.#newTexture(), sig: '' }; this.overlays.set(clip.id, e); }
    this.#upload(e.tex, oc);
    e.sig = sig;
    e.padX = pad;
    e.padY = pad;
    return e;
  }

  // ---------- frame ----------

  render(t) {
    if (this.lost) return;
    const gl = this.gl;
    const r = this.r;
    const [W, H] = r.size;
    const outW = this.canvas.width, outH = this.canvas.height;
    this.W = W;
    this.H = H;
    const project = r.store.project;
    this.used.clear();
    // Compose straight into the canvas when it is the sequence size; otherwise into a full-size master
    // that is then resampled (preview) or sharpened (upscaled export).
    const direct = outW === W && outH === H && !(this.postSharpen > 0);
    this.target = direct ? null : this.#exactTarget('master', W, H);
    this.#bindTarget();
    gl.disable(gl.SCISSOR_TEST);
    const bg = project.background || { mode: 'black' };
    const rgb = bg.mode === 'color' ? hex(bg.color) : [0, 0, 0];
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    const vtracks = project.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden).reverse();
    if (bg.mode === 'blur') {
      for (const tr of vtracks) {
        const layers = trackLayers(project, tr.id, t);
        const c = layers[layers.length - 1]?.clip;
        if (c && (c.kind === 'video' || c.kind === 'image')) { this.#blurFill(c, W, H, t); break; }
      }
    }
    for (const tr of vtracks) {
      for (const layer of trackLayers(project, tr.id, t)) this.#drawLayer(layer, t, W, H);
    }
    if (!direct) this.#output(W, H, outW, outH);
    this.target = null;
    this.#gc();
  }

  /** Master -> canvas: optional sharpening, then an anti-aliased Lanczos resample to the canvas size. */
  #output(W, H, outW, outH) {
    const gl = this.gl;
    let src = this.target.tex;
    const same = outW === W && outH === H;
    if (this.postSharpen > 0) {
      const dst = same ? null : this.#exactTarget('sharp', W, H);
      this.#pass(this.cas, src, dst, W, H, (u) => { gl.uniform2f(u.uTexel, 1 / W, 1 / H); gl.uniform1f(u.uSharp, this.postSharpen); });
      if (!dst) return;
      src = dst.tex;
    }
    const mid = this.#exactTarget('resampleH', outW, H);
    this.#pass(this.resample, src, mid, outW, H, (u) => { gl.uniform2f(u.uSrcSize, W, H); gl.uniform2f(u.uDir, 1, 0); gl.uniform1f(u.uScale, W / outW); });
    this.#pass(this.resample, mid.tex, null, outW, outH, (u) => { gl.uniform2f(u.uSrcSize, outW, H); gl.uniform2f(u.uDir, 0, 1); gl.uniform1f(u.uScale, H / outH); });
  }

  #blurFill(clip, W, H, t) {
    const asset = this.r.assets.get(clip.assetId);
    if (!asset || asset.status !== 'ready') return;
    const m = this.#mediaFor(clip, asset, W * 0.3, t);
    if (!m) return;
    const sw = asset.width || 16, sh = asset.height || 9;
    const k = Math.max(W / sw, H / sh) * 1.08;
    const w = sw * k, h = sh * k;
    const blurred = this.#blurInto(m.cur, w, h, Math.min(W, H) * 0.035);
    const gl = this.gl;
    this.#bindTarget();
    gl.useProgram(this.layer.p);
    gl.enable(gl.BLEND);
    this.#bindLayerTextures(blurred.tex, null, 1, 1, 1, false);
    this.#setGrade({ ...clip.fx, brightness: (clip.fx.brightness || 0) - 22 }, true);
    gl.uniform1f(this.layer.u.uOpacity, 1);
    this.#quad(this.layer, { res: [W, H], cx: W / 2, cy: H / 2, w, h, uv: blurred.uv });
  }

  #drawLayer(layer, t, W, H) {
    const r = this.r;
    const clip = layer.clip;
    const L = r.layout(clip, W, H);
    if (layer.role !== 'out') r.layouts.set(clip.id, L);
    if (L.bw <= 0 || L.bh <= 0) return;
    const A = r.animFor(clip, layer.role === 'out' ? clip.start + clip.duration - 1e-4 : t);
    const M = transitionMods(layer, W, H);
    const alpha = Math.max(0, Math.min(1, (clip.transform.opacity ?? 1) * A.alpha * M.alpha));
    if (alpha <= 0.002) return;
    const S = Math.min(W, H);
    const scale = (clip.transform.scale ?? 1) * A.scale * M.scale;
    const cx = L.cx + M.dx, cy = L.cy + A.dy * S + M.dy;
    const gl = this.gl;
    const scissor = () => {
      if (!M.scissor) return;
      gl.enable(gl.SCISSOR_TEST);
      const [sx, sy, sw, sh] = M.scissor;
      gl.scissor(Math.round(sx), Math.round(H - sy - sh), Math.round(sw), Math.round(sh));
    };
    if (clip.kind === 'video' || clip.kind === 'image') {
      const asset = r.assets.get(clip.assetId);
      if (asset?.status !== 'ready') return;
      const drawnW = L.bw * scale;
      // Frame upload and enhance passes bind their own targets; do them before setting up this layer.
      const m = this.#mediaFor(clip, asset, drawnW, t);
      if (!m) return;
      const fx = clip.fx || {};
      let tex = m.cur, prev = m.prev, uv = [0, 0, 1, 1];
      let texW = m.w, texH = m.h;
      const sigma = (fx.blur || 0) * (S / 1080) * Math.min(1, scale);
      if (sigma > 0.3) {
        const b = this.#blurInto(tex, L.bw * scale, L.bh * scale, sigma);
        tex = b.tex; prev = null; uv = b.uv; texW = 1; texH = 1;
      }
      this.#bindTarget();
      scissor();
      gl.enable(gl.BLEND);
      gl.useProgram(this.layer.p);
      // Bicubic when the clip is drawn larger than its source (e.g. 720p in a 1080p frame).
      const bicubic = texW > 1 && drawnW > texW * 1.02;
      this.#bindLayerTextures(tex, prev, m.mix, texW, texH, bicubic);
      const graded = fx.lut !== 'none' || fx.brightness || fx.contrast || fx.saturation || fx.sepia || fx.vignette;
      this.#setGrade(fx, !!graded);
      gl.uniform1f(this.layer.u.uOpacity, alpha);
      this.#quad(this.layer, { res: [W, H], cx, cy, w: L.bw * scale, h: L.bh * scale, rot: L.rot, uv });
    } else {
      const reveal = clip.id === r.editingId ? 1 : A.reveal;
      const e = this.#overlayEntry(clip, L, reveal);
      if (!e) return;
      this.#bindTarget();
      scissor();
      gl.enable(gl.BLEND);
      gl.useProgram(this.layer.p);
      this.#bindLayerTextures(e.tex, null, 1, 1, 1, false);
      this.#setGrade(null, false);
      gl.uniform1f(this.layer.u.uOpacity, alpha);
      const s = Math.max(0.05, clip.transform.scale ?? 1);
      const k = scale / s;
      this.#quad(this.layer, { res: [W, H], cx, cy, w: (L.bw + e.padX * 2) * s * k, h: (L.bh + e.padY * 2) * s * k, rot: L.rot });
    }
    if (M.scissor) gl.disable(gl.SCISSOR_TEST);
  }

  /** Free textures for clips that are gone (checked every few seconds of rendering). */
  #gc() {
    this.frames = (this.frames || 0) + 1;
    if (this.frames % 180) return;
    const live = new Set(this.r.store.project.clips.map((c) => c.id));
    const gl = this.gl;
    for (const [k, e] of this.overlays) if (!live.has(k)) { gl.deleteTexture(e.tex); this.overlays.delete(k); }
    for (const k of [...this.media.keys()]) {
      const clipId = k.startsWith('img:') ? null : k;
      const assetGone = k.startsWith('img:') && !this.r.assets.get(k.slice(4));
      if ((clipId && !live.has(clipId)) || assetGone) this.deleteMedia(k);
    }
  }

  deleteAll() {
    for (const k of [...this.media.keys()]) this.deleteMedia(k);
    for (const e of this.overlays.values()) this.gl.deleteTexture(e.tex);
    this.overlays.clear();
  }

  deleteMedia(key) {
    const e = this.media.get(key);
    if (!e) return;
    e.slots.forEach((s) => this.#freeSlot(s));
    this.media.delete(key);
  }

  stats() {
    let uploads = 0;
    for (const e of this.media.values()) uploads += e.uploads || 0;
    return { media: this.media.size, overlays: this.overlays.size, uploads };
  }

  /** Block until the GPU has finished the frame (benchmarks only). */
  finish() {
    const px = new Uint8Array(4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
  }
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
