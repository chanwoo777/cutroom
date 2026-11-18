// Web Audio engine. All timeline audio plays from decoded AudioBuffers scheduled on the AudioContext clock,
// which is also the master clock for video sync. The same bus feeds the speakers, the level meters and,
// during export, a MediaStreamAudioDestinationNode that MediaRecorder captures.

function applyEnvelope(param, when, lt0, dur, vol, fadeIn, fadeOut) {
  const total = fadeIn + fadeOut;
  if (total > dur && total > 0) { const k = dur / total; fadeIn *= k; fadeOut *= k; }
  const at = (lt) => vol * Math.max(0, Math.min(1, fadeIn > 0 ? lt / fadeIn : 1, fadeOut > 0 ? (dur - lt) / fadeOut : 1));
  param.cancelScheduledValues(0);
  param.setValueAtTime(at(lt0), when);
  if (fadeIn > 0 && lt0 < fadeIn) param.linearRampToValueAtTime(at(fadeIn), when + (fadeIn - lt0));
  if (fadeOut > 0) {
    const fo = dur - fadeOut;
    if (fo > lt0) param.setValueAtTime(at(fo), when + (fo - lt0));
    param.linearRampToValueAtTime(0, when + Math.max(0, dur - lt0));
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.live = [];
    this.elementNodes = new Map();
    this.previewNode = null;
    this.levels = [0, 0];
    this.masterVolume = 0.9;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = this.masterVolume;
    // Always mix in stereo, so mono sources (voice-overs, mono files) feed both channels and both meters.
    this.bus.channelCount = 2;
    this.bus.channelCountMode = 'explicit';
    this.bus.channelInterpretation = 'speakers';
    this.monitor = ctx.createGain();
    this.bus.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.splitter = ctx.createChannelSplitter(2);
    this.analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
    for (const a of this.analysers) { a.fftSize = 1024; a.smoothingTimeConstant = 0; }
    this.bus.connect(this.splitter);
    this.splitter.connect(this.analysers[0], 0);
    this.splitter.connect(this.analysers[1], 1);
    this.meterBuf = new Float32Array(1024);
    this.previewGain = ctx.createGain();
    this.previewGain.gain.value = 0.9;
    this.previewGain.connect(ctx.destination);
    return ctx;
  }

  get running() { return this.ctx?.state === 'running'; }

  async resume() {
    this.ensure();
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* blocked until a user gesture */ }
    }
  }

  /** Output latency between ctx.currentTime and the speaker, used to delay the picture to match. */
  get latency() {
    const c = this.ctx;
    if (!c) return 0;
    return (c.baseLatency || 0) + (c.outputLatency || 0);
  }

  async decode(arrayBuffer) {
    this.ensure();
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this.bus) this.bus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setMonitorMuted(muted) {
    this.ensure();
    this.monitor.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
  }

  /** A fresh capture node per export; disconnect it afterwards. */
  createCaptureNode() {
    this.ensure();
    const dest = this.ctx.createMediaStreamDestination();
    this.bus.connect(dest);
    return dest;
  }

  releaseCaptureNode(dest) {
    try { this.bus.disconnect(dest); } catch { /* already gone */ }
  }

  scheduleFrom(project, assets, t, when0) {
    this.stopAll();
    const ctx = this.ensure();
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]));
    for (const c of project.clips) {
      if (c.kind !== 'audio' && c.kind !== 'video') continue;
      const tr = tracks.get(c.trackId);
      if (!tr || tr.muted) continue;
      const asset = assets.get(c.assetId);
      const buf = asset?.buffer;
      if (!buf) continue;
      const end = c.start + c.duration;
      if (end <= t + 1e-4) continue;
      const startT = Math.max(t, c.start);
      const offset = c.in + (startT - c.start) * c.speed;
      if (offset >= buf.duration) continue;
      const srcDur = Math.min((end - startT) * c.speed, buf.duration - offset);
      if (srcDur <= 0) continue;
      const when = Math.max(ctx.currentTime, when0 + (startT - t));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = c.speed;
      const g = ctx.createGain();
      applyEnvelope(g.gain, when, startT - c.start, c.duration, c.volume ?? 1, c.fadeIn || 0, c.fadeOut || 0);
      src.connect(g);
      g.connect(this.bus);
      src.start(when, offset, srcDur);
      this.live.push({ src, g });
    }
  }

  /**
   * Offline mixdown of the whole sequence (unity gain, stereo) for frame-accurate export. Uses the same
   * scheduling and fade envelopes as playback, rendered faster than real time by OfflineAudioContext.
   * Returns { buffer, skipped } where skipped counts clips whose audio only exists as a streaming element.
   */
  async renderMix(project, assets, duration, sampleRate = 48000) {
    const length = Math.max(1, Math.ceil(duration * sampleRate));
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
    const bus = ctx.createGain();
    bus.channelCount = 2;
    bus.channelCountMode = 'explicit';
    bus.channelInterpretation = 'speakers';
    bus.connect(ctx.destination);
    const tracks = new Map(project.tracks.map((tr) => [tr.id, tr]));
    let skipped = 0;
    for (const c of project.clips) {
      if (c.kind !== 'audio' && c.kind !== 'video') continue;
      const tr = tracks.get(c.trackId);
      if (!tr || tr.muted) continue;
      const asset = assets.get(c.assetId);
      if (!asset) continue;
      if (!asset.buffer) { if (asset.audioMode === 'element') skipped++; continue; }
      const buf = asset.buffer;
      const offset = c.in;
      if (offset >= buf.duration) continue;
      const srcDur = Math.min(c.duration * c.speed, buf.duration - offset);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = c.speed;
      const g = ctx.createGain();
      applyEnvelope(g.gain, c.start, 0, c.duration, c.volume ?? 1, c.fadeIn || 0, c.fadeOut || 0);
      src.connect(g);
      g.connect(bus);
      src.start(c.start, offset, srcDur);
    }
    return { buffer: await ctx.startRendering(), skipped };
  }

  stopAll() {
    for (const n of this.live) {
      try { n.src.stop(); } catch { /* not started */ }
      n.src.disconnect();
      n.g.disconnect();
    }
    this.live = [];
  }

  /** Large videos (not decoded into a buffer) route their element audio through the bus. */
  attachElement(id, video) {
    this.ensure();
    if (this.elementNodes.has(id)) return;
    try {
      const node = this.ctx.createMediaElementSource(video);
      const g = this.ctx.createGain();
      node.connect(g);
      g.connect(this.bus);
      this.elementNodes.set(id, { node, g });
    } catch (err) {
      console.warn('element audio unavailable', err);
    }
  }

  setElementGain(id, v) {
    const n = this.elementNodes.get(id);
    if (n) n.g.gain.value = v;
  }

  detachElement(id) {
    const n = this.elementNodes.get(id);
    if (!n) return;
    n.node.disconnect();
    n.g.disconnect();
    this.elementNodes.delete(id);
  }

  meter() {
    if (!this.ctx) return this.levels;
    for (let i = 0; i < 2; i++) {
      this.analysers[i].getFloatTimeDomainData(this.meterBuf);
      let peak = 0;
      for (let j = 0; j < this.meterBuf.length; j++) { const v = Math.abs(this.meterBuf[j]); if (v > peak) peak = v; }
      this.levels[i] = Math.max(peak, this.levels[i] * 0.86);
    }
    return this.levels;
  }

  async preview(buffer, onEnd) {
    await this.resume();
    this.stopPreview();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.previewGain);
    src.onended = () => { if (this.previewNode === src) this.previewNode = null; onEnd?.(); };
    src.start();
    this.previewNode = src;
    return src;
  }

  stopPreview() {
    if (!this.previewNode) return;
    try { this.previewNode.stop(); } catch { /* ended */ }
    this.previewNode = null;
  }
}
