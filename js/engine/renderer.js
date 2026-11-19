// Compositor: draws one frame of the sequence at time t onto the program canvas.
// Picture tracks render bottom (V1) to top. Media goes through the WebGL2 grade; text and stickers are
// drawn with Canvas 2D (fillText), so user text never touches the DOM as markup.
import { clamp, easeOutCubic, easeOutBack, roundRectPath } from '../util.js';
import { activeClipAt, TEXT_FONTS, effectiveAnimDurations, migrateClip, trackLayers, transitionMods } from '../core/ops.js';
import { Compositor } from './compositor.js';
import { drawSticker, stickerAspect } from './stickers.js';
import { FALLBACK_FILTERS } from './luts.js';

export function fontString(T, px) {
  const stack = TEXT_FONTS[T.font]?.stack || TEXT_FONTS.grotesk.stack;
  return `${T.italic ? 'italic ' : ''}${T.weight || 700} ${px.toFixed(2)}px ${stack}`;
}

const IDENTITY_ANIM = Object.freeze({ alpha: 1, scale: 1, dy: 0, reveal: 1 });

/**
 * Entrance/exit animation and Ken Burns motion at time t. dy is a fraction of the frame's short side.
 * The entrance interpolates strictly over [0, intro]; the exit over [D - outro, D].
 */
export function computeAnim(clip, t) {
  if (clip.anim) migrateClip(clip);
  const local = t - clip.start;
  const D = clip.duration;
  const res = { alpha: 1, scale: 1, dy: 0, reveal: 1 };
  const { intro, outro } = effectiveAnimDurations(clip);
  const apply = (type, p, isIn) => {
    if (!type || type === 'none' || p >= 1) return;
    const q = clamp(p, 0, 1);
    const e = easeOutCubic(q);
    switch (type) {
      case 'fade': res.alpha *= e; break;
      case 'pop': res.scale *= 0.4 + 0.6 * easeOutBack(q); res.alpha *= Math.min(1, q * 3); break;
      case 'slide': res.dy += (1 - e) * (isIn ? 0.08 : -0.08); res.alpha *= e; break;
      case 'zoom': res.scale *= 1 + (1 - e) * 0.35; res.alpha *= e; break;
      case 'typewriter': if (isIn) res.reveal = q; else res.alpha *= e; break;
      default: break;
    }
  };
  if (intro > 0 && local < intro) apply(clip.introAnimation.type, local / intro, true);
  if (outro > 0 && local > D - outro) apply(clip.outroAnimation.type, (D - local) / outro, false);
  if (clip.motion === 'zoom-in') res.scale *= 1 + 0.15 * clamp(local / D, 0, 1);
  else if (clip.motion === 'zoom-out') res.scale *= 1.15 - 0.15 * clamp(local / D, 0, 1);
  return res;
}

function filterString(fx) {
  const parts = [];
  if (fx.lut && fx.lut !== 'none' && FALLBACK_FILTERS[fx.lut]) parts.push(FALLBACK_FILTERS[fx.lut]);
  if (fx.brightness) parts.push(`brightness(${1 + (fx.brightness / 100) * 0.75})`);
  if (fx.contrast) parts.push(`contrast(${Math.max(0.05, 1 + fx.contrast / 100)})`);
  if (fx.saturation) parts.push(`saturate(${Math.max(0, 1 + fx.saturation / 100)})`);
  if (fx.sepia) parts.push(`sepia(${fx.sepia / 100})`);
  if (fx.blur) parts.push(`blur(${fx.blur}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

export class Renderer {
  constructor({ canvas, store, assets, playback, glfx }) {
    this.canvas = canvas;
    // One context per canvas: the WebGL2 compositor when available, Canvas 2D otherwise.
    this.gpu = Compositor.create(canvas, this);
    this.ctx = this.gpu ? null : canvas.getContext('2d', { alpha: false });
    this.store = store;
    this.assets = assets;
    this.playback = playback;
    this.glfx = glfx;
    this.layouts = new Map();
    const m = document.createElement('canvas');
    m.width = m.height = 4;
    this.mctx = m.getContext('2d');
    this.posterKeys = new Set();
    this.editingId = null; // text clip being edited inline: drawn without animation so the caret lines up
    this.fontMetrics = new Map();
  }

  /** CSS-equivalent ascent/descent for a font, so canvas lines sit exactly where a textarea puts them. */
  #fontBox(font) {
    let fm = this.fontMetrics.get(font);
    if (fm) return fm;
    const ctx = this.mctx;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText('Hgjy가');
    fm = Number.isFinite(m.fontBoundingBoxAscent) ? { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent } : null;
    if (this.fontMetrics.size > 200) this.fontMetrics.clear();
    this.fontMetrics.set(font, fm);
    return fm;
  }

  /**
   * Composition size: the resolution every frame is composed at (sequence size, or the export size).
   * Layouts, hit-testing and handles all use this coordinate space.
   */
  resize(w, h) {
    this.comp = [w, h];
    this.#applyCanvas();
  }

  /**
   * Device-pixel size of the monitor. With the GPU compositor, the canvas backing store shrinks to it
   * and the full-resolution frame is Lanczos-resampled into it, so the browser never downscales the
   * canvas (bilinear CSS scaling aliases). Exports always use the full composition size.
   */
  setDisplaySize(w, h) {
    this.display = w > 0 && h > 0 ? [w, h] : null;
    this.#applyCanvas();
  }

  #applyCanvas() {
    let [w, h] = this.comp || [this.canvas.width, this.canvas.height];
    if (this.gpu && this.display && !this.store.exporting) {
      const k = Math.min(1, this.display[0] / w, this.display[1] / h);
      if (k < 0.999) { w = Math.max(2, Math.round(w * k)); h = Math.max(2, Math.round(h * k)); }
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  get size() { return this.comp || [this.canvas.width, this.canvas.height]; }

  /**
   * Text box metrics plus the ink rectangle (box-local, unscaled) that alignment and snapping use, so a
   * caption without a background box aligns by its visible glyphs rather than by line-height padding.
   */
  measureText(T, S) {
    const px = Math.max(4, (T.size || 0.09) * S);
    const ctx = this.mctx;
    const font = fontString(T, px);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const lines = String(T.content ?? '').split('\n');
    const measures = lines.map((l) => ctx.measureText(l || ' '));
    const widths = measures.map((m) => m.width);
    const maxW = Math.max(1, ...widths);
    const lineH = px * (T.lineHeight || 1.12);
    const strokePad = (T.strokeWidth || 0) * px * 0.06;
    const padX = (T.bg ? px * 0.42 : px * 0.08) + strokePad;
    const padY = (T.bg ? px * 0.22 : px * 0.04) + strokePad;
    const w = maxW + padX * 2, h = lines.length * lineH + padY * 2;
    const fm = this.#fontBox(font);
    // Baseline of line i, measured from the top of the box: identical to a CSS line box of height lineH.
    const baseline = (i) => padY + lineH * i + lineH / 2 + (fm ? (fm.asc - fm.desc) / 2 : 0);
    const lineX = (i) => (T.align === 'left' ? padX : T.align === 'right' ? w - padX - widths[i] : (w - widths[i]) / 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    measures.forEach((m, i) => {
      if (!lines[i].trim()) return;
      const lx = lineX(i), by = baseline(i);
      const l = Number.isFinite(m.actualBoundingBoxLeft) ? lx - m.actualBoundingBoxLeft : lx;
      const r = Number.isFinite(m.actualBoundingBoxRight) ? lx + m.actualBoundingBoxRight : lx + m.width;
      const a = Number.isFinite(m.actualBoundingBoxAscent) ? by - m.actualBoundingBoxAscent : by - px * 0.8;
      const d = Number.isFinite(m.actualBoundingBoxDescent) ? by + m.actualBoundingBoxDescent : by + px * 0.2;
      x0 = Math.min(x0, l); x1 = Math.max(x1, r); y0 = Math.min(y0, a); y1 = Math.max(y1, d);
    });
    let ink = null;
    if (!T.bg && Number.isFinite(x0)) {
      ink = { x0: x0 - strokePad - w / 2, y0: y0 - strokePad - h / 2, x1: x1 + strokePad - w / 2, y1: y1 + strokePad - h / 2 };
    }
    return { px, font, lines, widths, maxW, lineH, padX, padY, w, h, baseline, lineX, cssMatched: !!fm, ink };
  }

  /**
   * Axis-aligned bounds of what the layer visibly covers in W x H pixels, after scale and rotation
   * (animation excluded). Text without a box uses its ink; everything else its full box.
   */
  visualBounds(clip, W, H) {
    const L = this.layout(clip, W, H);
    const s = clip.transform.scale ?? 1;
    const ink = L.metrics?.ink;
    const r = ink ? { x0: ink.x0 * s, y0: ink.y0 * s, x1: ink.x1 * s, y1: ink.y1 * s } : { x0: -L.w / 2, y0: -L.h / 2, x1: L.w / 2, y1: L.h / 2 };
    const c = Math.cos(L.rot), sn = Math.sin(L.rot);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]) {
      const X = L.cx + x * c - y * sn, Y = L.cy + x * sn + y * c;
      minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
    }
    return { minX, maxX, minY, maxY, cx: L.cx, cy: L.cy };
  }

  /** Base (unscaled) box and the scaled layout used by hit-testing and handles. Frame pixel units. */
  layout(clip, W, H) {
    const S = Math.min(W, H);
    const tr = clip.transform;
    let bw = 0, bh = 0, metrics = null;
    if (clip.kind === 'video' || clip.kind === 'image') {
      const a = this.assets.get(clip.assetId);
      const sw = a?.width || 16, sh = a?.height || 9;
      const k = clip.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      bw = sw * k; bh = sh * k;
    } else if (clip.kind === 'text') {
      metrics = this.measureText(clip.text, S);
      bw = metrics.w; bh = metrics.h;
    } else if (clip.kind === 'sticker') {
      const size = (clip.sticker.size || 0.24) * S;
      const ar = stickerAspect(clip.sticker);
      bh = size / Math.sqrt(ar);
      bw = bh * ar;
    }
    const s = tr.scale ?? 1;
    return { cx: tr.x * W, cy: tr.y * H, bw, bh, w: bw * s, h: bh * s, rot: ((tr.rotation || 0) * Math.PI) / 180, metrics };
  }

  get backend() { return this.gpu ? 'webgl2' : '2d'; }

  animFor(clip, t) { return clip.id === this.editingId ? IDENTITY_ANIM : computeAnim(clip, t); }

  /** Wait for the GPU to finish the frame (benchmarks). */
  flush() {
    if (this.gpu) this.gpu.finish();
    else this.ctx.getImageData(0, 0, 1, 1);
  }

  render(t) {
    this.layouts.clear();
    if (this.gpu) { this.gpu.render(t); return; }
    this.#render2d(t);
  }

  #render2d(t) {
    const { ctx, store } = this;
    const [W, H] = this.size;
    const project = store.project;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    // Every scaled draw (GL result, stills, stickers) uses the browser's best resampler.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const bg = project.background || { mode: 'black' };
    ctx.fillStyle = bg.mode === 'color' ? bg.color : '#000000';
    ctx.fillRect(0, 0, W, H);

    const vtracks = project.tracks.filter((tr) => tr.kind === 'video').reverse();
    if (bg.mode === 'blur') {
      for (const tr of vtracks) {
        if (tr.hidden) continue;
        const c = activeClipAt(project, tr.id, t);
        if (c && (c.kind === 'video' || c.kind === 'image')) { this.#blurFill(c, W, H); break; }
      }
    }
    for (const tr of vtracks) {
      if (tr.hidden) continue;
      for (const layer of trackLayers(project, tr.id, t)) this.#drawClip(layer, t, W, H);
    }
  }

  #sourceFor(clip) {
    const asset = this.assets.get(clip.assetId);
    if (!asset || asset.status !== 'ready') return null;
    if (clip.kind === 'video') {
      const v = this.playback.videoFor(clip.id);
      const fresh = !!v && v.readyState >= 2 && v.videoWidth > 0;
      return { source: v, key: clip.id, fresh, asset };
    }
    const img = asset.img || asset.poster;
    return { source: img, key: `img:${asset.id}`, fresh: !!img && !this.glfx?.hasTex(`img:${asset.id}`), asset, still: true };
  }

  #drawMedia(clip, bw, bh, pixelScale, W, H) {
    const src = this.#sourceFor(clip);
    if (!src) return;
    const { ctx, glfx } = this;
    const fx = clip.fx;
    if (glfx && !glfx.lost) {
      // Mipmaps (trilinear filtering) whenever the source is drawn noticeably smaller than its native size,
      // e.g. a 4K clip in a 1080p export or picture-in-picture, so fine detail does not alias.
      const srcW = src.asset.width || bw;
      const minify = bw * pixelScale < srcW * 0.75;
      if (src.fresh && src.source) glfx.upload(src.key, src.source, { mipmap: !!src.still || minify });
      if (!glfx.hasTex(src.key)) return;
      const blurPx = (fx.blur || 0) * (Math.min(W, H) / 1080);
      const r = glfx.process(src.key, fx, bw * pixelScale, bh * pixelScale, blurPx * Math.min(1, pixelScale));
      if (r) ctx.drawImage(r.canvas, r.sx, r.sy, r.sw, r.sh, -bw / 2, -bh / 2, bw, bh);
      return;
    }
    if (!src.source || (!src.still && !src.fresh)) return;
    ctx.filter = filterString(fx);
    ctx.drawImage(src.source, -bw / 2, -bh / 2, bw, bh);
    ctx.filter = 'none';
    if (fx.vignette) {
      const g = ctx.createRadialGradient(0, 0, Math.min(bw, bh) * 0.25, 0, 0, Math.hypot(bw, bh) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${fx.vignette / 100})`);
      ctx.fillStyle = g;
      ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    }
  }

  #blurFill(clip, W, H) {
    const src = this.#sourceFor(clip);
    if (!src || !this.glfx || this.glfx.lost) return;
    const { glfx, ctx } = this;
    if (src.fresh && src.source) glfx.upload(src.key, src.source, { mipmap: !!src.still });
    if (!glfx.hasTex(src.key)) return;
    const sw = src.asset.width || 16, sh = src.asset.height || 9;
    const k = Math.max(W / sw, H / sh) * 1.08;
    const w = sw * k, h = sh * k;
    const fx = { ...clip.fx, brightness: (clip.fx.brightness || 0) - 22 };
    const r = glfx.process(src.key, fx, w, h, Math.min(W, H) * 0.035);
    if (r) ctx.drawImage(r.canvas, r.sx, r.sy, r.sw, r.sh, (W - w) / 2, (H - h) / 2, w, h);
  }

  #drawClip(layer, t, W, H) {
    const clip = layer.clip;
    const L = this.layout(clip, W, H);
    if (layer.role !== 'out') this.layouts.set(clip.id, L);
    if (L.bw <= 0 || L.bh <= 0) return;
    const A = this.animFor(clip, layer.role === 'out' ? clip.start + clip.duration - 1e-4 : t);
    const M = transitionMods(layer, W, H);
    const alpha = clamp((clip.transform.opacity ?? 1) * A.alpha * M.alpha, 0, 1);
    if (alpha <= 0.002) return;
    const S = Math.min(W, H);
    const scale = (clip.transform.scale ?? 1) * A.scale * M.scale;
    const { ctx } = this;
    ctx.save();
    if (M.scissor) { ctx.beginPath(); ctx.rect(...M.scissor); ctx.clip(); }
    ctx.globalAlpha = alpha;
    ctx.translate(L.cx + M.dx, L.cy + A.dy * S + M.dy);
    if (L.rot) ctx.rotate(L.rot);
    ctx.scale(scale, scale);
    if (clip.kind === 'video' || clip.kind === 'image') this.#drawMedia(clip, L.bw, L.bh, scale, W, H);
    else if (clip.kind === 'text') this.drawTextTo(ctx, clip.text, L.metrics, A.reveal);
    else if (clip.kind === 'sticker') drawSticker(ctx, clip.sticker, L.bw, L.bh);
    ctx.restore();
  }

  /** Draw text centred on the context origin (shared by the 2D path and the GPU text-texture cache). */
  drawTextTo(ctx, T, m, reveal) {
    ctx.font = m.font;
    // Alphabetic baselines placed exactly where a CSS line box would put them (see measureText).
    ctx.textBaseline = m.cssMatched ? 'alphabetic' : 'middle';
    const W2 = m.w / 2, H2 = m.h / 2;
    if (T.bg) {
      ctx.fillStyle = T.bgColor || '#1c1b19';
      roundRectPath(ctx, -W2, -H2, m.w, m.h, m.px * 0.16);
      ctx.fill();
    }
    const totalChars = m.lines.reduce((n, l) => n + l.length, 0);
    let remaining = reveal >= 1 ? Infinity : Math.floor(totalChars * reveal);
    for (let i = 0; i < m.lines.length; i++) {
      const full = m.lines[i];
      let line = full;
      let partial = false;
      if (remaining !== Infinity) {
        if (remaining <= 0) break;
        if (line.length > remaining) { line = line.slice(0, remaining); partial = true; }
        remaining -= full.length;
      }
      const y = m.cssMatched ? -H2 + m.baseline(i) : -H2 + m.padY + m.lineH * (i + 0.5);
      let x;
      if (partial || T.align === 'left') {
        // Typewriter text grows from the left edge of where the finished line will sit.
        const lw = m.widths[i];
        x = T.align === 'left' ? -W2 + m.padX : T.align === 'right' ? W2 - m.padX - lw : -lw / 2;
        ctx.textAlign = 'left';
      } else if (T.align === 'right') { x = W2 - m.padX; ctx.textAlign = 'right'; }
      else { x = 0; ctx.textAlign = 'center'; }
      if (T.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = m.px * 0.14;
        ctx.shadowOffsetY = m.px * 0.05;
      }
      if (T.strokeWidth > 0) {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.lineWidth = T.strokeWidth * m.px * 0.12;
        ctx.strokeStyle = T.strokeColor || '#000';
        ctx.strokeText(line, x, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = T.color || '#fff';
      ctx.fillText(line, x, y);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
  }
}
