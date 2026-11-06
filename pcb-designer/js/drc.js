// Connectivity analysis, ratsnest and design-rule check.
import { doc, allPads, trackSegments, viaShape, courtyard } from './state.js';
import { shapeDist, shapeBBox, bboxOverlap } from './geometry.js';

function copperItems() {
  const items = [];
  for (const p of allPads()) {
    for (const layer of p.layers) items.push({ type: 'pad', id: p.id, net: p.net, layer, shape: p.shape, pad: p });
  }
  for (const s of trackSegments()) items.push({ type: 'track', net: s.net, layer: s.layer, shape: s.shape, ti: s.ti });
  doc.vias.forEach((v, vi) => {
    for (const layer of ['top', 'bottom']) items.push({ type: 'via', net: v.net, layer, shape: viaShape(v), vi });
  });
  for (const it of items) it.bb = shapeBBox(it.shape);
  return items;
}

class DSU {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

// Groups copper that physically touches. Pads/vias spanning two layers join their layer copies.
export function connectivity() {
  const items = copperItems();
  const dsu = new DSU(items.length);
  const byKey = new Map();
  items.forEach((it, i) => {
    const key = it.type === 'pad' ? 'p' + it.id : it.type === 'via' ? 'v' + it.vi : null;
    if (key) { if (byKey.has(key)) dsu.union(i, byKey.get(key)); else byKey.set(key, i); }
  });
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.layer !== b.layer || !bboxOverlap(a.bb, b.bb, 0.001)) continue;
      if (dsu.find(i) === dsu.find(j)) continue;
      if (shapeDist(a.shape, b.shape) <= 0.001) dsu.union(i, j);
    }
  }
  return { items, dsu };
}

// For every net: islands of pad ids that are already joined by copper.
export function netIslands(conn = connectivity()) {
  const { items, dsu } = conn;
  const padRoot = new Map();
  items.forEach((it, i) => { if (it.type === 'pad') padRoot.set(it.id, dsu.find(i)); });
  const result = {};
  for (const [net, pins] of Object.entries(doc.nets)) {
    const groups = new Map();
    for (const id of pins) {
      if (!padRoot.has(id)) continue;
      const r = padRoot.get(id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(id);
    }
    result[net] = [...groups.values()];
  }
  return result;
}

// Minimal spanning lines between islands (the "ratsnest" airwires).
export function ratsnest(islands = netIslands()) {
  const pads = new Map(allPads().map((p) => [p.id, p]));
  const lines = [];
  for (const [net, groups] of Object.entries(islands)) {
    if (groups.length < 2) continue;
    const inTree = [groups[0]];
    const rest = groups.slice(1);
    while (rest.length) {
      let best = null;
      for (let gi = 0; gi < rest.length; gi++) {
        for (const a of rest[gi]) for (const t of inTree) for (const b of t) {
          const pa = pads.get(a), pb = pads.get(b);
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (!best || d < best.d) best = { d, gi, pa, pb };
        }
      }
      lines.push({ net, x1: best.pa.x, y1: best.pa.y, x2: best.pb.x, y2: best.pb.y });
      inTree.push(rest.splice(best.gi, 1)[0]);
    }
  }
  return lines;
}

export function runDRC() {
  const errors = [];
  const conn = connectivity();
  const { items, dsu } = conn;
  const clr = doc.rules.clearance;

  // clearance between different nets
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.layer !== b.layer) continue;
      if (a.type === 'pad' && b.type === 'pad' && a.pad.comp === b.pad.comp && a.net === b.net && a.net) continue;
      if (a.type === 'pad' && b.type === 'pad' && a.id === b.id) continue;
      if (a.net && a.net === b.net) continue;
      if (!bboxOverlap(a.bb, b.bb, clr)) continue;
      const d = shapeDist(a.shape, b.shape);
      if (d < clr - 1e-4) {
        const [x0, y0, x1, y1] = a.bb;
        const what = (it) => (it.type === 'pad' ? `pad ${it.id}` : it.type) + (it.net ? ` (${it.net})` : '');
        const kind = d <= 0 ? 'Short' : 'Clearance';
        errors.push({ kind, msg: `${kind}: ${what(a)} ↔ ${what(b)} on ${a.layer}${d > 0 ? `, gap ${d.toFixed(3)} mm < ${clr}` : ''}`, x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
      }
    }
  }

  // unrouted connections
  const islands = netIslands(conn);
  const padMap = new Map(allPads().map((p) => [p.id, p]));
  for (const [net, groups] of Object.entries(islands)) {
    if (groups.length > 1) {
      const p = padMap.get(groups[1][0]);
      errors.push({ kind: 'Unrouted', msg: `Unrouted: net ${net} is split into ${groups.length} islands`, x: p.x, y: p.y });
    }
  }

  // copper of one island touching pads of several nets
  const roots = new Map();
  items.forEach((it, i) => {
    if (it.type !== 'pad' || !it.net) return;
    const r = dsu.find(i);
    if (!roots.has(r)) roots.set(r, new Set());
    roots.get(r).add(it.net);
  });
  for (const nets of roots.values()) {
    if (nets.size > 1) errors.push({ kind: 'Short', msg: `Short: nets ${[...nets].join(', ')} are joined by copper` });
  }

  // board edges & courtyards
  const B = doc.board;
  const cys = doc.components.map((c) => ({ c, bb: courtyard(c) }));
  for (const { c, bb } of cys) {
    if (bb[0] < 0 || bb[1] < 0 || bb[2] > B.w || bb[3] > B.h) {
      errors.push({ kind: 'Board', msg: `Board: ${c.ref} is outside the board outline`, x: c.x, y: c.y });
    }
  }
  for (const it of items) {
    if (it.type === 'pad') continue;
    const [x0, y0, x1, y1] = it.bb;
    if (x0 < doc.rules.edge || y0 < doc.rules.edge || x1 > B.w - doc.rules.edge || y1 > B.h - doc.rules.edge) {
      errors.push({ kind: 'Board', msg: `Board: ${it.type} too close to the board edge`, x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
    }
  }
  for (let i = 0; i < cys.length; i++) {
    for (let j = i + 1; j < cys.length; j++) {
      const a = cys[i], b = cys[j];
      const fa = a.c.side || 'top', fb = b.c.side || 'top';
      if (fa !== fb) continue;
      if (a.bb[0] < b.bb[2] && b.bb[0] < a.bb[2] && a.bb[1] < b.bb[3] && b.bb[1] < a.bb[3]) {
        errors.push({ kind: 'Overlap', msg: `Overlap: ${a.c.ref} and ${b.c.ref} courtyards overlap`, x: (a.c.x + b.c.x) / 2, y: (a.c.y + b.c.y) / 2 });
      }
    }
  }

  // pins referenced by nets that no longer exist
  const padIds = new Set(allPads().map((p) => p.id));
  for (const [net, pins] of Object.entries(doc.nets)) {
    for (const id of pins) if (!padIds.has(id)) errors.push({ kind: 'Netlist', msg: `Netlist: ${id} in net ${net} does not exist` });
  }
  return errors;
}
