// Transport + video sync. The AudioContext clock is the master: audio is scheduled sample-accurately,
// video elements chase it. Drift above 30 ms is corrected by nudging playbackRate (±15%); above 250 ms
// we hard-seek. While paused, seeks are coalesced so scrubbing never queues a backlog of decodes.
import { clamp } from '../util.js';
import { tailDuration } from '../core/ops.js';

const LEAD = 0.05;          // seconds of headroom when scheduling audio
const NUDGE_AT = 0.03;      // start correcting drift
const RESEEK_AT = 0.25;     // give up nudging, seek

export class Playback {
  constructor({ store, assets, audio, glfx, pool, onDirty }) {
    this.store = store;
    this.assets = assets;
    this.audio = audio;
    this.glfx = glfx;
    this.pool = pool;
    this.onDirty = onDirty || (() => {});
    this.videos = new Map();
    this.playing = false;
    this.exporting = false;
    this.useAudioClock = false;
    this.anchorT = 0;
    this.anchorClock = 0;
    this.drift = 0;
    this.suspended = false; // true while the frame-accurate exporter drives the videos
    this.onRelease = null;  // GPU texture cleanup hook (set by main)
    this.gpu = null;        // compositor, for smooth-motion frame pairs during export (set by main)
  }

  /**
   * Smooth motion applies when the clip asks for it and its source frame rate is below the sequence
   * rate (e.g. 24 fps footage in a 30 or 60 fps sequence). Returns the source frame rate or 0.
   */
  smoothFps(clip) {
    if (!clip?.smooth || clip.kind !== 'video') return 0;
    const fps = this.assets.get(clip.assetId)?.fps;
    return fps && fps < this.store.project.fps - 0.5 ? fps : 0;
  }

  smoothActive(clip) { return this.smoothFps(clip) > 0; }

  /** Seconds the clip stays on screen after its end because the next clip transitions out of it. */
  #tail(project, c, t) {
    const end = c.start + c.duration;
    return t >= end - 0.001 && t < end + 5 ? tailDuration(project, c) : 0;
  }

  clockNow() { return this.useAudioClock ? this.audio.ctx.currentTime : performance.now() / 1000; }
  latency() { return this.useAudioClock && !this.exporting ? Math.min(0.3, this.audio.latency) : 0; }

  async play({ exporting = false } = {}) {
    if (this.playing) return;
    const dur = this.store.duration;
    if (dur <= 0) return;
    if (this.store.time >= dur - 1 / this.store.fps) this.store.setTime(0);
    this.exporting = exporting;
    await this.audio.resume();
    this.useAudioClock = this.audio.running;
    this.playing = true;
    this.store.playing = true;
    this.anchor(this.store.time);
    this.store.emit('playstate', true);
  }

  anchor(t) {
    this.anchorT = t;
    this.anchorClock = this.clockNow() + (this.useAudioClock ? LEAD : 0);
    if (this.useAudioClock) this.audio.scheduleFrom(this.store.project, this.assets, t, this.anchorClock);
  }

  pause(at) {
    if (!this.playing) return;
    const t = at ?? this.currentTime();
    this.playing = false;
    this.store.playing = false;
    this.exporting = false;
    this.audio.stopAll();
    for (const v of this.videos.values()) if (!v.paused) v.pause();
    const fps = this.store.fps;
    this.store.setTime(Math.round(t * fps) / fps); // park on a frame boundary so edits stay frame-accurate
    this.store.emit('playstate', false);
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  currentTime() {
    if (!this.playing) return this.store.time;
    const elapsed = this.clockNow() - this.anchorClock - this.latency();
    return this.anchorT + Math.max(0, elapsed);
  }

  seek(t) {
    // The playhead may sit past the last clip so new titles or media can be placed there.
    t = clamp(t, 0, this.store.duration + 3600);
    this.store.setTime(t);
    if (this.playing) this.anchor(t);
  }

  /** Re-time audio after an edit made during playback. */
  reschedule() {
    if (this.playing && this.useAudioClock) this.anchor(this.currentTime());
  }

  update() {
    if (this.playing) {
      const t = this.currentTime();
      const d = this.store.duration;
      if (t >= d) {
        if (this.store.ui.loop && !this.exporting && d > 0) {
          this.seek(0);
        } else {
          const wasExport = this.exporting;
          this.pause(d);
          this.store.emit('ended', { exporting: wasExport });
          this.sync(this.store.time);
          return;
        }
      } else {
        this.store.setTime(t);
      }
    }
    this.sync(this.store.time);
  }

  sync(t) {
    const { project } = this.store;
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]));
    const live = new Set();
    let maxDrift = 0;
    const lookahead = this.playing ? 2 : 0.75;
    for (const c of project.clips) {
      if (c.kind !== 'video') continue;
      live.add(c.id);
      const tr = tracks.get(c.trackId);
      const asset = this.assets.get(c.assetId);
      if (!tr || !asset || asset.status !== 'ready') continue;
      const end = c.start + c.duration + this.#tail(project, c, t);
      const active = !tr.hidden && t >= c.start && t < end;
      const upcoming = !tr.hidden && !active && c.start >= t && c.start - t <= lookahead;
      if (active) {
        const v = this.#ensure(c, asset);
        const d = this.#syncActive(v, c, t, tr);
        if (d > maxDrift) maxDrift = d;
      } else if (upcoming) {
        const v = this.#ensure(c, asset);
        if (!v.paused) v.pause();
        this.#requestSeek(v, c.in);
      } else {
        const v = this.videos.get(c.id);
        if (v) {
          if (!v.paused) v.pause();
          const dist = Math.min(Math.abs(t - c.start), Math.abs(t - end));
          if (dist > 20) this.release(c.id);
        }
      }
    }
    for (const id of [...this.videos.keys()]) if (!live.has(id)) this.release(id);
    this.drift = this.playing ? maxDrift : 0;
  }

  #syncActive(v, c, t, tr) {
    const sf = this.playing ? this.smoothFps(c) : 0;
    const expected = c.in + (t - c.start) * c.speed + (sf ? 1 / sf : 0);
    const target = Math.min(expected, (Number.isFinite(v.duration) ? v.duration : Infinity) - 0.001);
    const elementAudio = this.audio.elementNodes.has(c.id);
    if (elementAudio) this.audio.setElementGain(c.id, tr.muted ? 0 : c.volume ?? 1);
    if (this.playing) {
      if (v.readyState < 1) return 0;
      if (v.paused) {
        // Hold the picture until the audio clock actually starts (scheduling lead + output latency).
        if (this.clockNow() - this.anchorClock - this.latency() < 0) { this.#requestSeek(v, target); return 0; }
        if (Math.abs(v.currentTime - target) > 0.05) v.currentTime = target;
        v.playbackRate = c.speed;
        const p = v.play();
        if (p) p.catch(() => {});
        return 0;
      }
      const drift = v.currentTime - target; // + means the picture is ahead of the clock
      const ad = Math.abs(drift);
      if (ad > RESEEK_AT) {
        v.currentTime = target;
        v.playbackRate = c.speed;
      } else if (ad > NUDGE_AT) {
        v.playbackRate = clamp(c.speed * (1 - drift * 2), c.speed * 0.85, c.speed * 1.15);
      } else if (v.playbackRate !== c.speed) {
        v.playbackRate = c.speed;
      }
      return ad * 1000;
    }
    if (!v.paused) v.pause();
    this.#requestSeek(v, target);
    return 0;
  }

  #requestSeek(v, target) {
    const st = v._cr;
    if (st.seeking && performance.now() - st.since > 1500) st.seeking = false; // stuck seek
    if (st.seeking) { st.pending = target; return; }
    const tol = 0.25 / this.store.fps;
    if (Math.abs(v.currentTime - target) < tol && v.readyState >= 2) return;
    if (v.readyState < 1) { st.pending = target; return; }
    st.seeking = true;
    st.pending = null;
    st.since = performance.now();
    try { v.currentTime = target; } catch { st.seeking = false; }
  }

  #ensure(c, asset) {
    let v = this.videos.get(c.id);
    if (v && v._cr.assetId === asset.id) return v;
    if (v) this.release(c.id);
    v = document.createElement('video');
    const elementAudio = asset.audioMode === 'element';
    v.muted = !elementAudio;
    v.playsInline = true;
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    // frameSerial ticks whenever the element has a new picture, so the compositor uploads a texture
    // only for frames that changed (requestVideoFrameCallback), not on every display refresh.
    v._cr = { assetId: asset.id, seeking: false, pending: null, since: 0, frameSerial: 0, lastFrameAt: 0, rvfcOk: typeof v.requestVideoFrameCallback === 'function' };
    if (v._cr.rvfcOk) {
      const onFrame = (_now, meta) => {
        const st = v._cr;
        st.frameSerial++;
        st.lastFrameAt = performance.now();
        st.mediaTime = meta?.mediaTime;
        this.onDirty();
        if (this.videos.get(c.id) === v) v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    }
    v.addEventListener('seeked', () => {
      const st = v._cr;
      st.seeking = false;
      st.frameSerial++;
      this.onDirty();
      if (st.pending != null) { const p = st.pending; st.pending = null; this.#requestSeek(v, p); }
    });
    v.addEventListener('loadedmetadata', () => {
      const st = v._cr;
      if (st.pending != null) { const p = st.pending; st.pending = null; this.#requestSeek(v, p); }
    });
    v.addEventListener('loadeddata', () => { v._cr.frameSerial++; this.onDirty(); });
    v.src = asset.url;
    this.pool?.append(v);
    if (elementAudio) this.audio.attachElement(c.id, v);
    this.videos.set(c.id, v);
    return v;
  }

  videoFor(clipId) { return this.videos.get(clipId) || null; }

  release(id) {
    const v = this.videos.get(id);
    if (!v) return;
    v.pause();
    this.audio.detachElement(id);
    v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    v.remove();
    this.videos.delete(id);
    this.glfx?.deleteTex(id);
    this.onRelease?.(id);
  }

  releaseAll() { for (const id of [...this.videos.keys()]) this.release(id); }

  /**
   * Frame-accurate positioning for offline export: every video visible at t is paused and seeked to the
   * exact source time, and we wait for its decoded frame. Event-driven (no timers), so it keeps working
   * in a background tab. Resolves to the number of videos that had to seek.
   */
  async exactFrame(t, fps) {
    const { project } = this.store;
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]));
    const waits = [];
    for (const c of project.clips) {
      if (c.kind !== 'video') continue;
      const tr = tracks.get(c.trackId);
      const asset = this.assets.get(c.assetId);
      if (!tr || tr.hidden || !asset || asset.status !== 'ready' || t < c.start || t >= c.start + c.duration + this.#tail(project, c, t)) continue;
      const v = this.#ensure(c, asset);
      if (!v.paused) v.pause();
      const end = (Number.isFinite(v.duration) ? v.duration : Infinity) - 0.001;
      const src = c.in + (t - c.start) * c.speed;
      const sf = this.smoothFps(c);
      if (sf && this.gpu) {
        // Smooth motion: hold the two source frames around this output time; the compositor blends them.
        const k = Math.floor(src * sf + 1e-6);
        const tPrev = k / sf, tCur = (k + 1) / sf;
        if ((src - tPrev) * sf > 0.01 && tCur < end) { waits.push(this.#seekPair(c, v, tPrev, tCur, sf)); continue; }
        v._cr.frameTime = tPrev;
        waits.push(this.#seekExact(v, Math.min(tPrev + 0.25 / sf, end), sf));
        continue;
      }
      v._cr.frameTime = null;
      // Aim slightly inside the frame so float error never lands on the previous frame's boundary.
      waits.push(this.#seekExact(v, Math.min(src + 0.25 / fps, end), fps));
    }
    const n = (await Promise.all(waits)).filter(Boolean).length;
    // Drop decoders for clips that are behind us so long exports do not pile up video elements.
    for (const c of project.clips) if (c.kind === 'video' && c.start + c.duration < t - 6) this.release(c.id);
    return n;
  }

  /** Export: make the compositor hold frame tPrev as "previous" and leave the element on frame tCur. */
  async #seekPair(c, v, tPrev, tCur, sf) {
    const near = (a, b) => a != null && Math.abs(a - b) < 0.25 / sf;
    const pair = this.gpu.framePair(c);
    if (near(pair.prev, tPrev) && near(pair.cur, tCur)) return false; // already held
    if (near(pair.cur, tPrev)) this.gpu.promoteFrame(c); // stepped forward by one source frame
    else {
      await this.#seekExact(v, tPrev + 0.25 / sf, sf);
      this.gpu.captureFrame(c, tPrev);
    }
    v._cr.frameTime = tCur;
    await this.#seekExact(v, tCur + 0.25 / sf, sf);
    return true;
  }

  #seekExact(v, target, fps) {
    return new Promise((resolve) => {
      const st = v._cr;
      st.seeking = false;
      st.pending = null;
      const done = (seeked) => { cleanup(); resolve(seeked); };
      let timer = 0;
      const onSeeked = () => { if (v.readyState >= 2) done(true); else v.addEventListener('canplay', onCan, { once: true }); };
      const onCan = () => done(true);
      const onMeta = () => start();
      const cleanup = () => {
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('canplay', onCan);
      };
      const start = () => {
        if (Math.abs(v.currentTime - target) < 0.2 / fps && v.readyState >= 2) { done(false); return; }
        v.addEventListener('seeked', onSeeked);
        v.currentTime = target;
      };
      timer = setTimeout(() => done(false), 8000); // a broken file must not hang the export
      if (v.readyState < 1) v.addEventListener('loadedmetadata', onMeta, { once: true });
      else start();
    });
  }

  /** Wait until every video visible at t has a decoded frame (used before export starts). */
  async prepareAt(t, timeoutMs = 5000) {
    this.sync(t);
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      let ready = true;
      for (const c of this.store.project.clips) {
        if (c.kind !== 'video' || t < c.start || t >= c.start + c.duration) continue;
        const v = this.videos.get(c.id);
        if (!v || v._cr.seeking || v.readyState < 2) { ready = false; break; }
      }
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 40));
      this.sync(t);
    }
    return false;
  }
}
