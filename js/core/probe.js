// Reads a video's average frame rate from its MP4 / MOV container (ISO-BMFF): the video track's media
// timescale (mdhd) and sample durations (stts). Only box headers and the moov box are read, via
// Blob.slice, so a multi-gigabyte file costs a few small reads. Returns null for other containers.

const MAX_MOOV = 64 * 1024 * 1024;

async function readBytes(file, start, len) {
  return new DataView(await file.slice(start, start + len).arrayBuffer());
}

const type = (dv, off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));

/** Iterate child boxes inside dv[start, end). */
function* boxes(dv, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const t = type(dv, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = dv.getUint32(off + 8) * 2 ** 32 + dv.getUint32(off + 12);
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) return;
    yield { t, start: off + header, end: off + size };
    off += size;
  }
}

const child = (dv, box, t) => { for (const b of boxes(dv, box.start, box.end)) if (b.t === t) return b; return null; };

async function findMoov(file) {
  let off = 0;
  for (let guard = 0; guard < 64 && off + 8 <= file.size; guard++) {
    const h = await readBytes(file, off, 16);
    let size = h.getUint32(0);
    const t = type(h, 4);
    if (size === 1) size = h.getUint32(8) * 2 ** 32 + h.getUint32(12);
    else if (size === 0) size = file.size - off;
    if (size < 8) return null;
    if (t === 'moov') return size <= MAX_MOOV ? readBytes(file, off, size) : null;
    off += size;
  }
  return null;
}

export async function probeFrameRate(file) {
  try {
    const head = await readBytes(file, 0, 12);
    if (head.byteLength < 12 || !['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(type(head, 4))) return null;
    const dv = await findMoov(file);
    if (!dv) return null;
    const moov = { start: 8, end: dv.byteLength };
    for (const trak of boxes(dv, moov.start, moov.end)) {
      if (trak.t !== 'trak') continue;
      const mdia = child(dv, trak, 'mdia');
      const hdlr = mdia && child(dv, mdia, 'hdlr');
      if (!hdlr || type(dv, hdlr.start + 8) !== 'vide') continue;
      const mdhd = child(dv, mdia, 'mdhd');
      const version = dv.getUint8(mdhd.start);
      const timescale = dv.getUint32(mdhd.start + (version === 1 ? 20 : 12));
      const stbl = child(dv, child(dv, mdia, 'minf') || { start: 0, end: 0 }, 'stbl');
      const stts = stbl && child(dv, stbl, 'stts');
      if (!timescale || !stts) return null;
      const n = dv.getUint32(stts.start + 4);
      let samples = 0, ticks = 0;
      for (let i = 0; i < n && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
        const count = dv.getUint32(stts.start + 8 + i * 8);
        const delta = dv.getUint32(stts.start + 12 + i * 8);
        samples += count;
        ticks += count * delta;
      }
      if (!samples || !ticks) return null;
      const fps = (samples * timescale) / ticks;
      return Number.isFinite(fps) && fps > 1 && fps < 1000 ? fps : null;
    }
  } catch { /* unreadable container: fall back to the project rate */ }
  return null;
}

/** Nearest editing rate (24/25/30/50/60) when the source is within 2% of it (23.976 -> 24, 59.94 -> 60). */
export function snapRate(fps, options) {
  if (!fps) return null;
  let best = null;
  for (const o of options) if (Math.abs(fps - o) / o < 0.02 && (!best || Math.abs(fps - o) < Math.abs(fps - best))) best = o;
  return best;
}
