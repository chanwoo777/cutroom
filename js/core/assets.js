// Media lives only in this tab: files become Blob URLs tracked in a registry so every one can be revoked.
import { Emitter } from './emitter.js';
import { uid, once, seekVideo } from '../util.js';

/** Tracks every object URL the app creates. Delete an asset or reset the project and its URLs are revoked. */
export class BlobRegistry extends Emitter {
  constructor() {
    super();
    this.urls = new Map(); // url -> label
  }
  create(blob, label = '') {
    const url = URL.createObjectURL(blob);
    this.urls.set(url, label);
    this.emit('change', this.urls.size);
    return url;
  }
  revoke(url) {
    if (!url || !this.urls.has(url)) return;
    URL.revokeObjectURL(url);
    this.urls.delete(url);
    this.emit('change', this.urls.size);
  }
  revokeAll() {
    for (const url of this.urls.keys()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.emit('change', 0);
  }
  get count() { return this.urls.size; }
}

const TYPES = {
  video: { mimes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'], exts: ['mp4', 'm4v', 'webm', 'mov', 'ogv'] },
  image: { mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'], exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] },
  audio: {
    mimes: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/webm', 'audio/opus'],
    exts: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  },
};
const MAX_DECODE_BYTES = 400 * 1024 * 1024; // above this, video audio streams from the element instead of a decoded buffer

export function classify(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/svg+xml') return null; // never load scriptable SVG from untrusted files
  for (const [kind, t] of Object.entries(TYPES)) if (t.mimes.includes(mime)) return kind;
  const ext = (file.name || '').toLowerCase().split('.').pop();
  for (const [kind, t] of Object.entries(TYPES)) if (t.exts.includes(ext)) return kind;
  return null;
}

/** Peak amplitude per bucket, used to draw waveforms at any zoom. */
export function computePeaks(buffer, perSec = 200) {
  const n = Math.max(1, Math.ceil(buffer.duration * perSec));
  const data = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const len = buffer.length;
  const step = len / n;
  const stride = step > 64 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step);
    const e = Math.min(len, Math.floor((i + 1) * step));
    let m = 0;
    for (const d of chans) for (let j = s; j < e; j += stride) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; }
    data[i] = m;
  }
  return { perSec, data };
}

function friendlyError(kind, err) {
  const msg = String(err?.message || err || '');
  if (msg === 'timeout') return 'The file took too long to open.';
  if (kind === 'video') return 'This browser cannot decode the video codec in this file (HEVC/ProRes MOV files often fail; try MP4 H.264 or WebM).';
  if (kind === 'audio') return 'This browser cannot decode this audio file.';
  if (kind === 'image') return 'This image could not be decoded.';
  return 'Unsupported file.';
}

export class AssetStore extends Emitter {
  constructor({ blobs, audio }) {
    super();
    this.blobs = blobs;
    this.audio = audio;
    this.items = new Map();
  }

  list() { return [...this.items.values()]; }
  get(id) { return id ? this.items.get(id) || null : null; }

  async importFiles(files) {
    const list = [...files];
    const results = await Promise.all(list.map((f) => this.importFile(f)));
    return results.filter(Boolean);
  }

  async importFile(file, nameOverride) {
    const kind = classify(file);
    const name = nameOverride || file.name || 'Untitled';
    if (!kind) {
      this.emit('notice', { kind: 'error', message: `${name}: unsupported file type. Use MP4, WebM, MOV, PNG, JPG, MP3 or WAV.` });
      return null;
    }
    const asset = {
      id: uid('a'), kind, name, size: file.size, mime: file.type, source: 'file', status: 'loading',
      url: null, duration: kind === 'image' ? Infinity : 0, width: 0, height: 0,
      hasAudio: kind === 'audio', audioMode: 'buffer', buffer: null, peaks: null, thumbs: [], poster: null, img: null, error: '',
    };
    this.items.set(asset.id, asset);
    this.emit('change');
    try {
      asset.url = this.blobs.create(file, name);
      if (kind === 'video') await this.#loadVideo(asset, file);
      else if (kind === 'image') await this.#loadImage(asset, file);
      else await this.#loadAudio(asset, file);
      if (!this.items.has(asset.id)) return null; // removed while loading
      asset.status = 'ready';
    } catch (err) {
      console.warn('import failed', name, err);
      asset.status = 'error';
      asset.error = friendlyError(kind, err);
    }
    this.emit('change');
    return asset.status === 'ready' ? asset : null;
  }

  async #loadVideo(asset, file) {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.src = asset.url;
    await once(v, ['loadedmetadata'], ['error'], 20000);
    let dur = v.duration;
    if (!Number.isFinite(dur)) {
      // MediaRecorder WebM files often report Infinity until you seek past the end.
      const settle = once(v, ['durationchange', 'seeked'], [], 5000).catch(() => {});
      v.currentTime = 1e7;
      await settle;
      dur = v.duration;
      if (!Number.isFinite(dur)) { await once(v, ['durationchange'], [], 3000).catch(() => {}); dur = v.duration; }
      await seekVideo(v, 0, 3000);
    }
    if (!v.videoWidth || !Number.isFinite(dur) || dur <= 0) throw new Error('decode');
    asset.duration = dur;
    asset.width = v.videoWidth;
    asset.height = v.videoHeight;

    if (file.size <= MAX_DECODE_BYTES) {
      try {
        const ab = await file.arrayBuffer();
        asset.buffer = await this.audio.decode(ab);
        asset.peaks = computePeaks(asset.buffer);
        asset.hasAudio = true;
      } catch {
        asset.hasAudio = false; // no audio track, or a codec decodeAudioData cannot read
      }
    } else {
      asset.audioMode = 'element';
      asset.hasAudio = true;
    }
    this.#extractThumbs(asset, v); // runs in the background
  }

  async #extractThumbs(asset, v) {
    try {
      const n = Math.max(1, Math.min(48, Math.ceil(asset.duration / 1.5)));
      const th = 72;
      const tw = Math.max(16, Math.round((th * asset.width) / asset.height));
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const cx = c.getContext('2d');
      for (let i = 0; i < n; i++) {
        if (!this.items.has(asset.id)) break;
        const t = Math.min(asset.duration - 0.04, ((i + 0.5) * asset.duration) / n);
        await seekVideo(v, Math.max(0, t), 3000);
        cx.drawImage(v, 0, 0, tw, th);
        const bmp = await createImageBitmap(c);
        asset.thumbs.push({ t, bmp });
        if (i === 0) asset.poster = bmp;
        this.emit('thumbs', asset);
      }
    } catch (err) {
      console.warn('thumbnails failed', err);
    } finally {
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignore */ }
    }
  }

  async #loadImage(asset, file) {
    // createImageBitmap decodes off the main thread and does not wait for the page to paint
    // (HTMLImageElement.decode() can stall in a background tab). EXIF orientation is applied.
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = null; }
    if (!bmp) {
      const img = new Image();
      img.decoding = 'async';
      img.src = asset.url;
      await img.decode();
      bmp = await createImageBitmap(img);
    }
    asset.width = bmp.width;
    asset.height = bmp.height;
    asset.img = null;
    asset.poster = bmp;
    asset.thumbs = [{ t: 0, bmp }];
  }

  async #loadAudio(asset, file) {
    const ab = await file.arrayBuffer();
    asset.buffer = await this.audio.decode(ab);
    asset.duration = asset.buffer.duration;
    asset.peaks = computePeaks(asset.buffer);
  }

  /** Procedural audio from the built-in synth: no file, no URL. */
  addBuffer(name, buffer, meta = {}) {
    const asset = {
      id: uid('a'), kind: 'audio', name, size: buffer.length * buffer.numberOfChannels * 4, mime: 'audio/x-synth', source: 'synth',
      status: 'ready', url: null, duration: buffer.duration, width: 0, height: 0, hasAudio: true, audioMode: 'buffer',
      buffer, peaks: computePeaks(buffer), thumbs: [], poster: null, img: null, error: '', ...meta,
    };
    this.items.set(asset.id, asset);
    this.emit('change');
    return asset;
  }

  remove(id) {
    const a = this.items.get(id);
    if (!a) return;
    this.items.delete(id);
    if (a.url) this.blobs.revoke(a.url);
    for (const t of a.thumbs || []) t.bmp?.close?.();
    if (a.poster && !a.thumbs?.some((t) => t.bmp === a.poster)) a.poster.close?.();
    a.buffer = null;
    a.peaks = null;
    a.img = null;
    this.emit('change');
    this.emit('removed', id);
  }

  reset() {
    for (const id of [...this.items.keys()]) this.remove(id);
    this.blobs.revokeAll();
  }
}
