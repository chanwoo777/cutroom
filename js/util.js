// Small shared helpers. No DOM string building anywhere in the app: text goes through textContent or canvas fillText.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

let counter = 0;
export const uid = (prefix = 'id') =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const quantize = (t, fps) => Math.round(t * fps) / fps;

const pad2 = (n) => String(n).padStart(2, '0');

/** Seconds -> HH:MM:SS:FF at an integer frame rate. */
export function formatTC(t, fps) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const total = Math.round(t * fps);
  const ff = total % fps;
  const secs = Math.floor(total / fps);
  return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}:${pad2(ff)}`;
}

/** Accepts HH:MM:SS:FF, MM:SS:FF, MM:SS or plain seconds. Returns seconds or null. */
export function parseTC(str, fps) {
  const s = String(str).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const parts = s.split(/[:;.]/).map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let hh = 0, mm = 0, ss = 0, ff = 0;
  if (parts.length === 4) [hh, mm, ss, ff] = parts;
  else if (parts.length === 3) [mm, ss, ff] = parts;
  else if (parts.length === 2) [mm, ss] = parts;
  else return null;
  if (ff >= fps) return null;
  return hh * 3600 + mm * 60 + ss + ff / fps;
}

export function formatDuration(t) {
  if (!Number.isFinite(t)) return '–';
  if (t < 60) return `${t.toFixed(t < 10 ? 1 : 0)}s`;
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  if (m < 60) return `${m}:${pad2(s)}`;
  return `${Math.floor(m / 60)}:${pad2(m % 60)}:${pad2(s)}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export const easeOutExpo = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
export const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
export const easeOutBack = (p) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reducedMotion = () => !!motionQuery?.matches;

export function sanitizeFilename(name, fallback = 'cutroom-export') {
  const s = String(name || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || fallback;
}

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'color', 'file', 'submit'].includes(el.type);
  return false;
}

export function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Resolve on the first of okEvents, reject on errEvents or timeout. */
export function once(target, okEvents, errEvents = [], timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      okEvents.forEach((e) => target.removeEventListener(e, ok));
      errEvents.forEach((e) => target.removeEventListener(e, bad));
      clearTimeout(timer);
    };
    const ok = (ev) => { cleanup(); resolve(ev); };
    const bad = (ev) => { cleanup(); reject(ev instanceof Error ? ev : new Error(ev?.type || 'error')); };
    okEvents.forEach((e) => target.addEventListener(e, ok));
    errEvents.forEach((e) => target.addEventListener(e, bad));
    if (timeoutMs) timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
  });
}

export async function seekVideo(v, t, timeoutMs = 4000) {
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  const p = once(v, ['seeked'], ['error'], timeoutMs);
  v.currentTime = t;
  try { await p; } catch { /* a stalled seek should not break thumbnailing */ }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
