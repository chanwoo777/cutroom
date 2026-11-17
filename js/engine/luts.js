// Procedural 3D LUTs. Each preset is a colour function baked into an N^3 table and sampled on the GPU,
// so grades are non-destructive and identical in preview and export. .cube files load the same way.

export const LUT_PRESETS = [
  { id: 'none', name: 'None' },
  { id: 'teal-orange', name: 'Teal & Orange' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'noir', name: 'Noir' },
  { id: 'cyberpunk', name: 'Cyberpunk' },
  { id: 'arctic', name: 'Arctic' },
  { id: 'bleach', name: 'Bleach Bypass' },
  { id: 'golden', name: 'Golden Hour' },
];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// Contrast S-curve that keeps 0 and 1 fixed. k > 0 adds contrast, k < 0 flattens.
const curve = (x, k) => { x = clamp01(x); return x + k * (x * x * (3 - 2 * x) - x); };
const sat = (r, g, b, s) => { const l = luma(r, g, b); return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s]; };

const FN = {
  'teal-orange'(r, g, b) {
    const l = luma(r, g, b);
    const sh = 1 - sstep(0.05, 0.6, l);
    const hi = sstep(0.4, 0.95, l);
    r += -0.075 * sh + 0.085 * hi;
    g += 0.015 * sh + 0.02 * hi;
    b += 0.075 * sh - 0.075 * hi;
    [r, g, b] = sat(r, g, b, 1.18);
    return [curve(r, 0.35), curve(g, 0.35), curve(b, 0.3)];
  },
  vintage(r, g, b) {
    const l = luma(r, g, b);
    [r, g, b] = sat(r, g, b, 0.72);
    r = r * 1.04 + 0.02;
    g = g + 0.01 + 0.025 * (1 - sstep(0, 0.5, l));
    b = b * 0.86 + 0.05;
    return [r, g, b].map((c) => 0.07 + curve(c, -0.12) * 0.86);
  },
  noir(r, g, b) {
    let l = clamp01((luma(r, g, b) - 0.03) / 0.94);
    l = curve(curve(l, 0.7), 0.3);
    return [l * 0.985, l, l * 1.025];
  },
  cyberpunk(r, g, b) {
    const l = luma(r, g, b);
    const sh = 1 - sstep(0, 0.55, l);
    const hi = sstep(0.45, 1, l);
    let nr = r * 1.02 + 0.1 * hi + 0.04 * sh;
    let ng = g * 0.82 + 0.02 * hi;
    let nb = b * 1.05 + 0.18 * sh + 0.06 * hi + 0.12 * g * (1 - hi);
    [nr, ng, nb] = sat(nr, ng, nb, 1.35);
    return [curve(nr, 0.3), curve(ng, 0.3), curve(nb, 0.25)];
  },
  arctic(r, g, b) {
    const l = luma(r, g, b);
    let [nr, ng, nb] = sat(r, g, b, 0.7);
    const hi = sstep(0.5, 1, l);
    nr = nr * 0.9 + 0.06 * hi;
    ng = ng * 0.98 + 0.02 + 0.06 * hi;
    nb = nb * 1.04 + 0.07 + 0.03 * hi;
    return [nr, ng, nb].map((c) => 0.035 + clamp01(c) * 0.965);
  },
  bleach(r, g, b) {
    const lc = curve(luma(r, g, b), 0.6);
    return [r, g, b].map((c) => curve(c * 0.45 + lc * 0.55, 0.25));
  },
  golden(r, g, b) {
    const hi = sstep(0.3, 1, luma(r, g, b));
    r = r * 1.08 + 0.05 * hi;
    g = g * 1.02 + 0.025 * hi;
    b = b * 0.82;
    [r, g, b] = sat(r, g, b, 1.1);
    return [r, g, b].map((c) => 0.02 + curve(c, 0.15) * 0.98);
  },
};

/** RGB8 table, red fastest, then green, then blue (matches TEXTURE_3D x/y/z). */
export function buildLut(id, size = 33) {
  const fn = FN[id];
  const data = new Uint8Array(size * size * size * 3);
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const r = ri / (size - 1), g = gi / (size - 1), b = bi / (size - 1);
        const out = fn ? fn(r, g, b) : [r, g, b];
        data[i++] = Math.round(clamp01(out[0]) * 255);
        data[i++] = Math.round(clamp01(out[1]) * 255);
        data[i++] = Math.round(clamp01(out[2]) * 255);
      }
    }
  }
  return data;
}

/** Parse an Adobe/Resolve .cube 3D LUT. Throws with a readable message on bad input. */
export function parseCube(text) {
  let size = 0;
  let title = '';
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  const values = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) { title = line.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, '').slice(0, 60); continue; }
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported; export a 3D .cube.');
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue; // other keywords
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) values.push(parts[0], parts[1], parts[2]);
  }
  if (!size || size < 2 || size > 65) throw new Error('Missing or unsupported LUT_3D_SIZE (2–65).');
  if (values.length !== size * size * size * 3) throw new Error(`Expected ${size ** 3} entries, found ${values.length / 3}.`);
  const data = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const ch = i % 3;
    const v = (values[i] - dmin[ch]) / ((dmax[ch] - dmin[ch]) || 1);
    data[i] = Math.round(clamp01(v) * 255);
  }
  return { size, data, title };
}

/** Rough CSS-filter equivalents for browsers without WebGL2. */
export const FALLBACK_FILTERS = {
  'teal-orange': 'contrast(1.12) saturate(1.2) hue-rotate(-6deg)',
  vintage: 'sepia(0.35) contrast(0.9) saturate(0.8) brightness(1.04)',
  noir: 'grayscale(1) contrast(1.45)',
  cyberpunk: 'hue-rotate(18deg) saturate(1.5) contrast(1.2)',
  arctic: 'saturate(0.7) hue-rotate(12deg) brightness(1.08)',
  bleach: 'saturate(0.45) contrast(1.35)',
  golden: 'sepia(0.25) saturate(1.25) brightness(1.04)',
};
