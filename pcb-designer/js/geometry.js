// Basic 2D geometry helpers. All units are millimetres.
// Shapes: { kind: 'cap', ax, ay, bx, by, r }  -> capsule (track, round/oval pad, via)
//         { kind: 'poly', pts: [[x,y], ...] } -> convex polygon (rect pad)

export const EPS = 1e-9;

export function rotPt(x, y, deg) {
  if (!deg) return [x, y];
  const r = (deg * Math.PI) / 180;
  let c = Math.cos(r), s = Math.sin(r);
  if (Math.abs(c) < EPS) c = 0;
  if (Math.abs(s) < EPS) s = 0;
  return [x * c - y * s, x * s + y * c];
}

export function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function orient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return Math.abs(v) < EPS ? 0 : v > 0 ? 1 : -1;
}

function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    ptSegDist(ax, ay, cx, cy, dx, dy),
    ptSegDist(bx, by, cx, cy, dx, dy),
    ptSegDist(cx, cy, ax, ay, bx, by),
    ptSegDist(dx, dy, ax, ay, bx, by)
  );
}

export function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyEdges(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push([a[0], a[1], b[0], b[1]]);
  }
  return out;
}

// Signed-ish distance between the copper of two shapes (negative / 0 = touching or overlapping).
export function shapeDist(a, b) {
  if (a.kind === 'cap' && b.kind === 'cap') {
    return segSegDist(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by) - a.r - b.r;
  }
  if (a.kind === 'poly' && b.kind === 'cap') return shapeDist(b, a);
  if (a.kind === 'cap' && b.kind === 'poly') {
    if (pointInPoly(a.ax, a.ay, b.pts) || pointInPoly(a.bx, a.by, b.pts)) return -a.r;
    let d = Infinity;
    for (const e of polyEdges(b.pts)) d = Math.min(d, segSegDist(a.ax, a.ay, a.bx, a.by, ...e));
    return d - a.r;
  }
  // poly-poly
  for (const p of a.pts) if (pointInPoly(p[0], p[1], b.pts)) return -1;
  for (const p of b.pts) if (pointInPoly(p[0], p[1], a.pts)) return -1;
  let d = Infinity;
  for (const e1 of polyEdges(a.pts)) for (const e2 of polyEdges(b.pts)) d = Math.min(d, segSegDist(...e1, ...e2));
  return d;
}

export function shapeBBox(s) {
  if (s.kind === 'cap') {
    return [Math.min(s.ax, s.bx) - s.r, Math.min(s.ay, s.by) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.ay, s.by) + s.r];
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

export function bboxOverlap(a, b, m = 0) {
  return a[0] - m <= b[2] && b[0] - m <= a[2] && a[1] - m <= b[3] && b[1] - m <= a[3];
}

export function circlePoly(cx, cy, r, n = 24, a0 = 0, a1 = 360) {
  const pts = [];
  const full = Math.abs(a1 - a0) >= 360;
  const steps = full ? n : Math.max(2, Math.round((n * Math.abs(a1 - a0)) / 360));
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export const round3 = (v) => Math.round(v * 1000) / 1000;
