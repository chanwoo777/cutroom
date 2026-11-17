// Procedural, royalty-free sound: every effect and beat is synthesized in an OfflineAudioContext.
// Noise is seeded so the same preset always renders the same buffer.

const SR = 44100;

export const SFX_LIST = [
  { id: 'whoosh', name: 'Whoosh', dur: 1.4 },
  { id: 'riser', name: 'Riser', dur: 3 },
  { id: 'impact', name: 'Impact', dur: 2.6 },
  { id: 'drop', name: 'Pitch drop', dur: 0.9 },
  { id: 'pop', name: 'Pop', dur: 0.3 },
  { id: 'ding', name: 'Ding', dur: 1.6 },
  { id: 'click', name: 'UI click', dur: 0.12 },
  { id: 'shutter', name: 'Shutter', dur: 0.4 },
  { id: 'typing', name: 'Typing', dur: 1.8 },
  { id: 'glitch', name: 'Glitch', dur: 0.8 },
  { id: 'kick', name: 'Kick', dur: 0.6 },
  { id: 'snare', name: 'Snare', dur: 0.4 },
  { id: 'clap', name: 'Clap', dur: 0.45 },
  { id: 'hat', name: 'Hi-hat', dur: 0.25 },
];

export const BEAT_STYLES = [
  { id: 'lofi', name: 'Lo-fi', bpm: 84 },
  { id: 'house', name: 'House', bpm: 122 },
  { id: 'synthwave', name: 'Synthwave', bpm: 100 },
  { id: 'trap', name: 'Trap', bpm: 140 },
];

export const KEYS = [
  { id: 'Am', name: 'A minor', root: 57, minor: true },
  { id: 'Cm', name: 'C minor', root: 48, minor: true },
  { id: 'Dm', name: 'D minor', root: 50, minor: true },
  { id: 'Em', name: 'E minor', root: 52, minor: true },
  { id: 'C', name: 'C major', root: 48, minor: false },
  { id: 'F', name: 'F major', root: 53, minor: false },
  { id: 'G', name: 'G major', root: 55, minor: false },
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const noiseCache = new WeakMap(); // identical seed + length -> identical buffer, so reuse it per render
function noiseBuffer(ctx, dur, seed = 7) {
  const len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  let perCtx = noiseCache.get(ctx);
  if (!perCtx) { perCtx = new Map(); noiseCache.set(ctx, perCtx); }
  const key = `${seed}:${len}`;
  if (perCtx.has(key)) return perCtx.get(key);
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  perCtx.set(key, b);
  const d = b.getChannelData(0);
  const r = rng(seed);
  for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  return b;
}

function reverbImpulse(ctx, dur = 1.8, decay = 3) {
  const len = Math.ceil(ctx.sampleRate * dur);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    const r = rng(101 + ch * 7);
    for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

function noise(ctx, out, t, dur, { type = 'highpass', freq = 1000, q = 0.7, gain = 0.5, attack = 0.001, decay = dur, seed = 7 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur + 0.05, seed);
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t); src.stop(t + dur + 0.05);
  return { src, f, g };
}

function tone(ctx, out, t, dur, { type = 'sine', freq = 440, to = null, glide = dur, gain = 0.5, attack = 0.002, decay = dur } = {}) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + glide);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 0.02);
  return { o, g };
}

// ---- drum voices ----
function kick(ctx, out, t, v = 1) {
  tone(ctx, out, t, 0.5, { freq: 160, to: 42, glide: 0.12, gain: 0.95 * v, decay: 0.45 });
  noise(ctx, out, t, 0.02, { type: 'highpass', freq: 2500, gain: 0.25 * v, decay: 0.018, seed: 3 });
}
function snare(ctx, out, t, v = 1, send = null) {
  const n = noise(ctx, out, t, 0.22, { type: 'bandpass', freq: 1900, q: 0.8, gain: 0.55 * v, decay: 0.2, seed: 11 });
  if (send) n.g.connect(send);
  tone(ctx, out, t, 0.12, { type: 'triangle', freq: 200, to: 160, glide: 0.08, gain: 0.35 * v, decay: 0.11 });
}
function clap(ctx, out, t, v = 1, send = null) {
  for (let i = 0; i < 3; i++) noise(ctx, out, t + i * 0.011, 0.03, { type: 'bandpass', freq: 1150, q: 1.1, gain: 0.45 * v, decay: 0.028, seed: 20 + i });
  const tail = noise(ctx, out, t + 0.033, 0.26, { type: 'bandpass', freq: 1150, q: 1, gain: 0.42 * v, decay: 0.24, seed: 25 });
  if (send) tail.g.connect(send);
}
function hat(ctx, out, t, v = 1, open = false) {
  noise(ctx, out, t, open ? 0.32 : 0.06, { type: 'highpass', freq: 7200, gain: 0.26 * v, decay: open ? 0.3 : 0.045, seed: 31 });
}
function bassNote(ctx, out, t, len, freq, { type = 'sawtooth', cutoff = 900, gain = 0.32 } = {}) {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = freq;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.Q.value = 4;
  f.frequency.setValueAtTime(cutoff * 2.2, t);
  f.frequency.exponentialRampToValueAtTime(cutoff * 0.6, t + Math.min(0.25, len));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.006);
  g.gain.setValueAtTime(gain, t + Math.max(0.01, len - 0.05));
  g.gain.linearRampToValueAtTime(0.0001, t + len);
  o.connect(f); f.connect(g); g.connect(out);
  o.start(t); o.stop(t + len + 0.02);
}
function sub808(ctx, out, t, len, freq) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq * 1.8, t);
  o.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
  shaper.curve = curve;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.2, len));
  o.connect(shaper); shaper.connect(g); g.connect(out);
  o.start(t); o.stop(t + len + 0.05);
}
function padChord(ctx, out, t, len, freqs, { gain = 0.05, cutoff = 1400, send = null } = {}) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + Math.min(0.35, len / 3));
  g.gain.setValueAtTime(gain, t + len * 0.8);
  g.gain.linearRampToValueAtTime(0.0001, t + len);
  f.connect(g); g.connect(out);
  if (send) g.connect(send);
  for (const fr of freqs) {
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = fr; o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + len + 0.05);
    }
  }
}
function pluck(ctx, out, t, freq, { gain = 0.12, type = 'square', send = null } = {}) {
  const o = ctx.createOscillator();
  o.type = type; o.frequency.value = freq;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(3600, t);
  f.frequency.exponentialRampToValueAtTime(500, t + 0.18);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  o.connect(f); f.connect(g); g.connect(out);
  if (send) g.connect(send);
  o.start(t); o.stop(t + 0.3);
}

function masterChain(ctx, { lowpass = 0 } = {}) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 3.5; comp.attack.value = 0.005; comp.release.value = 0.18;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  if (lowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = lowpass; lp.Q.value = 0.5;
    lp.connect(comp);
    comp.connect(out);
    out.connect(ctx.destination);
    return lp;
  }
  comp.connect(out);
  out.connect(ctx.destination);
  return comp;
}

function reverbSend(ctx, dest, level = 0.25, dur = 1.8) {
  const conv = ctx.createConvolver();
  conv.buffer = reverbImpulse(ctx, dur);
  const g = ctx.createGain();
  g.gain.value = level;
  g.connect(conv); conv.connect(dest);
  return g;
}

export async function renderSfx(id) {
  const meta = SFX_LIST.find((s) => s.id === id);
  if (!meta) throw new Error(`Unknown effect ${id}`);
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * meta.dur), SR);
  const out = masterChain(ctx);
  const t = 0.005;
  switch (id) {
    case 'whoosh': {
      const n = noise(ctx, out, t, 1.35, { type: 'bandpass', freq: 400, q: 1.8, gain: 0.0001, decay: 1.35, seed: 41 });
      n.f.frequency.setValueAtTime(380, t);
      n.f.frequency.exponentialRampToValueAtTime(2800, t + 0.7);
      n.f.frequency.exponentialRampToValueAtTime(500, t + 1.35);
      n.g.gain.cancelScheduledValues(t);
      n.g.gain.setValueAtTime(0.0001, t);
      n.g.gain.linearRampToValueAtTime(0.9, t + 0.7);
      n.g.gain.linearRampToValueAtTime(0.0001, t + 1.35);
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(-0.9, t);
      pan.pan.linearRampToValueAtTime(0.9, t + 1.35);
      n.g.disconnect(); n.g.connect(pan); pan.connect(out);
      break;
    }
    case 'riser': {
      const o = tone(ctx, out, t, 2.95, { type: 'sawtooth', freq: 180, to: 1500, glide: 2.9, gain: 0.0001, decay: 2.95 });
      o.g.gain.cancelScheduledValues(t);
      o.g.gain.setValueAtTime(0.0001, t);
      o.g.gain.exponentialRampToValueAtTime(0.28, t + 2.85);
      o.g.gain.linearRampToValueAtTime(0.0001, t + 2.95);
      const n = noise(ctx, out, t, 2.95, { type: 'highpass', freq: 500, gain: 0.0001, decay: 2.95, seed: 52 });
      n.f.frequency.exponentialRampToValueAtTime(6500, t + 2.9);
      n.g.gain.cancelScheduledValues(t);
      n.g.gain.setValueAtTime(0.0001, t);
      n.g.gain.exponentialRampToValueAtTime(0.35, t + 2.85);
      n.g.gain.linearRampToValueAtTime(0.0001, t + 2.95);
      break;
    }
    case 'impact': {
      const send = reverbSend(ctx, out, 0.5, 2.2);
      const b = tone(ctx, out, t, 2.4, { freq: 72, to: 28, glide: 0.6, gain: 1, decay: 2.2 });
      b.g.connect(send);
      const n = noise(ctx, out, t, 0.6, { type: 'lowpass', freq: 900, gain: 0.7, decay: 0.5, seed: 61 });
      n.g.connect(send);
      break;
    }
    case 'drop': tone(ctx, out, t, 0.85, { freq: 900, to: 55, glide: 0.8, gain: 0.6, decay: 0.85 }); break;
    case 'pop': tone(ctx, out, t, 0.2, { freq: 380, to: 1150, glide: 0.05, gain: 0.7, decay: 0.15 }); break;
    case 'ding': {
      tone(ctx, out, t, 1.55, { freq: 1318.5, gain: 0.35, decay: 1.5 });
      tone(ctx, out, t, 1.0, { freq: 1975.5, gain: 0.18, decay: 0.95 });
      tone(ctx, out, t, 0.5, { freq: 2637, gain: 0.08, decay: 0.45 });
      break;
    }
    case 'click': noise(ctx, out, t, 0.05, { type: 'bandpass', freq: 3200, q: 2, gain: 0.8, decay: 0.04, seed: 71 }); break;
    case 'shutter': {
      noise(ctx, out, t, 0.04, { type: 'bandpass', freq: 2600, q: 1.5, gain: 0.9, decay: 0.035, seed: 81 });
      noise(ctx, out, t + 0.09, 0.2, { type: 'highpass', freq: 1800, gain: 0.35, decay: 0.18, seed: 82 });
      noise(ctx, out, t + 0.16, 0.04, { type: 'bandpass', freq: 2200, q: 1.5, gain: 0.7, decay: 0.035, seed: 83 });
      break;
    }
    case 'typing': {
      const r = rng(91);
      let tt = t;
      let i = 0;
      while (tt < meta.dur - 0.1) {
        noise(ctx, out, tt, 0.03, { type: 'bandpass', freq: 2400 + r() * 1800, q: 2.5, gain: 0.45 + r() * 0.35, decay: 0.025, seed: 92 + i });
        tt += 0.07 + r() * 0.11;
        i++;
      }
      break;
    }
    case 'glitch': {
      const r = rng(101);
      for (let k = 0; k < 14; k++) {
        const st = t + k * 0.055;
        tone(ctx, out, st, 0.04, { type: 'square', freq: 120 + r() * 1800, gain: 0.12 + r() * 0.12, decay: 0.04 });
      }
      noise(ctx, out, t + 0.35, 0.12, { type: 'bandpass', freq: 5000, q: 3, gain: 0.3, decay: 0.1, seed: 102 });
      break;
    }
    case 'kick': kick(ctx, out, t); break;
    case 'snare': snare(ctx, out, t); break;
    case 'clap': clap(ctx, out, t); break;
    case 'hat': hat(ctx, out, t, 1, true); break;
    default: break;
  }
  return await ctx.startRendering();
}

function chordsFor(key) {
  const r = key.root;
  // i–VI–III–VII in minor, I–V–vi–IV in major; each chord as MIDI notes.
  const prog = key.minor ? [[0, 3, 7, 10], [-4, 0, 3, 7], [3, 7, 10, 14], [-2, 2, 5, 9]] : [[0, 4, 7, 11], [7, 11, 14, 17], [9, 12, 16, 19], [5, 9, 12, 16]];
  return prog.map((ch) => ch.map((n) => r + n));
}

const SHOT_CACHE = new Map(); // one-shots are deterministic, so keep them across renders

/** Render one voice into a short buffer (a "one-shot"), so the beat can be mixed sample-wise. */
async function oneShot(fn, dur) {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(SR * dur)), SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  fn(ctx, out, 0);
  return await ctx.startRendering();
}

/**
 * Beats are built in three steps for speed: every distinct hit or note is rendered once as a one-shot,
 * the pattern is mixed into Float32 arrays (dry plus a reverb send), and a single final pass applies
 * the reverb, the master compressor and (for lo-fi) the vinyl crackle. Thousands of live nodes would
 * otherwise make OfflineAudioContext take several seconds.
 */
export async function renderBeat({ style = 'lofi', bpm = 90, bars = 8, key = 'Am' } = {}) {
  const k = KEYS.find((x) => x.id === key) || KEYS[0];
  const step = 60 / bpm / 4; // sixteenth
  const barLen = step * 16;
  const total = barLen * bars;
  const len = Math.ceil(SR * total);
  const chords = chordsFor(k);
  const r = rng(7 + bpm + bars);
  const swing = style === 'lofi' ? 0.22 : style === 'house' ? 0.06 : 0;
  const at = (bar, s) => bar * barLen + s * step + (s % 2 === 1 ? swing * step : 0);

  const cache = SHOT_CACHE;
  const shot = (keyStr, fn, dur) => {
    if (cache.size > 240) cache.clear();
    if (!cache.has(keyStr)) cache.set(keyStr, oneShot(fn, dur));
    return cache.get(keyStr);
  };
  const events = []; // [promise, time, gain, send]
  const add = (p, t, gain = 1, send = 0) => events.push([p, t, gain, send]);
  const KICK = () => shot('kick', (c, o, t) => kick(c, o, t), 0.55);
  const SNARE = () => shot('snare', (c, o, t) => snare(c, o, t), 0.3);
  const CLAP = () => shot('clap', (c, o, t) => clap(c, o, t), 0.36);
  const HAT = (open) => shot(`hat${open}`, (c, o, t) => hat(c, o, t, 1, open), open ? 0.36 : 0.1);
  const BASS = (freq, l, opts) => shot(`bass:${freq.toFixed(2)}:${l.toFixed(3)}:${opts.type || 'saw'}:${opts.cutoff}`, (c, o, t) => bassNote(c, o, t, l, freq, { ...opts, gain: 1 }), l + 0.03);
  const SUB = (freq, l) => shot(`sub:${freq.toFixed(2)}:${l.toFixed(3)}`, (c, o, t) => sub808(c, o, t, l, freq), l + 0.06);
  const PAD = (freqs, l, cutoff) => shot(`pad:${freqs.map((f) => f.toFixed(1)).join(',')}:${l.toFixed(3)}:${cutoff}`, (c, o, t) => padChord(c, o, t, l, freqs, { gain: 1, cutoff }), l + 0.06);
  const PLUCK = (freq) => shot(`pluck:${freq.toFixed(2)}`, (c, o, t) => pluck(c, o, t, freq, { gain: 1, type: 'sawtooth' }), 0.3);

  for (let bar = 0; bar < bars; bar++) {
    const chord = chords[bar % 4];
    const rootHz = mtof(chord[0] - 24);
    switch (style) {
      case 'lofi':
        [0, 7, 10].forEach((s) => add(KICK(), at(bar, s), s === 0 ? 1 : 0.8));
        [4, 12].forEach((s) => add(SNARE(), at(bar, s), 0.75, 0.6));
        for (let s = 0; s < 16; s += 2) add(HAT(false), at(bar, s), 0.45 + r() * 0.35);
        add(PAD(chord.map((m) => mtof(m)), barLen, 1100), bar * barLen, 0.045, 0.6);
        add(BASS(rootHz, step * 6, { type: 'triangle', cutoff: 500 }), at(bar, 0), 0.4);
        add(BASS(rootHz, step * 4, { type: 'triangle', cutoff: 500 }), at(bar, 10), 0.35);
        break;
      case 'house':
        [0, 4, 8, 12].forEach((s) => add(KICK(), at(bar, s)));
        [4, 12].forEach((s) => add(CLAP(), at(bar, s), 0.8, 0.5));
        [2, 6, 10, 14].forEach((s) => add(HAT(true), at(bar, s), 0.7));
        for (let s = 1; s < 16; s += 2) add(HAT(false), at(bar, s), 0.25);
        [2, 6, 10, 14].forEach((s) => add(BASS(rootHz * 2, step * 1.6, { cutoff: 700 }), at(bar, s), 0.3));
        [3, 11].forEach((s) => add(PAD(chord.map((m) => mtof(m + 12)), step * 1.5, 2400), at(bar, s), 0.05, 0.5));
        break;
      case 'synthwave':
        [0, 8].forEach((s) => add(KICK(), at(bar, s)));
        [4, 12].forEach((s) => add(SNARE(), at(bar, s), 0.95, 0.7));
        for (let s = 0; s < 16; s++) add(HAT(false), at(bar, s), s % 4 === 2 ? 0.45 : 0.2);
        for (let s = 0; s < 16; s++) add(BASS(rootHz * (s % 2 ? 2 : 1), step * 0.9, { cutoff: 600 }), at(bar, s), 0.26);
        add(PAD(chord.map((m) => mtof(m)), barLen, 1800), bar * barLen, 0.04, 0.6);
        for (let s = 0; s < 16; s++) {
          const note = chord[s % chord.length] + 12 + (Math.floor(s / 4) % 2 ? 12 : 0);
          add(PLUCK(mtof(note)), at(bar, s), 0.07, 0.6);
        }
        break;
      case 'trap':
        [0, 7, 11].forEach((s) => { add(KICK(), at(bar, s), 0.9); add(SUB(rootHz, step * 3.5), at(bar, s), 1); });
        add(CLAP(), at(bar, 8), 0.9, 0.5);
        add(SNARE(), at(bar, 8), 0.6);
        for (let s = 0; s < 16; s++) {
          add(HAT(false), at(bar, s), 0.35 + (s % 4 === 0 ? 0.2 : 0));
          if (s >= 12 && bar % 2 === 1) add(HAT(false), at(bar, s) + step / 2, 0.3); // rolls
        }
        add(PAD(chord.map((m) => mtof(m + 12)), barLen, 1600), bar * barLen, 0.03, 0.5);
        break;
      default: break;
    }
  }

  // Mix every event into dry and reverb-send buses.
  const dryL = new Float32Array(len), dryR = new Float32Array(len);
  const wetL = new Float32Array(len), wetR = new Float32Array(len);
  const resolved = await Promise.all(events.map((e) => e[0]));
  events.forEach(([, t, gain, send], idx) => {
    const buf = resolved[idx];
    const off = Math.round(t * SR);
    if (off >= len) return;
    const a = buf.getChannelData(0);
    const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
    const n = Math.min(buf.length, len - off);
    for (let i = 0; i < n; i++) {
      const l = a[i] * gain, rr = b[i] * gain;
      dryL[off + i] += l; dryR[off + i] += rr;
      if (send) { wetL[off + i] += l * send; wetR[off + i] += rr * send; }
    }
  });

  // Final pass in plain JS (no second audio graph): reverb, lo-fi filter + crackle, then a soft limiter.
  const wetLevel = style === 'synthwave' ? 0.85 : 0.55;
  const revL = freeverb(wetL, 0), revR = freeverb(wetR, 23);
  for (let i = 0; i < len; i++) { dryL[i] += revL[i] * wetLevel; dryR[i] += revR[i] * wetLevel; }
  if (style === 'lofi') {
    const crackle = new Float32Array(len);
    const rr = rng(5);
    for (let i = 0; i < len; i++) crackle[i] = (rr() * 2 - 1) * 0.05;
    biquadInPlace(crackle, 'bandpass', 3000, 0.4);
    for (let i = 0; i < len; i++) { dryL[i] += crackle[i]; dryR[i] += crackle[i]; }
    biquadInPlace(dryL, 'lowpass', 4600, 0.5);
    biquadInPlace(dryR, 'lowpass', 4600, 0.5);
  }
  limit(dryL, dryR);
  const outBuf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SR });
  outBuf.copyToChannel(dryL, 0);
  outBuf.copyToChannel(dryR, 1);
  return outBuf;
}

/** Freeverb-style reverb: 8 damped feedback combs into 4 allpasses. Fast enough to run on the main thread. */
function freeverb(input, spread, room = 0.84, damp = 0.25) {
  const n = input.length;
  const out = new Float32Array(n);
  for (const base of [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]) {
    const L = base + spread;
    const buf = new Float32Array(L);
    let idx = 0, store = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[idx];
      store = y * (1 - damp) + store * damp;
      buf[idx] = input[i] * 0.015 + store * room;
      out[i] += y;
      if (++idx >= L) idx = 0;
    }
  }
  for (const base of [556, 441, 341, 225]) {
    const L = base + spread;
    const buf = new Float32Array(L);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[idx];
      const x = out[i];
      buf[idx] = x + b * 0.5;
      out[i] = b - x;
      if (++idx >= L) idx = 0;
    }
  }
  return out;
}

/** RBJ biquad (lowpass or constant-peak bandpass), applied in place. */
function biquadInPlace(arr, type, f0, Q) {
  const w0 = (2 * Math.PI * f0) / SR;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  let b0, b1, b2;
  if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; } else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    arr[i] = y;
  }
}

/** Normalize to about -1 dBFS with a gentle tanh knee so stacked hits never clip. */
function limit(L, R) {
  let peak = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
  if (!peak) return;
  const drive = 1.3, norm = Math.tanh(drive);
  const pre = Math.min(1.6, 0.95 / peak) ;
  for (let i = 0; i < L.length; i++) {
    L[i] = (Math.tanh(L[i] * pre * drive) / norm) * 0.89;
    R[i] = (Math.tanh(R[i] * pre * drive) / norm) * 0.89;
  }
}
