// Compositor: draws one frame of the sequence at time t onto the program canvas.
// Picture tracks render bottom (V1) to top. Media goes through the WebGL2 grade; text and stickers are
// drawn with Canvas 2D (fillText), so user text never touches the DOM as markup.
import { clamp, easeOutCubic, easeOutBack, roundRectPath } from '../util.js';
import { activeClipAt, TEXT_FONTS } from '../core/ops.js';
import { drawSticker, stickerAspect } from './stickers.js';
import { FALLBACK_FILTERS } from './luts.js';

export function fontString(T, px) {
  const stack = TEXT_FONTS[T.font]?.stack || TEXT_FONTS.grotesk.stack;
  return `${T.italic ? 'italic ' : ''}${T.weight || 700} ${px.toFixed(1)}px ${stack}`;
}

/** Entrance/exit animation and Ken Burns motion at time t. dy is a fraction of the frame's short side. */
export function computeAnim(clip, t) {
  const local = t - clip.start;
  const D = clip.duration;
  const res = { alpha: 1, scale: 1, dy: 0, reveal: 1 };
  const a = clip.anim || {};
  const d = Math.max(0.05, Math.min(a.dur || 0.5, D / 2));
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
  if (a.in && a.in !== 'none') apply(a.in, local / (a.in === 'typewriter' ? Math.min(a.dur || 1, D) : d), true);
  if (a.out && a.out !== 'none') apply(a.out, (D - local) / d, false);
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
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.store = store;
    this.assets = assets;
    this.playback = playback;
    this.glfx = glfx;
    this.layouts = new Map();
    const m = document.createElement('canvas');
    m.width = m.height = 4;
    this.mctx = m.getContext('2d');
    this.posterKeys = new Set();
  }

  resize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  get size() { return [this.canvas.width, this.canvas.height]; }

  measureText(T, S) {
    const px = Math.max(4, (T.size || 0.09) * S);
    const ctx = this.mctx;
    ctx.font = fontString(T, px);
    const lines = String(T.content ?? '').split('\n');
    const widths = lines.map((l) => ctx.measureText(l || ' ').width);
    const maxW = Math.max(1, ...widths);
    const lineH = px * (T.lineHeight || 1.12);
    const strokePad = (T.strokeWidth || 0) * px * 0.06;
    const padX = (T.bg ? px * 0.42 : px * 0.08) + strokePad;
    const padY = (T.bg ? px * 0.22 : px * 0.04) + strokePad;
    return { px, lines, widths, maxW, lineH, padX, padY, w: maxW + padX * 2, h: lines.length * lineH + padY * 2 };
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

  render(t) {
    const { ctx, canvas, store } = this;
    const W = canvas.width, H = canvas.height;
    const project = store.project;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    const bg = project.background || { mode: 'black' };
    ctx.fillStyle = bg.mode === 'color' ? bg.color : '#000000';
    ctx.fillRect(0, 0, W, H);
    this.layouts.clear();

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
      const clip = activeClipAt(project, tr.id, t);
      if (clip) this.#drawClip(clip, t, W, H);
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
      if (src.fresh && src.source) glfx.upload(src.key, src.source, { mipmap: !!src.still });
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

  #drawClip(clip, t, W, H) {
    const L = this.layout(clip, W, H);
    this.layouts.set(clip.id, L);
    if (L.bw <= 0 || L.bh <= 0) return;
    const A = computeAnim(clip, t);
    const alpha = clamp((clip.transform.opacity ?? 1) * A.alpha, 0, 1);
    if (alpha <= 0.002) return;
    const S = Math.min(W, H);
    const scale = (clip.transform.scale ?? 1) * A.scale;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(L.cx, L.cy + A.dy * S);
    if (L.rot) ctx.rotate(L.rot);
    ctx.scale(scale, scale);
    if (clip.kind === 'video' || clip.kind === 'image') this.#drawMedia(clip, L.bw, L.bh, scale, W, H);
    else if (clip.kind === 'text') this.#drawText(clip.text, L.metrics, A.reveal);
    else if (clip.kind === 'sticker') drawSticker(ctx, clip.sticker, L.bw, L.bh);
    ctx.restore();
  }

  #drawText(T, m, reveal) {
    const { ctx } = this;
    ctx.font = fontString(T, m.px);
    ctx.textBaseline = 'middle';
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
      const y = -H2 + m.padY + m.lineH * (i + 0.5);
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
