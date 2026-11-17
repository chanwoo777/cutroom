// Client-side export: the program canvas (captureStream) plus the Web Audio mix (MediaStreamDestination)
// recorded in real time by MediaRecorder, then saved through a local Blob URL. Nothing is uploaded.
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
const BPP = { draft: 0.05, standard: 0.1, high: 0.17 };

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

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
function dimsFor([bw, bh], shortSide) {
  const s = shortSide / Math.min(bw, bh);
  return [even(bw * s), even(bh * s)];
}

export class ExportDialog {
  constructor({ store, renderer, playback, audio, blobs, monitor, applyCanvasSize }) {
    Object.assign(this, { store, renderer, playback, audio, blobs, monitor, applyCanvasSize });
    this.dlg = $('export-dialog');
    this.el = {
      res: $('ex-res'), fps: $('ex-fps'), format: $('ex-format'), quality: $('ex-quality'), monitor: $('ex-monitor'),
      summary: $('ex-summary'), settings: $('export-settings'), progress: $('export-progress'), bar: $('ex-bar'),
      pct: $('ex-pct'), eta: $('ex-eta'), phase: $('ex-phase'), result: $('ex-result'), cancel: $('ex-cancel'), start: $('ex-start'),
    };
    this.quality = 'standard';
    this.state = 'idle'; // idle | running | done
    this.resultUrl = null;
    this.dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    this.dlg.addEventListener('cancel', (e) => { if (this.state === 'running') e.preventDefault(); });
    this.dlg.addEventListener('close', () => this.#cleanupResult());
    for (const b of this.el.quality.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        this.quality = b.dataset.q;
        this.el.quality.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        this.#summary();
      });
    }
    for (const k of ['res', 'fps', 'format']) this.el[k].addEventListener('change', () => this.#summary());
    this.el.start.addEventListener('click', () => {
      if (this.state === 'done') this.#download();
      else if (this.state === 'idle') this.start();
    });
    this.el.cancel.addEventListener('click', () => {
      if (this.state === 'running') this.abort = true;
      else this.close();
    });
  }

  open() {
    if (this.store.exporting) return;
    if (!this.store.project.clips.length) { toast('Add something to the timeline before exporting.'); return; }
    const formats = supportedFormats();
    if (!formats.length) { toast('This browser cannot record video (MediaRecorder is unavailable).', { kind: 'error' }); return; }
    this.formats = formats;
    const dims = this.store.dims;
    this.el.res.replaceChildren(...RESOLUTIONS.map((r) => {
      const [w, h] = dimsFor(dims, r);
      const o = document.createElement('option');
      o.value = String(r);
      o.textContent = `${w}×${h}${r === 1080 ? ' · Full HD' : r === 2160 ? ' · 4K' : ''}`;
      return o;
    }));
    this.el.res.value = '1080';
    this.el.fps.replaceChildren(...FPS_OPTIONS.map((f) => { const o = document.createElement('option'); o.value = String(f); o.textContent = `${f} fps`; return o; }));
    this.el.fps.value = String(this.store.project.fps);
    this.el.format.replaceChildren(...formats.map((f, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = f.label; return o; }));
    this.#setState('idle');
    this.#summary();
    this.dlg.showModal();
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
    const vbps = Math.round(Math.min(80e6, Math.max(1e6, w * h * fps * BPP[this.quality])));
    return { w, h, fps, format, vbps, abps: 192000, monitorAudio: this.el.monitor.checked };
  }

  #summary() {
    const o = this.#opts();
    const dur = this.store.duration;
    const bytes = ((o.vbps + o.abps) * dur) / 8;
    this.el.summary.textContent = `${o.w}×${o.h} · ${o.fps} fps · ${o.format.label} · ${(o.vbps / 1e6).toFixed(1)} Mbps · ≈ ${formatBytes(bytes)} · renders in ${formatDuration(dur)}`;
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

  async start() {
    const { store, renderer, playback, audio } = this;
    const o = this.#opts();
    const dur = store.duration;
    if (dur <= 0) return;
    this.abort = false;
    this.#setState('running');
    this.el.phase.textContent = 'Preparing';
    this.el.bar.value = 0;
    this.el.pct.textContent = '0%';
    this.el.eta.textContent = '';

    playback.pause();
    store.exporting = true;
    store.emit('exporting', true);
    store.clearSelection();
    const prevFps = store.project.fps;
    renderer.resize(o.w, o.h);
    this.monitor.layout();

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
      const t0 = performance.now();
      await playback.play({ exporting: true });
      const tick = () => {
        if (this.state !== 'running') return;
        const p = Math.min(1, store.time / dur);
        this.el.bar.value = p;
        this.el.pct.textContent = `${Math.round(p * 100)}%`;
        this.el.phase.textContent = document.hidden ? 'Paused: bring this tab back to finish' : 'Rendering';
        const el = (performance.now() - t0) / 1000;
        this.el.eta.textContent = `${formatTC(store.time, prevFps)} of ${formatTC(dur, prevFps)} · ${formatDuration(Math.max(0, dur - store.time))} left`;
        if (this.abort) { this.stopWait?.(); return; }
        if (el > dur * 3 + 30 && p < 0.01) { failed = new Error('Rendering stalled.'); this.stopWait?.(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await ended;
      playback.pause();
      await sleep(180); // let the recorder take the last frame
      rec.stop();
      await stopped;
    } catch (err) {
      failed = failed || err;
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    } finally {
      vstream?.getTracks().forEach((t) => t.stop());
      if (dest) audio.releaseCaptureNode(dest);
      audio.setMonitorMuted(false);
      store.exporting = false;
      store.emit('exporting', false);
      this.applyCanvasSize();
    }

    if (this.abort) {
      this.#setState('idle');
      toast('Export stopped. Nothing was saved.');
      return;
    }
    if (failed || !chunks.length) {
      this.#setState('idle');
      toast(`Export failed: ${failed?.message || 'the recorder produced no data'}. Try WebM or a lower resolution.`, { kind: 'error', timeout: 7000 });
      return;
    }
    const type = o.format.mime.split(';')[0];
    const blob = new Blob(chunks, { type });
    this.#cleanupResult();
    this.resultUrl = this.blobs.create(blob, 'export');
    this.resultName = `${sanitizeFilename(store.project.title)}.${o.format.ext}`;
    this.#setState('done');
    this.el.phase.textContent = 'Done';
    this.el.bar.value = 1;
    this.el.pct.textContent = '100%';
    this.el.eta.textContent = `${o.w}×${o.h} · ${o.fps} fps · ${formatBytes(blob.size)}`;
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
      setTimeout(() => this.blobs.revoke(url), 1500); // give the download a moment to start
    }
  }
}
