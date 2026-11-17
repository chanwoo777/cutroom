// Shared UI for the AI voice: settings controls and a live model-status block used in the inspector
// (text clips) and the library (script narration).
import { h, icon } from './dom.js';
import { uid, formatBytes } from '../util.js';
import { VOICES, VOICE_LANGS, QUALITY, VOICE_MODEL, saveVoiceSettings } from '../engine/voice.js';

function select(options, value, onChange, label) {
  const id = uid('v');
  const el = h('select', { class: 'select', id, 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v, text: t })));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** Language, voice, speed and quality controls bound to a settings object (persisted per viewer). */
export function voiceControls(settings, onChange) {
  const set = (k, v) => { settings[k] = v; saveVoiceSettings(settings); onChange?.(settings); };
  const speedId = uid('v');
  const speed = h('input', { type: 'range', class: 'range', id: speedId, min: 0.8, max: 1.4, step: 0.05 });
  const speedOut = h('output', { class: 'unit', for: speedId });
  const syncSpeed = () => {
    speed.value = String(settings.speed);
    speedOut.textContent = `${Number(settings.speed).toFixed(2)}×`;
    speed.style.setProperty('--p', `${((settings.speed - 0.8) / 0.6) * 100}%`);
  };
  speed.addEventListener('input', () => { settings.speed = Number(speed.value); syncSpeed(); });
  speed.addEventListener('change', () => set('speed', Number(speed.value)));
  syncSpeed();
  const qGroup = h('div', { class: 'seg fill', role: 'radiogroup', 'aria-label': 'Voice quality' });
  const qButtons = QUALITY.map(([v, t, steps]) => h('button', {
    type: 'button', role: 'radio', text: t, title: `${steps} denoising steps`,
    'aria-checked': String(settings.quality === v),
    on: { click: () => { set('quality', v); qButtons.forEach((b, i) => b.setAttribute('aria-checked', String(QUALITY[i][0] === v))); } },
  }));
  qGroup.append(...qButtons);
  const lang = select(VOICE_LANGS, settings.lang, (v) => set('lang', v), 'Voice language');
  const voice = select(VOICES, settings.voice, (v) => set('voice', v), 'Voice');
  const row = (label, ctl, forId) => h('div', { class: 'field two' }, forId ? h('label', { for: forId, text: label }) : h('span', { class: 'lbl', text: label }), ctl);
  return h('div', { class: 'voice-controls' },
    row('Language', h('div', { class: 'ctl' }, lang), lang.id),
    row('Voice', h('div', { class: 'ctl' }, voice), voice.id),
    row('Speed', h('div', { class: 'ctl' }, speed, speedOut), speedId),
    row('Quality', qGroup));
}

const statusEls = new Set();
let wired = false;

function paint(el, voice) {
  const { state, progress, backend, error, cached } = voice;
  const kids = [];
  if (state === 'loading') {
    const p = progress.total ? progress.loaded / progress.total : 0;
    const label = progress.phase === 'prepare'
      ? 'Preparing the voice engine. The first time each session this takes about a minute…'
      : progress.fromCache && progress.loaded >= progress.total ? 'Opening the cached voice model…'
        : `Downloading voice model · ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`;
    const bar = h('progress', { max: 1, value: progress.phase === 'prepare' ? 1 : p, 'aria-label': 'Voice model download' });
    kids.push(h('p', { class: 'voice-line', text: label }), bar);
  } else if (state === 'ready') {
    kids.push(h('p', { class: 'voice-line ok' }, icon('shield'), h('span', { text: backend === 'webgpu' ? 'Voice ready · runs on your GPU (WebGPU)' : 'Voice ready · runs on your CPU (slower without WebGPU)' })));
  } else if (state === 'error') {
    kids.push(h('p', { class: 'voice-line error', text: error || 'The voice engine failed to start.' }),
      h('button', { type: 'button', class: 'btn small', on: { click: () => voice.load().catch(() => {}) } }, h('span', { text: 'Try again' })));
  } else if (cached) {
    kids.push(h('p', { class: 'voice-line', text: 'Voice model is saved on this device and opens when you generate.' }));
  } else {
    kids.push(h('p', { class: 'voice-line', text: `First use downloads the ${formatBytes(VOICE_MODEL.bytes)} voice model once and keeps it for offline use. Your text never leaves this device.` }),
      h('button', { type: 'button', class: 'btn small', on: { click: () => voice.load().catch(() => {}) } }, icon('download'), h('span', { text: 'Download voice model' })));
  }
  el.replaceChildren(...kids);
}

/** A status block that follows the engine's state wherever it is shown. */
export function modelStatus(voice) {
  if (!wired) {
    wired = true;
    voice.on('state', () => {
      for (const el of [...statusEls]) { if (!el.isConnected) statusEls.delete(el); else paint(el, voice); }
    });
  }
  const el = h('div', { class: 'voice-status', role: 'status', 'aria-live': 'polite' });
  statusEls.add(el);
  paint(el, voice);
  return el;
}

export function licenseNote() {
  return h('p', { class: 'voice-license' },
    'Voice: ', h('span', { text: `${VOICE_MODEL.name} by ${VOICE_MODEL.by}` }), `, ${VOICE_MODEL.license}. Don't use it to imitate a real person without consent, and say when a voice is AI-generated.`);
}

/** Wrap an async generate action on a button with busy and percentage feedback. */
export async function runWithProgress(button, label, fn) {
  const span = button.querySelector('span:last-child');
  const original = span?.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const setText = (t) => { if (span) span.textContent = t; };
  setText(`${label}…`);
  try {
    return await fn((done, total) => setText(`${label} ${Math.round((done / Math.max(1, total)) * 100)}%`), setText);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    setText(original);
  }
}
