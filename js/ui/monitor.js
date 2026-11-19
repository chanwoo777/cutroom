// Program monitor: fits the program canvas to the stage, draws safe zones and the selected layer's
// bounding box on an overlay canvas, and turns pointer drags into move / scale / rotate edits.
import { clamp, formatTC, debounce } from '../util.js';
import { activeClipAt, isVisual } from '../core/ops.js';
import { sizeCanvas, setIcon, setTimecode } from './dom.js';

const ROT_OFF = 26;
const HIT = 10;
const $ = (id) => document.getElementById(id);

export class Monitor {
  constructor({ store, renderer, playback, audio, actions, onQuality, onResize }) {
    this.onResize = onResize;
    this.store = store;
    this.renderer = renderer;
    this.playback = playback;
    this.audio = audio;
    this.actions = actions;
    this.onQuality = onQuality;
    this.monitorEl = document.querySelector('.monitor');
    this.stage = $('stage');
    this.frameEl = $('frame');
    this.stageInner = $('stage-inner');
    this.program = $('program');
    this.overlay = $('overlay');
    this.empty = $('empty-stage');
    this.octx = this.overlay.getContext('2d');
    this.dw = 1; this.dh = 1; this.dpr = 1;
    this.drag = null;
    this.hoverId = null;
    this.guides = { x: [], y: [] };
    this.dirty = true;
    this.lastTc = '';
    this.commitNudge = debounce(() => store.commit('Nudge layer'), 450);
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.#bindPointer();
    this.#bindTransport();
    store.on('selection', () => { this.dirty = true; });
    store.on('project', () => { this.dirty = true; this.#updateEmpty(); });
    store.on('time', () => { this.dirty = true; });
    this.#updateEmpty();
    this.layout();
  }

  layout() {
    const r = this.stage.getBoundingClientRect();
    const [W, H] = this.store.exporting ? this.renderer.size : this.store.dims;
    const pad = r.width < 520 ? 10 : 22;
    const fit = Math.max(0.01, Math.min((r.width - pad * 2) / W, (r.height - pad * 2) / H));
    // Canvas zoom: Fit, or a fixed ratio where 100% is one sequence pixel per screen pixel. The stage
    // scrolls when the frame is larger than it. The CSS box never exceeds 8192 px (canvas limits).
    const z = this.store.ui.zoom;
    let s = typeof z === 'number' && !this.store.exporting ? z / (window.devicePixelRatio || 1) : fit;
    s = Math.min(s, 8192 / Math.max(W, H));
    if (this.stageInner) this.stageInner.style.padding = `${pad}px`;
    const ar = `${W} / ${H}`;
    if (this.stage.style.getPropertyValue('--frame-ar') !== ar) this.stage.style.setProperty('--frame-ar', ar); // narrow layouts size the stage to the frame
    this.dw = Math.max(1, Math.floor(W * s));
    this.dh = Math.max(1, Math.floor(H * s));
    this.frameEl.style.width = `${this.dw}px`;
    this.frameEl.style.height = `${this.dh}px`;
    this.dpr = sizeCanvas(this.overlay, this.dw, this.dh);
    this.program.style.width = `${this.dw}px`;
    this.program.style.height = `${this.dh}px`;
    this.dirty = true;
    this.onResize?.(this.dw, this.dh);
  }

  #updateEmpty() {
    this.empty.hidden = this.store.project.clips.length > 0 || this.store.exporting;
  }

  get k() { return this.dw / Math.max(1, this.renderer.size[0]); }

  #screen(L) {
    const k = this.k;
    return { cx: L.cx * k, cy: L.cy * k, w: L.w * k, h: L.h * k, rot: L.rot };
  }

  #local(e) {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #toLocal(p, S) {
    const dx = p.x - S.cx, dy = p.y - S.cy;
    const c = Math.cos(-S.rot), s = Math.sin(-S.rot);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  #toScreen(lx, ly, S) {
    const c = Math.cos(S.rot), s = Math.sin(S.rot);
    return { x: S.cx + lx * c - ly * s, y: S.cy + lx * s + ly * c };
  }

  #visible() {
    const { project } = this.store;
    const out = [];
    for (const tr of project.tracks) {
      if (tr.kind !== 'video' || tr.hidden) continue;
      const c = activeClipAt(project, tr.id, this.store.time);
      if (c && this.renderer.layouts.has(c.id)) out.push({ clip: c, track: tr });
    }
    return out; // top track first
  }

  #hitClip(p) {
    for (const { clip, track } of this.#visible()) {
      if (track.locked) continue;
      const S = this.#screen(this.renderer.layouts.get(clip.id));
      const l = this.#toLocal(p, S);
      if (Math.abs(l.x) <= S.w / 2 + 2 && Math.abs(l.y) <= S.h / 2 + 2) return clip;
    }
    return null;
  }

  #single() {
    if (this.store.selection.size !== 1) return null;
    const clip = this.store.getClip([...this.store.selection][0]);
    if (!clip || !isVisual(clip)) return null;
    const tr = this.store.getTrack(clip.trackId);
    if (!tr || tr.locked) return null;
    const L = this.renderer.layouts.get(clip.id);
    if (!L) return null;
    return { clip, S: this.#screen(L) };
  }

  #handles(S) {
    const w2 = S.w / 2, h2 = S.h / 2;
    return [
      { id: 'nw', ...this.#toScreen(-w2, -h2, S) },
      { id: 'ne', ...this.#toScreen(w2, -h2, S) },
      { id: 'se', ...this.#toScreen(w2, h2, S) },
      { id: 'sw', ...this.#toScreen(-w2, h2, S) },
      { id: 'rot', ...this.#toScreen(0, -h2 - ROT_OFF, S) },
    ];
  }

  #hitHandle(p, S) {
    for (const hd of this.#handles(S)) if (Math.hypot(p.x - hd.x, p.y - hd.y) <= HIT) return hd.id;
    return null;
  }

  #bindPointer() {
    const o = this.overlay;
    o.addEventListener('pointerdown', (e) => {
      if (this.store.exporting) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      o.focus({ preventScroll: true });
      const p = this.#local(e);
      const sel = this.#single();
      if (sel) {
        const hd = this.#hitHandle(p, sel.S);
        if (hd) {
          if (this.store.playing) this.playback.pause();
          const t = sel.clip.transform;
          this.drag = hd === 'rot'
            ? { type: 'rotate', id: sel.clip.id, S: sel.S, a0: Math.atan2(p.y - sel.S.cy, p.x - sel.S.cx), orig: { ...t }, changed: false }
            : { type: 'scale', id: sel.clip.id, S: sel.S, dist0: Math.max(4, Math.hypot(p.x - sel.S.cx, p.y - sel.S.cy)), orig: { ...t }, changed: false, p };
          o.setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = this.#hitClip(p);
      if (hit) {
        if (!this.store.selection.has(hit.id) || this.store.selection.size > 1) this.store.select([hit.id]);
        if (this.store.playing) this.playback.pause();
        this.drag = { type: 'move', id: hit.id, start: p, orig: { ...hit.transform }, changed: false, snap: this.#snapSetup(hit) };
        o.setPointerCapture(e.pointerId);
      } else {
        this.store.clearSelection();
      }
    });
    o.addEventListener('pointermove', (e) => {
      const p = this.#local(e);
      if (!this.drag) { this.#hover(p); return; }
      const d = this.drag;
      const clip = this.store.getClip(d.id);
      if (!clip) return;
      const t = clip.transform;
      if (d.type === 'move') {
        if (!d.changed && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 2) return;
        d.changed = true;
        let x = d.orig.x + (p.x - d.start.x) / this.dw;
        let y = d.orig.y + (p.y - d.start.y) / this.dh;
        this.guides = { x: [], y: [] };
        if (!e.altKey && d.snap) {
          const sx = this.#snapAxis(x * d.snap.W, d.snap.offX, d.snap.tx);
          const sy = this.#snapAxis(y * d.snap.H, d.snap.offY, d.snap.ty);
          if (sx) { x = sx.pos / d.snap.W; this.guides.x = sx.lines; }
          if (sy) { y = sy.pos / d.snap.H; this.guides.y = sy.lines; }
        }
        t.x = x; t.y = y;
      } else if (d.type === 'scale') {
        d.changed = true;
        d.p = p;
        const dist = Math.hypot(p.x - d.S.cx, p.y - d.S.cy);
        t.scale = clamp(d.orig.scale * (dist / d.dist0), 0.02, 20);
      } else if (d.type === 'rotate') {
        d.changed = true;
        const a = Math.atan2(p.y - d.S.cy, p.x - d.S.cx);
        let deg = d.orig.rotation + ((a - d.a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        else { const r = Math.round(deg / 90) * 90; if (Math.abs(deg - r) < 3) deg = r; }
        t.rotation = Math.round(((((deg + 180) % 360) + 360) % 360 - 180) * 10) / 10;
        d.p = p;
      }
      this.store.touch();
    });
    const end = () => {
      const d = this.drag;
      this.drag = null;
      this.guides = { x: [], y: [] };
      this.dirty = true;
      if (d?.changed) this.store.commit({ move: 'Move layer', scale: 'Scale layer', rotate: 'Rotate layer' }[d.type]);
    };
    o.addEventListener('pointerup', end);
    o.addEventListener('pointercancel', () => this.cancelDrag());
    o.addEventListener('pointerleave', () => { if (!this.drag && this.hoverId) { this.hoverId = null; this.dirty = true; } });
    o.addEventListener('dblclick', (e) => {
      const hit = this.#hitClip(this.#local(e));
      if (!hit) return;
      // Text: type straight onto the canvas. Other layers: jump to their properties.
      if (hit.kind === 'text') this.store.emit('edit-text', hit.id);
      else this.store.emit('focus-inspector', hit.id);
    });
  }

  /**
   * Snap candidates for a move, in program-canvas pixels: the layer's visible left / centre / right
   * (and top / middle / bottom) as offsets from its anchor, against the frame edges and centre lines,
   * the title-safe lines when guides are shown, and the edges and centres of the other visible layers.
   */
  #snapSetup(clip) {
    const [W, H] = this.renderer.size;
    const r = this.renderer;
    const b = r.visualBounds(clip, W, H);
    const offX = [b.minX - b.cx, (b.minX + b.maxX) / 2 - b.cx, b.maxX - b.cx];
    const offY = [b.minY - b.cy, (b.minY + b.maxY) / 2 - b.cy, b.maxY - b.cy];
    const tx = [{ v: 0, kind: 'frame' }, { v: W / 2, kind: 'center' }, { v: W, kind: 'frame' }];
    const ty = [{ v: 0, kind: 'frame' }, { v: H / 2, kind: 'center' }, { v: H, kind: 'frame' }];
    if (this.store.ui.guides) {
      tx.push({ v: W * 0.05, kind: 'safe' }, { v: W * 0.95, kind: 'safe' });
      ty.push({ v: H * 0.05, kind: 'safe' }, { v: H * 0.95, kind: 'safe' });
    }
    for (const { clip: other } of this.#visible()) {
      if (other.id === clip.id) continue;
      const ob = r.visualBounds(other, W, H);
      tx.push({ v: ob.minX, kind: 'layer' }, { v: (ob.minX + ob.maxX) / 2, kind: 'layer' }, { v: ob.maxX, kind: 'layer' });
      ty.push({ v: ob.minY, kind: 'layer' }, { v: (ob.minY + ob.maxY) / 2, kind: 'layer' }, { v: ob.maxY, kind: 'layer' });
    }
    return { W, H, offX, offY, tx, ty };
  }

  /** Nearest snap within ~7 screen pixels; returns the snapped anchor and every guide line it lands on. */
  #snapAxis(anchor, offsets, targets) {
    const thr = 7 / Math.max(1e-6, this.k);
    let best = null;
    for (const off of offsets) {
      for (const t of targets) {
        const delta = t.v - (anchor + off);
        if (Math.abs(delta) <= thr && (!best || Math.abs(delta) < Math.abs(best.delta) - 1e-9)) best = { delta };
      }
    }
    if (!best) return null;
    const pos = anchor + best.delta;
    const lines = [];
    for (const off of offsets) for (const t of targets) if (Math.abs(t.v - (pos + off)) < 0.5 && !lines.some((l) => Math.abs(l.v - t.v) < 0.5)) lines.push(t);
    return { pos, lines };
  }

  cancelDrag() {
    if (!this.drag) return false;
    const d = this.drag;
    this.drag = null;
    this.guides = { x: [], y: [] };
    if (d.changed) this.store.revert();
    this.dirty = true;
    return true;
  }

  #hover(p) {
    const sel = this.#single();
    let cursor = 'default';
    if (sel) {
      const hd = this.#hitHandle(p, sel.S);
      if (hd === 'rot') cursor = 'grab';
      else if (hd) {
        const ang = ((Math.atan2(p.y - sel.S.cy, p.x - sel.S.cx) * 180) / Math.PI + 360) % 180;
        cursor = ang < 90 ? 'nwse-resize' : 'nesw-resize';
      }
    }
    const hit = this.#hitClip(p);
    if (cursor === 'default' && hit) cursor = 'move';
    this.overlay.style.cursor = cursor;
    const id = hit?.id || null;
    if (id !== this.hoverId) { this.hoverId = id; this.dirty = true; }
  }

  nudge(dx, dy) {
    const sel = this.#single();
    if (!sel) return false;
    const t = sel.clip.transform;
    t.x += dx / this.dw;
    t.y += dy / this.dh;
    this.store.touch();
    this.commitNudge();
    return true;
  }

  get overlayFocused() { return document.activeElement === this.overlay; }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.octx;
    const { dw, dh, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dw, dh);
    if (this.store.exporting) return;
    if (this.store.ui.guides) this.#guides(ctx);
    // Smart-snap guide lines: the cut-red hairline; safe area and other layers dashed.
    const k = this.k;
    const style = (kind) => {
      ctx.setLineDash(kind === 'safe' ? [3, 4] : kind === 'layer' ? [6, 3] : []);
      ctx.strokeStyle = kind === 'layer' ? 'rgba(255,115,120,0.9)' : '#f0464c';
    };
    ctx.lineWidth = 1;
    for (const g of this.guides.x) { style(g.kind); const X = Math.round(Math.min(dw - 0.5, Math.max(0.5, g.v * k))) + 0.5; ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, dh); ctx.stroke(); }
    for (const g of this.guides.y) { style(g.kind); const Y = Math.round(Math.min(dh - 0.5, Math.max(0.5, g.v * k))) + 0.5; ctx.beginPath(); ctx.moveTo(0, Y); ctx.lineTo(dw, Y); ctx.stroke(); }
    ctx.setLineDash([]);
    const layouts = this.renderer.layouts;
    if (this.hoverId && !this.store.selection.has(this.hoverId) && layouts.has(this.hoverId)) {
      const S = this.#screen(layouts.get(this.hoverId));
      ctx.save();
      ctx.translate(S.cx, S.cy); ctx.rotate(S.rot);
      ctx.strokeStyle = 'rgba(231,234,240,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-S.w / 2, -S.h / 2, S.w, S.h);
      ctx.restore();
    }
    const ids = [...this.store.selection].filter((id) => layouts.has(id));
    for (const id of ids) {
      const S = this.#screen(layouts.get(id));
      ctx.save();
      ctx.translate(S.cx, S.cy);
      ctx.rotate(S.rot);
      ctx.strokeStyle = 'rgba(11,13,16,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeRect(-S.w / 2, -S.h / 2, S.w, S.h);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(-S.w / 2, -S.h / 2, S.w, S.h);
      if (ids.length === 1 && this.renderer.editingId !== id) {
        ctx.beginPath();
        ctx.moveTo(0, -S.h / 2);
        ctx.lineTo(0, -S.h / 2 - ROT_OFF);
        ctx.stroke();
        const sq = 8;
        for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect((hx * S.w) / 2 - sq / 2, (hy * S.h) / 2 - sq / 2, sq, sq);
          ctx.strokeStyle = '#0b0d10';
          ctx.lineWidth = 1;
          ctx.strokeRect((hx * S.w) / 2 - sq / 2 + 0.5, (hy * S.h) / 2 - sq / 2 + 0.5, sq - 1, sq - 1);
        }
        ctx.beginPath();
        ctx.arc(0, -S.h / 2 - ROT_OFF, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#0b0d10';
        ctx.stroke();
      }
      ctx.restore();
    }
    const d = this.drag;
    if (d && (d.type === 'scale' || d.type === 'rotate') && d.p) {
      const clip = this.store.getClip(d.id);
      if (clip) {
        const label = d.type === 'scale' ? `${Math.round(clip.transform.scale * 100)}%` : `${clip.transform.rotation}°`;
        ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
        const tw = ctx.measureText(label).width + 10;
        const x = clamp(d.p.x + 12, 0, dw - tw), y = clamp(d.p.y - 26, 0, dh - 20);
        ctx.fillStyle = 'rgba(30,34,43,0.94)';
        ctx.fillRect(x, y, tw, 20);
        ctx.fillStyle = '#e7eaf0';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 5, y + 10.5);
      }
    }
  }

  #guides(ctx) {
    const { dw, dh } = this;
    const aspect = this.store.project.aspect;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(231,234,240,0.16)';
    for (const f of [1 / 3, 2 / 3]) {
      ctx.beginPath(); ctx.moveTo(Math.round(dw * f) + 0.5, 0); ctx.lineTo(Math.round(dw * f) + 0.5, dh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, Math.round(dh * f) + 0.5); ctx.lineTo(dw, Math.round(dh * f) + 0.5); ctx.stroke();
    }
    if (aspect === '9:16') {
      ctx.fillStyle = 'rgba(231,234,240,0.08)';
      ctx.fillRect(0, 0, dw, dh * 0.12);
      ctx.fillRect(0, dh * 0.8, dw, dh * 0.2);
      ctx.fillRect(dw * 0.86, dh * 0.42, dw * 0.14, dh * 0.38);
      ctx.fillStyle = 'rgba(231,234,240,0.6)';
      ctx.font = '10px "Hanken Grotesk", system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('Platform UI', 6, dh * 0.8 + 6);
    }
    ctx.setLineDash([4, 3]);
    const zones = [[0.035, 'Action safe'], [0.05, 'Title safe']];
    ctx.font = '10px "Hanken Grotesk", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const [m, label] of zones) {
      const x = dw * m, y = dh * m;
      ctx.strokeStyle = m < 0.04 ? 'rgba(231,234,240,0.38)' : 'rgba(231,234,240,0.6)';
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(dw - 2 * x), Math.round(dh - 2 * y));
      ctx.fillStyle = 'rgba(231,234,240,0.6)';
      if (dw > 260) ctx.fillText(label, x + 4, y + 3 + (m < 0.04 ? 0 : 12));
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(231,234,240,0.55)';
    ctx.beginPath();
    ctx.moveTo(dw / 2 - 8, dh / 2 + 0.5); ctx.lineTo(dw / 2 + 8, dh / 2 + 0.5);
    ctx.moveTo(dw / 2 + 0.5, dh / 2 - 8); ctx.lineTo(dw / 2 + 0.5, dh / 2 + 8);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- transport ----------
  #bindTransport() {
    const { store, actions, audio } = this;
    const play = $('tp-play');
    play.addEventListener('click', () => actions.togglePlay());
    store.on('playstate', (on) => {
      setIcon(play, on ? 'pause' : 'play');
      play.setAttribute('aria-label', on ? 'Pause (Space)' : 'Play (Space)');
    });
    $('tp-start').addEventListener('click', () => actions.seek(0));
    $('tp-end').addEventListener('click', () => actions.seek(store.duration));
    $('tp-back').addEventListener('click', () => actions.step(-1));
    $('tp-fwd').addEventListener('click', () => actions.step(1));
    const loop = $('tp-loop');
    loop.addEventListener('click', () => { store.ui.loop = !store.ui.loop; loop.setAttribute('aria-pressed', String(store.ui.loop)); });
    const guides = $('tp-guides');
    this.toggleGuides = () => {
      store.ui.guides = !store.ui.guides;
      guides.setAttribute('aria-pressed', String(store.ui.guides));
      this.dirty = true;
    };
    guides.addEventListener('click', this.toggleGuides);
    const q = $('tp-quality');
    q.value = String(store.ui.previewScale);
    q.addEventListener('change', () => { store.ui.previewScale = Number(q.value) || 1; this.onQuality?.(); });
    const vol = $('tp-volume');
    const setVol = () => { audio.setMasterVolume(Number(vol.value) / 100); vol.style.setProperty('--p', `${vol.value}%`); };
    vol.addEventListener('input', setVol);
    setVol();
    $('tp-full').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else this.monitorEl.requestFullscreen?.().catch(() => this.monitorEl.classList.toggle('fullscreen'));
    });
    this.meter = $('meter');
    this.meterDpr = sizeCanvas(this.meter, 44, 14);
    this.mctx = this.meter.getContext('2d');
    this.tcNow = $('tc-now');
    this.tcDur = $('tc-dur');
  }

  #drawMeter() {
    const ctx = this.mctx;
    const dpr = this.meterDpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 44, 14);
    const levels = this.store.playing ? this.audio.meter() : [0, 0];
    for (let i = 0; i < 2; i++) {
      const y = i * 7 + 1;
      ctx.fillStyle = '#272c37';
      ctx.fillRect(0, y, 44, 5);
      const db = 20 * Math.log10(Math.max(1e-5, levels[i]));
      const norm = clamp((db + 48) / 48, 0, 1);
      ctx.fillStyle = db > -1 ? '#f0464c' : db > -9 ? '#f2c14e' : '#6fcf97';
      ctx.fillRect(0, y, Math.round(44 * norm), 5);
    }
  }

  frame() {
    const { store } = this;
    const fps = store.project.fps;
    const tc = formatTC(store.time, fps);
    if (tc !== this.lastTc) { setTimecode(this.tcNow, tc); this.lastTc = tc; }
    setTimecode(this.tcDur, formatTC(store.duration, fps));
    if (store.playing || this.meterActive) { this.#drawMeter(); this.meterActive = store.playing; }
    this.draw();
  }
}
