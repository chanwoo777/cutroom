// Library: imported media, text presets, stickers, and the procedural audio synth.
import { h, icon, toast, armable } from './dom.js';
import { formatDuration, formatBytes } from '../util.js';
import { makeClip } from '../core/ops.js';
import { SHAPES, EMOJI, drawSticker, stickerAspect } from '../engine/stickers.js';
import { SFX_LIST, BEAT_STYLES, KEYS, renderSfx, renderBeat } from '../engine/synth.js';
import { dragPayload } from './timeline.js';
import { loadVoiceSettings, saveVoiceSettings } from '../engine/voice.js';
import { splitScript } from '../voice/voiceover.js';
import { voiceControls, modelStatus, licenseNote, runWithProgress } from './voicepanel.js';

const $ = (id) => document.getElementById(id);

const TEXT_PRESETS = [
  { id: 'title', label: 'Title', cls: 'sample-title', sample: 'Big title', props: { text: { content: 'Big title', size: 0.12, weight: 900 }, introAnimation: { type: 'pop', duration: 0.5 }, outroAnimation: { type: 'fade', duration: 0.5 } } },
  { id: 'lower', label: 'Lower third', cls: 'sample-lower', sample: 'Name · Role', props: { text: { content: 'Name Surname\nRole or place', size: 0.045, weight: 700, align: 'left', bg: true, bgColor: '#e6e0d2', color: '#1c1b19', shadow: false, lineHeight: 1.3 }, transform: { x: 0.27, y: 0.8 }, introAnimation: { type: 'slide', duration: 0.45 }, outroAnimation: { type: 'fade', duration: 0.45 } } },
  { id: 'caption', label: 'Caption', cls: 'sample-caption', sample: 'Caption text', props: { text: { content: 'Caption text goes here', size: 0.05, weight: 700, bg: true, bgColor: '#141311', shadow: false }, transform: { y: 0.86 }, introAnimation: { type: 'fade', duration: 0.2 }, outroAnimation: { type: 'fade', duration: 0.2 } } },
  { id: 'outline', label: 'Outline', cls: 'sample-outline', sample: 'OUTLINE', props: { text: { content: 'OUTLINE', font: 'heavy', weight: 400, size: 0.14, color: '#e6e0d2', strokeColor: '#1c1b19', strokeWidth: 3, shadow: false }, introAnimation: { type: 'zoom', duration: 0.4 }, outroAnimation: { type: 'fade', duration: 0.4 } } },
  { id: 'type', label: 'Typewriter', cls: 'sample-type', sample: 'Typed out_', props: { text: { content: 'Typed out, one letter at a time.', font: 'mono', weight: 400, size: 0.05 }, introAnimation: { type: 'typewriter', duration: 1.6 }, outroAnimation: { type: 'fade', duration: 1.6 } } },
  { id: 'serif', label: 'Serif line', cls: 'sample-serif', sample: 'An elegant line', props: { text: { content: 'An elegant line', font: 'serif', weight: 400, italic: true, size: 0.08 }, introAnimation: { type: 'fade', duration: 0.8 }, outroAnimation: { type: 'fade', duration: 0.8 } } },
  { id: 'big', label: 'Big number', cls: 'sample-big', sample: '01', props: { text: { content: '01', font: 'condensed', weight: 700, size: 0.3, color: '#d8382b', shadow: false }, introAnimation: { type: 'zoom', duration: 0.35 }, outroAnimation: { type: 'fade', duration: 0.35 } } },
];
const SHAPE_COLORS = { star: '#d8382b', burst: '#e6e0d2', heart: '#d8382b', arrow: '#e6e0d2', ring: '#d8382b', bubble: '#e6e0d2', bolt: '#b98a2e', sparkle: '#e6e0d2', check: '#4f6b86', pin: '#d8382b', tape: '#e6e0d2', brackets: '#e6e0d2', swoosh: '#d8382b' };

export class MediaBin {
  constructor({ store, assets, audio, actions, voice, voiceover }) {
    this.store = store;
    this.assets = assets;
    this.audio = audio;
    this.actions = actions;
    this.voice = voice;
    this.voiceover = voiceover;
    this.fileInput = $('file-input');
    this.posters = new Map();
    this.sfxCache = new Map();
    this.playingRow = null;
    this.renderMedia();
    this.#renderText();
    this.#renderStickers();
    this.#renderAudio();
    assets.on('change', () => this.renderMedia());
    assets.on('thumbs', (a) => { const c = this.posters.get(a.id); if (c && a.thumbs.length === 1) this.#drawPoster(a, c); });
    this.fileInput.addEventListener('change', async () => {
      const files = [...(this.fileInput.files || [])];
      this.fileInput.value = '';
      if (files.length) await this.importAndReport(files);
    });
  }

  openPicker() { this.fileInput.click(); }

  async importAndReport(files) {
    const list = await this.assets.importFiles(files);
    if (list.length) toast(`Imported ${list.length} file${list.length > 1 ? 's' : ''}. Nothing left this device.`, { kind: 'ok' });
    return list;
  }

  #dragFor(el, payloadFn) {
    el.addEventListener('dragstart', (e) => {
      const payload = payloadFn();
      if (!payload) { e.preventDefault(); return; }
      dragPayload.current = payload;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-cutroom', payload.kind);
    });
    el.addEventListener('dragend', () => { setTimeout(() => { dragPayload.current = null; }, 0); });
  }

  // ---------- Media ----------
  renderMedia() {
    const pane = $('pane-media');
    const list = this.assets.list();
    this.posters.clear();
    const head = h('div', { class: 'pane-head' },
      h('span', { class: 'count', text: list.length ? `${list.length} file${list.length > 1 ? 's' : ''} in this tab` : '' }),
      h('button', { type: 'button', class: 'btn bone small', on: { click: () => this.openPicker() } }, icon('import'), h('span', { text: 'Import' })));
    let body;
    if (!list.length) {
      body = h('div', { class: 'bin-empty' },
        h('strong', { text: 'No media yet' }),
        h('p', { text: 'Drop files here or import them. They are read from your disk and never uploaded.' }),
        h('button', { type: 'button', class: 'btn', on: { click: () => this.openPicker() } }, icon('import'), h('span', { text: 'Choose files' })),
        h('p', { class: 'formats', text: 'MP4 · WebM · MOV · PNG · JPG · MP3 · WAV' }));
    } else {
      body = h('div', { class: 'asset-grid', role: 'list', 'aria-label': 'Imported media' }, ...list.map((a) => this.#card(a)));
    }
    const zone = h('div', { class: 'dropzone' }, head, body);
    zone.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('over'); });
    zone.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      zone.classList.remove('over');
      this.importAndReport(e.dataTransfer.files);
    });
    pane.replaceChildren(zone);
  }

  #card(a) {
    const canvas = h('canvas', { width: 224, height: 140 });
    this.posters.set(a.id, canvas);
    this.#drawPoster(a, canvas);
    const kindIcon = a.kind === 'video' ? 'film' : a.kind === 'image' ? 'image' : 'music';
    const badgeText = a.kind === 'image' ? `${a.width}×${a.height}` : formatDuration(a.duration);
    const addBtn = h('button', { type: 'button', title: 'Add at playhead', 'aria-label': `Add ${a.name} at the playhead`, on: { click: (e) => { e.stopPropagation(); this.actions.addAsset(a); } } }, icon('plus'));
    const delBtn = h('button', { type: 'button', title: 'Remove from project', 'aria-label': `Remove ${a.name}` }, icon('trash'), h('span', { class: 'armed-label', text: 'Remove?', hidden: true }));
    armable(delBtn, () => this.actions.removeAsset(a.id));
    const ready = a.status === 'ready';
    const meta = a.status === 'loading' ? 'Decoding…'
      : a.status === 'error' ? null
        : `${a.kind === 'audio' && a.source === 'synth' ? 'Synth' : a.kind[0].toUpperCase() + a.kind.slice(1)} · ${a.source === 'synth' ? 'generated' : formatBytes(a.size)}${a.kind === 'video' && !a.hasAudio ? ' · no audio' : ''}`;
    const el = h('div', {
      class: `asset is-${a.status}`, role: 'listitem', tabindex: 0, draggable: ready ? 'true' : 'false',
      dataset: { kind: a.kind }, 'aria-label': `${a.name}, ${a.kind}${ready ? `, ${badgeText}. Press Enter to add at the playhead` : a.status === 'loading' ? ', decoding' : ', failed to load'}`,
      on: {
        dblclick: () => ready && this.actions.addAsset(a),
        keydown: (e) => { if (e.key === 'Enter' && ready && e.target === el) { e.preventDefault(); this.actions.addAsset(a); } },
      },
    },
    h('div', { class: 'asset-thumb' }, canvas, ready ? h('span', { class: 'asset-badge' }, icon(kindIcon), h('span', { text: badgeText })) : null,
      h('div', { class: 'asset-actions' }, ready ? addBtn : null, delBtn)),
    h('div', { class: 'asset-name', text: a.name, title: a.name }),
    a.status === 'error' ? h('div', { class: 'asset-error', text: a.error }) : h('div', { class: 'asset-meta', text: meta }));
    if (ready) this.#dragFor(el, () => ({ kind: a.kind, duration: a.kind === 'image' ? 5 : Math.floor(a.duration * this.store.fps) / this.store.fps, make: () => this.actions.makeAssetClip(a) }));
    return el;
  }

  #drawPoster(a, canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (a.kind === 'audio') {
      ctx.fillStyle = '#1e6e52';
      ctx.fillRect(0, 0, W, H);
      const data = a.peaks?.data;
      if (!data) return;
      ctx.fillStyle = '#1c1b19';
      const mid = H / 2;
      for (let x = 0; x < W; x += 2) {
        const i0 = Math.floor((x / W) * data.length), i1 = Math.max(i0 + 1, Math.floor(((x + 2) / W) * data.length));
        let m = 0;
        for (let i = i0; i < i1; i++) if (data[i] > m) m = data[i];
        const hgt = Math.max(1, m * (H * 0.42));
        ctx.fillRect(x, mid - hgt, 1.4, hgt * 2);
      }
      return;
    }
    const p = a.poster;
    if (!p) return;
    const k = Math.max(W / p.width, H / p.height);
    const w = p.width * k, hh = p.height * k;
    try { ctx.drawImage(p, (W - w) / 2, (H - hh) / 2, w, hh); } catch { /* closed bitmap */ }
  }

  // ---------- Text ----------
  #renderText() {
    const pane = $('pane-text');
    const make = (p) => makeClip('text', { name: p.label, duration: 4, ...structuredClone(p.props) });
    const items = TEXT_PRESETS.map((p) => {
      const btn = h('button', {
        type: 'button', class: 'preset', draggable: 'true', 'aria-label': `Add ${p.label} text at the playhead`,
        on: { click: () => { const c = this.actions.addClip(make(p), { label: `Add ${p.label}` }); if (c) this.store.emit('edit-text', { id: c.id, selectAll: true }); } },
      }, h('span', { class: `preset-sample ${p.cls}`, text: p.sample }), h('span', { class: 'preset-add' }, icon('plus')));
      this.#dragFor(btn, () => ({ kind: 'text', duration: 4, make: () => make(p) }));
      return btn;
    });
    pane.replaceChildren(
      h('div', { class: 'pane-head' }, h('h2', { text: 'Text' })),
      h('p', { class: 'pane-note', text: 'Click to add at the playhead on an overlay track, or drag onto the timeline. Edit wording and style in the inspector.' }),
      h('div', { class: 'preset-list' }, ...items));
  }

  // ---------- Stickers ----------
  #renderStickers() {
    const pane = $('pane-stickers');
    const shapeBtn = (shape) => {
      const st = { shape: shape.id, emoji: '', color: SHAPE_COLORS[shape.id] || '#d8382b', outline: false, size: 0.24 };
      return this.#stickerButton(st, shape.name);
    };
    const emojiBtn = (e) => this.#stickerButton({ shape: 'star', emoji: e, color: '#ffffff', outline: false, size: 0.2 }, `Emoji ${e}`);
    pane.replaceChildren(
      h('div', { class: 'pane-head' }, h('h2', { text: 'Stickers' })),
      h('h3', { text: 'Cut-paper shapes' }),
      h('div', { class: 'sticker-grid' }, ...SHAPES.map(shapeBtn)),
      h('h3', { text: 'Emoji' }),
      h('div', { class: 'sticker-grid' }, ...EMOJI.map(emojiBtn)));
  }

  #stickerButton(st, label) {
    const canvas = h('canvas', { width: 120, height: 120 });
    const ctx = canvas.getContext('2d');
    const ar = stickerAspect(st);
    const box = 84;
    const bh = box / Math.sqrt(ar) * (ar > 2 ? 0.8 : 1), bw = bh * ar;
    ctx.translate(60, 60);
    drawSticker(ctx, st, Math.min(bw, 104), Math.min(bh, 104 / ar));
    const make = () => makeClip('sticker', { name: label, duration: 3, sticker: { ...st }, introAnimation: { type: 'pop', duration: 0.35 }, outroAnimation: { type: 'fade', duration: 0.35 } });
    const btn = h('button', {
      type: 'button', class: 'sticker-btn', draggable: 'true', title: label, 'aria-label': `Add ${label} sticker at the playhead`,
      on: { click: () => this.actions.addClip(make(), { label: 'Add sticker' }) },
    }, canvas);
    this.#dragFor(btn, () => ({ kind: 'sticker', duration: 3, make }));
    return btn;
  }

  // ---------- Audio / synth ----------
  #renderAudio() {
    const pane = $('pane-audio');
    const rows = SFX_LIST.map((s) => {
      const play = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Preview ${s.name}`, title: 'Preview' }, icon('play'));
      const add = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Add ${s.name} at the playhead`, title: 'Add at playhead' }, icon('plus'));
      play.addEventListener('click', () => this.#previewSfx(s, play));
      add.addEventListener('click', async () => {
        const buf = await this.#sfx(s.id);
        if (!buf) return;
        const asset = this.assets.addBuffer(s.name, buf);
        this.actions.addAsset(asset, { label: `Add ${s.name}` });
      });
      return h('div', { class: 'sfx-row' }, h('span', { class: 'sfx-name' }, s.name, h('small', { text: `${s.dur.toFixed(1)}s · synth` })), play, add);
    });

    const style = h('select', { class: 'select', id: 'beat-style' }, ...BEAT_STYLES.map((b) => h('option', { value: b.id, text: b.name })));
    const key = h('select', { class: 'select', id: 'beat-key' }, ...KEYS.map((k) => h('option', { value: k.id, text: k.name })));
    const bpm = h('input', { type: 'range', class: 'range', id: 'beat-bpm', min: 60, max: 170, step: 1, value: 84 });
    const bpmNum = h('input', { type: 'number', class: 'num', min: 60, max: 170, step: 1, value: 84, 'aria-label': 'Tempo in BPM' });
    const syncBpm = (v) => { bpm.value = v; bpmNum.value = v; bpm.style.setProperty('--p', `${((v - 60) / 110) * 100}%`); };
    syncBpm(84);
    bpm.addEventListener('input', () => syncBpm(Number(bpm.value)));
    bpmNum.addEventListener('change', () => syncBpm(Math.min(170, Math.max(60, Number(bpmNum.value) || 84))));
    style.addEventListener('change', () => syncBpm(BEAT_STYLES.find((b) => b.id === style.value).bpm));
    let bars = 8;
    const barBtns = [4, 8, 16].map((n) => h('button', { type: 'button', role: 'radio', text: String(n), 'aria-checked': String(n === bars), on: { click: () => { bars = n; barBtns.forEach((b) => b.setAttribute('aria-checked', String(b.textContent === String(n)))); } } }));
    const params = () => ({ style: style.value, bpm: Number(bpm.value), bars, key: key.value });
    const nameFor = (p) => `${BEAT_STYLES.find((b) => b.id === p.style).name} · ${p.bpm} BPM · ${KEYS.find((k) => k.id === p.key).name} · ${p.bars} bars`;
    let lastBeat = null;
    const render = async (btn) => {
      const p = params();
      const sig = JSON.stringify(p);
      if (lastBeat?.sig === sig) return lastBeat;
      btn.classList.add('is-busy');
      try {
        const buf = await renderBeat(p);
        lastBeat = { sig, buf, name: nameFor(p) };
        return lastBeat;
      } catch (err) {
        toast(`Could not render the beat: ${err.message}`, { kind: 'error' });
        return null;
      } finally { btn.classList.remove('is-busy'); }
    };
    const previewBtn = h('button', { type: 'button', class: 'btn' }, icon('play'), h('span', { text: 'Preview' }));
    const addBtn = h('button', { type: 'button', class: 'btn bone' }, icon('plus'), h('span', { text: 'Add to timeline' }));
    let previewing = false;
    previewBtn.addEventListener('click', async () => {
      if (previewing) { this.audio.stopPreview(); return; }
      const b = await render(previewBtn);
      if (!b) return;
      previewing = true;
      previewBtn.lastElementChild.textContent = 'Stop';
      await this.audio.preview(b.buf, () => { previewing = false; previewBtn.lastElementChild.textContent = 'Preview'; });
    });
    addBtn.addEventListener('click', async () => {
      const b = await render(addBtn);
      if (!b) return;
      const asset = this.assets.addBuffer(b.name, b.buf);
      this.actions.addAsset(asset, { label: 'Add beat' });
      toast(`Added "${b.name}". Royalty-free: it was synthesized in your browser.`, { kind: 'ok' });
    });

    pane.replaceChildren(
      h('div', { class: 'pane-head' }, h('h2', { text: 'Audio' })),
      ...(this.voice ? this.#narrator() : []),
      h('h3', { text: 'Beat generator' }),
      h('p', { class: 'pane-note', text: 'Beats and effects are synthesized on this device with Web Audio: royalty-free, no downloads.' }),
      h('div', { class: 'beat-form' },
        h('div', { class: 'row' }, h('label', { for: 'beat-style', text: 'Style' }), style),
        h('div', { class: 'row' }, h('label', { for: 'beat-key', text: 'Key' }), key),
        h('div', { class: 'row' }, h('label', { for: 'beat-bpm', text: 'Tempo' }), h('div', { class: 'ctl', style: { display: 'flex', gap: '6px', 'align-items': 'center' } }, bpm, bpmNum)),
        h('div', { class: 'row' }, h('span', { class: 'lbl', text: 'Bars' }), h('div', { class: 'seg fill', role: 'radiogroup', 'aria-label': 'Bars' }, ...barBtns)),
        h('div', { class: 'actions' }, previewBtn, addBtn)),
      h('h3', { text: 'Sound effects' }),
      h('div', {}, ...rows));
  }

  /** Script → AI narration with captions timed to each sentence. */
  #narrator() {
    const settings = loadVoiceSettings();
    let draft = '';
    try { draft = sessionStorage.getItem('cutroom.script') || ''; } catch { /* storage blocked */ }
    const ta = h('textarea', {
      class: 'text-area', rows: 5, spellcheck: 'true', id: 'narrate-script',
      placeholder: 'Type or paste a script. Each sentence becomes a caption timed to the voice.\n예: 안녕하세요. 오늘은 새 영상을 소개합니다.',
    });
    ta.value = draft;
    const count = h('span', { class: 'count' });
    const syncCount = () => {
      const n = splitScript(ta.value).length;
      count.textContent = n ? `${n} sentence${n > 1 ? 's' : ''}` : '';
      try { sessionStorage.setItem('cutroom.script', ta.value.slice(0, 20000)); } catch { /* ignore */ }
    };
    ta.addEventListener('input', syncCount);
    syncCount();
    const captions = h('input', { type: 'checkbox' });
    captions.checked = settings.captions !== false;
    captions.addEventListener('change', () => { settings.captions = captions.checked; saveVoiceSettings(settings); });
    const previewBtn = h('button', { type: 'button', class: 'btn' }, icon('play'), h('span', { text: 'Preview' }));
    const addBtn = h('button', { type: 'button', class: 'btn bone' }, icon('mic'), h('span', { text: 'Add to timeline' }));
    previewBtn.addEventListener('click', () => {
      const first = splitScript(ta.value).slice(0, 2).join(' ');
      if (!first) { toast('Write a script first.'); ta.focus(); return; }
      runWithProgress(previewBtn, 'Voicing', async (onStep) => {
        const r = await this.voiceover.speak(first, settings, onStep);
        await this.audio.preview(r.buffer);
      }).catch((err) => toast(err.message, { kind: 'error', timeout: 6000 }));
    });
    addBtn.addEventListener('click', () => {
      if (!splitScript(ta.value).length) { toast('Write a script first.'); ta.focus(); return; }
      runWithProgress(addBtn, 'Voicing', (_onStep, setText) => this.voiceover.narrate(ta.value, settings, {
        onProgress: (i, n) => setText(i < n ? `Sentence ${i + 1} of ${n}…` : 'Placing…'),
      })).then((r) => toast(`Added ${r.duration.toFixed(1)} s of narration${settings.captions ? ` with ${r.sentences} captions` : ''} at the playhead.`, { kind: 'ok' }))
        .catch((err) => toast(err.message, { kind: 'error', timeout: 6000 }));
    });
    return [
      h('h3', {}, 'AI voice-over ', count),
      h('div', { class: 'beat-form narrator' },
        modelStatus(this.voice),
        h('label', { class: 'sr-only', for: 'narrate-script', text: 'Narration script' }),
        ta,
        voiceControls(settings),
        h('label', { class: 'check' }, captions, h('span', { text: 'Add captions timed to each sentence' })),
        h('div', { class: 'actions' }, previewBtn, addBtn),
        licenseNote()),
    ];
  }

  async #sfx(id) {
    if (this.sfxCache.has(id)) return this.sfxCache.get(id);
    try {
      const buf = await renderSfx(id);
      this.sfxCache.set(id, buf);
      return buf;
    } catch (err) {
      toast(`Could not synthesize that sound: ${err.message}`, { kind: 'error' });
      return null;
    }
  }

  async #previewSfx(s, btn) {
    const buf = await this.#sfx(s.id);
    if (!buf) return;
    btn.querySelector('use')?.setAttribute('href', '#i-pause');
    await this.audio.preview(buf, () => btn.querySelector('use')?.setAttribute('href', '#i-play'));
  }
}
