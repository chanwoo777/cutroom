// WebGL2 colour pipeline: source texture -> (optional separable Gaussian blur at reduced resolution)
// -> grade pass (3D LUT, brightness, contrast, saturation, sepia, vignette). The 2D compositor then
// draws the result. One texture per video clip keeps the last good frame while a seek is in flight.
import { buildLut } from './luts.js';

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uUvScale;
uniform vec2 uUvMax;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i);
    float w = exp(-0.5 * x * x / 36.0);
    vec2 p = clamp(vUv + uDir * x, 0.0, 1.0);
    acc += texture(uTex, min(p * uUvScale, uUvMax)) * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

const GRADE_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform sampler3D uLut;
uniform vec2 uUvScale;
uniform vec2 uUvMax;
uniform float uLutSize, uLutAmt, uBright, uContrast, uSat, uSepia, uVig;
void main() {
  vec4 c = texture(uTex, min(vUv * uUvScale, uUvMax));
  if (c.a <= 0.0005) { o = vec4(0.0); return; }
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
    float r = length(vUv - 0.5) * 1.41421;
    float v = 1.0 - smoothstep(0.32, 1.12, r);
    rgb *= mix(1.0, v, uVig);
  }
  rgb = clamp(rgb, 0.0, 1.0);
  o = vec4(rgb * c.a, c.a);
}`;

const ROUND = 128;
const roundUp = (v) => Math.ceil(v / ROUND) * ROUND;

export class GLFX {
  static create() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const gl = canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: true, powerPreference: 'high-performance',
      });
      if (!gl) return null;
      return new GLFX(canvas, gl);
    } catch (err) {
      console.warn('WebGL2 unavailable, using Canvas 2D filters', err);
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.lost = false;
    this.customLuts = new Map();
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.#init(); this.lost = false; });
    this.#init();
  }

  #init() {
    const gl = this.gl;
    this.textures = new Map();
    this.luts = new Map();
    this.fbo = [null, null];
    this.blur = this.#program(BLUR_FS, ['uTex', 'uDir', 'uUvScale', 'uUvMax']);
    this.grade = this.#program(GRADE_FS, ['uTex', 'uLut', 'uUvScale', 'uUvMax', 'uLutSize', 'uLutAmt', 'uBright', 'uContrast', 'uSat', 'uSepia', 'uVig']);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const id = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255]);
    this.identity = this.#lutTexture(2, id);
  }

  #program(fs, uniforms) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    const u = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
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
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return { tex, size };
  }

  #lut(id) {
    if (!id || id === 'none') return null;
    let entry = this.luts.get(id);
    if (entry) return entry;
    let src;
    if (id.startsWith('custom:')) {
      src = this.customLuts.get(id);
      if (!src) return null;
    } else {
      src = { size: 33, data: buildLut(id, 33) };
    }
    entry = this.#lutTexture(src.size, src.data);
    this.luts.set(id, entry);
    return entry;
  }

  registerCustomLut(id, size, data) {
    this.customLuts.set(id, { size, data });
    const old = this.luts.get(id);
    if (old) { this.gl.deleteTexture(old.tex); this.luts.delete(id); }
  }

  hasTex(key) { return this.textures.has(key); }

  /** Upload a frame (video, image, bitmap or canvas). Returns false if the source is not ready. */
  upload(key, source, { mipmap = false } = {}) {
    if (this.lost) return false;
    const gl = this.gl;
    let entry = this.textures.get(key);
    if (!entry) {
      const tex = gl.createTexture();
      entry = { tex, w: 0, h: 0, mip: false };
      this.textures.set(key, entry);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) {
      console.warn('texture upload failed', err);
      return false;
    }
    entry.w = source.videoWidth || source.naturalWidth || source.width || 1;
    entry.h = source.videoHeight || source.naturalHeight || source.height || 1;
    // The filter is chosen per upload: a texture marked mipmapped but re-uploaded without regenerating its
    // levels would be incomplete (black), and a non-mipmapped one sampled small would alias.
    if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
    if (entry.mip !== mipmap) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      entry.mip = mipmap;
    }
    return true;
  }

  deleteTex(key) {
    const e = this.textures.get(key);
    if (!e) return;
    this.gl.deleteTexture(e.tex);
    this.textures.delete(key);
  }

  deleteAll() {
    for (const key of [...this.textures.keys()]) this.deleteTex(key);
  }

  #fbo(i, w, h) {
    const gl = this.gl;
    let f = this.fbo[i];
    const fw = roundUp(w), fh = roundUp(h);
    if (f && f.fw >= w && f.fh >= h && f.fw <= fw * 2 && f.fh <= fh * 2) return f;
    if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    f = { tex, fb, fw, fh };
    this.fbo[i] = f;
    return f;
  }

  /**
   * Grade the texture `key` into a region of the GL canvas sized outW x outH.
   * fx uses slider units (see DEFAULT_FX). blurPx is the Gaussian sigma in output pixels.
   * Returns the source rectangle to drawImage() from, or null.
   */
  process(key, fx, outW, outH, blurPx = 0) {
    if (this.lost) return null;
    const src = this.textures.get(key);
    if (!src) return null;
    const gl = this.gl;
    outW = Math.max(1, Math.min(4096, Math.round(outW)));
    outH = Math.max(1, Math.min(4096, Math.round(outH)));
    if (this.canvas.width < outW || this.canvas.height < outH) {
      this.canvas.width = Math.max(this.canvas.width, outW);
      this.canvas.height = Math.max(this.canvas.height, outH);
    }
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);

    let inTex = src.tex, uvScale = [1, 1], uvMax = [1, 1];
    if (blurPx > 0.3) {
      const s = blurPx > 18 ? 0.25 : blurPx > 7 ? 0.5 : 1;
      const bw = Math.max(1, Math.round(outW * s)), bh = Math.max(1, Math.round(outH * s));
      const a = this.#fbo(0, bw, bh), b = this.#fbo(1, bw, bh);
      const stepX = blurPx / outW / 6 * 1.0, stepY = blurPx / outH / 6 * 1.0;
      const { p, u } = this.blur;
      gl.useProgram(p);
      gl.uniform1i(u.uTex, 0);
      // horizontal: source -> A
      gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
      gl.viewport(0, 0, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(u.uDir, stepX, 0);
      gl.uniform2f(u.uUvScale, 1, 1);
      gl.uniform2f(u.uUvMax, 1, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // vertical: A -> B
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
      gl.viewport(0, 0, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform2f(u.uDir, 0, stepY);
      gl.uniform2f(u.uUvScale, bw / a.fw, bh / a.fh);
      gl.uniform2f(u.uUvMax, (bw - 0.5) / a.fw, (bh - 0.5) / a.fh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      inTex = b.tex;
      uvScale = [bw / b.fw, bh / b.fh];
      uvMax = [(bw - 0.5) / b.fw, (bh - 0.5) / b.fh];
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const { p, u } = this.grade;
    gl.useProgram(p);
    gl.bindTexture(gl.TEXTURE_2D, inTex);
    gl.uniform1i(u.uTex, 0);
    const lut = this.#lut(fx?.lut) || this.identity;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut.tex);
    gl.uniform1i(u.uLut, 1);
    gl.uniform1f(u.uLutSize, lut.size);
    gl.uniform1f(u.uLutAmt, lut === this.identity ? 0 : (fx.lutAmount ?? 100) / 100);
    gl.uniform1f(u.uBright, ((fx?.brightness || 0) / 100) * 0.75);
    gl.uniform1f(u.uContrast, Math.max(-0.95, (fx?.contrast || 0) / 100));
    gl.uniform1f(u.uSat, (fx?.saturation || 0) / 100);
    gl.uniform1f(u.uSepia, (fx?.sepia || 0) / 100);
    gl.uniform1f(u.uVig, (fx?.vignette || 0) / 100);
    gl.uniform2f(u.uUvScale, uvScale[0], uvScale[1]);
    gl.uniform2f(u.uUvMax, uvMax[0], uvMax[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
    return { canvas: this.canvas, sx: 0, sy: this.canvas.height - outH, sw: outW, sh: outH };
  }
}
