// Overlay alignment against the frame (or its title-safe area). Bounds come from Renderer.visualBounds,
// so scale, rotation and (for box-less text) the actual glyph ink are all accounted for.
import { isVisual } from '../core/ops.js';

export const ALIGN_MODES = [
  ['left', 'Align left', 'align-left'], ['hcenter', 'Align centre (horizontal)', 'align-hcenter'], ['right', 'Align right', 'align-right'],
  ['top', 'Align top', 'align-top'], ['vmiddle', 'Align middle (vertical)', 'align-vmiddle'], ['bottom', 'Align bottom', 'align-bottom'],
];

const SAFE = 0.05; // title-safe margin as a fraction of each side

/** Move each visual clip so its visible bounds meet the chosen edge or centre. Returns how many moved. */
export function alignClips(store, renderer, ids, mode, { safe = false } = {}) {
  const [W, H] = store.dims;
  const mx = safe ? W * SAFE : 0, my = safe ? H * SAFE : 0;
  let n = 0;
  for (const id of ids) {
    const c = store.getClip(id);
    if (!c || !isVisual(c)) continue;
    const tr = store.getTrack(c.trackId);
    if (tr?.locked) continue;
    const b = renderer.visualBounds(c, W, H);
    let dx = 0, dy = 0;
    if (mode === 'left') dx = mx - b.minX;
    else if (mode === 'right') dx = W - mx - b.maxX;
    else if (mode === 'hcenter') dx = W / 2 - (b.minX + b.maxX) / 2;
    else if (mode === 'top') dy = my - b.minY;
    else if (mode === 'bottom') dy = H - my - b.maxY;
    else if (mode === 'vmiddle') dy = H / 2 - (b.minY + b.maxY) / 2;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) continue;
    c.transform.x += dx / W;
    c.transform.y += dy / H;
    n++;
  }
  return n;
}
