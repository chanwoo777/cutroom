// Pure timeline operations on the serializable project. They mutate the passed project; callers commit.
import { uid, quantize } from '../util.js';
import { clone } from './store.js';

/**
 * Clip schema (serializable; every edit snapshots it for undo).
 * @typedef {{ type: 'none'|'fade'|'pop'|'slide'|'zoom'|'typewriter', duration: number }} ClipAnimation
 *   Entrance runs over [0, intro.duration]; exit over [clip.duration - outro.duration, clip.duration].
 *   Their sum never exceeds the clip duration (see effectiveAnimDurations).
 * @typedef {{ x: number, y: number, scale: number, rotation: number, opacity: number }} Transform
 *   x / y are the layer centre as a fraction of the frame; rotation in degrees.
 * @typedef {object} Clip
 * @property {string} id
 * @property {'video'|'image'|'audio'|'text'|'sticker'} kind
 * @property {string|null} trackId
 * @property {string|null} assetId
 * @property {number} start      timeline seconds
 * @property {number} duration   timeline seconds
 * @property {number} in         source offset in seconds
 * @property {number} speed
 * @property {Transform} transform
 * @property {ClipAnimation} introAnimation
 * @property {ClipAnimation} outroAnimation
 */

export const DEFAULT_FX = () => ({ lut: 'none', lutAmount: 100, brightness: 0, contrast: 0, saturation: 0, blur: 0, sepia: 0, vignette: 0, enhance: 0 });
export const DEFAULT_TRANSFORM = () => ({ x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 });
export const DEFAULT_INTRO = () => ({ type: 'none', duration: 0.5 });
export const DEFAULT_OUTRO = () => ({ type: 'none', duration: 0.5 });
export const MIN_ANIM = 0.05;

/** Upgrade the old shared-duration `anim: {in, out, dur}` shape in place. */
export function migrateClip(c) {
  if (c && c.anim && !c.introAnimation) {
    const d = Number(c.anim.dur) || 0.5;
    c.introAnimation = { type: c.anim.in || 'none', duration: d };
    c.outroAnimation = { type: c.anim.out || 'none', duration: d };
  }
  if (c) {
    c.introAnimation ||= DEFAULT_INTRO();
    c.outroAnimation ||= DEFAULT_OUTRO();
    delete c.anim;
  }
  return c;
}

/**
 * Durations actually played. Inactive phases take no time; if intro + outro would overrun the clip,
 * both are scaled down proportionally so the entrance finishes before the exit starts.
 */
export function effectiveAnimDurations(c) {
  const D = Math.max(0, c.duration);
  let i = c.introAnimation?.type && c.introAnimation.type !== 'none' ? Math.max(MIN_ANIM, c.introAnimation.duration || 0) : 0;
  let o = c.outroAnimation?.type && c.outroAnimation.type !== 'none' ? Math.max(MIN_ANIM, c.outroAnimation.duration || 0) : 0;
  if (i + o > D && i + o > 0) { const k = D / (i + o); i *= k; o *= k; }
  return { intro: i, outro: o };
}
export const DEFAULT_TEXT = () => ({
  content: 'Your title', font: 'grotesk', weight: 700, italic: false, size: 0.09,
  color: '#ffffff', align: 'center', strokeColor: '#000000', strokeWidth: 0,
  bg: false, bgColor: '#1c1b19', shadow: true, lineHeight: 1.12,
});
export const DEFAULT_STICKER = () => ({ shape: 'star', emoji: '', color: '#d8382b', outline: false, size: 0.24 });

/** System font stacks only: the app makes no network requests, so text overlays use faces already on the machine. */
export const TEXT_FONTS = {
  grotesk: { label: 'Grotesk', stack: '"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif' },
  condensed: { label: 'Condensed', stack: '"Bahnschrift Condensed", "Bahnschrift", "Arial Narrow", "Helvetica Neue Condensed", sans-serif' },
  heavy: { label: 'Heavy', stack: 'Impact, Haettenschweiler, "Arial Black", sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", Times, serif' },
  mono: { label: 'Mono', stack: '"Cascadia Mono", Consolas, ui-monospace, Menlo, monospace' },
  script: { label: 'Script', stack: '"Segoe Script", "Brush Script MT", "Snell Roundhand", cursive' },
};

export const ANIM_IN = [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide up'], ['zoom', 'Zoom'], ['typewriter', 'Typewriter']];
export const ANIM_OUT = [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide up'], ['zoom', 'Zoom']];

export const TRANSITIONS = [
  ['none', 'None'], ['dissolve', 'Cross dissolve'], ['fade-black', 'Fade through black'], ['wipe-left', 'Wipe left'],
  ['wipe-right', 'Wipe right'], ['slide-left', 'Slide left'], ['slide-up', 'Slide up'], ['zoom', 'Zoom in'],
];

/** The clip that ends exactly where `clip` starts on the same track: the outgoing side of its transition. */
export function prevAdjacent(project, clip) {
  return project.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start + c.duration - clip.start) < 1e-4) || null;
}
export function nextAdjacent(project, clip) {
  const end = clip.start + clip.duration;
  return project.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start - end) < 1e-4) || null;
}
/** Seconds of transition at the head of `clip` (0 when it has none or nothing butts against it). */
export function transitionDuration(project, clip) {
  const tr = clip.transition;
  if (!tr || tr.type === 'none' || !prevAdjacent(project, clip)) return 0;
  return Math.max(0.05, Math.min(tr.duration || 0.5, clip.duration));
}
/** How long past its own end a clip stays visible because the next clip transitions out of it. */
export function tailDuration(project, clip) {
  const next = nextAdjacent(project, clip);
  return next ? transitionDuration(project, next) : 0;
}

/**
 * What to draw for one track at time t. Normally one layer; during a transition, the outgoing clip
 * (continuing past its end) and the incoming clip with the transition's progress p in [0, 1).
 */
export function trackLayers(project, trackId, t) {
  const B = activeClipAt(project, trackId, t);
  if (!B) return [];
  const d = transitionDuration(project, B);
  if (d > 0 && t < B.start + d) {
    const A = prevAdjacent(project, B);
    const p = Math.max(0, Math.min(1, (t - B.start) / d));
    return [{ clip: A, role: 'out', type: B.transition.type, p }, { clip: B, role: 'in', type: B.transition.type, p }];
  }
  return [{ clip: B }];
}

const smooth = (p) => p * p * (3 - 2 * p);
/** Alpha, offset, scale and scissor a transition applies to one of its two layers (frame pixels). */
export function transitionMods(layer, W, H) {
  const m = { alpha: 1, dx: 0, dy: 0, scale: 1, scissor: null };
  if (!layer.role) return m;
  const p = layer.p, e = smooth(p), out = layer.role === 'out';
  switch (layer.type) {
    case 'dissolve': if (!out) m.alpha = p; break;
    case 'fade-black': m.alpha = out ? Math.max(0, 1 - 2 * p) : Math.max(0, 2 * p - 1); break;
    case 'wipe-left': if (!out) m.scissor = [W * (1 - e), 0, W * e + 1, H]; break;
    case 'wipe-right': if (!out) m.scissor = [0, 0, W * e, H]; break;
    case 'slide-left': m.dx = out ? -W * e : W * (1 - e); break;
    case 'slide-up': m.dy = out ? -H * e : H * (1 - e); break;
    case 'zoom': if (!out) { m.scale = 1 + 0.25 * (1 - e); m.alpha = e; } break;
    default: break;
  }
  return m;
}

export const isVisual = (c) => c.kind === 'video' || c.kind === 'image' || c.kind === 'text' || c.kind === 'sticker';
export const isMedia = (c) => c.kind === 'video' || c.kind === 'image';
export const trackKindFor = (kind) => (kind === 'audio' ? 'audio' : 'video');
export const clipEnd = (c) => c.start + c.duration;

export function makeClip(kind, props = {}) {
  const base = {
    id: uid('c'), kind, trackId: null, assetId: null, name: '',
    start: 0, duration: 5, in: 0, speed: 1,
    volume: 1, fadeIn: 0, fadeOut: 0,
    transform: DEFAULT_TRANSFORM(), introAnimation: DEFAULT_INTRO(), outroAnimation: DEFAULT_OUTRO(),
    fit: 'contain', motion: 'none', fx: DEFAULT_FX(),
  };
  if (kind === 'text') base.text = DEFAULT_TEXT();
  if (kind === 'sticker') base.sticker = DEFAULT_STICKER();
  for (const [k, v] of Object.entries(props)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') base[k] = { ...base[k], ...v };
    else base[k] = v;
  }
  if (props.anim) { // legacy call sites
    const d = props.anim.dur ?? 0.5;
    base.introAnimation = { type: props.anim.in || 'none', duration: d };
    base.outroAnimation = { type: props.anim.out || 'none', duration: d };
    delete base.anim;
  }
  return base;
}

export function cloneClip(c) {
  const copy = clone(c);
  copy.id = uid('c');
  delete copy.voice; // a copy (or the right half of a split) does not own the original's voice-over
  return copy;
}

/** Clips that travel with this one: a text and its voice-over, or a narration and its captions. */
export function linkedClips(project, id) {
  const byId = new Map(project.clips.map((c) => [c.id, c]));
  const c = byId.get(id);
  if (!c) return [];
  const out = new Set();
  if (c.voice?.clipId && byId.has(c.voice.clipId)) out.add(c.voice.clipId);
  if (c.voiceOf && byId.get(c.voiceOf)?.voice?.clipId === c.id) out.add(c.voiceOf);
  for (const x of project.clips) if (x.voiceOf === c.id && x.kind === 'text' && !x.voice) out.add(x.id);
  out.delete(id);
  return [...out];
}

/** Longest the clip may run on the timeline given its source media (Infinity for stills, text, stickers). */
export function maxTimelineDuration(clip, asset) {
  if ((clip.kind === 'video' || clip.kind === 'audio') && asset && Number.isFinite(asset.duration)) {
    return Math.max(0, (asset.duration - clip.in) / clip.speed);
  }
  return Infinity;
}

export function activeClipAt(project, trackId, t) {
  let best = null;
  for (const c of project.clips) {
    if (c.trackId === trackId && t >= c.start && t < c.start + c.duration && (!best || c.start > best.start)) best = c;
  }
  return best;
}

export function clipsOnTrack(project, trackId) {
  return project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function isRangeFree(project, trackId, s, e, exclude = new Set()) {
  const eps = 1e-6;
  return !project.clips.some((c) => c.trackId === trackId && !exclude.has(c.id) && c.start < e - eps && c.start + c.duration > s + eps);
}

/**
 * Overwrite edit: make [s, e) on a track empty by trimming, splitting or removing other clips.
 * Matches how a drop behaves in Premiere's default overwrite mode.
 */
export function overwriteRange(project, trackId, s, e, exclude = new Set(), fps = 30) {
  const eps = 1e-6;
  const minLen = 0.5 / fps;
  const out = [];
  for (const c of project.clips) {
    if (c.trackId !== trackId || exclude.has(c.id)) { out.push(c); continue; }
    const cs = c.start, ce = c.start + c.duration;
    if (ce <= s + eps || cs >= e - eps) { out.push(c); continue; }
    if (cs >= s - eps && ce <= e + eps) continue; // fully covered: removed
    if (cs < s && ce > e) {
      const right = cloneClip(c);
      right.start = e;
      right.duration = ce - e;
      right.in = c.in + (e - cs) * c.speed;
      right.introAnimation.type = 'none';
      delete right.transition;
      right.fadeIn = 0;
      c.duration = s - cs;
      c.outroAnimation.type = 'none';
      c.fadeOut = 0;
      out.push(c);
      if (right.duration >= minLen) out.push(right);
      continue;
    }
    if (cs < s) { c.duration = s - cs; if (c.duration >= minLen) out.push(c); continue; }
    const cut = e - cs; // head overlap
    c.start = e;
    c.duration = ce - e;
    c.in += cut * c.speed;
    if (c.duration >= minLen) out.push(c);
  }
  project.clips = out;
}

/** Razor: split one clip at time t (frame-quantized). Returns the new right-hand clip or null. */
export function splitClip(project, clip, t, fps) {
  const f = 1 / fps;
  t = quantize(t, fps);
  const end = clipEnd(clip);
  if (t <= clip.start + f * 0.5 || t >= end - f * 0.5) return null;
  const right = cloneClip(clip);
  right.start = t;
  right.duration = end - t;
  right.in = clip.in + (t - clip.start) * clip.speed;
  right.introAnimation.type = 'none';
  delete right.transition; // a cut never inherits the clip's head transition
  right.fadeIn = 0;
  clip.duration = t - clip.start;
  clip.outroAnimation.type = 'none';
  clip.fadeOut = 0;
  project.clips.push(right);
  return right;
}

export function deleteClips(project, ids) {
  project.clips = project.clips.filter((c) => !ids.has(c.id));
}

/** Delete and close each gap on its own track. */
export function rippleDelete(project, ids) {
  const removed = project.clips.filter((c) => ids.has(c.id));
  project.clips = project.clips.filter((c) => !ids.has(c.id));
  const byTrack = new Map();
  for (const r of removed) {
    if (!byTrack.has(r.trackId)) byTrack.set(r.trackId, []);
    byTrack.get(r.trackId).push(r);
  }
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => b.start - a.start);
    for (const r of list) {
      const gapEnd = r.start + r.duration;
      for (const c of project.clips) {
        if (c.trackId === trackId && c.start >= gapEnd - 1e-6) c.start = Math.max(0, c.start - r.duration);
      }
    }
  }
}

export function addTrack(project, kind) {
  const prefix = kind === 'video' ? 'V' : 'A';
  let n = 1;
  for (const t of project.tracks) {
    if (t.kind !== kind) continue;
    const m = /^[VA](\d+)$/.exec(t.name);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  const tr = { id: uid('t'), kind, name: `${prefix}${n}`, role: kind === 'video' ? 'Overlay' : 'Audio', hidden: false, locked: false, muted: false };
  if (kind === 'video') project.tracks.unshift(tr); // new picture tracks stack on top
  else project.tracks.push(tr);
  return tr;
}

/**
 * Pick a track for a new clip. Media prefers the main (lowest) picture track; text and stickers prefer
 * overlay tracks above it; audio goes top-down. Returns null when every candidate is busy.
 */
export function findFreeTrack(project, clipKind, s, e) {
  const kind = trackKindFor(clipKind);
  let tracks = project.tracks.filter((t) => t.kind === kind && !t.locked);
  if (kind === 'video') {
    tracks = tracks.slice().reverse(); // bottom (main) first
    if (clipKind === 'text' || clipKind === 'sticker') {
      const overlays = tracks.slice(1);
      tracks = overlays.length ? overlays : tracks;
    }
  }
  for (const t of tracks) if (isRangeFree(project, t.id, s, e)) return t.id;
  return null;
}

export function duplicateClips(project, ids, fps) {
  const sel = project.clips.filter((c) => ids.has(c.id)).sort((a, b) => a.start - b.start);
  if (!sel.length) return [];
  const groupStart = Math.min(...sel.map((c) => c.start));
  const groupEnd = Math.max(...sel.map(clipEnd));
  const span = quantize(groupEnd - groupStart, fps);
  const created = [];
  for (const c of sel) {
    const copy = cloneClip(c);
    copy.start = c.start + span;
    if (!isRangeFree(project, c.trackId, copy.start, clipEnd(copy))) {
      const other = findFreeTrack(project, c.kind, copy.start, clipEnd(copy));
      copy.trackId = other || addTrack(project, trackKindFor(c.kind)).id;
    }
    project.clips.push(copy);
    created.push(copy.id);
  }
  return created;
}

/** Every clip boundary, sorted, for up/down edit-point navigation and snapping. */
export function editPoints(project) {
  const set = new Set([0]);
  for (const c of project.clips) { set.add(c.start); set.add(clipEnd(c)); }
  return [...set].sort((a, b) => a - b);
}
