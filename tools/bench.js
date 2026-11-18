// Dev-only benchmark helpers (loaded manually from the console; not imported by the app).
// makeFixture(): a deterministic 1080p60 H.264 test clip with burned-in frame numbers, built with WebCodecs.
// benchRender(): times the compositor at the current program-canvas size.
export async function makeFixture({ w = 1920, h = 1080, fps = 60, seconds = 5, name = 'fixture-1080p60.mp4' } = {}) {
  const { Muxer, ArrayBufferTarget } = await import('../vendor/mp4-muxer/5.2.2/mp4-muxer.mjs');
  const n = Math.round(fps * seconds);
  const mux = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
  const enc = new VideoEncoder({ output: (c, m) => mux.addVideoChunk(c, m), error: (e) => { throw e; } });
  enc.configure({ codec: 'avc1.64002A', width: w, height: h, framerate: fps, bitrate: 25e6, avc: { format: 'avc' } });
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d');
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, `hsl(${(t * 40) % 360} 45% 22%)`);
    grd.addColorStop(1, `hsl(${(t * 40 + 120) % 360} 50% 35%)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 24) for (let x = (y / 24) % 2 ? 0 : 24; x < w; x += 48) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x, y, 24, 24); }
    g.fillStyle = '#e5484d';
    g.beginPath();
    g.arc(w * 0.5 + Math.cos(t * 2) * w * 0.3, h * 0.55 + Math.sin(t * 2) * h * 0.25, h * 0.12, 0, Math.PI * 2);
    g.fill();
    for (let k = 0; k < 40; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#111111'; g.fillRect(80 + k * 6, h - 160, 3, 100); }
    g.fillStyle = '#ffffff';
    g.font = `700 ${Math.round(h * 0.09)}px Consolas, monospace`;
    g.fillText(`FRAME ${String(i).padStart(4, '0')}  ${t.toFixed(3)}s`, w * 0.06, h * 0.16);
    const f = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    enc.encode(f, { keyFrame: i % fps === 0 });
    f.close();
  }
  await enc.flush();
  mux.finalize();
  return new File([mux.target.buffer], name, { type: 'video/mp4' });
}

export function benchRender(renderer, t0 = 1, frames = 120, fps = 60) {
  const times = [];
  for (let i = 0; i < frames; i++) {
    const a = performance.now();
    renderer.render(t0 + i / fps);
    renderer.flush?.();
    times.push(performance.now() - a);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, v) => s + v, 0) / times.length;
  return { avgMs: +avg.toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), canvas: [renderer.canvas.width, renderer.canvas.height] };
}
