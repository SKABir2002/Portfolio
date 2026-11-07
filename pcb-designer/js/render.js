// Canvas renderer (EasyEDA-like dark theme).
import { doc, allPads, silkOf, courtyard } from './state.js';
import { textStrokes, strokeWidth } from './font.js';

export const COLORS = {
  bg: '#101216', board: '#050607', edge: '#d946ef', grid: 'rgba(255,255,255,0.13)',
  top: '#e5484d', bottom: '#3d7bf5', tht: '#c9a227', drill: '#101216', via: '#a0a9b4',
  silkTop: '#f5d90a', silkBottom: '#b9a6ff', rats: '#f1f1f1', marker: '#ff3bd4', select: '#ffffff', hole: '#2a2f38',
};

export function makeView() { return { scale: 8, ox: 40, oy: 40 }; }

export function fitView(view, w, h) {
  const B = doc.board, pad = 30;
  view.scale = Math.max(1, Math.min((w - 2 * pad) / B.w, (h - 2 * pad) / B.h));
  view.ox = (w - B.w * view.scale) / 2;
  view.oy = (h - B.h * view.scale) / 2;
}

export function toWorld(view, sx, sy) { return [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale]; }

function fillShape(c, v, shape) {
  const S = v.scale;
  if (shape.kind === 'poly') {
    c.beginPath();
    shape.pts.forEach(([x, y], i) => (i ? c.lineTo(x * S + v.ox, y * S + v.oy) : c.moveTo(x * S + v.ox, y * S + v.oy)));
    c.closePath(); c.fill();
  } else if (shape.ax === shape.bx && shape.ay === shape.by) {
    c.beginPath(); c.arc(shape.ax * S + v.ox, shape.ay * S + v.oy, shape.r * S, 0, Math.PI * 2); c.fill();
  } else {
    c.save(); c.strokeStyle = c.fillStyle; c.lineCap = 'round'; c.lineWidth = shape.r * 2 * S;
    c.beginPath(); c.moveTo(shape.ax * S + v.ox, shape.ay * S + v.oy); c.lineTo(shape.bx * S + v.ox, shape.by * S + v.oy); c.stroke(); c.restore();
  }
}

function polyline(c, v, pts) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x * v.scale + v.ox, y * v.scale + v.oy) : c.moveTo(x * v.scale + v.ox, y * v.scale + v.oy)));
  c.stroke();
}

function drawText(c, v, text, x, y, size, color, mirror = false) {
  c.strokeStyle = color; c.lineWidth = Math.max(1, strokeWidth(size) * v.scale); c.lineCap = 'round'; c.lineJoin = 'round';
  for (const pl of textStrokes(text, x, y, size, mirror)) polyline(c, v, pl);
}

export function render(canvas, view, st) {
  const c = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = COLORS.bg; c.fillRect(0, 0, W, H);
  const v = view, S = v.scale, B = doc.board;
  const X = (x) => x * S + v.ox, Y = (y) => y * S + v.oy;

  // board
  c.fillStyle = COLORS.board; c.fillRect(X(0), Y(0), B.w * S, B.h * S);
  const g = doc.grid || 0.5;
  let step = g; while (step * S < 7) step *= 2;
  if (step * S >= 7) {
    c.fillStyle = COLORS.grid;
    for (let x = 0; x <= B.w + 1e-6; x += step) for (let y = 0; y <= B.h + 1e-6; y += step) c.fillRect(X(x) - 0.5, Y(y) - 0.5, 1, 1);
  }
  c.strokeStyle = COLORS.edge; c.lineWidth = 1.5; c.strokeRect(X(0), Y(0), B.w * S, B.h * S);

  const pads = allPads();
  const front = st.layer === 'bottom' ? 'bottom' : 'top';
  const back = front === 'top' ? 'bottom' : 'top';
  const hl = st.hoverNet;

  const drawCopper = (layer, alpha) => {
    c.globalAlpha = alpha;
    const col = COLORS[layer];
    for (const t of doc.tracks) {
      if (t.layer !== layer) continue;
      c.strokeStyle = col; c.lineWidth = Math.max(1, t.width * S); c.lineCap = 'round'; c.lineJoin = 'round';
      polyline(c, v, t.pts);
    }
    c.fillStyle = col;
    for (const p of pads) if (!p.drill && p.layers[0] === layer) fillShape(c, v, p.shape);
    c.globalAlpha = 1;
  };
  drawCopper(back, st.layer === 'all' ? 0.85 : 0.55);
  drawCopper(front, 1);

  // through-hole pads, vias, holes
  c.fillStyle = COLORS.tht;
  for (const p of pads) if (p.drill) fillShape(c, v, p.shape);
  c.fillStyle = COLORS.drill;
  for (const p of pads) if (p.drill) { c.beginPath(); c.arc(X(p.x), Y(p.y), (p.drill / 2) * S, 0, 7); c.fill(); }
  for (const via of doc.vias) {
    c.fillStyle = COLORS.via; c.beginPath(); c.arc(X(via.x), Y(via.y), (via.dia / 2) * S, 0, 7); c.fill();
    c.fillStyle = COLORS.drill; c.beginPath(); c.arc(X(via.x), Y(via.y), (via.drill / 2) * S, 0, 7); c.fill();
  }
  for (const h of doc.holes) {
    c.fillStyle = COLORS.hole; c.beginPath(); c.arc(X(h.x), Y(h.y), (h.d / 2) * S, 0, 7); c.fill();
    c.strokeStyle = '#59606b'; c.lineWidth = 1; c.stroke();
  }

  // highlighted net
  if (hl) {
    c.save(); c.globalAlpha = 0.55; c.fillStyle = '#ffffff'; c.strokeStyle = '#ffffff';
    for (const t of doc.tracks) if (t.net === hl) { c.lineWidth = Math.max(1, t.width * S); c.lineCap = 'round'; polyline(c, v, t.pts); }
    for (const p of pads) if (p.net === hl) fillShape(c, v, p.shape);
    c.restore();
  }

  // silkscreen
  for (const side of [back, front]) {
    const col = side === 'top' ? COLORS.silkTop : COLORS.silkBottom;
    c.globalAlpha = side === front ? 1 : 0.4;
    c.strokeStyle = col; c.lineWidth = Math.max(1, 0.15 * S); c.lineCap = 'round'; c.lineJoin = 'round';
    for (const comp of doc.components) {
      if ((comp.side || 'top') !== side) continue;
      c.strokeStyle = col; c.lineWidth = Math.max(1, 0.15 * S);
      for (const pl of silkOf(comp)) polyline(c, v, pl);
      const bb = courtyard(comp);
      const size = Math.min(1.2, Math.max(0.8, (bb[2] - bb[0]) / 4));
      drawText(c, v, comp.ref, comp.x, bb[1] - size * 0.75, size, col, side === 'bottom');
    }
    for (const t of doc.texts) if ((t.side || 'top') === side) drawText(c, v, t.text, t.x, t.y, t.size, col, side === 'bottom');
    c.globalAlpha = 1;
  }

  // pad numbers when zoomed in
  if (S > 14) {
    c.fillStyle = 'rgba(255,255,255,0.85)'; c.font = `${Math.min(12, S * 0.6)}px ui-monospace, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const p of pads) c.fillText(p.pad.num, X(p.x), Y(p.y));
  }

  // ratsnest
  if (st.rats) {
    c.strokeStyle = COLORS.rats; c.globalAlpha = 0.75; c.lineWidth = 1; c.setLineDash([]);
    for (const r of st.rats) { c.beginPath(); c.moveTo(X(r.x1), Y(r.y1)); c.lineTo(X(r.x2), Y(r.y2)); c.stroke(); }
    c.globalAlpha = 1;
  }

  // selection
  if (st.selected) {
    const comp = doc.components.find((k) => k.ref === st.selected);
    if (comp) {
      const bb = courtyard(comp);
      c.strokeStyle = COLORS.select; c.lineWidth = 1; c.setLineDash([4, 3]);
      c.strokeRect(X(bb[0]), Y(bb[1]), (bb[2] - bb[0]) * S, (bb[3] - bb[1]) * S);
      c.setLineDash([]);
    }
  }

  // DRC markers
  if (st.markers) {
    c.strokeStyle = COLORS.marker; c.lineWidth = 2;
    for (const m of st.markers) {
      if (m.x == null) continue;
      const x = X(m.x), y = Y(m.y), r = 7;
      c.beginPath(); c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); c.stroke();
      c.beginPath(); c.arc(x, y, r + 3, 0, 7); c.stroke();
    }
  }
  if (st.overlay) st.overlay(c, v);
}

export function hitComponent(wx, wy) {
  for (let i = doc.components.length - 1; i >= 0; i--) {
    const comp = doc.components[i];
    const bb = courtyard(comp);
    if (wx >= bb[0] && wx <= bb[2] && wy >= bb[1] && wy <= bb[3]) return comp;
  }
  return null;
}

export function hitPad(wx, wy) {
  return allPads().find((p) => Math.hypot(p.x - wx, p.y - wy) < Math.max(p.pad.w, p.pad.h) / 2) || null;
}
