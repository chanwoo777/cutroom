// Voice-over commands: speak a text clip, voice several at once, or narrate a script into one voice track
// with captions timed to each sentence. Generated audio is an ordinary audio asset, so it mixes, shows a
// waveform and exports like anything else.
import { quantize } from '../util.js';
import { makeClip, findFreeTrack, addTrack, isRangeFree, clipEnd, overwriteRange } from '../core/ops.js';
import { VoiceEngine, detectLang, stepsFor } from '../engine/voice.js';
import { toast, announce } from '../ui/dom.js';

const snippet = (s, n = 28) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Split a script into caption-sized sentences (keeps Korean and CJK sentence endings). */
export function splitScript(script) {
  const out = [];
  for (const line of String(script || '').split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    const parts = l.split(/(?<=[.!?。！？…])\s+/);
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (s.length > 90) {
        // Long sentences become two captions at the comma nearest the middle.
        const mid = s.length / 2;
        let cut = -1;
        for (let i = 0; i < s.length; i++) if (/[,，、;]/.test(s[i]) && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
        if (cut > 10 && cut < s.length - 10) { out.push(s.slice(0, cut + 1).trim(), s.slice(cut + 1).trim()); continue; }
      }
      out.push(s);
    }
  }
  return out;
}

export function createVoiceover({ store, assets, voice }) {
  const fps = () => store.project.fps;

  function resolveLang(settings, text) {
    return settings.lang === 'auto' ? detectLang(text) : settings.lang;
  }

  async function speak(text, settings, onStep, gap = 0.3) {
    const lang = resolveLang(settings, text);
    const res = await voice.synthesize({ text, lang, voice: settings.voice, speed: settings.speed, steps: stepsFor(settings.quality), gap }, onStep);
    return { ...res, lang, buffer: VoiceEngine.toAudioBuffer(res.pcm, res.sampleRate) };
  }

  function placeAudio(project, asset, start, dur, preferTrack, extra = {}) {
    let trackId = preferTrack && isRangeFree(project, preferTrack, start, start + dur) ? preferTrack : null;
    trackId ||= findFreeTrack(project, 'audio', start, start + dur) || addTrack(project, 'audio').id;
    const clip = makeClip('audio', { assetId: asset.id, name: asset.name, start, duration: dur, trackId, ...extra });
    project.clips.push(clip);
    return clip;
  }

  /** Generate (or regenerate) the voice-over for one text clip. Returns the new audio clip id. */
  async function voiceText(clipId, settings, { onStep, commit = true } = {}) {
    const c0 = store.getClip(clipId);
    if (!c0 || c0.kind !== 'text') throw new Error('Select a text clip first.');
    const text = String(c0.text.content || '').trim();
    if (!text) throw new Error('This text clip is empty.');
    const res = await speak(text, settings, onStep);
    const project = store.project;
    const c = store.getClip(clipId);
    if (!c) throw new Error('The text clip was deleted while its voice was being generated.');
    const f = 1 / fps();
    const dur = Math.max(f, Math.ceil(res.buffer.duration * fps()) / fps());
    const asset = assets.addBuffer(`Voice · ${settings.voice} · ${snippet(text)}`, res.buffer, { source: 'voice', voiceText: text, lang: res.lang });
    const prev = c.voice?.clipId ? store.getClip(c.voice.clipId) : null;
    const preferTrack = prev?.trackId || project.tracks.find((t) => t.kind === 'audio' && t.role === 'Dialogue')?.id;
    if (prev) project.clips = project.clips.filter((x) => x.id !== prev.id);
    const audioClip = placeAudio(project, asset, c.start, dur, preferTrack, { voiceOf: c.id });
    c.voice = { clipId: audioClip.id, voice: settings.voice, lang: res.lang, speed: settings.speed, quality: settings.quality, text };
    if (settings.fit) {
      const next = Math.min(Infinity, ...project.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id && x.start >= c.start + 1e-6).map((x) => x.start));
      const want = quantize(dur + 0.2, fps());
      const room = next - c.start;
      c.duration = Math.max(f, Math.min(want, room));
      if (want > room + 1e-6) toast(`The voice runs ${(want - room).toFixed(1)} s past the next clip on ${store.getTrack(c.trackId)?.name}. The text was fitted up to that clip.`);
    }
    if (commit) store.commit(prev ? 'Regenerate voice-over' : 'Voice-over');
    announce(`Voice-over added, ${dur.toFixed(1)} seconds`);
    return audioClip.id;
  }

  async function voiceTexts(ids, settings, onProgress) {
    const list = ids.map((id) => store.getClip(id)).filter((c) => c?.kind === 'text' && String(c.text.content || '').trim());
    if (!list.length) throw new Error('Select one or more text clips with words in them.');
    let n = 0;
    for (const c of list) {
      onProgress?.(n, list.length, c);
      await voiceText(c.id, settings, { commit: false });
      n++;
    }
    store.commit(n > 1 ? `Voice-over ${n} texts` : 'Voice-over');
    return n;
  }

  /** Narrate a script: one continuous voice clip plus a caption per sentence, timed to the speech. */
  async function narrate(script, settings, { start = store.time, onProgress } = {}) {
    const sentences = splitScript(script);
    if (!sentences.length) throw new Error('Write a script first.');
    const gapSec = 0.28;
    const results = [];
    for (let i = 0; i < sentences.length; i++) {
      onProgress?.(i, sentences.length);
      results.push(await speak(sentences[i], settings, null));
    }
    onProgress?.(sentences.length, sentences.length);
    const sr = results[0].sampleRate;
    const gapLen = Math.round(gapSec * sr);
    const total = results.reduce((s, r) => s + r.pcm.length, 0) + gapLen * (results.length - 1);
    const pcm = new Float32Array(total);
    const timings = [];
    let at = 0;
    results.forEach((r, i) => {
      pcm.set(r.pcm, at);
      timings.push({ text: sentences[i], start: at / sr, end: (at + r.pcm.length) / sr });
      at += r.pcm.length + gapLen;
    });
    const buffer = VoiceEngine.toAudioBuffer(pcm, sr);
    const project = store.project;
    const s0 = quantize(Math.max(0, start), fps());
    const dur = Math.ceil(buffer.duration * fps()) / fps();
    const asset = assets.addBuffer(`Narration · ${settings.voice} · ${snippet(sentences[0])}`, buffer, { source: 'voice', voiceText: script, lang: results[0].lang });
    const audioClip = placeAudio(project, asset, s0, dur, project.tracks.find((t) => t.kind === 'audio' && t.role === 'Dialogue')?.id);
    const created = [audioClip.id];
    if (settings.captions) {
      const capEnd = s0 + dur + 0.2;
      const trackId = findFreeTrack(project, 'text', s0, capEnd) || addTrack(project, 'video').id;
      timings.forEach((tm, i) => {
        const cs = quantize(s0 + tm.start, fps());
        const nextStart = i + 1 < timings.length ? quantize(s0 + timings[i + 1].start, fps()) : quantize(s0 + tm.end + 0.25, fps());
        const cap = makeClip('text', {
          name: `Caption ${i + 1}`, trackId, start: cs, duration: Math.max(1 / fps(), nextStart - cs),
          text: { content: tm.text, size: 0.05, weight: 700, bg: true, bgColor: '#141311', color: '#ffffff', shadow: false, lineHeight: 1.2 },
          transform: { y: 0.86 }, introAnimation: { type: 'fade', duration: 0.12 }, outroAnimation: { type: 'none', duration: 0.12 }, voiceOf: audioClip.id,
        });
        overwriteRange(project, trackId, cap.start, clipEnd(cap), new Set(), fps());
        project.clips.push(cap);
        created.push(cap.id);
      });
    }
    store.select(created);
    store.commit('Narrate script');
    return { clips: created.length, duration: dur, sentences: sentences.length };
  }

  return { voiceText, voiceTexts, narrate, resolveLang, speak };
}
