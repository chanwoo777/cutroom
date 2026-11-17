// Main-thread side of the on-device voice: owns the TTS worker, tracks model state for the UI and
// turns raw PCM into AudioBuffers the timeline can use like any other audio asset.
import { Emitter } from '../core/emitter.js';

export const VOICE_MODEL = {
  name: 'Supertonic 3',
  by: 'Supertone',
  license: 'OpenRAIL-M',
  bytes: 398075273,
  url: 'https://huggingface.co/Supertone/supertonic-3',
};

export const VOICES = [
  ['F1', 'Female 1'], ['F2', 'Female 2'], ['F3', 'Female 3'], ['F4', 'Female 4'], ['F5', 'Female 5'],
  ['M1', 'Male 1'], ['M2', 'Male 2'], ['M3', 'Male 3'], ['M4', 'Male 4'], ['M5', 'Male 5'],
];

export const VOICE_LANGS = [
  ['auto', 'Detect from text'], ['en', 'English'], ['ko', '한국어 · Korean'], ['ja', '日本語 · Japanese'],
  ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'],
  ['nl', 'Nederlands'], ['pl', 'Polski'], ['ru', 'Русский'], ['uk', 'Українська'], ['tr', 'Türkçe'],
  ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['hi', 'हिन्दी · Hindi'], ['ar', 'العربية · Arabic'],
  ['el', 'Ελληνικά'], ['bg', 'Български'], ['cs', 'Čeština'], ['da', 'Dansk'], ['et', 'Eesti'], ['fi', 'Suomi'],
  ['hr', 'Hrvatski'], ['hu', 'Magyar'], ['lt', 'Lietuvių'], ['lv', 'Latviešu'], ['ro', 'Română'],
  ['sk', 'Slovenčina'], ['sl', 'Slovenščina'], ['sv', 'Svenska'],
];

export const QUALITY = [['fast', 'Fast', 3], ['balanced', 'Balanced', 5], ['best', 'Best', 10]];
export const stepsFor = (q) => (QUALITY.find((x) => x[0] === q) || QUALITY[1])[2];

/** Pick the model language from the script the text is written in. Latin text defaults to English. */
export function detectLang(text) {
  const s = String(text || '');
  if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(s)) return 'ko';
  if (/[぀-ヿㇰ-ㇿ]/.test(s)) return 'ja';
  if (/[Ѐ-ӿ]/.test(s)) return /[іїєґ]/i.test(s) ? 'uk' : /[ъщ]/i.test(s) && /\b(и|на|се)\b/i.test(s) ? 'bg' : 'ru';
  if (/[Ͱ-Ͽ]/.test(s)) return 'el';
  if (/[؀-ۿ]/.test(s)) return 'ar';
  if (/[ऀ-ॿ]/.test(s)) return 'hi';
  if (/[ơưđĐƠƯ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/.test(s)) return 'vi';
  if (/[一-鿿]/.test(s)) return 'ja';
  if (/[ñ¿¡]/i.test(s)) return 'es';
  if (/[ãõ]/i.test(s)) return 'pt';
  if (/[ß]|\b(und|der|die|das|nicht|ist)\b/i.test(s)) return 'de';
  if (/[çœæ]|\b(le|la|les|est|une|des)\b/i.test(s) && /[éèêàù]/i.test(s)) return 'fr';
  return 'en';
}

const SETTINGS_KEY = 'cutroom.voice';
const DEFAULTS = { lang: 'auto', voice: 'F1', speed: 1.05, quality: 'balanced', fit: true, captions: true };
export function loadVoiceSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function saveVoiceSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage blocked: settings stay for this session */ }
}

export class VoiceEngine extends Emitter {
  constructor() {
    super();
    this.worker = null;
    this.state = 'idle'; // idle | loading | ready | error
    this.progress = { loaded: 0, total: VOICE_MODEL.bytes, phase: '' };
    this.backend = '';
    this.error = '';
    this.pending = new Map();
    this.seq = 0;
    this.readyWaiters = [];
    this.cached = null;
    this.#checkCache();
  }

  async #checkCache() {
    try {
      const keys = await caches.keys();
      this.cached = keys.some((k) => k.startsWith('cutroom-voice-supertonic3-fp32'));
    } catch { this.cached = false; }
    this.emit('state', this);
  }

  #start() {
    if (this.worker) return;
    const w = new Worker(new URL('../voice/tts-worker.js', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (e) => this.#onMessage(e.data);
    w.onerror = (e) => this.#fail(e.message || 'The voice engine could not start in this browser.');
  }

  #setState(state) {
    this.state = state;
    this.emit('state', this);
  }

  #fail(message) {
    this.error = message;
    this.#setState('error');
    for (const r of this.readyWaiters) r.reject(new Error(message));
    this.readyWaiters = [];
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  #onMessage(d) {
    if (d.type === 'progress') {
      this.progress = { loaded: d.loaded, total: d.total, phase: d.phase, fromCache: d.fromCache };
      if (this.state !== 'loading') this.state = 'loading';
      this.emit('state', this);
    } else if (d.type === 'ready') {
      this.backend = d.backend;
      this.cached = true;
      this.#setState('ready');
      for (const r of this.readyWaiters) r.resolve();
      this.readyWaiters = [];
    } else if (d.type === 'step') {
      this.pending.get(d.id)?.onStep?.(d.done, d.total);
    } else if (d.type === 'result') {
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      p.resolve(d);
      this.emit('busy', this.pending.size);
    } else if (d.type === 'error') {
      if (d.id == null) { this.#fail(d.message); return; }
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      p.reject(new Error(d.message));
      this.emit('busy', this.pending.size);
    }
  }

  /** Download (first time) or open from cache, then build the sessions. */
  load() {
    if (this.state === 'ready') return Promise.resolve();
    this.#start();
    const p = new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    if (this.state !== 'loading') {
      this.error = '';
      this.progress = { loaded: 0, total: VOICE_MODEL.bytes, phase: 'download' };
      this.#setState('loading');
      this.worker.postMessage({ type: 'load' });
    }
    return p;
  }

  async synthesize({ text, lang, voice, speed, steps, gap = 0.3 }, onStep) {
    await this.load();
    const id = ++this.seq;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, onStep }));
    this.emit('busy', this.pending.size);
    this.worker.postMessage({ type: 'synth', id, text, lang, voice, speed, steps, gap });
    return result;
  }

  get busy() { return this.pending.size > 0; }

  static toAudioBuffer(pcm, sampleRate) {
    const buf = new AudioBuffer({ length: Math.max(1, pcm.length), numberOfChannels: 1, sampleRate });
    buf.copyToChannel(pcm, 0);
    return buf;
  }
}
