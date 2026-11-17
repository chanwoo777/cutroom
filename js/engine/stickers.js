// Vector stickers drawn straight onto the canvas (resolution independent, recolourable) plus emoji glyphs.
import { roundRectPath } from '../util.js';

export const SHAPES = [
  { id: 'star', name: 'Star', ar: 1 },
  { id: 'burst', name: 'Burst', ar: 1 },
  { id: 'heart', name: 'Heart', ar: 1.1 },
  { id: 'arrow', name: 'Arrow', ar: 1.7 },
  { id: 'ring', name: 'Ring', ar: 1 },
  { id: 'bubble', name: 'Speech bubble', ar: 1.35 },
  { id: 'bolt', name: 'Bolt', ar: 0.62 },
  { id: 'sparkle', name: 'Sparkle', ar: 1 },
  { id: 'check', name: 'Check', ar: 1 },
  { id: 'pin', name: 'Pin', ar: 0.74 },
  { id: 'tape', name: 'Paper tape', ar: 3.2 },
  { id: 'brackets', name: 'Brackets', ar: 1.5 },
  { id: 'swoosh', name: 'Underline', ar: 3.4 },
];

export const EMOJI = ['🔥', '✨', '😂', '😍', '👀', '🎉', '💯', '👍', '😮', '🙌', '💥', '⭐'];

export function stickerAspect(st) {
  if (st.emoji) return 1;
  return SHAPES.find((s) => s.id === st.shape)?.ar ?? 1;
}

function star(ctx, R, points, inner, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? R * inner : R;
    const a = rot + (i * Math.PI) / points;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Draw centred on the current origin inside a w x h box. */
export function drawSticker(ctx, st, w, h) {
  if (st.emoji) {
    ctx.font = `${Math.round(h * 0.84)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(st.emoji, 0, h * 0.04);
    return;
  }
  const color = st.color || '#d8382b';
  const R = Math.min(w, h) / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let stroked = false;
  switch (st.shape) {
    case 'star': star(ctx, R, 5, 0.46); ctx.fill(); break;
    case 'burst': star(ctx, R, 14, 0.74); ctx.fill(); break;
    case 'heart': {
      const s = R * 0.95;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.85);
      ctx.bezierCurveTo(-s * 1.15, s * 0.05, -s * 0.85, -s * 0.95, 0, -s * 0.42);
      ctx.bezierCurveTo(s * 0.85, -s * 0.95, s * 1.15, s * 0.05, 0, s * 0.85);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'arrow': {
      const x0 = -w / 2, x1 = w / 2, t = h * 0.2, hh = h / 2;
      ctx.beginPath();
      ctx.moveTo(x0, -t); ctx.lineTo(x1 - h * 0.62, -t); ctx.lineTo(x1 - h * 0.62, -hh);
      ctx.lineTo(x1, 0); ctx.lineTo(x1 - h * 0.62, hh); ctx.lineTo(x1 - h * 0.62, t); ctx.lineTo(x0, t);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'ring':
      ctx.beginPath(); ctx.arc(0, 0, R * 0.86, 0, Math.PI * 2);
      ctx.lineWidth = R * 0.2; ctx.stroke(); stroked = true;
      break;
    case 'bubble': {
      const bw = w, bh = h * 0.78;
      roundRectPath(ctx, -bw / 2, -h / 2, bw, bh, bh * 0.32);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-bw * 0.22, -h / 2 + bh - 2);
      ctx.lineTo(-bw * 0.3, h / 2);
      ctx.lineTo(-bw * 0.02, -h / 2 + bh - 2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'bolt': {
      const sx = w / 2, sy = h / 2;
      ctx.beginPath();
      ctx.moveTo(sx * 0.35, -sy); ctx.lineTo(-sx * 0.95, sy * 0.12); ctx.lineTo(-sx * 0.05, sy * 0.12);
      ctx.lineTo(-sx * 0.4, sy); ctx.lineTo(sx * 0.95, -sy * 0.18); ctx.lineTo(sx * 0.05, -sy * 0.18);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'sparkle': {
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 - Math.PI / 2;
        const ax = Math.cos(a) * R, ay = Math.sin(a) * R;
        const b = a + Math.PI / 2;
        const bx = Math.cos(b) * R, by = Math.sin(b) * R;
        if (i === 0) ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(0, 0, bx, by);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'check': {
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = R * 0.2;
      ctx.beginPath(); ctx.moveTo(-R * 0.45, 0); ctx.lineTo(-R * 0.1, R * 0.36); ctx.lineTo(R * 0.5, -R * 0.36); ctx.stroke();
      ctx.strokeStyle = color;
      break;
    }
    case 'pin': {
      const r = w / 2;
      ctx.beginPath();
      ctx.arc(0, -h / 2 + r, r, Math.PI * 0.82, Math.PI * 0.18);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, -h / 2 + r, r * 0.38, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'tape': {
      const zig = h * 0.18, n = 4;
      ctx.globalAlpha *= 0.88;
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(w / 2, -h / 2);
      for (let i = 0; i <= n; i++) ctx.lineTo(w / 2 - (i % 2 ? zig : 0), -h / 2 + (h * i) / n);
      ctx.lineTo(-w / 2, h / 2);
      for (let i = n; i >= 0; i--) ctx.lineTo(-w / 2 + (i % 2 ? zig : 0), -h / 2 + (h * i) / n);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'brackets': {
      const L = Math.min(w, h) * 0.28;
      ctx.lineWidth = Math.min(w, h) * 0.07;
      const x = w / 2 - ctx.lineWidth / 2, y = h / 2 - ctx.lineWidth / 2;
      ctx.beginPath();
      ctx.moveTo(-x, -y + L); ctx.lineTo(-x, -y); ctx.lineTo(-x + L, -y);
      ctx.moveTo(x - L, -y); ctx.lineTo(x, -y); ctx.lineTo(x, -y + L);
      ctx.moveTo(x, y - L); ctx.lineTo(x, y); ctx.lineTo(x - L, y);
      ctx.moveTo(-x + L, y); ctx.lineTo(-x, y); ctx.lineTo(-x, y - L);
      ctx.stroke();
      stroked = true;
      break;
    }
    case 'swoosh': {
      ctx.lineWidth = h * 0.34;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + ctx.lineWidth / 2, h * 0.12);
      ctx.quadraticCurveTo(0, -h * 0.42, w / 2 - ctx.lineWidth / 2, -h * 0.02);
      ctx.stroke();
      stroked = true;
      break;
    }
    default: star(ctx, R, 5, 0.46); ctx.fill();
  }
  if (st.outline && !stroked) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, R * 0.06);
    ctx.stroke();
  }
}
