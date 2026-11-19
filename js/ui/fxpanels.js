// Drawer panels for Transitions and Effects. Both act on the current selection: a transition sits at the
// head of a clip that butts against the previous clip on its track; effects (looks and quick grades)
// apply to every selected video or image clip. Previews are drawn locally on small canvases.
import { TRANSITIONS, prevAdjacent, transitionMods, isMedia } from '../core/ops.js';
import { LUT_PRESETS, buildLut } from '../engine/luts.js';
import { h, icon, toast } from './dom.js';
import { clamp, reducedMotion } from '../util.js';

const $ = (id) => document.getElementById(id);
const PW = 112, PH = 63;

/** Quick grades: a look plus slider values, all expressed in the clip's normal fx fields. */
const QUICK = [
  { id: 'cinematic', name: 'Cinematic', fx: { lut: 'teal-orange', lutAmount: 80, contrast: 12, saturation: 0, brightness: -4, vignette: 32, sepia: 0, blur: 0 } },
  { id: 'mono', name: 'Mono', fx: { lut: 'noir', lutAmount: 100, contrast: 10, saturation: 0, brightness: 0, vignette: 18, sepia: 0, blur: 0 } },
  { id: 'warm', name: 'Warm film', fx: { lut: 'golden', lutAmount: 70, contrast: 4, saturation: -6, brightness: 2, vignette: 14, sepia: 10, blur: 0 } },
  { id: 'cool', name: 'Cool', fx: { lut: 'arctic', lutAmount: 75, contrast: 6, saturation: 0, brightness: 0, vignette: 0, sepia: 0, blur: 0 } },
  { id: 'faded', name: 'Faded', fx: { lut: 'none', lutAmount: 100, contrast: -22, saturation: -28, brightness: 7, vignette: 0, sepia: 6, blur: 0 } },
  { id: 'punchy', name: 'Punchy', fx: { lut: 'none', lutAmount: 100, contrast: 18, saturation: 24, brightness: 0, vignette: 10, sepia: 0, blur: 0 } },
  { id: 'dream', name: 'Dreamy', fx: { lut: 'bleach', lutAmount: 40, contrast: -8, saturation: -10, brightness: 8, vignette: 24, sepia: 0, blur: 3 } },
  { id: 'reset', name: 'No effect', fx: { lut: 'none', lutAmount: 100, contrast: 0, saturation: 0, brightness: 0, vignette: 0, sepia: 0, blur: 0 } },
];

// ---------- preview scene (sky, sun, skin tone, foliage, shadow) ----------
let scene = null;
function sceneData() {
  if (scene) return scene;
  const c = new OffscreenCanvas(PW, PH);
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, PH * 0.62);
  sky.addColorStop(0, '#5b8fd6'); sky.addColorStop(1, '#f2b77a');
  g.fillStyle = sky; g.fillRect(0, 0, PW, PH);
  g.fillStyle = '#ffe2a8'; g.beginPath(); g.arc(PW * 0.78, PH * 0.42, PH * 0.12, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#3f6b3a'; g.beginPath(); g.moveTo(0, PH * 0.62); g.quadraticCurveTo(PW * 0.4, PH * 0.48, PW, PH * 0.66); g.lineTo(PW, PH); g.lineTo(0, PH); g.fill();
  g.fillStyle = '#20262e'; g.fillRect(0, PH * 0.84, PW, PH * 0.16);
  g.fillStyle = '#d9a07c'; g.beginPath(); g.ellipse(PW * 0.3, PH * 0.5, PH * 0.13, PH * 0.16, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2c2a33'; g.fillRect(PW * 0.2, PH * 0.64, PW * 0.2, PH * 0.3);
  scene = g.getImageData(0, 0, PW, PH);
  return scene;
}

const lutCache = new Map();
function lutTable(id) {
  if (!id || id === 'none') return null;
  if (!lutCache.has(id)) lutCache.set(id, buildLut(id, 17));
  return lutCache.get(id);
}

/** The compositor's grade, on the CPU, for a 112x63 preview. */
function gradePreview(canvas, fx) {
  const src = sceneData();
  const out = new ImageData(PW, PH);
  const lut = lutTable(fx.lut), N = 17, amt = (fx.lutAmount ?? 100) / 100;
  const br = ((fx.brightness || 0) / 100) * 0.75, ct = Math.max(-0.95, (fx.contrast || 0) / 100), sat = (fx.saturation || 0) / 100;
  const sep = (fx.sepia || 0) / 100, vig = (fx.vignette || 0) / 100;
  for (let y = 0, i = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++, i += 4) {
      let r = src.data[i] / 255, g = src.data[i + 1] / 255, b = src.data[i + 2] / 255;
      if (lut) {
        const k = ((Math.round(b * (N - 1)) * N + Math.round(g * (N - 1))) * N + Math.round(r * (N - 1))) * 3;
        r += (lut[k] / 255 - r) * amt; g += (lut[k + 1] / 255 - g) * amt; b += (lut[k + 2] / 255 - b) * amt;
      }
      r *= 1 + br; g *= 1 + br; b *= 1 + br;
      r = (r - 0.5) * (1 + ct) + 0.5; g = (g - 0.5) * (1 + ct) + 0.5; b = (b - 0.5) * (1 + ct) + 0.5;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * (1 + sat); g = l + (g - l) * (1 + sat); b = l + (b - l) * (1 + sat);
      if (sep) {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (sr - r) * sep; g += (sg - g) * sep; b += (sb - b) * sep;
      }
      if (vig) {
        const d = Math.hypot(x / PW - 0.5, y / PH - 0.5) * 1.41421;
        const t = clamp((d - 0.32) / 0.8, 0, 1);
        const f = 1 - vig * t * t * (3 - 2 * t);
        r *= f; g *= f; b *= f;
      }
      out.data[i] = clamp(r, 0, 1) * 255; out.data[i + 1] = clamp(g, 0, 1) * 255; out.data[i + 2] = clamp(b, 0, 1) * 255; out.data[i + 3] = 255;
    }
  }
  const ctx = canvas.getContext('2d');
  ctx.putImageData(out, 0, 0);
  if (fx.blur) { ctx.filter = `blur(${fx.blur * 0.4}px)`; ctx.drawImage(canvas, 0, 0); ctx.filter = 'none'; }
}

/** A/B diagram of a transition at progress p: outgoing clip in blue, incoming in violet. */
function drawTransition(canvas, type, p) {
  const ctx = canvas.getContext('2d');
  const W = PW, H = PH;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const layer = (role, fill, label) => {
    const M = type === 'none' ? { alpha: role === 'in' ? (p >= 0.5 ? 1 : 0) : 1, dx: 0, dy: 0, scale: 1, scissor: null } : transitionMods({ role, type, p }, W, H);
    ctx.save();
    if (M.scissor) { ctx.beginPath(); ctx.rect(...M.scissor); ctx.clip(); }
    ctx.globalAlpha = M.alpha;
    ctx.translate(W / 2 + M.dx, H / 2 + M.dy);
    ctx.scale(M.scale, M.scale);
    ctx.fillStyle = fill;
    ctx.fillRect(-W / 2, -H / 2, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '700 20px "Hanken Grotesk", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 1);
    ctx.restore();
  };
  layer('out', '#2d5596', 'A');
  layer('in', '#6243b5', 'B');
}

export class FxPanels {
  constructor({ store, actions, openPanel }) {
    this.store = store;
    this.actions = actions;
    this.openPanel = openPanel;
    this.duration = 0.5;
    this.#buildTransitions();
    this.#buildEffects();
    store.on('selection', () => this.sync());
    store.on('project', () => this.sync());
    this.sync();
  }

  // ---------- Transitions ----------
  #buildTransitions() {
    const pane = $('pane-transitions');
    this.trTarget = h('div', { class: 'fx-target', role: 'status' });
    const range = h('input', { type: 'range', class: 'range', min: 0.1, max: 2, step: 0.05, value: this.duration, id: 'tr-dur', 'aria-label': 'Transition duration' });
    const num = h('input', { type: 'number', class: 'num', min: 0.1, max: 2, step: 0.05, value: this.duration.toFixed(2), 'aria-label': 'Transition duration in seconds' });
    const setDur = (v, commit) => {
      this.duration = clamp(Number(v) || 0.5, 0.1, 2);
      range.value = String(this.duration);
      range.style.setProperty('--p', `${((this.duration - 0.1) / 1.9) * 100}%`);
      if (document.activeElement !== num) num.value = this.duration.toFixed(2);
      const c = this.#trClip();
      if (commit && c?.transition && c.transition.type !== 'none') { c.transition.duration = this.duration; this.store.commit('Transition duration'); }
    };
    range.addEventListener('input', () => setDur(range.value, false));
    range.addEventListener('change', () => setDur(range.value, true));
    num.addEventListener('change', () => setDur(num.value, true));
    num.addEventListener('input', () => { if (num.classList.contains('scrubbing')) setDur(num.value, false); });
    setDur(this.duration, false);
    this.trDur = { setDur };

    this.trCards = TRANSITIONS.map(([id, name]) => {
      const canvas = h('canvas', { width: PW, height: PH });
      const still = id === 'none' ? 0.6 : id === 'fade-black' ? 0.3 : 0.5; // mid-fade is pure black, so show it on the way down
      drawTransition(canvas, id, still);
      const btn = h('button', { type: 'button', class: 'fx-card', 'aria-pressed': 'false', title: id === 'none' ? 'Remove the transition (straight cut)' : `${name} into the selected clip`, on: { click: () => this.#applyTransition(id, name) } }, canvas, h('span', { text: name }));
      let raf = 0, t0 = 0;
      const loop = (now) => {
        const p = ((now - t0) / 1400) % 1;
        drawTransition(canvas, id, p < 0.15 ? 0 : p > 0.85 ? 1 : (p - 0.15) / 0.7);
        raf = requestAnimationFrame(loop);
      };
      btn.addEventListener('pointerenter', () => { if (reducedMotion() || id === 'none') return; t0 = performance.now(); raf = requestAnimationFrame(loop); });
      btn.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); drawTransition(canvas, id, still); });
      btn.dataset.type = id;
      return btn;
    });
    const allBtn = h('button', { type: 'button', class: 'btn small block', on: { click: () => this.#applyAll() } }, icon('transition'), h('span', { text: 'Use the chosen one on every cut' }));
    pane.replaceChildren(
      h('p', { class: 'pane-note', text: 'A transition blends a clip into the one that ends right before it on the same track. Select the incoming clip, then pick one.' }),
      this.trTarget,
      h('div', { class: 'field' }, h('label', { for: 'tr-dur', text: 'Duration' }), range, num),
      h('div', { class: 'fx-grid', role: 'group', 'aria-label': 'Transitions' }, ...this.trCards),
      h('h3', { text: 'Whole sequence' }),
      allBtn,
    );
    this.lastType = 'dissolve';
  }

  #trClip() {
    const sel = this.store.selectedClips();
    return sel.length === 1 && (isMedia(sel[0]) || sel[0].kind === 'text' || sel[0].kind === 'sticker') ? sel[0] : null;
  }

  #applyTransition(type, name) {
    const c = this.#trClip();
    if (!c) { toast('Select one clip first: the transition goes at its start.'); return; }
    if (!prevAdjacent(this.store.project, c)) {
      toast('This clip has no clip ending right where it starts on the same track. Butt two clips together (or split one) and select the second.');
      return;
    }
    if (type === 'none') delete c.transition;
    else { c.transition = { type, duration: Math.min(this.duration, c.duration) }; this.lastType = type; }
    this.store.commit(type === 'none' ? 'Remove transition' : `Transition: ${name}`);
  }

  #applyAll() {
    const type = this.lastType;
    const name = TRANSITIONS.find(([id]) => id === type)?.[1] || type;
    const project = this.store.project;
    let n = 0;
    for (const c of project.clips) {
      if (!(isMedia(c)) || !prevAdjacent(project, c)) continue;
      c.transition = { type, duration: Math.min(this.duration, c.duration) };
      n++;
    }
    if (!n) { toast('No cuts found: no video or image clip starts exactly where another ends.'); return; }
    this.store.commit(`${name} on ${n} cut${n > 1 ? 's' : ''}`);
    toast(`${name} added to ${n} cut${n > 1 ? 's' : ''}.`, { kind: 'ok' });
  }

  // ---------- Effects ----------
  #buildEffects() {
    const pane = $('pane-effects');
    this.fxTarget = h('div', { class: 'fx-target', role: 'status' });
    const card = (name, fx, title, onClick) => {
      const canvas = h('canvas', { width: PW, height: PH });
      gradePreview(canvas, fx);
      return h('button', { type: 'button', class: 'fx-card', title, 'aria-pressed': 'false', on: { click: onClick } }, canvas, h('span', { text: name }));
    };
    this.lookCards = LUT_PRESETS.map((p) => {
      const b = card(p.name, { lut: p.id, lutAmount: 100 }, p.id === 'none' ? 'Remove the look' : `${p.name} look`, () => this.#applyFx({ lut: p.id, lutAmount: 100 }, `Look: ${p.name}`));
      b.dataset.lut = p.id;
      return b;
    });
    this.quickCards = QUICK.map((q) => {
      const b = card(q.name, q.fx, q.id === 'reset' ? 'Clear every colour effect' : `${q.name} grade`, () => this.#applyFx(q.fx, q.id === 'reset' ? 'Clear effects' : `Effect: ${q.name}`));
      b.dataset.quick = q.id;
      return b;
    });
    this.enhanceBtns = [[0, 'Off'], [1, 'Light'], [2, 'Strong']].map(([lvl, name]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': 'false', text: name, dataset: { lvl: String(lvl) },
      on: { click: () => this.#applyFx({ enhance: lvl }, lvl ? `Enhance: ${name}` : 'Enhance off') },
    }));
    const allBtn = h('button', { type: 'button', class: 'link-btn', text: 'Use Light on every clip', on: { click: () => this.#enhanceAll() } });
    pane.replaceChildren(
      h('p', { class: 'pane-note', text: 'Applies to every selected video or image clip. Fine-tune the result under Colour in the inspector.' }),
      this.fxTarget,
      h('h3', { text: 'Enhance' }),
      h('div', { class: 'seg fill', role: 'radiogroup', 'aria-label': 'Enhance' }, ...this.enhanceBtns),
      h('p', { class: 'pane-note fx-hint' }, 'Smooths compression blocks and noise, then sharpens edges. Best for clips sent through messaging apps. ', allBtn),
      h('h3', { text: 'Quick grades' }),
      h('div', { class: 'fx-grid', role: 'group', 'aria-label': 'Quick grades' }, ...this.quickCards),
      h('h3', { text: 'Looks' }),
      h('div', { class: 'fx-grid', role: 'group', 'aria-label': 'Looks' }, ...this.lookCards),
    );
  }

  #enhanceAll() {
    let n = 0;
    for (const c of this.store.project.clips) if (isMedia(c) && !(c.fx.enhance | 0)) { c.fx = { ...c.fx, enhance: 1 }; n++; }
    if (!n) { toast('Every clip already has Enhance on.'); return; }
    this.store.commit(`Enhance ${n} clip${n > 1 ? 's' : ''}`);
    toast(`Light enhance on ${n} clip${n > 1 ? 's' : ''}.`, { kind: 'ok' });
  }

  #applyFx(fx, label) {
    const targets = this.store.selectedClips().filter(isMedia);
    if (!targets.length) { toast('Select a video or image clip on the timeline first.'); return; }
    for (const c of targets) c.fx = { ...c.fx, ...fx };
    this.store.commit(targets.length > 1 ? `${label} (${targets.length} clips)` : label);
  }

  sync() {
    const project = this.store.project;
    const c = this.#trClip();
    const prev = c && prevAdjacent(project, c);
    const cur = c?.transition?.type && prev ? c.transition.type : 'none';
    this.trTarget.classList.toggle('ready', !!prev);
    this.trTarget.replaceChildren(h('span', { class: 'dot' }), c
      ? (prev ? h('span', {}, 'Into ', h('strong', { text: c.name || c.kind }), ` from ${prev.name || prev.kind}`) : h('span', { text: 'The selected clip has nothing butting against its start.' }))
      : h('span', { text: 'Select the incoming clip on the timeline.' }));
    this.trCards.forEach((b) => b.setAttribute('aria-pressed', String(!!c && !!prev && b.dataset.type === cur)));
    if (c?.transition && prev && document.activeElement?.id !== 'tr-dur') this.trDur.setDur(c.transition.duration, false);

    const media = this.store.selectedClips().filter(isMedia);
    this.fxTarget.classList.toggle('ready', media.length > 0);
    this.fxTarget.replaceChildren(h('span', { class: 'dot' }), media.length
      ? h('span', {}, h('strong', { text: media.length === 1 ? media[0].name || 'Clip' : `${media.length} clips` }), media.length === 1 ? ' selected' : ' selected')
      : h('span', { text: 'Select a video or image clip on the timeline.' }));
    const one = media.length === 1 ? media[0].fx : null;
    this.enhanceBtns.forEach((b) => b.setAttribute('aria-checked', String(!!one && (one.enhance | 0) === Number(b.dataset.lvl))));
    this.lookCards.forEach((b) => b.setAttribute('aria-pressed', String(!!one && one.lut === b.dataset.lut)));
    this.quickCards.forEach((b) => {
      const q = QUICK.find((x) => x.id === b.dataset.quick);
      const match = !!one && Object.entries(q.fx).every(([k, v]) => (one[k] ?? (k === 'lutAmount' ? 100 : k === 'lut' ? 'none' : 0)) === v);
      b.setAttribute('aria-pressed', String(match));
    });
  }
}
