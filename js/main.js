// Cutroom bootstrap. Everything runs in this tab: no network, no uploads, no API keys.
import { Store, defaultProject } from './core/store.js';
import { BlobRegistry, AssetStore } from './core/assets.js';
import { AudioEngine } from './engine/audio.js';
import { GLFX } from './engine/glfx.js';
import { Playback } from './engine/playback.js';
import { Renderer } from './engine/renderer.js';
import { createActions } from './ui/actions.js';
import { Timeline } from './ui/timeline.js';
import { Monitor } from './ui/monitor.js';
import { Inspector } from './ui/inspector.js';
import { MediaBin } from './ui/mediabin.js';
import { ExportDialog } from './ui/export.js';
import { installShortcuts } from './ui/shortcuts.js';
import { toast } from './ui/dom.js';
import { buildDemo } from './demo.js';
import { clamp, formatBytes } from './util.js';
import { VoiceEngine, loadVoiceSettings } from './engine/voice.js';
import { createVoiceover } from './voice/voiceover.js';
import { InlineTextEditor } from './ui/texteditor.js';
import { installShell } from './ui/shell.js';
import { FxPanels } from './ui/fxpanels.js';
import { installScrubbers } from './ui/dom.js';

const $ = (id) => document.getElementById(id);

const store = new Store();
const blobs = new BlobRegistry();
const audio = new AudioEngine();
const assets = new AssetStore({ blobs, audio });
const glfx = GLFX.create();
let renderDirty = true;
const markDirty = () => { renderDirty = true; };

const playback = new Playback({ store, assets, audio, glfx, pool: $('media-pool'), onDirty: markDirty });
const renderer = new Renderer({ canvas: $('program'), store, assets, playback, glfx });
const actions = createActions({ store, assets, playback, glfx });
playback.onRelease = (id) => renderer.gpu?.deleteMedia(id);

/**
 * Preview resolution. The program canvas's backing store is the sequence resolution itself (1920x1080,
 * 3840x2160...), independent of its CSS size; the browser scales it to the monitor with high-quality
 * filtering (object-fit: contain), so the preview is exactly the exported picture. Half and Quarter are
 * opt-in for slow machines. Exports render at their own resolution.
 */
function sizeProgram() {
  if (store.exporting) return;
  const [W, H] = store.dims;
  const q = typeof store.ui.previewScale === 'number' ? store.ui.previewScale : 1;
  renderer.resize(Math.max(2, Math.round(W * q)), Math.max(2, Math.round(H * q)));
  markDirty();
}
function applyCanvasSize() {
  if (store.exporting) return;
  monitor.layout(); // recomputes the display box, then calls sizeProgram
}
matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.('change', () => applyCanvasSize());

const voice = new VoiceEngine();
const voiceover = createVoiceover({ store, assets, voice });
let voicing = false;
async function voiceSelected() {
  const texts = store.selectedClips().filter((c) => c.kind === 'text');
  if (!texts.length) {
    toast('Select one or more text clips, then press Voice-over. To narrate a whole script, use Audio → AI voice-over.');
    return;
  }
  if (voicing) return;
  voicing = true;
  const btn = $('act-voice');
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('is-busy');
  try {
    const n = await voiceover.voiceTexts(texts.map((c) => c.id), loadVoiceSettings());
    toast(`Added ${n} AI voice-over${n > 1 ? 's' : ''}.`, { kind: 'ok' });
  } catch (err) {
    toast(err.message, { kind: 'error', timeout: 6000 });
  } finally {
    voicing = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-busy');
  }
}

const monitor = new Monitor({ store, renderer, playback, audio, actions, onQuality: applyCanvasSize, onResize: () => sizeProgram() });
const textEditor = new InlineTextEditor({ store, renderer, monitor, playback });
const timeline = new Timeline({ store, assets, playback, actions, onVoice: voiceSelected });
const inspector = new Inspector({ store, assets, glfx, actions, voice, voiceover, audio, renderer });
const bin = new MediaBin({ store, assets, audio, actions, voice, voiceover });
const exporter = new ExportDialog({ store, assets, renderer, playback, audio, blobs, monitor, applyCanvasSize });
const shortcutsDialog = $('shortcuts-dialog');
shortcutsDialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => shortcutsDialog.close()));
installShortcuts({ store, actions, playback, timeline, monitor, exporter, shortcutsDialog, onVoice: voiceSelected, textEditor });
const shell = installShell({ store, actions, monitor });
inspector.openPanel = shell.openPanel;
const fxPanels = new FxPanels({ store, actions, openPanel: shell.openPanel });
installScrubbers(document);
applyCanvasSize();

// ---------- app bar ----------
const titleInput = $('project-title');
titleInput.addEventListener('input', () => { store.project.title = titleInput.value.slice(0, 80); });
titleInput.addEventListener('change', () => store.commit('Rename project'));
titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });
const aspectBtns = [...document.querySelectorAll('#aspect-group [data-aspect]')];
aspectBtns.forEach((b) => b.addEventListener('click', () => actions.setAspect(b.dataset.aspect)));
const undoBtn = $('btn-undo');
const redoBtn = $('btn-redo');
undoBtn.addEventListener('click', () => actions.undo());
redoBtn.addEventListener('click', () => actions.redo());
$('btn-export').addEventListener('click', () => exporter.open());
$('btn-shortcuts').addEventListener('click', () => shortcutsDialog.showModal());
$('btn-new').addEventListener('click', () => {
  if ((store.project.clips.length || assets.list().length) && !window.confirm('Start a new project? The timeline and every imported file will be cleared from memory. This cannot be undone.')) return;
  playback.pause();
  playback.releaseAll();
  glfx?.deleteAll();
  renderer.gpu?.deleteAll();
  assets.reset();
  store.replaceProject(defaultProject());
  applyCanvasSize();
  toast('New project. All media from the previous one was released.', { kind: 'ok' });
});
$('empty-import').addEventListener('click', () => bin.openPicker());
const demoBtn = $('empty-demo');
demoBtn.addEventListener('click', async () => {
  demoBtn.classList.add('is-busy');
  demoBtn.setAttribute('aria-busy', 'true');
  try {
    await buildDemo({ store, assets, audio, onProgress: (m) => { demoBtn.title = m; } });
    timeline.zoomFit();
    toast('Demo cut ready. All of its media was generated on this device.', { kind: 'ok' });
  } catch (err) {
    console.error(err);
    toast(`Could not build the demo: ${err.message}`, { kind: 'error' });
  } finally {
    demoBtn.classList.remove('is-busy');
    demoBtn.removeAttribute('aria-busy');
  }
});

let lastAspect = store.project.aspect;
const st = { blobs: $('st-blobs'), engine: $('st-engine'), format: $('st-format'), drift: $('st-drift') };
function syncChrome() {
  const p = store.project;
  if (document.activeElement !== titleInput && titleInput.value !== p.title) titleInput.value = p.title;
  aspectBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.aspect === p.aspect)));
  if (p.aspect !== lastAspect) { lastAspect = p.aspect; applyCanvasSize(); }
  const [W, H] = store.dims;
  st.format.textContent = `${W}×${H} · ${p.fps} fps · ${p.clips.length} clip${p.clips.length === 1 ? '' : 's'}`;
}
function syncHistory() {
  const hst = store.history;
  undoBtn.disabled = !hst.canUndo;
  redoBtn.disabled = !hst.canRedo;
  undoBtn.title = hst.canUndo ? `Undo ${hst.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
  redoBtn.title = hst.canRedo ? `Redo ${hst.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
}
st.engine.textContent = renderer.gpu ? 'WebGL2 compositor' : 'Canvas 2D compositor (WebGL2 unavailable)';
const stVoice = $('st-voice');
voice.on('state', (v) => {
  stVoice.hidden = v.state === 'idle';
  if (v.state === 'loading') {
    const p = v.progress.total ? Math.round((v.progress.loaded / v.progress.total) * 100) : 0;
    stVoice.textContent = v.progress.phase === 'prepare' ? 'AI voice: preparing…' : `AI voice: ${p}% of ${formatBytes(v.progress.total)}`;
  } else if (v.state === 'ready') stVoice.textContent = `AI voice ready · ${v.backend === 'webgpu' ? 'WebGPU' : 'CPU'}`;
  else if (v.state === 'error') stVoice.textContent = 'AI voice unavailable';
});
blobs.on('change', (n) => { st.blobs.textContent = `${n} object URL${n === 1 ? '' : 's'} live`; });

let rescheduleTimer = 0;
store.on('project', (e) => {
  markDirty();
  syncChrome();
  if (playback.playing && !e?.live) {
    clearTimeout(rescheduleTimer);
    rescheduleTimer = setTimeout(() => playback.reschedule(), 60);
  }
});
store.on('history', syncHistory);
store.on('time', markDirty);
store.on('selection', markDirty);
store.on('exporting', (on) => {
  document.body.classList.toggle('is-exporting', on);
  $('empty-stage').hidden = on || store.project.clips.length > 0;
  monitor.dirty = true;
});
assets.on('change', markDirty);
assets.on('notice', (n) => toast(n.message, { kind: n.kind }));
syncChrome();
syncHistory();

// ---------- drag files anywhere ----------
const stage = $('stage');
window.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  stage.classList.toggle('drop-over', stage.contains(e.target));
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('drop-over'); });
window.addEventListener('drop', (e) => {
  stage.classList.remove('drop-over');
  if (e.defaultPrevented || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  bin.importAndReport(e.dataTransfer.files).then((list) => {
    if (stage.contains(e.target) && list.length && !store.project.clips.length) {
      let at = 0;
      for (const a of list) { const c = actions.addAsset(a, { start: at }); if (c) at = c.start + c.duration; }
      timeline.zoomFit();
    }
  });
});

// ---------- timeline height splitter ----------
const workspace = $('workspace');
const splitter = $('splitter');
const readHeight = () => { try { return Number(localStorage.getItem('cutroom.tlh')) || 0; } catch { return 0; } };
const saveHeight = (v) => { try { localStorage.setItem('cutroom.tlh', String(Math.round(v))); } catch { /* storage blocked */ } };
const setTlHeight = (v) => {
  const max = Math.max(200, window.innerHeight - 260);
  const hgt = clamp(v, 180, max);
  workspace.style.setProperty('--tl-h', `${hgt}px`);
  splitter.setAttribute('aria-valuenow', String(Math.round(hgt)));
  return hgt;
};
setTlHeight(readHeight() || Math.round(window.innerHeight * 0.36));
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  const startY = e.clientY;
  const start = $('timeline').getBoundingClientRect().height;
  const move = (ev) => setTlHeight(start - (ev.clientY - startY));
  const up = () => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    saveHeight($('timeline').getBoundingClientRect().height);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});
splitter.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const cur = $('timeline').getBoundingClientRect().height;
  saveHeight(setTlHeight(cur + (e.key === 'ArrowUp' ? 24 : -24)));
});

// ---------- lifecycle ----------
window.addEventListener('beforeunload', (e) => {
  if (store.project.clips.length) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => blobs.revokeAll());

// ---------- frame loop ----------
// Perf readout: display frame rate (rAF cadence) and the CPU cost of compositing one frame.
const perf = { el: $('st-perf'), last: 0, n: 0, dtSum: 0, msSum: 0, shownAt: 0, fps: 0, ms: 0, lastMs: 0 };
function trackPerf(now, renderMs) {
  if (renderMs > 0) perf.lastMs = renderMs;
  if (perf.last) { perf.n++; perf.dtSum += now - perf.last; perf.msSum += renderMs; }
  perf.last = now;
  if (now - perf.shownAt < 500 || !perf.n) return;
  perf.fps = 1000 / (perf.dtSum / perf.n);
  perf.ms = perf.msSum / perf.n;
  perf.n = 0; perf.dtSum = 0; perf.msSum = 0; perf.shownAt = now;
  if (perf.el) {
    // Frame rate only means something while playing; when parked, show the cost of the last frame.
    perf.el.textContent = playback.playing ? `${Math.round(perf.fps)} fps · ${perf.ms.toFixed(1)} ms/frame` : `${perf.lastMs.toFixed(1)} ms/frame`;
    perf.el.dataset.level = !playback.playing || perf.fps >= 55 ? 'ok' : perf.fps >= 40 ? 'warn' : 'bad';
  }
}
function frame(now) {
  try {
    let renderMs = 0;
    // During a frame-accurate export the exporter owns the videos and the program canvas.
    if (!playback.suspended) {
      playback.update();
      if (renderDirty || playback.playing) {
        const a = performance.now();
        renderer.render(store.time);
        renderMs = performance.now() - a;
        renderDirty = false;
        monitor.dirty = true;
      }
    }
    trackPerf(now, renderMs);
    textEditor.frame();
    monitor.frame();
    timeline.frame();
    if (playback.playing) {
      const d = Math.round(playback.drift);
      st.drift.hidden = false;
      st.drift.textContent = `A/V drift ${d} ms`;
      st.drift.className = `status-item tabular ${d > 80 ? 'warn' : 'ok'}`;
    } else if (!st.drift.hidden) st.drift.hidden = true;
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for debugging in the console only; holds no secrets.
window.cutroom = { store, assets, playback, renderer, actions, blobs, glfx, voice, voiceover, textEditor, perf, timeline, monitor, fxPanels };
