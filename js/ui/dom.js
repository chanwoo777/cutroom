// Safe DOM construction. Text is always assigned with textContent; there is no innerHTML in the app.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ATTRS = new Set(['role', 'for', 'tabindex', 'title', 'type', 'name', 'id', 'placeholder', 'min', 'max', 'step',
  'maxlength', 'accept', 'draggable', 'autocomplete', 'spellcheck', 'inputmode', 'href', 'download', 'rows', 'list']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else if (k.startsWith('aria-') || k.startsWith('data-') || ATTRS.has(k)) el.setAttribute(k, v === true ? '' : String(v));
    else el[k] = v;
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(button, name) {
  const use = button.querySelector('use');
  if (use) use.setAttribute('href', `#i-${name}`);
}

let toastHost = null;
export function toast(message, { kind = 'info', timeout = 4200 } = {}) {
  toastHost ||= document.getElementById('toasts');
  if (!toastHost) return;
  const el = h('div', { class: `toast ${kind}` }, h('span', { text: message }));
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  const leave = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const timer = setTimeout(leave, timeout);
  el.addEventListener('click', () => { clearTimeout(timer); leave(); });
}

let live = null;
export function announce(message) {
  live ||= document.getElementById('tl-live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = message; });
}

/** Two-step destructive button: first press arms it, second press within 3 s confirms. */
export function armable(button, onConfirm, { armedLabel = 'Remove?' } = {}) {
  let timer = 0;
  const original = button.getAttribute('aria-label') || '';
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (button.classList.contains('armed')) {
      clearTimeout(timer);
      button.classList.remove('armed');
      onConfirm();
      return;
    }
    button.classList.add('armed');
    button.setAttribute('aria-label', armedLabel);
    const label = button.querySelector('.armed-label');
    if (label) label.hidden = false;
    timer = setTimeout(() => {
      button.classList.remove('armed');
      button.setAttribute('aria-label', original);
      if (label) label.hidden = true;
    }, 3000);
  });
}

/** Tracks DPR-correct canvas sizing. */
export function sizeCanvas(canvas, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h2 = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h2) {
    canvas.width = w;
    canvas.height = h2;
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  return dpr;
}

/**
 * Timecode with its leading zeros dimmed (00:00:0|3:09), so the digits that are changing read first.
 * Built from two text spans; nothing is parsed as markup.
 */
export function setTimecode(el, tc) {
  if (el._tc === tc) return;
  el._tc = tc;
  const m = /^[0:;.]*/.exec(tc)[0];
  const cut = m.length >= tc.length ? tc.length - 1 : m.length;
  let lead = el._lead, rest = el._rest;
  if (!lead) {
    lead = el._lead = document.createElement('span');
    lead.className = 'tc-lead';
    rest = el._rest = document.createElement('span');
    el.replaceChildren(lead, rest);
  }
  lead.textContent = tc.slice(0, cut);
  rest.textContent = tc.slice(cut);
}

/**
 * Numeric scrubbers: drag any `input.num` sideways to change its value (Shift x10, Alt x0.1); a click
 * without movement focuses it for typing. Fires `input` while dragging and `change` on release, so
 * controls update live and commit one undo step.
 */
export function installScrubbers(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.classList.contains('num') || el.disabled || e.button !== 0) return;
    if (document.activeElement === el) return; // already typing: let the caret move
    e.preventDefault();
    const step = Number(el.step) || 1;
    const min = el.min === '' ? -Infinity : Number(el.min);
    const max = el.max === '' ? Infinity : Number(el.max);
    const dp = (String(el.step).split('.')[1] || '').length;
    const start = Number(el.value) || 0;
    const x0 = e.clientX;
    let moved = false;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; el.classList.add('scrubbing'); document.body.style.cursor = 'ew-resize'; }
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      // One step per 2 px, so a 100 px drag on a 0-100 slider covers half its range.
      const raw = start + Math.round(dx / 2) * step * k;
      const v = Math.min(max, Math.max(min, raw));
      const s = v.toFixed(Math.max(dp, k < 1 ? dp + 1 : dp));
      if (el.value !== s) { el.value = s; el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      if (moved) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.classList.remove('scrubbing');
      } else {
        el.focus();
        el.select();
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
