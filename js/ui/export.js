// Client-side export. Nothing is uploaded; the file is saved through a local Blob URL.
//
// Two engines:
//  • Frame-accurate (WebCodecs, default where available): every frame is rendered offline at the export
//    resolution, with each video seeked to the exact source frame, then encoded with VideoEncoder
//    (H.264 High, variable bitrate tuned for quality). Audio is mixed offline at 48 kHz and encoded with
//    AudioEncoder; both are muxed into MP4. No dropped or duplicated frames, no real-time pressure, and the
//    tab may be in the background.
//  • Real-time (MediaRecorder fallback): canvas.captureStream + the live Web Audio mix, recorded while the
//    sequence plays.
import { formatBytes, formatDuration, formatTC, sanitizeFilename, once, sleep } from '../util.js';
import { FPS_OPTIONS } from '../core/store.js';
import { toast } from './dom.js';

const $ = (id) => document.getElementById(id);
const FORMATS = [
  { mime: 'video/mp4;codecs=avc1.640033,mp4a.40.2', label: 'MP4 · H.264 + AAC', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1,mp4a.40.2', label: 'MP4 · H.264 + AAC', ext: 'mp4' },
  { mime: 'video/mp4', label: 'MP4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', label: 'WebM · VP9 + Opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', label: 'WebM · VP8 + Opus', ext: 'webm' },
  { mime: 'video/webm', label: 'WebM', ext: 'webm' },
];
const RESOLUTIONS = [480, 720, 1080, 1440, 2160];
// Bits per pixel at 30 fps; higher rates scale by (fps/30)^0.75 because consecutive frames share more detail.
// 1080p30: Draft ~7.5, Standard ~20.5, High ~31, Master ~81 Mbps (Master is near-lossless, for re-uploading
// or re-editing without another generation of visible loss).
const BPP = { draft: 0.12, standard: 0.33, high: 0.5, master: 1.3 };
/** Sharpening applied to the final frame when the export is larger than every source clip. */
const UPSCALE_SHARPEN = 0.3;
const AUDIO_RATE = 48000;
// H.264 levels: [level hex, max macroblocks per frame, max macroblocks per second, max High-profile bitrate]
const AVC_LEVELS = [
  ['28', 8192, 245760, 25e6], ['2A', 8704, 522240, 62.5e6], ['32', 22080, 589824, 168.75e6],
  ['33', 36864, 983040, 300e6], ['34', 36864, 2073600, 300e6], ['3C', 139264, 4177920, 300e6],
];

export function supportedFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  const seen = new Set();
  const out = [];
  for (const f of FORMATS) {
    let ok = false;
    try { ok = MediaRecorder.isTypeSupported(f.mime); } catch { ok = false; }
    if (ok && !seen.has(f.label)) { seen.add(f.label); out.push(f); }
  }
  return out;
}

const hasWebCodecs = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

/** Smallest H.264 High level that fits the size, frame rate and bitrate and that this browser can encode. */
async function pickVideoCodec(w, h, fps, bitrate) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const candidates = AVC_LEVELS.filter(([, fs, mbps, br]) => mbs <= fs && mbs * fps <= mbps && bitrate <= br).map(([lv]) => `avc1.6400${lv}`);
  for (const codec of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } });
      if (supported) return codec;
    } catch { /* try the next level */ }
  }
  return null;
}

async function pickAudioCodec() {
  if (typeof AudioEncoder !== 'function') return null;
  for (const [codec, mux, bitrate] of [['mp4a.40.2', 'aac', 192000], ['mp4a.40.2', 'aac', 128000], ['opus', 'opus', 192000]]) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported({ codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate });
      if (supported) return { codec, mux, bitrate };
    } catch { /* next */ }
  }
  return null;
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
function dimsFor([bw, bh], shortSide) {
  const s = shortSide / Math.min(bw, bh);
  return [even(bw * s), even(bh * s)];
}

export class ExportDialog {
  constructor({ store, assets, renderer, playback, audio, blobs, monitor, applyCanvasSize }) {
    Object.assign(this, { store, assets, renderer, playback, audio, blobs, monitor, applyCanvasSize });
    this.dlg = $('export-dialog');
    this.el = {
      preset: $('ex-preset'), engine: $('ex-engine'), res: $('ex-res'), fps: $('ex-fps'), format: $('ex-format'), quality: $('ex-quality'), monitor: $('ex-monitor'),
      monitorRow: $('ex-monitor-row'), summary: $('ex-summary'), note: $('ex-note'), settings: $('export-settings'), progress: $('export-progress'),
      bar: $('ex-bar'), pct: $('ex-pct'), eta: $('ex-eta'), phase: $('ex-phase'), result: $('ex-result'), cancel: $('ex-cancel'), start: $('ex-start'),
    };
    this.quality = 'standard';
    this.state = 'idle'; // idle | running | done
    this.resultUrl = null;
    this.dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    this.dlg.addEventListener('cancel', (e) => { if (this.state === 'running') e.preventDefault(); });
    this.dlg.addEventListener('close', () => this.#cleanupResult());
    for (const b of this.el.quality.querySelectorAll('button')) {
      b.addEventListener('click', () => { this.#setQuality(b.dataset.q); this.el.preset.value = 'custom'; this.#summary(); });
    }
    for (const k of ['res', 'fps', 'format']) this.el[k].addEventListener('change', () => { this.el.preset.value = 'custom'; this.#summary(); });
    this.el.preset.addEventListener('change', () => { this.#applyPreset(this.el.preset.value); this.#summary(); });
    this.el.engine.addEventListener('change', () => { this.#fillFormats(); this.#summary(); });
    this.el.start.addEventListener('click', () => {
      if (this.state === 'done') this.#download();
      else if (this.state === 'idle') this.start();
    });
    this.el.cancel.addEventListener('click', () => {
      if (this.state === 'running') this.abort = true;
      else this.close();
    });
  }

  #setQuality(q) {
    this.quality = q;
    this.el.quality.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.q === q)));
  }

  /** Presets fill in resolution and quality; editing any field afterwards switches back to Custom. */
  #applyPreset(p) {
    const native = this.#nativeShortSide();
    const seq = Math.min(...this.store.dims);
    if (p === 'standard') { this.el.res.value = String(Math.min(1080, RESOLUTIONS.reduce((a, r) => (r <= seq ? r : a), 1080))); this.#setQuality('standard'); }
    else if (p === 'youtube4k') { this.el.res.value = '2160'; this.#setQuality('high'); }
    else if (p === 'master') { this.el.res.value = String(Math.max(native, RESOLUTIONS.reduce((a, r) => (r <= seq ? r : a), 1080))); this.#setQuality('master'); }
    if (this.el.engine.value !== 'webcodecs' && [...this.el.engine.options].some((o) => o.value === 'webcodecs')) { this.el.engine.value = 'webcodecs'; this.#fillFormats(); }
  }

  /** Short side of the largest source picture on the timeline (video or image). */
  #largestSourceShort() {
    let best = 0;
    for (const c of this.store.project.clips) {
      const a = this.assets.get(c.assetId);
      if ((c.kind === 'video' || c.kind === 'image') && a?.width) best = Math.max(best, Math.min(a.width, a.height));
    }
    return best;
  }

  #usesStreamedAudio() {
    return this.store.project.clips.some((c) => this.assets.get(c.assetId)?.audioMode === 'element');
  }

  open() {
    if (this.store.exporting) return;
    if (!this.store.project.clips.length) { toast('Add something to the timeline before exporting.'); return; }
    this.recorderFormats = supportedFormats();
    const engines = [];
    if (hasWebCodecs()) engines.push(['webcodecs', 'Frame-accurate · WebCodecs (best quality)']);
    if (this.recorderFormats.length) engines.push(['realtime', 'Real-time · MediaRecorder']);
    if (!engines.length) { toast('This browser cannot encode video (no WebCodecs or MediaRecorder).', { kind: 'error' }); return; }
    this.el.engine.replaceChildren(...engines.map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }));
    this.el.engine.value = engines[0][0] === 'webcodecs' && this.#usesStreamedAudio() && engines.length > 1 ? 'realtime' : engines[0][0];
    const dims = this.store.dims;
    this.el.res.replaceChildren(...RESOLUTIONS.map((r) => {
      const [w, h] = dimsFor(dims, r);
      const o = document.createElement('option');
      o.value = String(r);
      o.textContent = `${w}×${h}${r === 1080 ? ' · Full HD' : r === 2160 ? ' · 4K' : ''}`;
      return o;
    }));
    this.el.res.value = String(this.#nativeShortSide());
    this.el.fps.replaceChildren(...FPS_OPTIONS.map((f) => { const o = document.createElement('option'); o.value = String(f); o.textContent = `${f} fps`; return o; }));
    this.el.fps.value = String(this.store.project.fps);
    this.#fillFormats();
    this.el.preset.value = 'custom';
    this.#setState('idle');
    this.#summary();
    this.dlg.showModal();
  }

  /** Default export size: the sequence size, raised to the largest source video's size (never upscaled past 4K). */
  #nativeShortSide() {
    let best = 1080;
    for (const c of this.store.project.clips) {
      const a = this.assets.get(c.assetId);
      if (c.kind === 'video' && a?.width) best = Math.max(best, Math.min(a.width, a.height));
    }
    return RESOLUTIONS.reduce((p, r) => (r <= best ? r : p), 1080);
  }

  #fillFormats() {
    const webcodecs = this.el.engine.value === 'webcodecs';
    const list = webcodecs ? [{ label: 'MP4 · H.264 High + AAC', ext: 'mp4' }] : this.recorderFormats;
    this.formats = list;
    this.el.format.replaceChildren(...list.map((f, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = f.label; return o; }));
    this.el.format.disabled = webcodecs;
    this.el.monitorRow.hidden = webcodecs;
    this.el.note.textContent = webcodecs
      ? 'Every frame is rendered at full resolution and encoded at a high bitrate. It can take longer or shorter than the video itself; you can switch tabs while it works. Nothing leaves this device.'
      : 'Real-time recording: the sequence plays while it is recorded, so keep this tab visible. Use it if frame-accurate export is unavailable.';
  }

  close() {
    if (this.state === 'running') return;
    this.dlg.close();
  }

  #opts() {
    const short = Number(this.el.res.value);
    const [w, h] = dimsFor(this.store.dims, short);
    const fps = Number(this.el.fps.value);
    const format = this.formats[Number(this.el.format.value)] || this.formats[0];
    const engine = this.el.engine.value;
    const cap = engine === 'webcodecs' ? 150e6 : 80e6;
    const vbps = Math.round(Math.min(cap, Math.max(2e6, w * h * 30 * (fps / 30) ** 0.75 * BPP[this.quality])));
    const src = this.#largestSourceShort();
    const upscale = src > 0 && Math.min(w, h) > src * 1.05 ? src : 0;
    return { engine, w, h, fps, format, vbps, abps: 256000, monitorAudio: this.el.monitor.checked, upscaleFrom: upscale, postSharpen: upscale && engine === 'webcodecs' ? UPSCALE_SHARPEN : 0 };
  }

  #summary() {
    const o = this.#opts();
    const dur = this.store.duration;
    const bytes = ((o.vbps + o.abps) * dur) / 8;
    const how = o.engine === 'webcodecs' ? 'frame-accurate' : `real time, ${formatDuration(dur)}`;
    const up = o.upscaleFrom ? ` · upscaled from ${o.upscaleFrom}p${o.postSharpen ? ' and sharpened' : ''}` : '';
    this.el.summary.textContent = `${o.w}×${o.h} · ${o.fps} fps · ${o.format.label} · up to ${(o.vbps / 1e6).toFixed(1)} Mbps · ≈ ${formatBytes(bytes)} · ${how}${up}`;
  }

  #setState(state) {
    this.state = state;
    const running = state === 'running';
    this.el.settings.hidden = running || state === 'done';
    this.el.progress.hidden = !(running || state === 'done');
    this.el.start.hidden = running;
    this.el.cancel.textContent = running ? 'Stop' : state === 'done' ? 'Close' : 'Cancel';
    this.el.start.lastElementChild.textContent = state === 'done' ? 'Download again' : 'Start export';
    if (state !== 'done') this.el.result.textContent = '';
    this.dlg.querySelectorAll('[data-close]').forEach((b) => { b.disabled = running; });
  }

  #progress(p, phase, eta) {
    this.el.bar.value = p;
    this.el.pct.textContent = `${Math.round(p * 100)}%`;
    if (phase) this.el.phase.textContent = phase;
    if (eta != null) this.el.eta.textContent = eta;
  }

  async start() {
    const o = this.#opts();
    if (this.store.duration <= 0) return;
    this.abort = false;
    this.#setState('running');
    this.#progress(0, 'Preparing', '');
    const startTime = this.store.time;
    let result = null;
    try {
      result = o.engine === 'webcodecs' ? await this.#runWebCodecs(o) : await this.#runRealtime(o);
    } catch (err) {
      console.error(err);
      this.#setState('idle');
      if (err?.message !== 'aborted') toast(`Export failed: ${err?.message || err}. Try the real-time engine or a lower resolution.`, { kind: 'error', timeout: 8000 });
      else toast('Export stopped. Nothing was saved.');
      return;
    } finally {
      this.playback.suspended = false;
      if (this.renderer.gpu) this.renderer.gpu.postSharpen = 0;
      this.renderer.editingId = null;
      this.store.exporting = false;
      this.store.emit('exporting', false);
      this.applyCanvasSize();
      this.playback.seek(startTime);
    }
    this.#finish(result.blob, result.ext, o, result.stats);
  }

  #enter(o) {
    this.playback.pause();
    this.store.exporting = true;
    this.store.emit('exporting', true);
    this.store.clearSelection();
    this.renderer.editingId = null;
    this.renderer.resize(o.w, o.h);
    if (this.renderer.gpu) this.renderer.gpu.postSharpen = o.postSharpen || 0;
    this.monitor.layout();
  }

  async #runWebCodecs(o) {
    const { store, renderer, playback, audio, assets } = this;
    const fps = o.fps;
    const dur = store.duration;
    const total = Math.max(1, Math.round(dur * fps));
    const vcodec = await pickVideoCodec(o.w, o.h, fps, o.vbps);
    if (!vcodec) throw new Error(`H.264 encoding at ${o.w}×${o.h} ${fps} fps is not supported here`);
    const acfg = await pickAudioCodec();
    const { Muxer, ArrayBufferTarget } = await import('../../vendor/mp4-muxer/5.2.2/mp4-muxer.mjs');
    this.#enter(o);
    playback.suspended = true;

    this.#progress(0, 'Mixing audio', '');
    const { buffer: mix, skipped } = await audio.renderMix(store.project, assets, dur, AUDIO_RATE);
    if (skipped) toast(`${skipped} very large clip${skipped > 1 ? 's' : ''} stream their audio and will be silent in this export. Use the real-time engine to include it.`, { kind: 'error', timeout: 8000 });

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: o.w, height: o.h, frameRate: fps },
      audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: AUDIO_RATE } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let encodeError = null;

    if (acfg) {
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encodeError = e; } });
      aenc.configure({ codec: acfg.codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: acfg.bitrate });
      const L = mix.getChannelData(0), R = mix.getChannelData(1);
      const block = AUDIO_RATE; // one second per AudioData
      for (let off = 0; off < mix.length; off += block) {
        const n = Math.min(block, mix.length - off);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(off, off + n), 0);
        data.set(R.subarray(off, off + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / AUDIO_RATE) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
    }

    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encodeError = e; } });
    venc.configure({ codec: vcodec, width: o.w, height: o.h, framerate: fps, bitrate: o.vbps, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } });
    const canDequeue = 'ondequeue' in VideoEncoder.prototype;
    const frameDur = Math.round(1e6 / fps);
    const t0 = performance.now();
    let seeks = 0;
    for (let i = 0; i < total; i++) {
      if (this.abort) { venc.close(); throw new Error('aborted'); }
      if (encodeError) throw encodeError;
      const t = i / fps;
      seeks += await playback.exactFrame(t, fps);
      renderer.render(t);
      const frame = new VideoFrame(renderer.canvas, { timestamp: Math.round(i * frameDur), duration: frameDur });
      venc.encode(frame, { keyFrame: i % Math.round(fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6) {
        await (canDequeue ? new Promise((r) => venc.addEventListener('dequeue', r, { once: true })) : sleep(0));
      }
      if (i % 3 === 0 || i === total - 1) {
        const el = (performance.now() - t0) / 1000;
        const rate = (i + 1) / Math.max(0.001, el);
        this.#progress((i + 1) / total, 'Rendering frames', `Frame ${i + 1} of ${total} · ${rate.toFixed(1)} fps · ${formatDuration(Math.max(0, (total - i - 1) / rate))} left`);
      }
    }
    this.#progress(1, 'Finishing', 'Writing the MP4…');
    await venc.flush();
    venc.close();
    if (encodeError) throw encodeError;
    muxer.finalize();
    const secs = (performance.now() - t0) / 1000;
    return {
      blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
      ext: 'mp4',
      stats: `${total} frames in ${formatDuration(secs)} (${(total / secs).toFixed(1)} fps) · ${vcodec}${acfg ? ` + ${acfg.mux.toUpperCase()}` : ''} · ${seeks} video seeks`,
    };
  }

  async #runRealtime(o) {
    const { store, renderer, playback, audio } = this;
    const dur = store.duration;
    this.#enter(o);
    let dest = null, vstream = null, rec = null;
    const chunks = [];
    let failed = null;
    try {
      await audio.resume();
      dest = audio.createCaptureNode();
      audio.setMonitorMuted(!o.monitorAudio);
      vstream = renderer.canvas.captureStream(o.fps);
      const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      rec = new MediaRecorder(stream, { mimeType: o.format.mime, videoBitsPerSecond: o.vbps, audioBitsPerSecond: o.abps });
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      const stopped = once(rec, ['stop'], [], 0);
      rec.onerror = (e) => { failed = e.error || new Error('recorder error'); };
      playback.seek(0);
      await playback.prepareAt(0);
      renderer.render(0);
      const ended = new Promise((resolve) => {
        const off = store.on('ended', () => { off(); resolve(); });
        this.stopWait = () => { off(); resolve(); };
      });
      rec.start(1000);
      await playback.play({ exporting: true });
      const tick = () => {
        if (this.state !== 'running') return;
        const p = Math.min(1, store.time / dur);
        this.#progress(p, document.hidden ? 'Paused: bring this tab back to finish' : 'Recording in real time',
          `${formatTC(store.time, store.project.fps)} of ${formatTC(dur, store.project.fps)} · ${formatDuration(Math.max(0, dur - store.time))} left`);
        if (this.abort) { this.stopWait?.(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await ended;
      playback.pause();
      await sleep(180);
      rec.stop();
      await stopped;
    } catch (err) {
      failed = failed || err;
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    } finally {
      vstream?.getTracks().forEach((t) => t.stop());
      if (dest) audio.releaseCaptureNode(dest);
      audio.setMonitorMuted(false);
    }
    if (this.abort) throw new Error('aborted');
    if (failed || !chunks.length) throw failed || new Error('the recorder produced no data');
    return { blob: new Blob(chunks, { type: o.format.mime.split(';')[0] }), ext: o.format.ext, stats: 'real-time recording' };
  }

  #finish(blob, ext, o, stats) {
    this.#cleanupResult();
    this.resultUrl = this.blobs.create(blob, 'export');
    this.resultName = `${sanitizeFilename(this.store.project.title)}.${ext}`;
    this.#setState('done');
    this.#progress(1, 'Done', `${o.w}×${o.h} · ${o.fps} fps · ${formatBytes(blob.size)} · ${stats}`);
    this.el.result.textContent = this.resultName;
    this.#download();
    toast(`Exported ${this.resultName} (${formatBytes(blob.size)}).`, { kind: 'ok' });
  }

  #download() {
    if (!this.resultUrl) return;
    const a = document.createElement('a');
    a.href = this.resultUrl;
    a.download = this.resultName;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }

  #cleanupResult() {
    if (this.resultUrl) {
      const url = this.resultUrl;
      this.resultUrl = null;
      setTimeout(() => this.blobs.revoke(url), 1500);
    }
  }
}
