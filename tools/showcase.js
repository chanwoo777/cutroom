// Dev-only: builds the 1080p60 showcase sequence used for the README video (load from the console:
// `const S = await import('/tools/showcase.js'); await S.buildShowcase(window.cutroom)`).
// Footage is synthesised here with WebCodecs so the demo needs no external media.
import { makeFixture } from './bench.js';
import { makeClip, splitClip } from '../js/core/ops.js';

const W = 1920, H = 1080, FPS = 60;

async function encodeScene(name, seconds, draw) {
  const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer/5.2.2/mp4-muxer.mjs');
  const n = Math.round(seconds * FPS);
  const mux = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: FPS }, fastStart: 'in-memory' });
  const enc = new VideoEncoder({ output: (c, m) => mux.addVideoChunk(c, m), error: (e) => { throw e; } });
  enc.configure({ codec: 'avc1.64002A', width: W, height: H, framerate: FPS, bitrate: 30e6, avc: { format: 'avc' } });
  const cv = new OffscreenCanvas(W, H);
  const g = cv.getContext('2d');
  for (let i = 0; i < n; i++) {
    draw(g, i / FPS, i);
    const f = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(f, { keyFrame: i % FPS === 0 });
    f.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush();
  mux.finalize();
  return new File([mux.target.buffer], name, { type: 'video/mp4' });
}

/** Dusk: sky, a setting sun and three hill layers scrolling at different speeds (parallax). */
function dusk(g, t) {
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1d2b5a'); sky.addColorStop(0.55, '#e0785a'); sky.addColorStop(1, '#f6c27a');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const sy = H * 0.42 + t * 26;
  const sun = g.createRadialGradient(W * 0.62, sy, 10, W * 0.62, sy, 220);
  sun.addColorStop(0, 'rgba(255,240,200,1)'); sun.addColorStop(0.35, 'rgba(255,200,130,0.9)'); sun.addColorStop(1, 'rgba(255,170,110,0)');
  g.fillStyle = sun; g.beginPath(); g.arc(W * 0.62, sy, 220, 0, Math.PI * 2); g.fill();
  for (let c = 0; c < 5; c++) {
    const x = ((c * 520 + t * (30 + c * 8)) % (W + 600)) - 300;
    g.fillStyle = 'rgba(255,220,200,0.18)';
    g.beginPath(); g.ellipse(x, 160 + c * 70, 180, 26, 0, 0, Math.PI * 2); g.fill();
  }
  const layers = [['#7a3b52', 0.52, 60, 90], ['#4a2440', 0.64, 140, 70], ['#24142b', 0.78, 300, 50]];
  for (const [col, base, speed, amp] of layers) {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) {
      const u = (x + t * speed) / W;
      g.lineTo(x, H * base + Math.sin(u * 6.2) * amp + Math.sin(u * 17.3) * amp * 0.3);
    }
    g.lineTo(W, H); g.fill();
  }
}

/** Night lights: drifting bokeh discs over a deep blue field. */
const BOKEH = Array.from({ length: 46 }, (_, i) => ({ x: (i * 397) % W, y: (i * 233) % H, r: 30 + ((i * 53) % 90), s: 20 + ((i * 31) % 70), hue: [18, 32, 200, 340, 48][i % 5], a: 0.18 + ((i * 17) % 30) / 100 }));
function lights(g, t) {
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#070a18'); bg.addColorStop(1, '#14102a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  for (const b of BOKEH) {
    const x = (b.x + t * b.s) % (W + 200) - 100, y = b.y + Math.sin(t * 0.8 + b.x) * 18;
    const grd = g.createRadialGradient(x, y, b.r * 0.2, x, y, b.r);
    grd.addColorStop(0, `hsla(${b.hue} 90% 70% / ${b.a})`); grd.addColorStop(0.8, `hsla(${b.hue} 90% 60% / ${b.a * 0.7})`); grd.addColorStop(1, `hsla(${b.hue} 90% 60% / 0)`);
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, b.r, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}

function pad(seconds, sr = 48000) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * sr), sr);
  const buf = ctx.createBuffer(2, Math.round(seconds * sr), sr);
  const notes = [[0, [220, 277.18, 329.63]], [4.5, [196, 246.94, 293.66]], [8.5, [174.61, 220, 261.63]]];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let seg = notes[0];
      for (const n of notes) if (t >= n[0]) seg = n;
      const lt = t - seg[0];
      const env = Math.min(1, lt / 0.8) * Math.min(1, (seconds - t) / 1.2);
      let v = 0;
      for (const [k, f] of seg[1].entries()) v += Math.sin(2 * Math.PI * f * (1 + (ch ? 0.002 : -0.002)) * t + k) / 3;
      const kick = Math.exp(-((t % 0.5) * 18)) * Math.sin(2 * Math.PI * 55 * (t % 0.5)) * 0.5;
      d[i] = (v * 0.22 + kick * 0.35) * env;
    }
  }
  return buf;
}

export async function buildShowcase(c) {
  const { store, assets, actions } = c;
  store.project.title = 'Cutroom 1080p60 showcase';
  const [fDusk, fLights, fCount] = await Promise.all([
    encodeScene('dusk-1080p60.mp4', 5.5, dusk),
    encodeScene('lights-1080p60.mp4', 5, lights),
    makeFixture({ seconds: 5, name: 'frame-counter-1080p60.mp4' }),
  ]);
  const aDusk = await assets.importFile(fDusk);
  const aLights = await assets.importFile(fLights);
  const aCount = await assets.importFile(fCount);
  const v1 = 'v1', v2 = 'v2';
  const dClip = actions.addAsset(aDusk, { start: 0, trackId: v1 });
  dClip.duration = 4.5; dClip.fx.lut = 'golden'; dClip.fx.lutAmount = 60; dClip.fx.vignette = 22;
  const lClip = actions.addAsset(aLights, { start: 4.5, trackId: v1 });
  lClip.duration = 4; lClip.fx.lut = 'cyberpunk'; lClip.fx.lutAmount = 55;
  lClip.transition = { type: 'dissolve', duration: 0.8 };
  const cClip = actions.addAsset(aCount, { start: 8.5, trackId: v1 });
  cClip.duration = 3.5; cClip.transition = { type: 'wipe-left', duration: 0.6 };
  const pip = actions.addAsset(aCount, { start: 1, trackId: v2 });
  pip.duration = 3; pip.in = 0.5; pip.transform = { ...pip.transform, scale: 0.28, x: 0.8, y: 0.23 };
  pip.introAnimation = { type: 'pop', duration: 0.45 }; pip.outroAnimation = { type: 'fade', duration: 0.35 };
  const pip2 = actions.addAsset(aDusk, { start: 5, trackId: v2 });
  pip2.duration = 3; pip2.transform = { ...pip2.transform, scale: 0.3, x: 0.2, y: 0.74, rotation: -4 };
  pip2.introAnimation = { type: 'slide', duration: 0.5 }; pip2.outroAnimation = { type: 'fade', duration: 0.4 };
  pip2.fx.lut = 'teal-orange';
  const T = (content, start, duration, props = {}) => {
    const clip = makeClip('text', { name: content, duration, ...props, text: { content, ...(props.text || {}) } });
    return actions.addClip(clip, { start, label: 'Add text' });
  };
  T('Cutroom', 0.2, 2.6, { text: { size: 0.16, weight: 800, font: 'grotesk' }, transform: { y: 0.46 }, introAnimation: { type: 'pop', duration: 0.6 }, outroAnimation: { type: 'fade', duration: 0.5 } });
  T('GPU compositor · 1080p · 60 fps', 2.9, 3.4, { text: { size: 0.045, weight: 700, align: 'left', bg: true, bgColor: '#14171d', color: '#e7eaf0', shadow: false, lineHeight: 1.3 }, transform: { x: 0.25, y: 0.86 }, introAnimation: { type: 'slide', duration: 0.45 }, outroAnimation: { type: 'fade', duration: 0.4 } });
  T('Cross dissolve', 4.6, 2.2, { text: { size: 0.06, weight: 700 }, transform: { y: 0.82 }, introAnimation: { type: 'fade', duration: 0.4 }, outroAnimation: { type: 'fade', duration: 0.4 } });
  T('Every frame rendered offline,\nnone dropped', 8.8, 3.1, { text: { size: 0.055, weight: 700, font: 'mono', color: '#ffffff', bg: true, bgColor: '#0b0d10' }, transform: { y: 0.78 }, introAnimation: { type: 'typewriter', duration: 1.2 }, outroAnimation: { type: 'fade', duration: 0.3 } });
  const music = assets.addBuffer('Pad and kick (synth)', pad(12));
  const mClip = actions.addAsset(music, { start: 0, trackId: 'a2' });
  mClip.fadeOut = 1; mClip.volume = 0.8;
  store.commit('Showcase');
  store.clearSelection();
  c.timeline.zoomFit();
  return store.project.clips.length;
}
