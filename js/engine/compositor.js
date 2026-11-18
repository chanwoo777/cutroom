// GPU compositor: the program canvas is a single WebGL2 context. Every layer is a textured quad drawn
// with its transform in the vertex shader and premultiplied-alpha blending; colour grading (3D LUT,
// brightness, contrast, saturation, sepia, vignette) runs in the same fragment shader, so a frame is one
// pass per layer with no intermediate canvases or cross-context copies. Blur is a separable Gaussian at
// reduced resolution in two FBO passes. Text and stickers are rasterised once into textures and only
// re-rasterised when their content or style changes. Video textures are uploaded only when the element
// has produced a new frame (requestVideoFrameCallback), not on every display refresh.
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
uniform sampler3D uLut;
uniform float uOpacity, uGrade, uLutSize, uLutAmt, uBright, uContrast, uSat, uSepia, uVig;
void main() {
  vec4 c = texture(uTex, vUv);
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

const roundUp = (v, m = 128) => Math.ceil(v / m) * m;

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
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.#init(); this.lost = false; this.r.store.emit('project', { live: true }); });
    this.#init();
  }

  #init() {
    const gl = this.gl;
    this.media = new Map();   // key -> { tex, w, h, serial, mip }
    this.overlays = new Map(); // clipId -> { tex, sig, w, h, padX, padY }
    this.luts = new Map();
    this.fbo = [null, null];
    this.used = new Set();
    this.layer = this.#program(LAYER_FS, ['uRes', 'uCenter', 'uSize', 'uRot', 'uUvRect', 'uTex', 'uLut', 'uOpacity', 'uGrade', 'uLutSize', 'uLutAmt', 'uBright', 'uContrast', 'uSat', 'uSepia', 'uVig']);
    this.blur = this.#program(BLUR_FS, ['uRes', 'uCenter', 'uSize', 'uRot', 'uUvRect', 'uTex', 'uDir', 'uClamp']);
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

  /** Upload a frame; mipmapped (trilinear) when the layer is drawn noticeably smaller than its source. */
  #upload(entry, source, mip) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch { return false; }
    entry.w = source.videoWidth || source.naturalWidth || source.width || 1;
    entry.h = source.videoHeight || source.naturalHeight || source.height || 1;
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    if (entry.mip !== mip) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      entry.mip = mip;
    }
    entry.uploads = (entry.uploads || 0) + 1;
    return true;
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

  /** Two-pass blur of a texture into FBO 1; returns the texture and its used uv rect. */
  #blurInto(srcTex, outW, outH, sigma) {
    const gl = this.gl;
    const s = sigma > 18 ? 0.25 : sigma > 7 ? 0.5 : 1;
    const bw = Math.max(1, Math.round(outW * s)), bh = Math.max(1, Math.round(outH * s));
    const a = this.#fbo(0, bw, bh), b = this.#fbo(1, bw, bh);
    const { p, u } = this.blur;
    gl.useProgram(p);
    gl.disable(gl.BLEND);
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

  #mediaEntry(clip, asset, drawnW) {
    const key = clip.kind === 'video' ? clip.id : `img:${asset.id}`;
    this.used.add(key);
    let e = this.media.get(key);
    if (!e) { e = { tex: this.#newTexture(), w: 0, h: 0, serial: -1, mip: false, ready: false }; this.media.set(key, e); }
    const minify = drawnW < (asset.width || drawnW) * 0.75;
    if (clip.kind === 'video') {
      const v = this.r.playback.videoFor(clip.id);
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        const st = v._cr || {};
        // Upload only when the element has a new frame. If frame callbacks are unavailable, or have gone
        // quiet while the video plays (some platforms throttle them), upload every frame instead.
        const trusted = st.rvfcOk && (v.paused || performance.now() - st.lastFrameAt < 250);
        const serial = trusted ? st.frameSerial : -2;
        if (serial !== e.serial || serial === -2 || e.mip !== minify) {
          if (this.#upload(e, v, minify)) { e.serial = serial; e.ready = true; }
        }
      }
    } else if (!e.ready || (minify && !e.mip)) {
      const src = asset.img || asset.poster;
      if (src && this.#upload(e, src, true)) e.ready = true;
    }
    return e.ready ? e : null;
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
    if (!e) { e = { tex: this.#newTexture(), sig: '', mip: false }; this.overlays.set(clip.id, e); }
    this.#upload(e, oc, false);
    e.sig = sig;
    e.padX = pad;
    e.padY = pad;
    return e;
  }

  render(t) {
    if (this.lost) return;
    const gl = this.gl;
    const r = this.r;
    const W = this.canvas.width, H = this.canvas.height;
    const project = r.store.project;
    this.used.clear();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
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
        if (c && (c.kind === 'video' || c.kind === 'image')) { this.#blurFill(c, W, H); break; }
      }
    }
    for (const tr of vtracks) {
      for (const layer of trackLayers(project, tr.id, t)) this.#drawLayer(layer, t, W, H);
    }
    this.#gc();
  }

  #blurFill(clip, W, H) {
    const asset = this.r.assets.get(clip.assetId);
    if (!asset || asset.status !== 'ready') return;
    const e = this.#mediaEntry(clip, asset, W * 0.3);
    if (!e) return;
    const sw = asset.width || 16, sh = asset.height || 9;
    const k = Math.max(W / sw, H / sh) * 1.08;
    const w = sw * k, h = sh * k;
    const blurred = this.#blurInto(e.tex, w, h, Math.min(W, H) * 0.035);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.layer.p);
    gl.enable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, blurred.tex);
    gl.uniform1i(this.layer.u.uTex, 0);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    if (M.scissor) {
      gl.enable(gl.SCISSOR_TEST);
      const [sx, sy, sw, sh] = M.scissor;
      gl.scissor(Math.round(sx), Math.round(H - sy - sh), Math.round(sw), Math.round(sh));
    }
    gl.enable(gl.BLEND);
    if (clip.kind === 'video' || clip.kind === 'image') {
      const asset = r.assets.get(clip.assetId);
      if (asset?.status === 'ready') {
        const e = this.#mediaEntry(clip, asset, L.bw * scale);
        if (e) {
          const fx = clip.fx || {};
          let tex = e.tex, uv = [0, 0, 1, 1];
          const sigma = (fx.blur || 0) * (S / 1080) * Math.min(1, scale);
          if (sigma > 0.3) {
            const b = this.#blurInto(e.tex, L.bw * scale, L.bh * scale, sigma);
            tex = b.tex; uv = b.uv;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, W, H);
            gl.enable(gl.BLEND);
          }
          gl.useProgram(this.layer.p);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1i(this.layer.u.uTex, 0);
          const graded = fx.lut !== 'none' || fx.brightness || fx.contrast || fx.saturation || fx.sepia || fx.vignette;
          this.#setGrade(fx, !!graded);
          gl.uniform1f(this.layer.u.uOpacity, alpha);
          this.#quad(this.layer, { res: [W, H], cx, cy, w: L.bw * scale, h: L.bh * scale, rot: L.rot, uv });
        }
      }
    } else {
      const reveal = clip.id === r.editingId ? 1 : A.reveal;
      const e = this.#overlayEntry(clip, L, reveal);
      if (e) {
        gl.useProgram(this.layer.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.uniform1i(this.layer.u.uTex, 0);
        this.#setGrade(null, false);
        gl.uniform1f(this.layer.u.uOpacity, alpha);
        const k = scale / Math.max(0.05, clip.transform.scale ?? 1);
        const s = Math.max(0.05, clip.transform.scale ?? 1);
        this.#quad(this.layer, { res: [W, H], cx, cy, w: (L.bw + e.padX * 2) * s * k, h: (L.bh + e.padY * 2) * s * k, rot: L.rot });
      }
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
    for (const [k, e] of this.media) {
      const clipId = k.startsWith('img:') ? null : k;
      const assetGone = k.startsWith('img:') && !this.r.assets.get(k.slice(4));
      if ((clipId && !live.has(clipId)) || assetGone) { gl.deleteTexture(e.tex); this.media.delete(k); }
    }
  }

  deleteAll() {
    const gl = this.gl;
    for (const e of this.media.values()) gl.deleteTexture(e.tex);
    for (const e of this.overlays.values()) gl.deleteTexture(e.tex);
    this.media.clear();
    this.overlays.clear();
  }

  deleteMedia(key) {
    const e = this.media.get(key);
    if (e) { this.gl.deleteTexture(e.tex); this.media.delete(key); }
  }

  stats() {
    let uploads = 0;
    for (const e of this.media.values()) uploads += e.uploads || 0;
    return { media: this.media.size, overlays: this.overlays.size, uploads };
  }

  /** Block until the GPU has finished the frame (benchmarks only). */
  finish() {
    const px = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
  }
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
