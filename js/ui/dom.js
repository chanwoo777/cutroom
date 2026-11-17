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
