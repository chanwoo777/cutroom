// On-device text-to-speech worker: Supertonic 3 by Supertone (fp32 ONNX) on ONNX Runtime Web.
// WebGPU when the browser has it (about 0.2 s per denoising step), otherwise WebAssembly.
// The pipeline follows Supertone's MIT-licensed browser example (helper.js): duration predictor ->
// text encoder -> flow-matching vector estimator (N steps) -> vocoder.
//
// Privacy: the only network traffic is downloading the model files themselves, once, from a pinned
// Hugging Face revision; each graph is checked against its published SHA-256 and kept in Cache Storage
// so later sessions work offline. The text being spoken is never sent anywhere.
import * as ort from '../../vendor/onnxruntime-web/1.31.1/ort.webgpu.bundle.min.mjs';

const VENDOR = new URL('../../vendor/onnxruntime-web/1.31.1/', import.meta.url).href;
const SOURCES = [
  'https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/',
  'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46/',
];
const CACHE = 'cutroom-voice-supertonic3-fp32-3cadd1e';
// The two small text graphs take int64 token ids, which run best on the CPU; the heavy flow-matching
// estimator and vocoder go to the GPU when WebGPU is available.
const GRAPHS = [
  { key: 'dp', path: 'onnx/duration_predictor.onnx', size: 3700147, sha: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db', gpu: false },
  { key: 'enc', path: 'onnx/text_encoder.onnx', size: 36416150, sha: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff', gpu: false },
  { key: 'vec', path: 'onnx/vector_estimator.onnx', size: 256534781, sha: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c', gpu: true },
  { key: 'voc', path: 'onnx/vocoder.onnx', size: 101424195, sha: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba', gpu: true },
];
const TOTAL = GRAPHS.reduce((s, g) => s + g.size, 0);
const LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

ort.env.wasm.wasmPaths = VENDOR;
ort.env.wasm.proxy = false;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
ort.env.logLevel = 'error';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
let tts = null;
let loading = null;
const styles = new Map();
const cancelled = new Set();
let queue = Promise.resolve();

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; }
}

async function hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Download one file (trying each mirror), streaming progress; cached responses skip the network. */
async function fetchFile(path, { onBytes = () => {}, sha = null, json = false } = {}) {
  const cache = await openCache();
  const cacheKey = `https://cutroom.local/supertonic3/${path}`;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      onBytes(buf.byteLength, true);
      return json ? JSON.parse(new TextDecoder().decode(buf)) : buf;
    }
  }
  let lastErr = null;
  for (const base of SOURCES) {
    let counted = 0;
    try {
      const res = await fetch(base + path, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const parts = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        n += value.byteLength;
        counted += value.byteLength;
        onBytes(value.byteLength, false);
      }
      const buf = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { buf.set(p, o); o += p.byteLength; }
      if (sha && (await hex(buf)) !== sha) throw new Error(`checksum mismatch for ${path}`);
      if (cache) {
        try { await cache.put(cacheKey, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* storage quota: keep going uncached */ }
      }
      return json ? JSON.parse(new TextDecoder().decode(buf)) : buf;
    } catch (err) {
      onBytes(-counted, false);
      lastErr = err;
    }
  }
  throw new Error(`Could not download the voice model (${lastErr?.message || 'network error'}). Check your connection and try again.`);
}

async function createSession(bytes, ep) {
  // logSeverityLevel 3 = errors only (ORT otherwise prints harmless "node placement" notices as console errors).
  return ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
}

function load() {
  if (tts) return Promise.resolve(tts);
  if (loading) return loading;
  loading = (async () => {
    let loaded = 0, last = 0, fromCache = true;
    const report = (phase, force = false) => {
      const now = performance.now();
      if (!force && now - last < 150) return;
      last = now;
      post({ type: 'progress', loaded: Math.max(0, Math.min(loaded, TOTAL)), total: TOTAL, phase, fromCache });
    };
    const [cfg, indexer] = await Promise.all([fetchFile('onnx/tts.json', { json: true }), fetchFile('onnx/unicode_indexer.json', { json: true })]);
    const bytes = {};
    for (const g of GRAPHS) {
      bytes[g.key] = await fetchFile(g.path, {
        sha: g.sha,
        onBytes: (n, cached) => { loaded += n; if (!cached) fromCache = false; report('download'); },
      });
      report('download', true);
    }
    report('prepare', true);
    let backend = 'wasm';
    let adapterOk = false;
    try { adapterOk = !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch { adapterOk = false; }
    const sessions = {};
    for (const g of GRAPHS) if (!g.gpu) sessions[g.key] = await createSession(bytes[g.key], 'wasm');
    if (adapterOk) {
      try {
        for (const g of GRAPHS) if (g.gpu) sessions[g.key] = await createSession(bytes[g.key], 'webgpu');
        backend = 'webgpu';
      } catch (err) {
        console.warn('WebGPU session failed, using WebAssembly', err);
        for (const g of GRAPHS) if (g.gpu && sessions[g.key]) { try { await sessions[g.key].release(); } catch { /* ignore */ } delete sessions[g.key]; }
      }
    }
    if (backend === 'wasm') for (const g of GRAPHS) if (g.gpu) sessions[g.key] = await createSession(bytes[g.key], 'wasm');
    // Warm-up: one tiny pass compiles the GPU shaders now rather than on the user's first click.
    try { await warmup({ cfg, indexer, ...sessions }); } catch (err) { console.warn('voice warm-up failed', err); }
    tts = { cfg, indexer, backend, ...sessions };
    post({ type: 'ready', backend, threads: ort.env.wasm.numThreads, fromCache });
    return tts;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

async function style(voice) {
  if (styles.has(voice)) return styles.get(voice);
  if (!/^[FM][1-5]$/.test(voice)) throw new Error(`Unknown voice ${voice}`);
  const j = await fetchFile(`voice_styles/${voice}.json`, { json: true });
  const s = {
    ttl: new ort.Tensor('float32', new Float32Array(j.style_ttl.data.flat(Infinity)), j.style_ttl.dims),
    dp: new ort.Tensor('float32', new Float32Array(j.style_dp.data.flat(Infinity)), j.style_dp.dims),
  };
  styles.set(voice, s);
  return s;
}

const REPLACE = { '–': '-', '‑': '-', '—': '-', '_': ' ', '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

function preprocess(text, lang) {
  text = text.normalize('NFKD').replace(EMOJI, '');
  for (const [k, v] of Object.entries(REPLACE)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, '');
  text = text.replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ');
  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

function chunkText(text, maxLen) {
  const chunks = [];
  for (let para of text.trim().split(/\n\s*\n+/)) {
    para = para.replace(/\s*\n\s*/g, ' ').trim();
    if (!para) continue;
    const sentences = para.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|St\.)(?<!\b[A-Z]\.)(?<=[.!?。！？])\s+/);
    let cur = '';
    for (const s of sentences) {
      if (cur.length + s.length + 1 <= maxLen) cur += (cur ? ' ' : '') + s;
      else { if (cur) chunks.push(cur.trim()); cur = s; }
    }
    if (cur) chunks.push(cur.trim());
  }
  return chunks;
}

function gaussian(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(1e-4, Math.random()), u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

// A sentence of typical length compiles the GPU kernels for realistic tensor sizes, so the user's first
// generation is as quick as every later one.
async function warmup(t) {
  const st = await style('F1');
  await inferChunk(t, 'This short sentence warms up the voice engine before you use it.', 'en', st, 2, 1, () => {}, -1);
}

async function inferChunk(t, chunk, lang, st, steps, speed, onStep, id) {
  const text = preprocess(chunk, lang);
  const L = text.length;
  const ids = new BigInt64Array(L);
  for (let j = 0; j < L; j++) {
    const cp = text.codePointAt(j);
    ids[j] = BigInt(cp < t.indexer.length ? t.indexer[cp] : -1);
  }
  const idsT = new ort.Tensor('int64', ids, [1, L]);
  const maskT = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
  post({ type: 'phase', id, phase: 'duration' });
  const dpOut = await t.dp.run({ text_ids: idsT, style_dp: st.dp, text_mask: maskT });
  const dur = dpOut.duration.data[0] / speed;
  post({ type: 'phase', id, phase: 'encode' });
  const encOut = await t.enc.run({ text_ids: idsT, style_ttl: st.ttl, text_mask: maskT });
  const sr = t.cfg.ae.sample_rate;
  const chunkSize = t.cfg.ae.base_chunk_size * t.cfg.ttl.chunk_compress_factor;
  const dim = t.cfg.ttl.latent_dim * t.cfg.ttl.chunk_compress_factor;
  const wavLen = Math.floor(dur * sr);
  const latLen = Math.max(1, Math.ceil(wavLen / chunkSize));
  let xt = gaussian(dim * latLen);
  const latMaskT = new ort.Tensor('float32', new Float32Array(latLen).fill(1), [1, 1, latLen]);
  const totalT = new ort.Tensor('float32', new Float32Array([steps]), [1]);
  for (let s = 0; s < steps; s++) {
    if (cancelled.has(id)) throw new Error('cancelled');
    const out = await t.vec.run({
      noisy_latent: new ort.Tensor('float32', xt, [1, dim, latLen]),
      text_emb: encOut.text_emb,
      style_ttl: st.ttl,
      latent_mask: latMaskT,
      text_mask: maskT,
      current_step: new ort.Tensor('float32', new Float32Array([s]), [1]),
      total_step: totalT,
    });
    xt = new Float32Array(out.denoised_latent.data);
    onStep();
  }
  post({ type: 'phase', id, phase: 'vocode' });
  const voc = await t.voc.run({ latent: new ort.Tensor('float32', xt, [1, dim, latLen]) });
  const wav = voc.wav_tts.data;
  return wav.slice(0, Math.min(wav.length, wavLen));
}

async function synth({ id, text, lang, voice, speed = 1.05, steps = 5, gap = 0.3 }) {
  const t = await load();
  if (!LANGS.includes(lang)) throw new Error(`Unsupported language: ${lang}`);
  const st = await style(voice);
  const chunks = chunkText(String(text || ''), lang === 'ko' || lang === 'ja' ? 120 : 300);
  if (!chunks.length) throw new Error('Nothing to say: the text is empty.');
  const sr = t.cfg.ae.sample_rate;
  const totalSteps = chunks.length * (steps + 1);
  let done = 0;
  const step = () => { done++; post({ type: 'step', id, done, total: totalSteps }); };
  const parts = [];
  const timings = [];
  let cursor = 0;
  const t0 = performance.now();
  for (let i = 0; i < chunks.length; i++) {
    const wav = await inferChunk(t, chunks[i], lang, st, steps, speed, step, id);
    step();
    if (i > 0) cursor += Math.floor(gap * sr);
    timings.push({ text: chunks[i], start: cursor / sr, end: (cursor + wav.length) / sr });
    parts.push({ wav, at: cursor });
    cursor += wav.length;
  }
  const pcm = new Float32Array(cursor);
  for (const p of parts) pcm.set(p.wav, p.at);
  post({ type: 'result', id, pcm, sampleRate: sr, chunks: timings, ms: performance.now() - t0, backend: t.backend }, [pcm.buffer]);
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'load') {
    load().catch((err) => post({ type: 'error', id: null, message: err.message || String(err) }));
  } else if (msg.type === 'synth') {
    queue = queue
      .then(() => synth(msg))
      .catch((err) => post({ type: 'error', id: msg.id, message: err.message === 'cancelled' ? 'cancelled' : err.message || String(err) }))
      .finally(() => cancelled.delete(msg.id));
  } else if (msg.type === 'cancel') {
    cancelled.add(msg.id);
  } else if (msg.type === 'forget') {
    caches.delete(CACHE).then((ok) => post({ type: 'forgotten', ok }));
  }
};
