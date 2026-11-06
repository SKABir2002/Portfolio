// Design document model + derived geometry.
import { getFootprint, refPrefix } from './footprints.js';
import { rotPt, circlePoly } from './geometry.js';

export function newDoc() {
  return {
    version: 1,
    name: 'Untitled',
    board: { w: 60, h: 40 },
    grid: 0.5,
    rules: { clearance: 0.2, width: 0.3, viaDia: 0.7, viaDrill: 0.35, edge: 0.4, routeGrid: 0.25, netWidth: {} },
    components: [],
    nets: {},          // name -> [ 'R1.1', 'U1.8', ... ]
    tracks: [],        // { net, layer: 'top'|'bottom', width, pts: [[x,y],...], auto }
    vias: [],          // { net, x, y, dia, drill, auto }
    texts: [],         // { text, x, y, size, side }
    holes: [],         // { x, y, d }
  };
}

export const doc = newDoc();

export function replaceDoc(d) {
  for (const k of Object.keys(doc)) delete doc[k];
  Object.assign(doc, newDoc(), d);
  doc.rules = Object.assign(newDoc().rules, d.rules || {});
}

// ---------- history ----------
const undoStack = [], redoStack = [];
export function snapshot() {
  undoStack.push(JSON.stringify(doc));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(JSON.stringify(doc));
  replaceDoc(JSON.parse(undoStack.pop()));
  return true;
}
export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(JSON.stringify(doc));
  replaceDoc(JSON.parse(redoStack.pop()));
  return true;
}
export function dropLastSnapshot() { undoStack.pop(); }

// ---------- lookups ----------
export function findComp(ref) {
  const r = String(ref).toUpperCase();
  return doc.components.find((c) => c.ref.toUpperCase() === r) || null;
}

export function nextRef(prefix) {
  let n = 1;
  const used = new Set(doc.components.map((c) => c.ref.toUpperCase()));
  while (used.has(`${prefix}${n}`.toUpperCase())) n++;
  return `${prefix}${n}`;
}

export function autoRef(fpName) { return nextRef(refPrefix(fpName)); }

export function parsePinId(s) {
  const m = String(s).match(/^([A-Za-z]+\d+)[.:](\w+)$/);
  if (!m) return null;
  const comp = findComp(m[1]);
  if (!comp) return null;
  const fp = getFootprint(comp.fp);
  const pad = fp.pads.find((p) => p.num.toUpperCase() === m[2].toUpperCase());
  if (!pad) return null;
  return `${comp.ref}.${pad.num}`;
}

export function netOfPin(id) {
  for (const [name, pins] of Object.entries(doc.nets)) if (pins.includes(id)) return name;
  return null;
}

export function netWidth(net) {
  return (net && doc.rules.netWidth[net]) || doc.rules.width;
}

// ---------- world geometry ----------
function xf(comp, x, y) {
  const mx = comp.side === 'bottom' ? -x : x;
  const [rx, ry] = rotPt(mx, y, comp.rot || 0);
  return [comp.x + rx, comp.y + ry];
}

export function padShape(comp, pad) {
  const [cx, cy] = xf(comp, pad.x, pad.y);
  if (pad.shape === 'round' || (pad.shape === 'oval' && pad.w === pad.h)) {
    return { kind: 'cap', ax: cx, ay: cy, bx: cx, by: cy, r: Math.min(pad.w, pad.h) / 2 };
  }
  if (pad.shape === 'oval') {
    const r = Math.min(pad.w, pad.h) / 2;
    const half = Math.abs(pad.w - pad.h) / 2;
    const [dx, dy] = pad.w > pad.h ? [half, 0] : [0, half];
    const [a0, a1] = xf(comp, pad.x - dx, pad.y - dy);
    const [b0, b1] = xf(comp, pad.x + dx, pad.y + dy);
    return { kind: 'cap', ax: a0, ay: a1, bx: b0, by: b1, r };
  }
  const hw = pad.w / 2, hh = pad.h / 2;
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => xf(comp, pad.x + x, pad.y + y));
  return { kind: 'poly', pts };
}

// All pads in world space.
export function allPads() {
  const out = [];
  for (const c of doc.components) {
    const fp = getFootprint(c.fp);
    if (!fp) continue;
    for (const p of fp.pads) {
      const id = `${c.ref}.${p.num}`;
      const [x, y] = xf(c, p.x, p.y);
      out.push({
        id, comp: c, pad: p, x, y,
        net: netOfPin(id),
        layers: p.drill ? ['top', 'bottom'] : [c.side || 'top'],
        drill: p.drill || 0,
        shape: padShape(c, p),
      });
    }
  }
  return out;
}

export function padById(id) {
  const [ref, num] = id.split('.');
  const c = findComp(ref);
  if (!c) return null;
  const p = getFootprint(c.fp).pads.find((q) => q.num === num);
  if (!p) return null;
  const [x, y] = xf(c, p.x, p.y);
  return { id, comp: c, pad: p, x, y, layers: p.drill ? ['top', 'bottom'] : [c.side || 'top'], shape: padShape(c, p) };
}

export function silkOf(c) {
  const fp = getFootprint(c.fp);
  return fp.silk.map((pl) => pl.map(([x, y]) => xf(c, x, y)));
}

export function courtyard(c) {
  const fp = getFootprint(c.fp);
  const [x0, y0, x1, y1] = fp.court;
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => xf(c, x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function trackSegments() {
  const segs = [];
  doc.tracks.forEach((t, ti) => {
    for (let i = 0; i + 1 < t.pts.length; i++) {
      const [ax, ay] = t.pts[i], [bx, by] = t.pts[i + 1];
      segs.push({ ti, net: t.net, layer: t.layer, width: t.width, shape: { kind: 'cap', ax, ay, bx, by, r: t.width / 2 } });
    }
  });
  return segs;
}

export function viaShape(v) { return { kind: 'cap', ax: v.x, ay: v.y, bx: v.x, by: v.y, r: v.dia / 2 }; }
export { circlePoly };
