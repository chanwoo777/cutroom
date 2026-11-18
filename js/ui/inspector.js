// Inspector: properties of the selection (or the sequence when nothing is selected).
// Controls mutate the project live on input and commit one undo step on change.
import { h, icon, toast } from './dom.js';
import { clamp, formatTC, parseTC, quantize, uid, formatBytes } from '../util.js';
import { LUT_PRESETS, parseCube } from '../engine/luts.js';
import { SHAPES } from '../engine/stickers.js';
import {
  TEXT_FONTS, ANIM_IN, ANIM_OUT, DEFAULT_FX, DEFAULT_TRANSFORM, isVisual, isMedia, overwriteRange, clipEnd, maxTimelineDuration,
  effectiveAnimDurations, MIN_ANIM, TRANSITIONS, prevAdjacent,
} from '../core/ops.js';
import { ALIGN_MODES, alignClips } from './align.js';
import { FPS_OPTIONS } from '../core/store.js';
import { loadVoiceSettings, VOICE_LANGS, VOICES } from '../engine/voice.js';
import { voiceControls, modelStatus, licenseNote, runWithProgress } from './voicepanel.js';

const KIND_ICON = { video: 'film', image: 'image', audio: 'music', text: 'type', sticker: 'shapes', project: 'sliders' };
const KIND_LABEL = { video: 'Video clip', image: 'Image', audio: 'Audio clip', text: 'Text', sticker: 'Sticker' };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const customLuts = [];

const decimals = (step) => (String(step).split('.')[1] || '').length;

export class Inspector {
  constructor({ store, assets, glfx, actions, voice, voiceover, audio, renderer }) {
    this.renderer = renderer;
    this.alignSafe = false;
    this.store = store;
    this.assets = assets;
    this.glfx = glfx;
    this.actions = actions;
    this.voice = voice;
    this.voiceover = voiceover;
    this.audio = audio;
    this.voiceSettings = loadVoiceSettings();
    this.root = document.getElementById('inspector');
    this.cubeInput = document.getElementById('cube-input');
    this.bindings = [];
    this.lutCanvases = [];
    this.clipId = null;
    store.on('selection', () => this.render());
    store.on('project', (e) => {
      if (e?.replaced || e?.undo || e?.redo || e?.revert || e?.asset) this.render();
      else if (this.clipId && !store.getClip(this.clipId)) this.render();
      else this.sync();
    });
    store.on('focus-inspector', () => {
      const ta = this.root.querySelector('.text-content') || this.root.querySelector('.insp-title input');
      ta?.focus();
      ta?.select?.();
    });
    assets.on('change', () => { if (!store.selection.size) this.render(); });
    assets.on('thumbs', (a) => {
      const c = this.clipId && store.getClip(this.clipId);
      if (c && c.assetId === a.id && a.thumbs.length === 1) this.#drawLutThumbs(c);
    });
    this.cubeInput.addEventListener('change', () => this.#loadCube());
    this.render();
  }

  sync() { for (const b of this.bindings) b(); }

  render() {
    const sel = this.store.selectedClips();
    this.bindings = [];
    this.lutCanvases = [];
    this.clipId = sel.length === 1 ? sel[0].id : null;
    const scrollTop = this.root.scrollTop;
    const nodes = sel.length === 0 ? this.#project() : sel.length === 1 ? this.#clip(sel[0]) : this.#multi(sel);
    this.root.replaceChildren(...nodes);
    this.root.scrollTop = sel.length === 1 ? scrollTop : 0;
    if (this.clipId) this.#drawLutThumbs(sel[0]);
  }

  // ---------- control builders ----------
  #touch() { this.store.touch(); }
  #commit(label) { this.store.commit(label); }

  #field(label, control, extra = null, cls = 'field') {
    const id = control.id || (control.id = uid('f'));
    return h('div', { class: cls }, h('label', { for: id, text: label }), control, extra);
  }

  #slider({ label, min, max, step = 1, get, set, commit, def = null, unit = '', disabled = null }) {
    const id = uid('f');
    const maxOf = () => (typeof max === 'function' ? Math.max(min + step, max()) : max);
    const range = h('input', { type: 'range', class: 'range', id, min, max: maxOf(), step });
    const num = h('input', { type: 'number', class: 'num', min, max: maxOf(), step, 'aria-label': `${label}${unit ? ` (${unit})` : ''}` });
    const dp = decimals(step);
    const update = () => {
      const v = get();
      if (v == null || Number.isNaN(v)) return;
      const mx = maxOf();
      range.max = String(mx);
      num.max = String(mx);
      const off = disabled ? !!disabled() : false;
      range.disabled = off;
      num.disabled = off;
      range.value = String(v);
      range.style.setProperty('--p', `${((clamp(v, min, mx) - min) / (mx - min)) * 100}%`);
      if (document.activeElement !== num) num.value = Number(v).toFixed(dp);
    };
    range.addEventListener('input', () => { set(Number(range.value)); this.#touch(); update(); });
    range.addEventListener('change', () => this.#commit(commit || label));
    num.addEventListener('input', () => {
      if (!num.classList.contains('scrubbing')) return; // typed values apply on change
      const v = Number(num.value);
      if (!Number.isFinite(v)) return;
      set(clamp(v, min, maxOf()));
      this.#touch();
      update();
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) { update(); return; }
      set(clamp(v, min, maxOf()));
      this.#touch();
      this.#commit(commit || label);
      update();
    });
    if (def != null) {
      range.addEventListener('dblclick', () => { set(def); this.#touch(); this.#commit(`Reset ${label}`); update(); });
      range.title = 'Double-click to reset';
    }
    this.bindings.push(update);
    update();
    return this.#field(label, range, num);
  }

  #select({ label, options, get, set, commit }) {
    const sel = h('select', { class: 'select' }, ...options.map(([v, t]) => h('option', { value: String(v), text: t })));
    const update = () => { const v = String(get()); if (sel.value !== v) sel.value = v; };
    sel.addEventListener('change', () => { set(sel.value); this.#touch(); this.#commit(commit || label); });
    this.bindings.push(update);
    update();
    return this.#field(label, h('div', { class: 'ctl' }, sel), null, 'field two');
  }

  #segmented({ label, options, get, set, commit }) {
    const group = h('div', { class: 'seg fill', role: 'radiogroup', 'aria-label': label });
    const buttons = options.map(([v, t]) => h('button', {
      type: 'button', role: 'radio', text: t,
      on: { click: () => { set(v); this.#touch(); this.#commit(commit || label); update(); } },
    }));
    group.append(...buttons);
    const update = () => { const cur = get(); buttons.forEach((b, i) => b.setAttribute('aria-checked', String(options[i][0] === cur))); };
    this.bindings.push(update);
    update();
    return h('div', { class: 'field two' }, h('span', { class: 'lbl', text: label }), group);
  }

  #color({ label, get, set, commit }) {
    const input = h('input', { type: 'color', class: 'swatch', 'aria-label': label });
    const update = () => { const v = get(); if (input.value !== v) input.value = v; };
    input.addEventListener('input', () => { set(input.value); this.#touch(); });
    input.addEventListener('change', () => this.#commit(commit || label));
    this.bindings.push(update);
    update();
    return input;
  }

  #check({ label, get, set, commit }) {
    const input = h('input', { type: 'checkbox' });
    const update = () => { input.checked = !!get(); };
    input.addEventListener('change', () => { set(input.checked); this.#touch(); this.#commit(commit || label); });
    this.bindings.push(update);
    update();
    return h('label', { class: 'check' }, input, h('span', { text: label }));
  }

  #tc({ label, get, set, commit }) {
    const fps = () => this.store.project.fps;
    const input = h('input', { type: 'text', class: 'text-input tc-input', inputmode: 'numeric', spellcheck: 'false', autocomplete: 'off' });
    const update = () => { if (document.activeElement !== input) input.value = formatTC(get(), fps()); input.removeAttribute('aria-invalid'); };
    input.addEventListener('change', () => {
      const v = parseTC(input.value, fps());
      if (v == null) { input.setAttribute('aria-invalid', 'true'); toast(`"${input.value}" is not a timecode. Use HH:MM:SS:FF or seconds.`, { kind: 'error' }); return; }
      set(v);
      this.#commit(commit || label);
      update();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('blur', update);
    this.bindings.push(update);
    update();
    return this.#field(label, input, null, 'field two');
  }

  #section(title, children, action = null) {
    return h('section', { class: 'insp-sec' }, h('h3', {}, h('span', { text: title }), action), ...children);
  }

  #linkBtn(text, onClick) {
    return h('button', { type: 'button', class: 'link-btn', text, on: { click: onClick } });
  }

  // ---------- panels ----------
  #head(kind, title, sub, actions = []) {
    return h('div', { class: 'insp-head' },
      h('span', { class: 'insp-kind', dataset: { kind } }, icon(KIND_ICON[kind] || 'sliders')),
      h('div', { class: 'insp-title' }, title, sub ? h('p', { text: sub }) : null),
      h('div', { class: 'insp-actions' }, ...actions));
  }

  #project() {
    const { store } = this;
    const p = () => store.project;
    const assets = this.assets.list();
    const bytes = assets.reduce((n, a) => n + (a.size || 0), 0);
    const head = this.#head('project', h('h2', { text: 'Sequence' }), ' ');
    const sub = head.querySelector('.insp-title p');
    const updSub = () => { sub.textContent = `${store.dims[0]}×${store.dims[1]} · ${store.project.fps} fps · ${store.project.clips.length} clips`; };
    this.bindings.push(updSub);
    updSub();
    const sections = [
      head,
      this.#section('Format', [
        this.#segmented({ label: 'Aspect', options: [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5']], get: () => p().aspect, set: (v) => { p().aspect = v; }, commit: 'Aspect' }),
        this.#select({ label: 'Frame rate', options: FPS_OPTIONS.map((f) => [f, `${f} fps`]), get: () => p().fps, set: (v) => { p().fps = Number(v); }, commit: 'Frame rate' }),
        this.#segmented({ label: 'Background', options: [['black', 'Black'], ['blur', 'Blur'], ['color', 'Colour']], get: () => p().background.mode, set: (v) => { p().background.mode = v; }, commit: 'Background' }),
        h('div', { class: 'field two' }, h('span', { class: 'lbl', text: 'Colour' }), h('div', { class: 'ctl' }, this.#color({ label: 'Background colour', get: () => p().background.color, set: (v) => { p().background.color = v; p().background.mode = 'color'; }, commit: 'Background colour' }))),
      ]),
      this.#section('Media in memory', [
        h('p', { class: 'insp-note', text: assets.length
          ? `${assets.length} item${assets.length > 1 ? 's' : ''}, ${formatBytes(bytes)} held locally in this tab. Removing an item from the library releases its memory.`
          : 'Nothing imported yet. Files you add are read straight from your disk and are never uploaded.' }),
      ]),
      this.#section('Quick keys', [
        h('ul', { class: 'hint-list' },
          ...[['Play / pause', 'Space'], ['Split at playhead', 'S'], ['Razor tool', 'C'], ['Ripple delete', 'Shift Del'], ['Undo', 'Ctrl Z'], ['All shortcuts', '?']]
            .map(([t, k]) => h('li', {}, h('span', { text: t }), h('span', {}, ...k.split(' ').map((x) => h('kbd', { text: x })))))),
      ]),
    ];
    return sections;
  }

  #multi(sel) {
    const A = this.actions;
    const texts = sel.filter((c) => c.kind === 'text');
    const voiceRows = [];
    if (texts.length && this.voice) {
      const btn = h('button', { type: 'button', class: 'btn bone block' }, icon('mic'), h('span', { text: `Voice-over ${texts.length} text clip${texts.length > 1 ? 's' : ''}` }));
      btn.addEventListener('click', () => {
        runWithProgress(btn, 'Voicing', (_onStep, setText) => this.voiceover.voiceTexts(texts.map((t) => t.id), this.voiceSettings, (i, n) => setText(`Voicing ${i + 1} of ${n}…`)))
          .then((n) => toast(`Added ${n} voice-over${n > 1 ? 's' : ''}.`, { kind: 'ok' }))
          .catch((err) => toast(err.message, { kind: 'error', timeout: 6000 }));
      });
      voiceRows.push(this.#section('AI voice-over', [modelStatus(this.voice), voiceControls(this.voiceSettings), btn, licenseNote()]));
    }
    return [
      this.#head('project', h('h2', { text: `${sel.length} clips selected` }), `${formatTC(Math.min(...sel.map((c) => c.start)), this.store.project.fps)} – ${formatTC(Math.max(...sel.map(clipEnd)), this.store.project.fps)}`),
      this.#section('Selection', [
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', on: { click: () => A.duplicateSelected() } }, icon('duplicate'), h('span', { text: 'Duplicate' })),
          h('button', { type: 'button', class: 'btn', on: { click: () => A.deleteSelected(false) } }, icon('trash'), h('span', { text: 'Delete' })),
          h('button', { type: 'button', class: 'btn', on: { click: () => A.deleteSelected(true) } }, icon('ripple'), h('span', { text: 'Ripple' }))),
      ]),
      ...(sel.some(isVisual) ? [this.#section('Align each to the frame', [this.#alignToolbar(() => sel.filter(isVisual).map((c) => c.id))])] : []),
      ...voiceRows,
    ];
  }

  #clip(clip0) {
    const { store, actions } = this;
    const id = clip0.id;
    const C = () => store.getClip(id) || clip0;
    const fps = () => store.project.fps;
    const asset = this.assets.get(clip0.assetId);
    const out = [];

    const isText = clip0.kind === 'text';
    const nameInput = isText
      ? h('h2', { class: 'insp-text-title' })
      : h('input', { type: 'text', maxlength: 120, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Clip name' });
    if (!isText) {
      nameInput.value = clip0.name || '';
      nameInput.addEventListener('change', () => { C().name = nameInput.value.slice(0, 120); this.#commit('Rename clip'); });
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
    }
    const sub = h('p', {});
    const updSub = () => {
      const c = C();
      if (isText) nameInput.textContent = String(c.text.content || '').split('\n')[0].trim() || 'Empty text';
      sub.textContent = `${KIND_LABEL[c.kind]} · ${store.getTrack(c.trackId)?.name || ''} · ${formatTC(c.start, fps())}`;
    };
    this.bindings.push(updSub);
    updSub();
    out.push(this.#head(clip0.kind, h('div', {}, nameInput, sub), null, [
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Split at playhead (S)', title: 'Split at playhead (S)', on: { click: () => actions.splitAtPlayhead() } }, icon('split')),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Duplicate (Ctrl+D)', title: 'Duplicate (Ctrl+D)', on: { click: () => actions.duplicateSelected() } }, icon('duplicate')),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Delete (Del)', title: 'Delete (Del)', on: { click: () => actions.deleteSelected(false) } }, icon('trash')),
    ]));
    out[0].querySelector('.insp-title').replaceChildren(nameInput, sub);

    // Timing
    const timing = [
      this.#tc({ label: 'Start', get: () => C().start, set: (v) => {
        const c = C();
        c.start = quantize(Math.max(0, v), fps());
        overwriteRange(store.project, c.trackId, c.start, clipEnd(c), new Set([c.id]), fps());
      }, commit: 'Move' }),
      this.#tc({ label: 'Duration', get: () => C().duration, set: (v) => {
        const c = C();
        const max = maxTimelineDuration(c, this.assets.get(c.assetId));
        c.duration = clamp(quantize(v, fps()), 1 / fps(), Number.isFinite(max) ? Math.floor(max * fps()) / fps() : 36000);
        overwriteRange(store.project, c.trackId, c.start, clipEnd(c), new Set([c.id]), fps());
      }, commit: 'Set duration' }),
    ];
    if (clip0.kind === 'video' || clip0.kind === 'audio') {
      timing.push(this.#select({ label: 'Speed', options: SPEEDS.map((s) => [s, `${s}×`]), get: () => C().speed, set: (v) => {
        const c = C();
        const s = Number(v);
        const newDur = (c.duration * c.speed) / s;
        c.speed = s;
        const max = maxTimelineDuration(c, this.assets.get(c.assetId));
        c.duration = Math.max(1 / fps(), Math.floor(Math.min(newDur, max) * fps()) / fps());
        overwriteRange(store.project, c.trackId, c.start, clipEnd(c), new Set([c.id]), fps());
      }, commit: 'Change speed' }));
    }
    const timingSec = this.#section('Timing', timing);
    // Overlays lead with what you edit most: their content and style, then position, then motion.
    if (clip0.kind === 'text' || clip0.kind === 'sticker') {
      out.push(clip0.kind === 'text' ? this.#textSection(C) : this.#stickerSection(C));
      out.push(this.#transformSection(C, clip0), this.#animSection(C, clip0), timingSec);
      const trSec = this.#transitionSection(C);
      if (trSec) out.push(trSec);
      if (clip0.kind === 'text' && this.voice) out.push(this.#voiceSection(C));
      return out;
    }
    out.push(timingSec);
    if (isMedia(clip0)) { const trSec = this.#transitionSection(C); if (trSec) out.push(trSec); }
    if (clip0.kind === 'audio' && asset?.source === 'voice') out.push(this.#voiceInfo(C, asset));
    if (isVisual(clip0)) out.push(this.#transformSection(C, clip0));
    if (isVisual(clip0)) out.push(this.#animSection(C, clip0));
    if (isMedia(clip0)) out.push(this.#colorSection(C));
    if (clip0.kind === 'audio' || (clip0.kind === 'video' && asset?.hasAudio)) out.push(this.#audioSection(C));
    if (clip0.kind === 'video' && asset && !asset.hasAudio) {
      out.push(this.#section('Audio', [h('p', { class: 'insp-note', text: 'This video has no audio track the browser could decode.' })]));
    }
    return out;
  }

  #textSection(C) {
    const T = () => C().text;
    const id = C().id;
    // Content: edits show on the canvas as you type; one undo step per editing session.
    const ta = h('textarea', { class: 'text-area text-content', rows: 2, spellcheck: 'true', 'aria-label': 'Text content', placeholder: 'Type your text' });
    const grow = () => { ta.rows = Math.min(8, Math.max(2, String(ta.value).split('\n').length)); };
    const updTa = () => { if (document.activeElement !== ta) { ta.value = T().content; grow(); } };
    ta.addEventListener('input', () => { T().content = ta.value.slice(0, 2000); grow(); this.#touch(); });
    ta.addEventListener('change', () => this.#commit('Edit text'));
    this.bindings.push(updTa);
    updTa();
    const editBtn = h('button', { type: 'button', class: 'btn small', title: 'Edit directly on the canvas (double-click the text, or press Enter)', on: { click: () => this.store.emit('edit-text', id) } }, icon('type'), h('span', { text: 'Edit on canvas' }));

    // Font family: each choice is drawn in its own typeface.
    const fontBtns = Object.entries(TEXT_FONTS).map(([k, f]) => {
      const b = h('button', { type: 'button', class: 'font-chip', role: 'radio', title: f.label, on: { click: () => { T().font = k; this.#touch(); this.#commit('Font'); updFonts(); } } },
        h('span', { class: 'font-chip-aa', text: 'Aa' }), h('span', { class: 'font-chip-name', text: f.label }));
      b.querySelector('.font-chip-aa').style.setProperty('font-family', f.stack);
      return [k, b];
    });
    const updFonts = () => fontBtns.forEach(([k, b]) => b.setAttribute('aria-checked', String(T().font === k)));
    this.bindings.push(updFonts);
    updFonts();

    // Weight + italic
    const italic = h('button', { type: 'button', class: 'icon-btn', title: 'Italic', 'aria-label': 'Italic', on: { click: () => { T().italic = !T().italic; this.#touch(); this.#commit('Italic'); updItalic(); } } }, icon('italic'));
    const updItalic = () => italic.setAttribute('aria-pressed', String(!!T().italic));
    this.bindings.push(updItalic);
    updItalic();
    const weight = this.#segmented({ label: 'Weight', options: [[400, 'Regular'], [700, 'Bold'], [900, 'Black']], get: () => T().weight, set: (v) => { T().weight = v; }, commit: 'Font weight' });
    weight.append(italic);
    weight.classList.add('with-tail');

    // Colour: swatch plus the palette the editor itself is built from.
    const PALETTE = ['#ffffff', '#1c1b19', '#e6e0d2', '#d8382b', '#b98a2e', '#4f6b86', '#f2c230'];
    const chips = PALETTE.map((c) => {
      const b = h('button', { type: 'button', class: 'color-chip', title: c, 'aria-label': `Text colour ${c}`, on: { click: () => { T().color = c; this.#touch(); this.#commit('Text colour'); this.sync(); } } });
      b.style.setProperty('--chip', c);
      return [c, b];
    });
    const updChips = () => chips.forEach(([c, b]) => b.setAttribute('aria-pressed', String(String(T().color).toLowerCase() === c)));
    this.bindings.push(updChips);
    updChips();

    // Alignment as icons
    const alignGroup = h('div', { class: 'seg icons', role: 'radiogroup', 'aria-label': 'Text alignment' });
    const alignBtns = [['left', 'text-left', 'Align text left'], ['center', 'text-center', 'Centre text'], ['right', 'text-right', 'Align text right']].map(([v, ic, lbl]) => {
      const b = h('button', { type: 'button', role: 'radio', title: lbl, 'aria-label': lbl, on: { click: () => { T().align = v; this.#touch(); this.#commit('Text align'); updAlign(); } } }, icon(ic));
      return [v, b];
    });
    alignBtns.forEach(([, b]) => alignGroup.append(b));
    const updAlign = () => alignBtns.forEach(([v, b]) => b.setAttribute('aria-checked', String(T().align === v)));
    this.bindings.push(updAlign);
    updAlign();

    const row = (label, ...kids) => h('div', { class: 'field two' }, h('span', { class: 'lbl', text: label }), h('div', { class: 'ctl wrap' }, ...kids));
    return this.#section('Text', [
      h('div', { class: 'field stack' }, ta, h('div', { class: 'text-edit-row' }, editBtn, h('span', { class: 'insp-hint', text: 'Or double-click the text on the canvas.' }))),
      h('div', { class: 'font-grid', role: 'radiogroup', 'aria-label': 'Font' }, ...fontBtns.map(([, b]) => b)),
      this.#slider({ label: 'Size', min: 8, max: 360, step: 1, get: () => Math.round(T().size * 1080), set: (v) => { T().size = v / 1080; }, commit: 'Text size', unit: 'px at 1080p', def: 97 }),
      weight,
      row('Colour', this.#color({ label: 'Text colour', get: () => T().color, set: (v) => { T().color = v; }, commit: 'Text colour' }), ...chips.map(([, b]) => b)),
      h('div', { class: 'field two' }, h('span', { class: 'lbl', text: 'Align' }), alignGroup),
      row('Box', this.#check({ label: 'Background', get: () => T().bg, set: (v) => { T().bg = v; }, commit: 'Text box' }), this.#color({ label: 'Box colour', get: () => T().bgColor, set: (v) => { T().bgColor = v; T().bg = true; }, commit: 'Box colour' })),
      this.#slider({ label: 'Outline', min: 0, max: 10, step: 0.5, get: () => T().strokeWidth, set: (v) => { T().strokeWidth = v; }, commit: 'Outline width', def: 0 }),
      row('Outline · shadow', this.#color({ label: 'Outline colour', get: () => T().strokeColor, set: (v) => { T().strokeColor = v; if (!T().strokeWidth) T().strokeWidth = 2; }, commit: 'Outline colour' }), this.#check({ label: 'Shadow', get: () => T().shadow, set: (v) => { T().shadow = v; }, commit: 'Text shadow' })),
      this.#slider({ label: 'Line height', min: 0.8, max: 2, step: 0.02, get: () => T().lineHeight, set: (v) => { T().lineHeight = v; }, commit: 'Line height', def: 1.12 }),
    ]);
  }

  #voiceSection(C) {
    const settings = this.voiceSettings;
    const store = this.store;
    const linked = () => { const v = C().voice; return v?.clipId ? store.getClip(v.clipId) : null; };
    const info = h('p', { class: 'insp-note voice-meta' });
    const genBtn = h('button', { type: 'button', class: 'btn bone block' }, icon('mic'), h('span', { text: 'Generate voice-over' }));
    const playBtn = h('button', { type: 'button', class: 'btn', title: 'Play the voice-over', 'aria-label': 'Play the voice-over' }, icon('play'), h('span', { text: 'Play' }));
    const updInfo = () => {
      const v = C().voice;
      const clip = linked();
      if (!v || !clip) {
        info.textContent = 'Turns this text into narration with an AI voice, placed on an audio track under the text.';
        genBtn.lastElementChild.textContent = 'Generate voice-over';
        playBtn.hidden = true;
        return;
      }
      const langName = (VOICE_LANGS.find((l) => l[0] === v.lang) || [v.lang, v.lang])[1];
      const voiceName = (VOICES.find((x) => x[0] === v.voice) || [v.voice, v.voice])[1];
      const stale = String(C().text.content || '').trim() !== v.text;
      info.textContent = `${voiceName} · ${langName} · ${clip.duration.toFixed(1)} s on ${store.getTrack(clip.trackId)?.name || '?'}${stale ? '. The text changed since this voice was made: regenerate to match.' : ''}`;
      info.classList.toggle('warn', stale);
      genBtn.lastElementChild.textContent = stale ? 'Regenerate to match text' : 'Regenerate voice-over';
      playBtn.hidden = false;
    };
    this.bindings.push(updInfo);
    updInfo();
    genBtn.addEventListener('click', () => {
      runWithProgress(genBtn, 'Generating', (onStep) => this.voiceover.voiceText(C().id, settings, { onStep }))
        .then(() => toast('Voice-over added under the text.', { kind: 'ok' }))
        .catch((err) => toast(err.message, { kind: 'error', timeout: 6000 }));
    });
    playBtn.addEventListener('click', () => {
      const clip = linked();
      const buf = clip && this.assets.get(clip.assetId)?.buffer;
      if (buf) this.audio.preview(buf);
    });
    // Already downloaded once? Start preparing now so the first click is quick.
    if (this.voice.cached && this.voice.state === 'idle') this.voice.load().catch(() => {});
    const fit = this.#check({ label: 'Fit text length to the voice', get: () => settings.fit, set: (v) => { settings.fit = v; } });
    fit.querySelector('input').addEventListener('change', () => { try { localStorage.setItem('cutroom.voice', JSON.stringify(settings)); } catch { /* ignore */ } });
    return this.#section('AI voice-over', [
      modelStatus(this.voice),
      info,
      voiceControls(settings),
      h('div', { class: 'field stack' }, fit),
      h('div', { class: 'btn-row' }, genBtn, playBtn),
      licenseNote(),
    ]);
  }

  #voiceInfo(C, asset) {
    const target = () => { const id = C().voiceOf; return id ? this.store.getClip(id) : null; };
    const note = h('p', { class: 'insp-note' });
    const upd = () => {
      const t = target();
      note.textContent = t?.kind === 'text'
        ? `Generated from the text "${String(t.text.content).slice(0, 60)}". Moving either clip moves both (hold Alt to move one).`
        : `AI narration (${asset.lang || 'auto'}). Captions made with it move along when you drag this clip (hold Alt to move it alone).`;
    };
    this.bindings.push(upd);
    upd();
    const rows = [note];
    if (target()?.kind === 'text') {
      rows.push(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn small', on: { click: () => this.store.select([target().id]) } }, icon('type'), h('span', { text: 'Select its text' }))));
    }
    rows.push(licenseNote());
    return this.#section('AI voice', rows);
  }

  #stickerSection(C) {
    const S = () => C().sticker;
    const rows = [];
    if (!S().emoji) {
      rows.push(this.#select({ label: 'Shape', options: SHAPES.map((s) => [s.id, s.name]), get: () => S().shape, set: (v) => { S().shape = v; }, commit: 'Sticker shape' }));
      rows.push(h('div', { class: 'field two' }, h('span', { class: 'lbl', text: 'Colour' }), h('div', { class: 'ctl' },
        this.#color({ label: 'Sticker colour', get: () => S().color, set: (v) => { S().color = v; }, commit: 'Sticker colour' }),
        this.#check({ label: 'White outline', get: () => S().outline, set: (v) => { S().outline = v; }, commit: 'Sticker outline' }))));
    }
    rows.push(this.#slider({ label: 'Size', min: 4, max: 90, step: 1, get: () => S().size * 100, set: (v) => { S().size = v / 100; }, commit: 'Sticker size', unit: '% of short side' }));
    return this.#section('Sticker', rows);
  }

  /** Six align buttons (frame or title-safe area) acting on the given clips. */
  #alignToolbar(ids) {
    const run = (mode, label) => {
      const n = alignClips(this.store, this.renderer, ids(), mode, { safe: this.alignSafe });
      if (n) { this.#touch(); this.#commit(label); this.sync(); }
    };
    const btns = ALIGN_MODES.map(([mode, label, ic]) => h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, on: { click: () => run(mode, label) } }, icon(ic)));
    const safeSeg = h('div', { class: 'seg compact-seg', role: 'radiogroup', 'aria-label': 'Align relative to' });
    const opts = [[false, 'Frame'], [true, 'Safe area']].map(([v, t]) => h('button', {
      type: 'button', role: 'radio', text: t, title: v ? 'Align inside the 5% title-safe margin' : 'Align to the frame edges',
      on: { click: () => { this.alignSafe = v; upd(); } },
    }));
    opts.forEach((b) => safeSeg.append(b));
    const upd = () => opts.forEach((b, i) => b.setAttribute('aria-checked', String(i === 1 ? this.alignSafe : !this.alignSafe)));
    upd();
    return h('div', { class: 'align-bar' },
      h('div', { class: 'align-group', role: 'group', 'aria-label': 'Horizontal alignment' }, ...btns.slice(0, 3)),
      h('div', { class: 'align-group', role: 'group', 'aria-label': 'Vertical alignment' }, ...btns.slice(3)),
      safeSeg);
  }

  #transformSection(C, clip0) {
    const T = () => C().transform;
    const rows = [
      this.#alignToolbar(() => [C().id]),
      this.#slider({ label: 'Position X', min: -50, max: 150, step: 0.1, get: () => T().x * 100, set: (v) => { T().x = v / 100; }, commit: 'Position', def: 50, unit: '%' }),
      this.#slider({ label: 'Position Y', min: -50, max: 150, step: 0.1, get: () => T().y * 100, set: (v) => { T().y = v / 100; }, commit: 'Position', def: 50, unit: '%' }),
      this.#slider({ label: 'Scale', min: 5, max: 500, step: 1, get: () => T().scale * 100, set: (v) => { T().scale = v / 100; }, commit: 'Scale', def: 100, unit: '%' }),
      this.#slider({ label: 'Rotation', min: -180, max: 180, step: 0.5, get: () => T().rotation, set: (v) => { T().rotation = v; }, commit: 'Rotation', def: 0, unit: 'degrees' }),
      this.#slider({ label: 'Opacity', min: 0, max: 100, step: 1, get: () => T().opacity * 100, set: (v) => { T().opacity = v / 100; }, commit: 'Opacity', def: 100, unit: '%' }),
    ];
    if (isMedia(clip0)) {
      rows.push(this.#segmented({ label: 'Fit', options: [['contain', 'Fit'], ['cover', 'Fill']], get: () => C().fit, set: (v) => { C().fit = v; }, commit: 'Fit' }));
      rows.push(this.#select({ label: 'Motion', options: [['none', 'None'], ['zoom-in', 'Slow zoom in'], ['zoom-out', 'Slow zoom out']], get: () => C().motion, set: (v) => { C().motion = v; }, commit: 'Motion' }));
    }
    return this.#section('Position & alignment', rows, this.#linkBtn('Reset', () => { C().transform = DEFAULT_TRANSFORM(); this.#touch(); this.#commit('Reset transform'); this.sync(); }));
  }

  /**
   * Independent entrance and exit. Each duration is limited so that intro + outro never exceeds the
   * clip; the entrance runs over [0, intro] and the exit over [end - outro, end].
   */
  #animSection(C, clip0) {
    const I = () => C().introAnimation;
    const O = () => C().outroAnimation;
    const active = (a) => a.type && a.type !== 'none';
    const room = (other) => Math.max(MIN_ANIM, C().duration - (active(other()) ? other().duration : 0));
    const inOpts = clip0.kind === 'text' ? ANIM_IN : ANIM_IN.filter(([k]) => k !== 'typewriter');
    const note = h('p', { class: 'insp-note anim-note' });
    const updNote = () => {
      const c = C();
      const eff = effectiveAnimDurations(c);
      const parts = [];
      if (eff.intro) parts.push(`In plays 0–${eff.intro.toFixed(2)} s`);
      if (eff.outro) parts.push(`out plays ${(c.duration - eff.outro).toFixed(2)}–${c.duration.toFixed(2)} s`);
      note.textContent = parts.length ? `${parts.join(', ')} of this ${c.duration.toFixed(2)} s clip.` : 'No entrance or exit animation.';
    };
    this.bindings.push(updNote);
    updNote();
    const setDur = (a, other) => (v) => { a().duration = clamp(v, MIN_ANIM, room(other)); };
    return this.#section('Animation', [
      h('h4', { class: 'insp-sub', text: 'Beginning (in)' }),
      this.#select({ label: 'Effect', options: inOpts, get: () => I().type, set: (v) => {
        I().type = v;
        if (v !== 'none') I().duration = clamp(I().duration || 0.5, MIN_ANIM, room(O));
      }, commit: 'Intro animation' }),
      this.#slider({ label: 'Duration', min: 0.05, max: () => Math.min(10, room(O)), step: 0.05, get: () => I().duration, set: setDur(I, O), commit: 'Intro duration', def: 0.5, unit: 'seconds', disabled: () => !active(I()) }),
      h('h4', { class: 'insp-sub', text: 'Ending (out)' }),
      this.#select({ label: 'Effect', options: ANIM_OUT, get: () => O().type, set: (v) => {
        O().type = v;
        if (v !== 'none') O().duration = clamp(O().duration || 0.5, MIN_ANIM, room(I));
      }, commit: 'Outro animation' }),
      this.#slider({ label: 'Duration', min: 0.05, max: () => Math.min(10, room(I)), step: 0.05, get: () => O().duration, set: setDur(O, I), commit: 'Outro duration', def: 0.5, unit: 'seconds', disabled: () => !active(O()) }),
      note,
    ]);
  }

  /** Transition into this clip from the one that ends where it starts (only shown when there is one). */
  #transitionSection(C) {
    const project = () => this.store.project;
    const prev = prevAdjacent(project(), C());
    if (!prev) return null;
    const T = () => C().transition || { type: 'none', duration: 0.5 };
    const on = () => T().type && T().type !== 'none';
    return this.#section('Transition in', [
      this.#select({ label: 'Type', options: TRANSITIONS, get: () => T().type, set: (v) => {
        if (v === 'none') delete C().transition;
        else C().transition = { type: v, duration: Math.min(C().transition?.duration || 0.5, C().duration) };
      }, commit: 'Transition' }),
      this.#slider({ label: 'Duration', min: 0.1, max: () => Math.max(0.15, Math.min(2, C().duration)), step: 0.05, get: () => T().duration, set: (v) => { if (on()) C().transition.duration = v; }, commit: 'Transition duration', def: 0.5, unit: 'seconds', disabled: () => !on() }),
      h('p', { class: 'insp-note', text: `Blends in from "${prev.name || prev.kind}". The outgoing clip keeps playing underneath for the length of the transition.` }),
    ], this.openPanel ? this.#linkBtn('Browse', () => this.openPanel('tab-transitions')) : null);
  }

  #colorSection(C) {
    const F = () => C().fx;
    const presets = [...LUT_PRESETS, ...customLuts];
    const buttons = presets.map((p) => {
      const canvas = h('canvas', { width: 96, height: 54 });
      this.lutCanvases.push({ id: p.id, canvas });
      return h('button', {
        type: 'button', class: 'lut-btn', title: p.name,
        on: { click: () => { F().lut = p.id; if (p.id !== 'none' && !F().lutAmount) F().lutAmount = 100; this.#touch(); this.#commit(`Look: ${p.name}`); update(); } },
      }, canvas, h('span', { text: p.name }));
    });
    const update = () => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(presets[i].id === F().lut)));
    this.bindings.push(update);
    update();
    const fxSlider = (label, key, min, max, def = 0, unit = '') => this.#slider({ label, min, max, step: 1, get: () => F()[key], set: (v) => { F()[key] = v; }, commit: label, def, unit });
    return this.#section('Colour', [
      h('div', { class: 'lut-grid', role: 'group', 'aria-label': 'Look presets' }, ...buttons),
      fxSlider('Look amount', 'lutAmount', 0, 100, 100, '%'),
      fxSlider('Brightness', 'brightness', -100, 100),
      fxSlider('Contrast', 'contrast', -100, 100),
      fxSlider('Saturation', 'saturation', -100, 100),
      fxSlider('Blur', 'blur', 0, 40, 0, 'px at 1080p'),
      fxSlider('Sepia', 'sepia', 0, 100),
      fxSlider('Vignette', 'vignette', 0, 100),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', on: { click: () => this.cubeInput.click() } }, icon('import'), h('span', { text: 'Load .cube' })),
        h('button', { type: 'button', class: 'btn small', on: { click: () => this.#applyGradeToAll(C()) } }, h('span', { text: 'Apply to all' }))),
    ], this.#linkBtn('Reset', () => { C().fx = DEFAULT_FX(); this.#touch(); this.#commit('Reset colour'); this.sync(); }));
  }

  #audioSection(C) {
    return this.#section('Audio', [
      this.#slider({ label: 'Volume', min: 0, max: 200, step: 1, get: () => Math.round((C().volume ?? 1) * 100), set: (v) => { C().volume = v / 100; }, commit: 'Volume', def: 100, unit: '%' }),
      this.#slider({ label: 'Fade in', min: 0, max: 5, step: 0.1, get: () => C().fadeIn, set: (v) => { C().fadeIn = Math.min(v, C().duration); }, commit: 'Fade in', def: 0, unit: 'seconds' }),
      this.#slider({ label: 'Fade out', min: 0, max: 5, step: 0.1, get: () => C().fadeOut, set: (v) => { C().fadeOut = Math.min(v, C().duration); }, commit: 'Fade out', def: 0, unit: 'seconds' }),
    ]);
  }

  #applyGradeToAll(src) {
    let n = 0;
    for (const c of this.store.project.clips) if (isMedia(c) && c.id !== src.id) { c.fx = { ...src.fx }; n++; }
    if (!n) { toast('No other video or image clips to grade.'); return; }
    this.#commit('Apply grade to all');
    toast(`Grade copied to ${n} clip${n > 1 ? 's' : ''}.`, { kind: 'ok' });
  }

  async #loadCube() {
    const file = this.cubeInput.files?.[0];
    this.cubeInput.value = '';
    if (!file) return;
    if (!this.glfx) { toast('Loading .cube LUTs needs WebGL2, which this browser has disabled.', { kind: 'error' }); return; }
    if (file.size > 8 * 1024 * 1024) { toast('That LUT file is larger than 8 MB.', { kind: 'error' }); return; }
    try {
      const { size, data, title } = parseCube(await file.text());
      const id = `custom:${uid('l')}`;
      const name = (title || file.name.replace(/\.cube$/i, '')).slice(0, 40);
      this.glfx.registerCustomLut(id, size, data);
      this.renderer?.gpu?.registerCustomLut(id, size, data);
      customLuts.push({ id, name });
      const c = this.clipId && this.store.getClip(this.clipId);
      if (c && isMedia(c)) { c.fx.lut = id; c.fx.lutAmount = 100; this.store.commit(`Look: ${name}`); }
      this.render();
      toast(`Loaded LUT "${name}" (${size}³).`, { kind: 'ok' });
    } catch (err) {
      toast(`Could not read that .cube file: ${err.message}`, { kind: 'error' });
    }
  }

  #drawLutThumbs(clip) {
    if (!this.lutCanvases.length || !this.glfx) return;
    const asset = this.assets.get(clip.assetId);
    const poster = asset?.poster;
    if (!poster) return;
    const key = `poster:${asset.id}`;
    if (!this.glfx.hasTex(key) && !this.glfx.upload(key, poster, { mipmap: true })) return;
    const pw = poster.width || 16, ph = poster.height || 9;
    for (const { id, canvas } of this.lutCanvases) {
      const ctx = canvas.getContext('2d');
      const k = Math.max(canvas.width / pw, canvas.height / ph);
      const w = pw * k, hh = ph * k;
      const r = this.glfx.process(key, { ...DEFAULT_FX(), lut: id, lutAmount: 100 }, w, hh, 0);
      if (!r) continue;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(r.canvas, r.sx, r.sy, r.sw, r.sh, (canvas.width - w) / 2, (canvas.height - hh) / 2, w, hh);
    }
  }
}
