// Canvas timeline: one viewport-sized canvas for clips (redrawn on change), one overlay canvas for the
// playhead, snap line, razor guide and marquee (redrawn every frame while playing). A native scroller
// underneath provides the scroll extents and scrollbars; the canvases draw at its scroll offset.
import { clamp, quantize, formatTC, cssVar, roundRectPath, easeOutExpo, reducedMotion } from '../util.js';
import { clipEnd, overwriteRange, trackKindFor, linkedClips, effectiveAnimDurations, isVisual } from '../core/ops.js';
import { drawSticker } from '../engine/stickers.js';
import { h, icon, sizeCanvas, announce } from './dom.js';

const TRACK_H = 60;
const PAD = 4;
const LABEL_H = 16;
const EDGE = 7;
const SNAP_PX = 8;
const SNIP_MS = 420;
const MIN_ZOOM = 1.5;
const MAX_ZOOM = 1800;

/** Shared with the library for HTML5 drag-and-drop (dataTransfer is unreadable during dragover). */
export const dragPayload = { current: null };

const $ = (id) => document.getElementById(id);

export class Timeline {
  constructor({ store, assets, playback, actions, onVoice }) {
    this.store = store;
    this.assets = assets;
    this.playback = playback;
    this.actions = actions;
    this.onVoice = onVoice;
    this.el = {
      ruler: $('tl-ruler'), rulerWrap: $('tl-ruler-wrap'), heads: $('tl-heads-inner'), main: $('tl-main'),
      scroller: $('tl-scroller'), spacer: $('tl-spacer'), canvas: $('timeline-canvas'), over: $('tl-overlay'),
      tc: $('tl-tc'), zoom: $('zoom-slider'),
    };
    this.ctx = this.el.canvas.getContext('2d');
    this.octx = this.el.over.getContext('2d');
    this.rctx = this.el.ruler.getContext('2d');
    this.w = 1; this.h = 1; this.rw = 1; this.dpr = 1;
    this.scrollX = 0; this.scrollY = 0;
    this.drag = null;
    this.hover = null;
    this.snapLine = null;
    this.razorHover = null;
    this.dropGhost = null;
    this.snips = [];
    this.dirtyBase = true;
    this.dirtyOver = true;
    this.lastTc = '';
    this.headSig = '';
    this.c = this.#readColors();
    this.#bind();
    this.renderHeads();
    this.resize();
    this.#syncZoomSlider();
    actions.onSnip((trackId, t) => { this.snips.push({ trackId, t, at: performance.now() }); this.dirtyBase = true; });
  }

  #readColors() {
    const v = (n) => cssVar(n);
    return {
      bg: v('--bg'), surface: v('--surface'), lane: '#1f1e1b', laneAlt: '#22211e', grid: 'rgba(236,231,220,0.05)',
      slate: v('--slate'), slateDeep: v('--slate-deep'), ochre: v('--ochre'), ochreDeep: v('--ochre-deep'),
      bone: v('--bone'), boneDeep: v('--bone-deep'), ink: v('--ink'), text: v('--text'), muted: v('--muted'),
      faint: v('--faint'), accent: v('--accent'), focus: v('--focus'), border: v('--border'),
      ui: v('--font-ui'), mono: v('--font-mono'),
    };
  }

  // ---------- geometry ----------
  get zoom() { return this.store.zoom; }
  get fps() { return this.store.project.fps; }
  trackIndex(id) { return this.store.project.tracks.findIndex((t) => t.id === id); }
  local(e, el = this.el.canvas) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  resize() {
    const { scroller, rulerWrap } = this.el;
    this.w = Math.max(1, scroller.clientWidth);
    this.h = Math.max(1, scroller.clientHeight);
    this.dpr = sizeCanvas(this.el.canvas, this.w, this.h);
    sizeCanvas(this.el.over, this.w, this.h);
    this.rw = Math.max(1, rulerWrap.clientWidth);
    sizeCanvas(this.el.ruler, this.rw, 30);
    this.updateSpacer();
    this.dirtyBase = this.dirtyOver = true;
  }

  updateSpacer() {
    const contentW = Math.max(this.w + 1, (Math.max(this.store.duration, 20) + 40) * this.zoom);
    const contentH = this.store.project.tracks.length * TRACK_H + 24;
    this.el.spacer.style.width = `${Math.ceil(contentW)}px`;
    this.el.spacer.style.height = `${contentH}px`;
  }

  // ---------- binding ----------
  #bind() {
    const { store } = this;
    const { canvas, scroller, ruler } = this.el;
    new ResizeObserver(() => this.resize()).observe(this.el.main);
    scroller.addEventListener('scroll', () => {
      this.scrollX = scroller.scrollLeft;
      this.scrollY = scroller.scrollTop;
      this.el.heads.style.transform = `translateY(${-this.scrollY}px)`;
      this.dirtyBase = this.dirtyOver = true;
    }, { passive: true });

    const wheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const p = this.local(e, canvas);
        this.zoomAround(this.zoom * Math.exp(-e.deltaY * 0.0022), clamp(p.x, 0, this.w));
      } else if (e.shiftKey) {
        scroller.scrollTop += e.deltaY;
      } else {
        scroller.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    ruler.addEventListener('wheel', wheel, { passive: false });

    canvas.addEventListener('pointerdown', (e) => this.#onDown(e));
    canvas.addEventListener('pointermove', (e) => this.#onMove(e));
    canvas.addEventListener('pointerup', (e) => this.#onUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
    canvas.addEventListener('pointerleave', () => {
      if (this.drag) return;
      if (this.hover || this.razorHover) { this.hover = null; this.razorHover = null; this.dirtyBase = this.dirtyOver = true; }
    });
    canvas.addEventListener('dblclick', (e) => {
      const p = this.local(e);
      const hit = this.hitTest(p.x, p.y);
      if (!hit.clip) return;
      store.select([hit.clip.id]);
      if (hit.clip.kind === 'text') store.emit('edit-text', hit.clip.id);
      else store.emit('focus-inspector', hit.clip.id);
    });

    ruler.addEventListener('pointerdown', (e) => {
      if (store.exporting) return;
      ruler.setPointerCapture(e.pointerId);
      if (store.playing) this.playback.pause();
      this.rulerDrag = true;
      this.#scrubTo(this.local(e, ruler).x);
    });
    ruler.addEventListener('pointermove', (e) => { if (this.rulerDrag) this.#scrubTo(this.local(e, ruler).x); });
    const endRuler = () => { this.rulerDrag = false; };
    ruler.addEventListener('pointerup', endRuler);
    ruler.addEventListener('pointercancel', endRuler);

    // HTML5 drag-and-drop from the library and from the OS
    canvas.addEventListener('dragover', (e) => {
      const payload = dragPayload.current;
      const hasFiles = [...(e.dataTransfer?.types || [])].includes('Files');
      if (!payload && !hasFiles) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (payload) { this.dropGhost = this.#ghostFor(payload, this.local(e)); this.dirtyOver = true; }
    });
    canvas.addEventListener('dragleave', () => { this.dropGhost = null; this.dirtyOver = true; });
    canvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      const p = this.local(e);
      const payload = dragPayload.current;
      const ghost = this.dropGhost;
      dragPayload.current = null;
      this.dropGhost = null;
      this.dirtyOver = true;
      if (payload && ghost) {
        const clip = payload.make();
        if (!clip) return;
        clip.duration = ghost.duration;
        this.actions.addClip(clip, { trackId: ghost.trackId, start: ghost.start });
        return;
      }
      const files = e.dataTransfer?.files;
      if (files?.length) {
        let at = quantize(Math.max(0, (p.x + this.scrollX) / this.zoom), this.fps);
        const list = await this.assets.importFiles(files);
        for (const a of list) { const c = this.actions.addAsset(a, { start: at }); if (c) at = clipEnd(c); }
      }
    });

    // toolbar
    const tools = { select: $('tool-select'), razor: $('tool-razor') };
    tools.select.addEventListener('click', () => store.setTool('select'));
    tools.razor.addEventListener('click', () => store.setTool('razor'));
    store.on('tool', (t) => {
      for (const [k, b] of Object.entries(tools)) b.setAttribute('aria-checked', String(k === t));
      canvas.classList.toggle('razor-cursor', t === 'razor');
      this.razorHover = null;
      this.dirtyOver = true;
    });
    $('act-split').addEventListener('click', () => this.actions.splitAtPlayhead());
    $('act-duplicate').addEventListener('click', () => this.actions.duplicateSelected());
    $('act-delete').addEventListener('click', () => this.actions.deleteSelected(false));
    $('act-ripple').addEventListener('click', () => this.actions.deleteSelected(true));
    const snapBtn = $('act-snap');
    snapBtn.addEventListener('click', () => store.setSnap(!store.snap));
    store.on('snap', (v) => { snapBtn.setAttribute('aria-pressed', String(v)); announce(`Snapping ${v ? 'on' : 'off'}`); });
    $('act-voice').addEventListener('click', () => this.onVoice?.());
    $('act-add-v').addEventListener('click', () => this.actions.addTrack('video'));
    $('act-add-a').addEventListener('click', () => this.actions.addTrack('audio'));
    $('zoom-in').addEventListener('click', () => this.zoomBy(1.4));
    $('zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.4));
    $('zoom-fit').addEventListener('click', () => this.zoomFit());
    this.el.zoom.addEventListener('input', () => {
      const v = Number(this.el.zoom.value) / 1000;
      const z = MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v);
      const px = clamp(this.store.time * this.zoom - this.scrollX, 0, this.w);
      this.zoomAround(z, px, false);
    });

    store.on('project', () => { this.updateSpacer(); this.renderHeads(); this.dirtyBase = this.dirtyOver = true; });
    store.on('selection', () => {
      this.dirtyBase = true;
      const sel = store.selectedClips();
      if (sel.length === 1) {
        const c = sel[0];
        const tr = store.getTrack(c.trackId);
        announce(`Selected ${c.name || c.kind} on ${tr?.name || ''}, ${formatTC(c.start, this.fps)} to ${formatTC(clipEnd(c), this.fps)}`);
      } else if (sel.length > 1) announce(`${sel.length} clips selected`);
    });
    store.on('time', () => { this.dirtyOver = true; });
    store.on('zoom', () => { this.updateSpacer(); this.#syncZoomSlider(); this.dirtyBase = this.dirtyOver = true; });
    this.assets.on('change', () => { this.dirtyBase = true; });
    this.assets.on('thumbs', () => { this.dirtyBase = true; });
  }

  #syncZoomSlider() {
    const v = Math.log(this.zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
    this.el.zoom.value = String(Math.round(v * 1000));
    this.el.zoom.style.setProperty('--p', `${v * 100}%`);
  }

  zoomAround(z, anchorX, syncSlider = true) {
    const t = (anchorX + this.scrollX) / this.zoom;
    this.store.setZoom(z);
    this.updateSpacer();
    this.el.scroller.scrollLeft = Math.max(0, t * this.zoom - anchorX);
    this.scrollX = this.el.scroller.scrollLeft;
    if (!syncSlider) return;
    this.#syncZoomSlider();
  }

  zoomBy(f) {
    const px = clamp(this.store.time * this.zoom - this.scrollX, 0, this.w);
    this.zoomAround(this.zoom * f, px);
  }

  zoomFit() {
    const d = Math.max(this.store.duration, 5);
    this.store.setZoom((this.w - 48) / d);
    this.updateSpacer();
    this.el.scroller.scrollLeft = 0;
    this.scrollX = 0;
  }

  renderHeads() {
    const tracks = this.store.project.tracks;
    const sig = JSON.stringify(tracks.map((t) => [t.id, t.name, t.role, t.hidden, t.locked, t.muted]));
    if (sig === this.headSig) return;
    this.headSig = sig;
    const btn = (tr, iconName, label, pressed, prop) => h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': label, 'aria-pressed': String(pressed), title: label,
      on: { click: () => this.actions.toggleTrack(tr.id, prop) },
    }, icon(iconName));
    this.el.heads.replaceChildren(...tracks.map((tr) => h('div', {
      class: `tl-head${tr.hidden || tr.muted ? ' is-off' : ''}`, dataset: { kind: tr.kind },
    },
    h('span', { class: 'tl-head-name', text: tr.name }),
    h('span', { class: 'tl-head-role', text: tr.role }),
    h('div', { class: 'tl-head-btns' },
      tr.kind === 'video' ? btn(tr, tr.hidden ? 'eye-off' : 'eye', `${tr.hidden ? 'Show' : 'Hide'} track ${tr.name}`, tr.hidden, 'hidden') : null,
      btn(tr, tr.muted ? 'volume-x' : 'volume', `${tr.muted ? 'Unmute' : 'Mute'} track ${tr.name}`, tr.muted, 'muted'),
      btn(tr, tr.locked ? 'lock' : 'unlock', `${tr.locked ? 'Unlock' : 'Lock'} track ${tr.name}`, tr.locked, 'locked')))));
  }

  // ---------- hit testing & snapping ----------
  hitTest(px, py) {
    const tracks = this.store.project.tracks;
    const ti = Math.floor((py + this.scrollY) / TRACK_H);
    const track = tracks[ti] || null;
    const time = (px + this.scrollX) / this.zoom;
    let clip = null, edge = null;
    if (track) {
      const y0 = ti * TRACK_H - this.scrollY;
      if (py >= y0 + PAD - 1 && py <= y0 + TRACK_H - PAD + 1) {
        for (const c of this.store.project.clips) {
          if (c.trackId !== track.id) continue;
          const x = c.start * this.zoom - this.scrollX;
          const w = Math.max(2, c.duration * this.zoom);
          if (px >= x && px < x + w) {
            clip = c;
            const zone = Math.min(EDGE, w / 3);
            if (px - x <= zone) edge = 'left';
            else if (x + w - px <= zone) edge = 'right';
          }
        }
      }
    }
    return { track, trackIndex: ti, time, clip, edge };
  }

  snapPoints(exclude) {
    const pts = [0, this.store.time];
    for (const c of this.store.project.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
    return pts;
  }

  #snapNear(t, pts) {
    const thr = SNAP_PX / this.zoom;
    let best = null, bd = thr;
    for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  #snapOn(e) { return this.store.snap !== !!e.altKey; }

  // ---------- pointer interactions ----------
  #onDown(e) {
    const { store } = this;
    if (store.exporting) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.el.canvas.focus({ preventScroll: true });
    const p = this.local(e);
    const hit = this.hitTest(p.x, p.y);
    const phx = store.time * this.zoom - this.scrollX;

    if (Math.abs(p.x - phx) <= 4 && !(hit.clip && hit.edge) && store.tool !== 'razor') {
      if (store.playing) this.playback.pause();
      this.#begin(e, { type: 'scrub' });
      this.#scrubTo(p.x);
      return;
    }
    if (store.tool === 'razor') {
      if (hit.clip && !hit.track.locked) {
        let t = hit.time;
        if (this.#snapOn(e)) { const s = this.#snapNear(t, this.snapPoints(new Set([hit.clip.id]))); if (s != null) t = s; }
        this.actions.splitClipAt(hit.clip.id, t);
      }
      return;
    }
    if (hit.clip) {
      if (hit.track.locked) { announce(`Track ${hit.track.name} is locked`); return; }
      const mod = e.shiftKey || e.ctrlKey || e.metaKey;
      const wasSelected = store.selection.has(hit.clip.id);
      if (hit.edge && !mod) {
        if (store.playing) this.playback.pause();
        store.select([hit.clip.id]);
        const c = hit.clip;
        this.#begin(e, { type: 'trim', edge: hit.edge, clipId: c.id, orig: { start: c.start, duration: c.duration, in: c.in, speed: c.speed }, bounds: this.#trimBounds(c) });
        return;
      }
      if (mod) {
        store.select([hit.clip.id], 'toggle');
        if (!store.selection.has(hit.clip.id)) return;
      } else if (!wasSelected) {
        store.select([hit.clip.id]);
      }
      const origin = new Map();
      for (const id of store.selection) {
        const c = store.getClip(id);
        const tr = c && store.getTrack(c.trackId);
        if (!c || !tr || tr.locked) continue;
        origin.set(id, { start: c.start, trackId: c.trackId, ti: this.trackIndex(c.trackId), kind: trackKindFor(c.kind), duration: c.duration });
      }
      if (!e.altKey) {
        // Voice-overs follow their text (and captions follow their narration) in time, on their own tracks.
        for (const id of [...origin.keys()]) {
          for (const fid of linkedClips(store.project, id)) {
            if (origin.has(fid)) continue;
            const c = store.getClip(fid);
            const tr = c && store.getTrack(c.trackId);
            if (!c || !tr || tr.locked) continue;
            origin.set(fid, { start: c.start, trackId: c.trackId, ti: this.trackIndex(c.trackId), kind: trackKindFor(c.kind), duration: c.duration, follower: true });
          }
        }
      }
      this.#begin(e, { type: 'move', sx: p.x + this.scrollX, sy: p.y, anchorId: hit.clip.id, anchorTi: hit.trackIndex, origin, moved: false, lastShift: 0, collapse: wasSelected && !mod });
      return;
    }
    this.#begin(e, {
      type: 'marquee', sx: p.x + this.scrollX, sy: p.y + this.scrollY, cx: p.x + this.scrollX, cy: p.y + this.scrollY,
      active: false, additive: e.shiftKey || e.ctrlKey || e.metaKey, base: new Set(store.selection),
    });
  }

  #begin(e, drag) {
    this.drag = drag;
    try { this.el.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  #onMove(e) {
    const p = this.local(e);
    if (!this.drag) { this.#hover(p, e); return; }
    const d = this.drag;
    if (d.type !== 'scrub') this.#autoScroll(p);
    if (d.type === 'move') this.#dragMove(d, p, e);
    else if (d.type === 'trim') this.#dragTrim(d, p, e);
    else if (d.type === 'marquee') this.#dragMarquee(d, p);
    else if (d.type === 'scrub') this.#scrubTo(p.x);
  }

  #dragMove(d, p, e) {
    const { store } = this;
    const fps = this.fps;
    const cx = p.x + this.scrollX;
    if (!d.moved && Math.hypot(cx - d.sx, p.y - d.sy) < 3) return;
    if (!d.moved) { d.moved = true; if (store.playing) this.playback.pause(); }
    let dT = (cx - d.sx) / this.zoom;
    const all = [...d.origin.values()];
    const origins = all.filter((o) => !o.follower);
    const minStart = Math.min(...all.map((o) => o.start));
    if (minStart + dT < 0) dT = -minStart;
    this.snapLine = null;
    if (this.#snapOn(e)) {
      const pts = this.snapPoints(new Set(d.origin.keys()));
      const thr = SNAP_PX / this.zoom;
      let best = null;
      for (const o of origins) {
        for (const edge of [o.start + dT, o.start + o.duration + dT]) {
          for (const pt of pts) {
            const diff = pt - edge;
            if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, pt };
          }
        }
      }
      if (best && minStart + dT + best.diff >= 0) { dT += best.diff; this.snapLine = best.pt; }
    }
    const tracks = store.project.tracks;
    const hoverTi = clamp(Math.floor((p.y + this.scrollY) / TRACK_H), 0, tracks.length - 1);
    let shift = hoverTi - d.anchorTi;
    const valid = origins.every((o) => { const tr = tracks[o.ti + shift]; return tr && tr.kind === o.kind && !tr.locked; });
    if (!valid) shift = d.lastShift; else d.lastShift = shift;
    for (const [id, o] of d.origin) {
      const c = store.getClip(id);
      if (!c) continue;
      c.start = Math.max(0, quantize(o.start + dT, fps));
      c.trackId = o.follower ? o.trackId : tracks[o.ti + shift]?.id || o.trackId;
    }
    store.touch();
  }

  #trimBounds(clip) {
    const fps = this.fps;
    const others = this.store.project.clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id);
    let minStart = Math.max(0, ...others.filter((c) => clipEnd(c) <= clip.start + 1e-6).map(clipEnd));
    let maxEnd = Math.min(Infinity, ...others.filter((c) => c.start >= clipEnd(clip) - 1e-6).map((c) => c.start));
    if (clip.kind === 'video' || clip.kind === 'audio') {
      const a = this.assets.get(clip.assetId);
      if (a && Number.isFinite(a.duration)) {
        minStart = Math.max(minStart, clip.start - clip.in / clip.speed);
        maxEnd = Math.min(maxEnd, clip.start + (a.duration - clip.in) / clip.speed);
      }
    }
    minStart = Math.ceil(minStart * fps - 1e-6) / fps;
    if (Number.isFinite(maxEnd)) maxEnd = Math.floor(maxEnd * fps + 1e-6) / fps;
    return { minStart, maxEnd };
  }

  #dragTrim(d, p, e) {
    const c = this.store.getClip(d.clipId);
    if (!c) return;
    const fps = this.fps;
    const f = 1 / fps;
    const o = d.orig;
    let t = (p.x + this.scrollX) / this.zoom;
    this.snapLine = null;
    if (this.#snapOn(e)) {
      const s = this.#snapNear(t, this.snapPoints(new Set([c.id])));
      if (s != null) { t = s; this.snapLine = s; }
    }
    t = quantize(t, fps);
    if (d.edge === 'left') {
      const ns = clamp(t, d.bounds.minStart, o.start + o.duration - f);
      c.start = ns;
      c.duration = o.start + o.duration - ns;
      c.in = Math.max(0, o.in + (ns - o.start) * o.speed);
    } else {
      const ne = clamp(t, o.start + f, d.bounds.maxEnd);
      c.duration = ne - o.start;
    }
    this.store.touch();
  }

  #dragMarquee(d, p) {
    const cx = p.x + this.scrollX, cy = p.y + this.scrollY;
    if (!d.active && Math.hypot(cx - d.sx, cy - d.sy) < 4) return;
    d.active = true;
    d.cx = cx; d.cy = cy;
    const x0 = Math.min(d.sx, cx), x1 = Math.max(d.sx, cx), y0 = Math.min(d.sy, cy), y1 = Math.max(d.sy, cy);
    const hits = [];
    const tracks = this.store.project.tracks;
    for (const c of this.store.project.clips) {
      const ti = tracks.findIndex((t) => t.id === c.trackId);
      if (ti < 0 || tracks[ti].locked) continue;
      const cy0 = ti * TRACK_H + PAD, cy1 = cy0 + TRACK_H - PAD * 2;
      const cx0 = c.start * this.zoom, cx1 = clipEnd(c) * this.zoom;
      if (cx1 >= x0 && cx0 <= x1 && cy1 >= y0 && cy0 <= y1) hits.push(c.id);
    }
    this.store.select([...new Set([...(d.additive ? d.base : []), ...hits])]);
    this.dirtyOver = true;
  }

  #onUp(e) {
    const d = this.drag;
    this.drag = null;
    try { this.el.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.snapLine = null;
    if (!d) return;
    const { store } = this;
    const fps = this.fps;
    if (d.type === 'move') {
      if (d.moved) {
        const ids = new Set(d.origin.keys());
        for (const id of ids) {
          const c = store.getClip(id);
          if (c) overwriteRange(store.project, c.trackId, c.start, clipEnd(c), ids, fps);
        }
        store.commit(ids.size > 1 ? `Move ${ids.size} clips` : 'Move');
      } else if (d.collapse && store.selection.size > 1) {
        store.select([d.anchorId]);
      }
    } else if (d.type === 'trim') {
      const c = store.getClip(d.clipId);
      if (c && (c.start !== d.orig.start || c.duration !== d.orig.duration)) store.commit('Trim');
    } else if (d.type === 'marquee' && !d.active) {
      if (!d.additive) store.clearSelection();
      this.playback.seek(quantize(Math.max(0, d.sx / this.zoom), fps));
    }
    this.dirtyBase = this.dirtyOver = true;
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    this.snapLine = null;
    if ((d.type === 'move' && d.moved) || d.type === 'trim') this.store.revert();
    this.dirtyBase = this.dirtyOver = true;
    return true;
  }

  #hover(p, e) {
    const { store } = this;
    const hit = this.hitTest(p.x, p.y);
    const canvas = this.el.canvas;
    this.razorHover = null;
    if (store.tool === 'razor') {
      canvas.style.cursor = '';
      if (hit.clip && !hit.track.locked) {
        let t = hit.time;
        if (this.#snapOn(e)) { const s = this.#snapNear(t, this.snapPoints(new Set([hit.clip.id]))); if (s != null) t = s; }
        this.razorHover = { t: quantize(t, this.fps), ti: hit.trackIndex };
      }
    } else {
      const phx = store.time * this.zoom - this.scrollX;
      let cursor = 'default';
      if (Math.abs(p.x - phx) <= 4 && !(hit.clip && hit.edge)) cursor = 'col-resize';
      else if (hit.clip) cursor = hit.track.locked ? 'not-allowed' : hit.edge ? 'ew-resize' : 'grab';
      canvas.style.cursor = cursor;
    }
    const nh = hit.clip ? { clipId: hit.clip.id, edge: hit.edge } : null;
    if (nh?.clipId !== this.hover?.clipId || nh?.edge !== this.hover?.edge) { this.hover = nh; this.dirtyBase = true; }
    this.dirtyOver = true;
  }

  #autoScroll(p) {
    const edge = 36;
    let dx = 0;
    if (p.x > this.w - edge) dx = (p.x - (this.w - edge)) * 0.5;
    else if (p.x < edge && this.scrollX > 0) dx = -(edge - p.x) * 0.5;
    if (dx) this.el.scroller.scrollLeft += dx;
  }

  #scrubTo(x) {
    const t = quantize(Math.max(0, (x + this.scrollX) / this.zoom), this.fps);
    this.playback.seek(t);
  }

  #ghostFor(payload, p) {
    const tracks = this.store.project.tracks;
    const kind = trackKindFor(payload.kind);
    let ti = Math.floor((p.y + this.scrollY) / TRACK_H);
    let tr = tracks[ti];
    if (!tr || tr.kind !== kind || tr.locked) {
      let bestI = -1, bestD = Infinity;
      tracks.forEach((t, i) => { if (t.kind === kind && !t.locked && Math.abs(i - ti) < bestD) { bestD = Math.abs(i - ti); bestI = i; } });
      ti = bestI;
      tr = tracks[ti];
    }
    if (!tr) return null;
    const dur = payload.duration;
    let start = Math.max(0, (p.x + this.scrollX) / this.zoom);
    if (this.store.snap) {
      const pts = this.snapPoints(new Set());
      const thr = SNAP_PX / this.zoom;
      let best = null;
      for (const edge of [start, start + dur]) for (const pt of pts) { const diff = pt - edge; if (Math.abs(diff) < thr && (best == null || Math.abs(diff) < Math.abs(best))) best = diff; }
      if (best != null) start += best;
    }
    return { trackId: tr.id, ti, start: quantize(Math.max(0, start), this.fps), duration: dur };
  }

  // ---------- drawing ----------
  #ticks() {
    const zoom = this.zoom, fps = this.fps;
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const major = steps.find((s) => s * zoom >= 96) ?? 3600;
    let minor = 0;
    if (major < 1 && zoom / fps >= 5) minor = 1 / fps;
    else {
      const subs = major >= 60 ? [6, 4, 2] : major >= 1 ? [5, 4, 2] : [5, 2];
      for (const s of subs) if ((major / s) * zoom >= 7) { minor = major / s; break; }
    }
    return { major, minor };
  }

  #snipGap(s, now) {
    if (reducedMotion()) return 0;
    const p = (now - s.at) / SNIP_MS;
    if (p >= 1) return 0;
    return p < 0.18 ? 3 * easeOutExpo(p / 0.18) : 3 * (1 - easeOutExpo((p - 0.18) / 0.82));
  }

  drawBase() {
    const { ctx, w, h, dpr, c, store } = this;
    const project = store.project;
    const zoom = this.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, w, h);
    const tracks = project.tracks;
    tracks.forEach((tr, i) => {
      const y = i * TRACK_H - this.scrollY;
      if (y > h || y + TRACK_H < 0) return;
      ctx.fillStyle = i % 2 ? c.laneAlt : c.lane;
      ctx.fillRect(0, y, w, TRACK_H);
      if (tr.locked) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, y, w, TRACK_H); ctx.clip();
        ctx.strokeStyle = 'rgba(236,231,220,0.035)';
        ctx.lineWidth = 6;
        for (let x = -TRACK_H; x < w + TRACK_H; x += 16) { ctx.beginPath(); ctx.moveTo(x, y + TRACK_H); ctx.lineTo(x + TRACK_H, y); ctx.stroke(); }
        ctx.restore();
      }
      ctx.fillStyle = c.border;
      ctx.fillRect(0, y + TRACK_H - 1, w, 1);
    });
    const { major } = this.#ticks();
    const t0 = this.scrollX / zoom, t1 = (this.scrollX + w) / zoom;
    ctx.fillStyle = c.grid;
    for (let i = Math.floor(t0 / major); i * major <= t1; i++) ctx.fillRect(Math.round(i * major * zoom - this.scrollX), 0, 1, h);
    const endX = Math.round(store.duration * zoom - this.scrollX);
    if (store.duration > 0 && endX > 0 && endX < w) {
      ctx.fillStyle = 'rgba(236,231,220,0.12)';
      ctx.fillRect(endX, 0, 1, Math.min(h, tracks.length * TRACK_H - this.scrollY));
    }

    const now = performance.now();
    const tIndex = new Map(tracks.map((t, i) => [t.id, i]));
    const ordered = project.clips.slice().sort((a, b) => (store.selection.has(a.id) ? 1 : 0) - (store.selection.has(b.id) ? 1 : 0));
    for (const clip of ordered) {
      const ti = tIndex.get(clip.trackId);
      if (ti == null) continue;
      let x = clip.start * zoom - this.scrollX;
      const cw = Math.max(2, clip.duration * zoom);
      if (x > w + 4 || x + cw < -4) continue;
      const y = ti * TRACK_H - this.scrollY + PAD;
      const ch = TRACK_H - PAD * 2;
      if (y > h || y + ch < 0) continue;
      for (const s of this.snips) {
        if (s.trackId !== clip.trackId) continue;
        const gap = this.#snipGap(s, now);
        if (Math.abs(clip.start - s.t) < 1e-6) x += gap;
        else if (Math.abs(clipEnd(clip) - s.t) < 1e-6) x -= gap;
      }
      this.#drawClip(ctx, clip, x, y, cw, ch, tracks[ti]);
    }
    for (const s of this.snips) {
      const p = (now - s.at) / SNIP_MS;
      if (p >= 1) continue;
      const ti = tIndex.get(s.trackId);
      if (ti == null) continue;
      const x = s.t * zoom - this.scrollX;
      const y = ti * TRACK_H - this.scrollY + PAD;
      ctx.globalAlpha = 1 - easeOutExpo(p);
      ctx.fillStyle = c.accent;
      ctx.fillRect(x - 1, y - 3, 2, TRACK_H - PAD * 2 + 6);
      ctx.globalAlpha = 1;
    }
  }

  #palette(kind) {
    const c = this.c;
    if (kind === 'audio') return { fill: c.ochre, band: null, label: c.ink, wave: c.ochreDeep };
    if (kind === 'text' || kind === 'sticker') return { fill: c.bone, band: null, label: c.ink, wave: c.boneDeep };
    return { fill: c.slate, band: c.slateDeep, label: c.bone, wave: 'rgba(236,231,220,0.75)' };
  }

  #drawClip(ctx, clip, x, y, w, h, track) {
    const { c, store } = this;
    const pal = this.#palette(clip.kind);
    const asset = this.assets.get(clip.assetId);
    const selected = store.selection.has(clip.id);
    ctx.save();
    roundRectPath(ctx, x + 0.5, y, Math.max(1, w - 1), h, 3);
    ctx.fillStyle = pal.fill;
    ctx.fill();
    ctx.clip();
    const bodyY = y + LABEL_H, bodyH = h - LABEL_H;
    if ((clip.kind === 'video' || clip.kind === 'image') && asset) {
      this.#drawThumbs(ctx, clip, asset, x, bodyY, w, bodyH);
      if (clip.kind === 'video' && asset.peaks) {
        const bandH = 13;
        ctx.fillStyle = 'rgba(20,19,17,0.55)';
        ctx.fillRect(x, y + h - bandH, w, bandH);
        this.#drawWave(ctx, clip, asset.peaks, x, y + h - bandH, w, bandH, pal.wave);
      }
    } else if (clip.kind === 'audio' && asset?.peaks) {
      this.#drawWave(ctx, clip, asset.peaks, x, bodyY, w, bodyH, pal.wave);
    } else if (clip.kind === 'text') {
      ctx.fillStyle = 'rgba(28,27,25,0.7)';
      ctx.font = `600 12px ${c.ui}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(String(clip.text.content).split('\n')[0], Math.max(x, 0) + 6, bodyY + bodyH / 2);
    } else if (clip.kind === 'sticker') {
      const s = Math.min(bodyH - 6, 30);
      ctx.save();
      ctx.translate(Math.max(x, 0) + 6 + s / 2, bodyY + bodyH / 2);
      drawSticker(ctx, clip.sticker, s, s);
      ctx.restore();
    }
    if (clip.fadeIn > 0 || clip.fadeOut > 0) {
      ctx.strokeStyle = 'rgba(20,19,17,0.75)';
      ctx.fillStyle = 'rgba(20,19,17,0.22)';
      ctx.lineWidth = 1.25;
      if (clip.fadeIn > 0) {
        const fx = Math.min(w, clip.fadeIn * this.zoom);
        ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + fx, bodyY); ctx.lineTo(x, bodyY); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + fx, bodyY); ctx.stroke();
      }
      if (clip.fadeOut > 0) {
        const fx = Math.min(w, clip.fadeOut * this.zoom);
        ctx.beginPath(); ctx.moveTo(x + w, y + h); ctx.lineTo(x + w - fx, bodyY); ctx.lineTo(x + w, bodyY); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x + w, y + h); ctx.lineTo(x + w - fx, bodyY); ctx.stroke();
      }
    }
    if (pal.band) { ctx.fillStyle = pal.band; ctx.fillRect(x, y, w, LABEL_H); }
    if (isVisual(clip)) {
      // Entrance / exit ramps in the label band, each exactly as long as its own duration.
      const { intro, outro } = effectiveAnimDurations(clip);
      const onDark = pal.label === c.bone;
      ctx.fillStyle = onDark ? 'rgba(236,231,220,0.26)' : 'rgba(28,27,25,0.2)';
      ctx.strokeStyle = onDark ? 'rgba(236,231,220,0.7)' : 'rgba(28,27,25,0.55)';
      ctx.lineWidth = 1;
      if (intro > 0) {
        const iw = Math.min(w, intro * this.zoom);
        ctx.beginPath(); ctx.moveTo(x, y + LABEL_H); ctx.lineTo(x + iw, y); ctx.lineTo(x + iw, y + LABEL_H); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, y + LABEL_H); ctx.lineTo(x + iw, y); ctx.stroke();
      }
      if (outro > 0) {
        const ow = Math.min(w, outro * this.zoom);
        ctx.beginPath(); ctx.moveTo(x + w - ow, y); ctx.lineTo(x + w, y + LABEL_H); ctx.lineTo(x + w - ow, y + LABEL_H); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x + w - ow, y); ctx.lineTo(x + w, y + LABEL_H); ctx.stroke();
      }
    }
    const lx = Math.max(x, 0) + 6;
    ctx.font = `600 11px ${c.ui}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = pal.label;
    const name = clip.kind === 'text' ? String(clip.text.content).split('\n')[0] || 'Text' : clip.name || clip.kind;
    let badges = '';
    if (clip.speed !== 1) badges += ` ${clip.speed}×`;
    const fx = clip.fx;
    if (fx && (fx.lut !== 'none' || fx.brightness || fx.contrast || fx.saturation || fx.blur || fx.sepia || fx.vignette) && (clip.kind === 'video' || clip.kind === 'image')) badges += ' · fx';
    if (w > 28) ctx.fillText(name + badges, lx, y + LABEL_H / 2 + 0.5);
    if (track.hidden || track.muted) {
      if ((track.hidden && clip.kind !== 'audio') || (track.muted && (clip.kind === 'audio' || clip.kind === 'video'))) {
        ctx.fillStyle = 'rgba(20,19,17,0.5)';
        ctx.fillRect(x, y, w, h);
      }
    }
    if (this.hover?.clipId === clip.id && this.hover.edge && store.tool === 'select') {
      ctx.fillStyle = c.focus;
      ctx.fillRect(this.hover.edge === 'left' ? x : x + w - 3, y, 3, h);
    }
    ctx.restore();
    if (selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = c.focus;
      roundRectPath(ctx, x - 1, y - 1, w + 2, h + 2, 4);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(20,19,17,0.85)';
      roundRectPath(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 3);
      ctx.stroke();
    }
  }

  #drawThumbs(ctx, clip, asset, x, y, w, h) {
    const thumbs = asset.thumbs;
    if (!thumbs?.length) {
      ctx.fillStyle = 'rgba(20,19,17,0.25)';
      for (let sx = x - h; sx < x + w; sx += 12) { ctx.beginPath(); ctx.moveTo(sx, y + h); ctx.lineTo(sx + 6, y + h); ctx.lineTo(sx + 6 + h, y); ctx.lineTo(sx + h, y); ctx.fill(); }
      return;
    }
    const ar = (asset.width || 16) / (asset.height || 9);
    const tw = Math.max(8, h * ar);
    const startI = Math.max(0, Math.floor(-x / tw));
    const endX = Math.min(x + w, this.w);
    for (let i = startI, px = x + startI * tw; px < endX; i++, px += tw) {
      let th = thumbs[0];
      if (thumbs.length > 1) {
        const srcT = clip.in + ((px - x + tw / 2) / this.zoom) * clip.speed;
        let lo = 0, hi = thumbs.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (thumbs[mid].t < srcT) lo = mid + 1; else hi = mid; }
        th = lo > 0 && Math.abs(thumbs[lo - 1].t - srcT) < Math.abs(thumbs[lo].t - srcT) ? thumbs[lo - 1] : thumbs[lo];
      }
      try { ctx.drawImage(th.bmp, px, y, tw, h); } catch { /* bitmap closed */ }
    }
  }

  #drawWave(ctx, clip, peaks, x, y, w, h, color) {
    const { data, perSec } = peaks;
    const mid = y + h / 2;
    const x0 = Math.max(Math.floor(x), 0), x1 = Math.min(x + w, this.w);
    const vol = clip.volume ?? 1;
    const fi = clip.fadeIn || 0, fo = clip.fadeOut || 0, D = clip.duration;
    ctx.fillStyle = color;
    for (let px = x0; px < x1; px++) {
      const lt = (px - x) / this.zoom;
      const ta = clip.in + lt * clip.speed;
      const tb = clip.in + ((px + 1 - x) / this.zoom) * clip.speed;
      const ia = Math.floor(ta * perSec);
      if (ia >= data.length) break;
      const ib = Math.min(data.length, Math.max(ia + 1, Math.ceil(tb * perSec)));
      let m = 0;
      for (let i = Math.max(0, ia); i < ib; i++) if (data[i] > m) m = data[i];
      const env = Math.min(1, fi > 0 ? lt / fi : 1, fo > 0 ? (D - lt) / fo : 1);
      const a = Math.min(1, m * vol * Math.max(0, env)) * (h / 2 - 1);
      ctx.fillRect(px, mid - a, 1, Math.max(1, a * 2));
    }
  }

  drawOverlay() {
    const { octx: ctx, w, h, dpr, c, store } = this;
    const zoom = this.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.dropGhost) {
      const g = this.dropGhost;
      const x = g.start * zoom - this.scrollX, cw = Math.max(4, g.duration * zoom), y = g.ti * TRACK_H - this.scrollY + PAD;
      roundRectPath(ctx, x, y, cw, TRACK_H - PAD * 2, 3);
      ctx.fillStyle = 'rgba(230,224,210,0.14)';
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = c.bone;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const d = this.drag;
    if (d?.type === 'marquee' && d.active) {
      const x0 = Math.min(d.sx, d.cx) - this.scrollX, y0 = Math.min(d.sy, d.cy) - this.scrollY;
      const mw = Math.abs(d.cx - d.sx), mh = Math.abs(d.cy - d.sy);
      ctx.fillStyle = 'rgba(230,224,210,0.07)';
      ctx.fillRect(x0, y0, mw, mh);
      ctx.strokeStyle = 'rgba(230,224,210,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, mw, mh);
    }
    if (this.snapLine != null) {
      const x = Math.round(this.snapLine * zoom - this.scrollX) + 0.5;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = c.bone;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (store.tool === 'razor' && this.razorHover) {
      const r = this.razorHover;
      const x = r.t * zoom - this.scrollX;
      const y = r.ti * TRACK_H - this.scrollY + PAD - 3;
      ctx.fillStyle = c.accent;
      ctx.fillRect(x - 0.75, y, 1.5, TRACK_H - PAD * 2 + 6);
    }
    const px = Math.round(store.time * zoom - this.scrollX);
    if (px >= -2 && px <= w + 2) {
      ctx.fillStyle = c.accent;
      ctx.fillRect(px - 1, 0, 2, h);
    }
  }

  drawRuler() {
    const { rctx: ctx, rw: w, dpr, c, store } = this;
    const H = 30;
    const zoom = this.zoom, fps = this.fps;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, w, H);
    const { major, minor } = this.#ticks();
    const t0 = this.scrollX / zoom, t1 = (this.scrollX + w) / zoom;
    ctx.fillStyle = c.faint;
    if (minor) for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) ctx.fillRect(Math.round(i * minor * zoom - this.scrollX), H - 5, 1, 5);
    ctx.font = `10.5px ${c.mono}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let i = Math.floor(t0 / major); i * major <= t1 + major; i++) {
      const t = i * major;
      const x = Math.round(t * zoom - this.scrollX);
      ctx.fillStyle = c.faint;
      ctx.fillRect(x, H - 11, 1, 11);
      ctx.fillStyle = c.muted;
      ctx.fillText(formatTC(t, fps), x + 4, 6);
    }
    const px = store.time * zoom - this.scrollX;
    if (px > -10 && px < w + 10) {
      // the playhead: a red paper flag with a notched point
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(px - 6, 11); ctx.lineTo(px + 6, 11); ctx.lineTo(px + 6, 21); ctx.lineTo(px, 29); ctx.lineTo(px - 6, 21);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(20,19,17,0.55)';
      ctx.beginPath(); ctx.moveTo(px - 6, 11); ctx.lineTo(px - 2, 11); ctx.lineTo(px - 6, 15); ctx.closePath(); ctx.fill();
    }
  }

  frame() {
    const { store } = this;
    const now = performance.now();
    if (this.snips.length) {
      const before = this.snips.length;
      this.snips = this.snips.filter((s) => now - s.at < SNIP_MS);
      this.dirtyBase = true;
      if (!this.snips.length && before) this.dirtyBase = true;
    }
    if (store.playing) {
      const x = store.time * this.zoom - this.scrollX;
      if (x > this.w - 24 || x < 0) this.el.scroller.scrollLeft = Math.max(0, store.time * this.zoom - this.w * 0.15);
      this.dirtyOver = true;
    }
    if (this.dirtyBase) { this.drawBase(); this.dirtyBase = false; this.dirtyOver = true; }
    if (this.dirtyOver) { this.drawOverlay(); this.drawRuler(); this.dirtyOver = false; }
    const tc = formatTC(store.time, this.fps);
    if (tc !== this.lastTc) { this.el.tc.textContent = tc; this.lastTc = tc; }
  }
}
