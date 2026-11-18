// "Build a demo cut": generates sample media entirely on this device (two cut-paper stills drawn on a
// canvas, a 4-second clip recorded from a canvas with MediaRecorder, a synth beat and a whoosh), then
// assembles a short sequence. Every piece is labelled as sample material.
import { formatTC, once } from './util.js';
import { makeClip, addTrack } from './core/ops.js';
import { renderBeat, renderSfx } from './engine/synth.js';

const PAPER = { graphite: '#24221f', ink: '#1c1b19', slate: '#4f6b86', slateDeep: '#3c536a', ochre: '#b98a2e', bone: '#e6e0d2', boneDeep: '#c4bba7', red: '#d8382b' };

function slip(ctx, pts, color, shadow = true) {
  if (shadow) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + 8, y + 10) : ctx.moveTo(x + 8, y + 10)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

function hill(W, base, amp, phase, n = 7) {
  const pts = [[0, 1080]];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * W;
    pts.push([x, base - Math.abs(Math.sin(i * 1.3 + phase)) * amp]);
  }
  pts.push([W, 1080]);
  return pts;
}

function paperScene(kind) {
  const c = document.createElement('canvas');
  c.width = 1920; c.height = 1080;
  const ctx = c.getContext('2d');
  const W = 1920;
  if (kind === 'dusk') {
    ctx.fillStyle = PAPER.slateDeep; ctx.fillRect(0, 0, W, 1080);
    ctx.fillStyle = PAPER.slate; ctx.fillRect(0, 360, W, 720);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(1388, 418, 170, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PAPER.red; ctx.beginPath(); ctx.arc(1380, 408, 170, 0, Math.PI * 2); ctx.fill();
    slip(ctx, hill(W, 700, 160, 0.4), PAPER.boneDeep);
    slip(ctx, hill(W, 820, 140, 2.1, 6), PAPER.ochre);
    slip(ctx, hill(W, 940, 90, 4.2, 9), PAPER.graphite);
  } else {
    ctx.fillStyle = PAPER.ochre; ctx.fillRect(0, 0, W, 1080);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(468, 300, 120, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PAPER.bone; ctx.beginPath(); ctx.arc(460, 290, 120, 0, Math.PI * 2); ctx.fill();
    let x = 0;
    let i = 0;
    while (x < W) {
      const w = 110 + ((i * 73) % 160);
      const h = 300 + ((i * 131) % 420);
      slip(ctx, [[x, 1080], [x, 1080 - h], [x + w, 1080 - h], [x + w, 1080]], i % 3 === 0 ? PAPER.slateDeep : PAPER.graphite);
      ctx.fillStyle = PAPER.bone;
      for (let wy = 1080 - h + 30; wy < 1040; wy += 54) for (let wx = x + 18; wx < x + w - 24; wx += 34) if ((wx * 7 + wy * 3 + i) % 5 < 2) ctx.fillRect(wx, wy, 14, 22);
      x += w + 12;
      i++;
    }
    slip(ctx, [[0, 1080], [0, 1000], [W, 960], [W, 1080]], PAPER.red);
  }
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
}

async function recordClip(audio, secs = 4) {
  if (typeof MediaRecorder === 'undefined') return null;
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(30);
  await audio.resume();
  const actx = audio.ctx;
  const dest = actx.createMediaStreamDestination();
  const g = actx.createGain();
  g.gain.value = 0.06;
  g.connect(dest);
  const oscs = [220, 277.18, 329.63].map((f) => { const o = actx.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.connect(g); o.start(); return o; });
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = once(rec, ['stop']);
  rec.start(250);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const p = Math.min(1, t / secs);
      ctx.fillStyle = PAPER.slate; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = PAPER.slateDeep; ctx.fillRect(0, 470, 1280, 250);
      const bx = -300 + p * 1700;
      slip(ctx, [[bx, 200], [bx + 520, 200], [bx + 440, 420], [bx - 80, 420]], PAPER.red);
      for (let i = 0; i < 6; i++) {
        const cx = ((i * 260 + t * 140) % 1500) - 100;
        ctx.fillStyle = PAPER.bone;
        ctx.beginPath(); ctx.arc(cx, 560 + Math.sin(t * 2 + i) * 30, 34, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(20,19,17,0.8)'; ctx.fillRect(24, 650, 330, 46);
      ctx.fillStyle = PAPER.bone; ctx.font = '600 26px "Cascadia Mono", Consolas, monospace'; ctx.textBaseline = 'middle';
      ctx.fillText(`SAMPLE ${formatTC(t, 30)}`, 38, 674);
      if (t < secs) requestAnimationFrame(draw); else resolve();
    };
    draw();
  });
  rec.stop();
  await stopped;
  oscs.forEach((o) => o.stop());
  g.disconnect();
  stream.getVideoTracks().forEach((tr) => tr.stop());
  return new Blob(chunks, { type: mime.split(';')[0] });
}

export async function buildDemo({ store, assets, audio, onProgress = () => {} }) {
  onProgress('Drawing sample stills…');
  const [dusk, city] = await Promise.all([paperScene('dusk'), paperScene('city')]);
  const aDusk = await assets.importFile(new File([dusk], 'Sample · paper dusk.png', { type: 'image/png' }));
  const aCity = await assets.importFile(new File([city], 'Sample · paper city.png', { type: 'image/png' }));
  onProgress('Recording a 4-second sample clip…');
  const vblob = await recordClip(audio, 4);
  const ext = vblob?.type.includes('mp4') ? 'mp4' : 'webm';
  const aVid = vblob ? await assets.importFile(new File([vblob], `Sample · paper sweep.${ext}`, { type: vblob.type })) : null;
  onProgress('Synthesizing music…');
  const beat = assets.addBuffer('Sample · Lo-fi 84 BPM', await renderBeat({ style: 'lofi', bpm: 84, bars: 8, key: 'Am' }));
  const whoosh = assets.addBuffer('Whoosh', await renderSfx('whoosh'));

  const p = store.project;
  const fps = p.fps;
  const v1 = p.tracks.find((t) => t.name === 'V1') || p.tracks.filter((t) => t.kind === 'video').pop();
  const v2 = p.tracks.find((t) => t.name === 'V2') || addTrack(p, 'video');
  const v3 = addTrack(p, 'video');
  const a1 = p.tracks.find((t) => t.kind === 'audio');
  const a2 = p.tracks.filter((t) => t.kind === 'audio')[1] || addTrack(p, 'audio');
  const clips = [];
  let t = 0;
  if (aVid) {
    const d = Math.floor(Math.min(4, aVid.duration) * fps) / fps;
    clips.push(makeClip('video', { assetId: aVid.id, name: aVid.name, trackId: v1.id, start: 0, duration: d, fadeOut: 0.3 }));
    t = d;
  }
  if (aDusk) {
    clips.push(makeClip('image', { assetId: aDusk.id, name: aDusk.name, trackId: v1.id, start: t, duration: 5, motion: 'zoom-in', fit: 'cover', fx: { lut: 'teal-orange', lutAmount: 70, vignette: 35 } }));
    t += 5;
  }
  if (aCity) {
    clips.push(makeClip('image', { assetId: aCity.id, name: aCity.name, trackId: v1.id, start: t, duration: 5, motion: 'zoom-out', fit: 'cover', fx: { lut: 'golden', lutAmount: 80, contrast: 10 }, introAnimation: { type: 'none', duration: 0.8 }, outroAnimation: { type: 'fade', duration: 0.8 } }));
    t += 5;
  }
  clips.push(makeClip('text', { name: 'Title', trackId: v2.id, start: 0.4, duration: 3.2, text: { content: 'Cutroom', size: 0.16, weight: 900 }, introAnimation: { type: 'pop', duration: 0.5 }, outroAnimation: { type: 'fade', duration: 0.5 } }));
  clips.push(makeClip('text', { name: 'Lower third', trackId: v2.id, start: 4.5, duration: 4, text: { content: 'Paper dusk\nSample still, drawn in your browser', size: 0.042, weight: 700, align: 'left', bg: true, bgColor: '#e6e0d2', color: '#1c1b19', shadow: false, lineHeight: 1.3 }, transform: { x: 0.3, y: 0.8 }, introAnimation: { type: 'slide', duration: 0.45 }, outroAnimation: { type: 'fade', duration: 0.45 } }));
  clips.push(makeClip('text', { name: 'Caption', trackId: v2.id, start: 9.5, duration: 4, text: { content: 'Every frame stays on this device.', size: 0.05, weight: 700, bg: true, bgColor: '#141311', shadow: false }, transform: { y: 0.86 }, introAnimation: { type: 'typewriter', duration: 1.4 }, outroAnimation: { type: 'fade', duration: 1.4 } }));
  clips.push(makeClip('sticker', { name: 'Star', trackId: v3.id, start: 5.2, duration: 3, sticker: { shape: 'star', color: '#d8382b', size: 0.2 }, transform: { x: 0.84, y: 0.2, rotation: 12 }, introAnimation: { type: 'pop', duration: 0.35 }, outroAnimation: { type: 'fade', duration: 0.35 } }));
  clips.push(makeClip('audio', { assetId: whoosh.id, name: whoosh.name, trackId: a1.id, start: Math.max(0, (aVid ? 4 : 0) - 0.7), duration: Math.floor(whoosh.duration * fps) / fps, volume: 0.8 }));
  clips.push(makeClip('audio', { assetId: beat.id, name: beat.name, trackId: a2.id, start: 0, duration: Math.min(Math.floor(beat.duration * fps) / fps, Math.max(t, 6)), volume: 0.85, fadeOut: 2 }));
  p.clips.push(...clips);
  if (p.title === 'Untitled cut') p.title = 'Demo cut';
  store.commit('Build demo cut');
}
