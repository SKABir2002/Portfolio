// Grid-based two-layer autorouter (A* with via + turn costs, rip-up-and-retry ordering).
import { doc, allPads, netWidth, viaShape } from './state.js';
import { shapeDist, shapeBBox } from './geometry.js';

const FREE = -1, BLOCK = -2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SQ2 = Math.SQRT2;

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

function buildGrid(netsToRoute, keepTracks, keepVias) {
  const R = doc.rules, G = R.routeGrid;
  const cols = Math.floor(doc.board.w / G) + 1, rows = Math.floor(doc.board.h / G) + 1, N = cols * rows;
  const owner = [new Int32Array(N).fill(FREE), new Int32Array(N).fill(FREE)];
  const ids = new Map();
  Object.keys(doc.nets).forEach((n, i) => ids.set(n, i));
  let uniq = 1000000;
  const wmax = Math.max(R.width, ...netsToRoute.map((n) => netWidth(n)));
  const half = wmax / 2;
  const L = (layer) => (layer === 'bottom' ? 1 : 0);

  const grid = { G, cols, rows, N, owner, ids, wmax };

  grid.mark = (li, shape, id, margin, force = false) => {
    const [x0, y0, x1, y1] = shapeBBox(shape);
    const i0 = Math.max(0, Math.floor((x0 - margin) / G)), i1 = Math.min(cols - 1, Math.ceil((x1 + margin) / G));
    const j0 = Math.max(0, Math.floor((y0 - margin) / G)), j1 = Math.min(rows - 1, Math.ceil((y1 + margin) / G));
    const o = owner[li];
    const probe = { kind: 'cap', ax: 0, ay: 0, bx: 0, by: 0, r: 0 };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        probe.ax = probe.bx = i * G; probe.ay = probe.by = j * G;
        if (shapeDist(probe, shape) > margin) continue;
        const k = j * cols + i;
        if (force) o[k] = id;
        else if (o[k] === FREE) o[k] = id;
        else if (o[k] !== id) o[k] = BLOCK;
      }
    }
  };

  // board edge keep-out
  const e = R.edge + half;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = i * G, y = j * G;
    if (x < e || y < e || x > doc.board.w - e || y > doc.board.h - e) { owner[0][j * cols + i] = BLOCK; owner[1][j * cols + i] = BLOCK; }
  }
  for (const h of doc.holes) {
    const s = { kind: 'cap', ax: h.x, ay: h.y, bx: h.x, by: h.y, r: h.d / 2 };
    grid.mark(0, s, BLOCK, R.clearance + half, true); grid.mark(1, s, BLOCK, R.clearance + half, true);
  }
  const pads = allPads();
  for (const p of pads) p.rid = p.net != null && ids.has(p.net) ? ids.get(p.net) : uniq++;
  for (const p of pads) for (const l of p.layers) grid.mark(L(l), p.shape, p.rid, R.clearance + half);
  for (const t of keepTracks) {
    const id = ids.has(t.net) ? ids.get(t.net) : uniq++;
    for (let i = 0; i + 1 < t.pts.length; i++) {
      const s = { kind: 'cap', ax: t.pts[i][0], ay: t.pts[i][1], bx: t.pts[i + 1][0], by: t.pts[i + 1][1], r: t.width / 2 };
      grid.mark(L(t.layer), s, id, R.clearance + half);
    }
  }
  for (const v of keepVias) {
    const id = ids.has(v.net) ? ids.get(v.net) : uniq++;
    grid.mark(0, viaShape(v), id, R.clearance + half); grid.mark(1, viaShape(v), id, R.clearance + half);
  }
  // pad cores always belong to their own net
  for (const p of pads) for (const l of p.layers) grid.mark(L(l), p.shape, p.rid, 0, true);
  grid.pads = pads;
  grid.L = L;
  return grid;
}

function simplify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function routeNet(grid, net, newTracks, newVias, keepTracks, keepVias) {
  const R = doc.rules;
  const { G, cols, rows, N, owner, L } = grid;
  const nid = grid.ids.get(net);
  const w = netWidth(net);
  const margin = R.clearance + grid.wmax / 2 + w / 2;
  const pins = grid.pads.filter((p) => p.net === net);
  const failed = [];
  if (pins.length < 2) return failed;

  const tree = [new Uint8Array(N), new Uint8Array(N)];
  const treePad = [new Int32Array(N).fill(-1), new Int32Array(N).fill(-1)];
  const cellOf = (x, y) => {
    const i = Math.round(x / G), j = Math.round(y / G);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
    return j * cols + i;
  };
  const markTree = (li, shape, padIdx = -1) => {
    const [x0, y0, x1, y1] = shapeBBox(shape);
    const probe = { kind: 'cap', ax: 0, ay: 0, bx: 0, by: 0, r: 0 };
    for (let j = Math.max(0, Math.floor(y0 / G)); j <= Math.min(rows - 1, Math.ceil(y1 / G)); j++) {
      for (let i = Math.max(0, Math.floor(x0 / G)); i <= Math.min(cols - 1, Math.ceil(x1 / G)); i++) {
        probe.ax = probe.bx = i * G; probe.ay = probe.by = j * G;
        if (shapeDist(probe, shape) <= 1e-6) { tree[li][j * cols + i] = 1; if (padIdx >= 0) treePad[li][j * cols + i] = padIdx; }
      }
    }
  };
  const addPadToTree = (pi) => {
    const p = pins[pi];
    for (const l of p.layers) {
      markTree(L(l), p.shape, pi);
      const k = cellOf(p.x, p.y);
      if (k >= 0) { tree[L(l)][k] = 1; treePad[L(l)][k] = pi; }
    }
  };
  // existing copper of this net counts as already connected
  for (const t of keepTracks.concat(newTracks)) {
    if (t.net !== net) continue;
    for (let i = 0; i + 1 < t.pts.length; i++) {
      markTree(L(t.layer), { kind: 'cap', ax: t.pts[i][0], ay: t.pts[i][1], bx: t.pts[i + 1][0], by: t.pts[i + 1][1], r: t.width / 2 });
    }
  }
  for (const v of keepVias) if (v.net === net) { markTree(0, viaShape(v)); markTree(1, viaShape(v)); }

  const connected = [0];
  addPadToTree(0);
  const remaining = pins.map((_, i) => i).slice(1);

  const passable = (li, k) => { const o = owner[li][k]; return o === FREE || o === nid; };
  const viaR = Math.ceil(Math.max(0, R.viaDia / 2 - grid.wmax / 2) / G);
  const viaOk = (k) => {
    const i = k % cols, j = (k - i) / cols;
    for (let dj = -viaR; dj <= viaR; dj++) for (let di = -viaR; di <= viaR; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) return false;
      const kk = jj * cols + ii;
      if (!passable(0, kk) || !passable(1, kk)) return false;
    }
    return true;
  };

  while (remaining.length) {
    // nearest unconnected pin to the connected set
    let bi = 0, bd = Infinity, target = null;
    remaining.forEach((pi, idx) => {
      for (const ci of connected) {
        const d = Math.hypot(pins[pi].x - pins[ci].x, pins[pi].y - pins[ci].y);
        if (d < bd) { bd = d; bi = idx; target = pins[ci]; }
      }
    });
    const pi = remaining.splice(bi, 1)[0];
    const pin = pins[pi];
    const sk = cellOf(pin.x, pin.y);
    if (sk < 0) { failed.push(`${net}: ${pin.id} is outside the board`); continue; }
    if (pin.layers.some((l) => tree[L(l)][sk])) { connected.push(pi); addPadToTree(pi); continue; }

    const g = new Float32Array(2 * N).fill(Infinity);
    const came = new Int32Array(2 * N).fill(-1);
    const dir = new Int8Array(2 * N).fill(-1);
    const closed = new Uint8Array(2 * N);
    const heap = new MinHeap();
    const ti = target.x / G, tj = target.y / G;
    const h = (k) => {
      const i = k % cols, j = (k - i) / cols;
      const dx = Math.abs(i - ti), dy = Math.abs(j - tj);
      return Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy);
    };
    for (const l of pin.layers) {
      const node = L(l) * N + sk;
      g[node] = 0; heap.push(h(sk), node);
    }
    let goal = -1, expansions = 0;
    const VIA_COST = 14, TURN = 0.35;
    while (heap.size) {
      const node = heap.pop();
      if (closed[node]) continue;
      closed[node] = 1;
      const li = node >= N ? 1 : 0, k = node - li * N;
      if (tree[li][k] && g[node] > 0) { goal = node; break; }
      if (++expansions > 4 * N) break;
      const i = k % cols, j = (k - i) / cols;
      for (let d = 0; d < 8; d++) {
        const ii = i + DIRS[d][0], jj = j + DIRS[d][1];
        if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
        const kk = jj * cols + ii;
        if (!passable(li, kk)) continue;
        if (d >= 4 && (!passable(li, j * cols + ii) || !passable(li, jj * cols + i))) continue;
        const nn = li * N + kk;
        if (closed[nn]) continue;
        const cost = g[node] + (d >= 4 ? SQ2 : 1) + (dir[node] >= 0 && dir[node] !== d ? TURN : 0) + (li === 1 ? 0.15 : 0);
        if (cost < g[nn]) { g[nn] = cost; came[nn] = node; dir[nn] = d; heap.push(cost + h(kk), nn); }
      }
      // layer change through a via
      const other = (1 - li) * N + k;
      if (!closed[other] && passable(1 - li, k) && viaOk(k)) {
        const cost = g[node] + VIA_COST;
        if (cost < g[other]) { g[other] = cost; came[other] = node; dir[other] = -1; heap.push(cost + h(k), other); }
      }
    }
    if (goal < 0) { failed.push(`${net}: ${pin.id} → ${target.id}`); continue; }

    // reconstruct
    const path = [];
    for (let n = goal; n >= 0; n = came[n]) path.push(n);
    path.reverse();
    const runs = [];
    let cur = null;
    for (let s = 0; s < path.length; s++) {
      const n = path[s], li = n >= N ? 1 : 0, k = n - li * N;
      const pt = [(k % cols) * G, Math.floor(k / cols) * G];
      if (!cur || cur.li !== li) {
        if (cur) newVias.push({ net, x: pt[0], y: pt[1], dia: R.viaDia, drill: R.viaDrill, auto: true });
        cur = { li, pts: [pt] };
        runs.push(cur);
      } else cur.pts.push(pt);
    }
    // join exactly onto the pad centres at both ends
    const first = runs[0];
    if (pin.layers.includes(first.li ? 'bottom' : 'top')) first.pts.unshift([pin.x, pin.y]);
    const last = runs[runs.length - 1];
    const gk = goal - last.li * N;
    const tp = treePad[last.li][gk];
    if (tp >= 0) last.pts.push([pins[tp].x, pins[tp].y]);
    for (const r of runs) {
      const pts = simplify(r.pts.filter((p, idx, arr) => idx === 0 || p[0] !== arr[idx - 1][0] || p[1] !== arr[idx - 1][1]));
      if (pts.length < 2) continue;
      const t = { net, layer: r.li ? 'bottom' : 'top', width: w, pts: pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]), auto: true };
      newTracks.push(t);
      for (let s = 0; s + 1 < t.pts.length; s++) {
        const shape = { kind: 'cap', ax: t.pts[s][0], ay: t.pts[s][1], bx: t.pts[s + 1][0], by: t.pts[s + 1][1], r: w / 2 };
        grid.mark(r.li, shape, nid, margin);
        markTree(r.li, shape);
      }
    }
    for (const v of newVias.filter((v) => v.net === net)) {
      const s = viaShape(v);
      for (const li of [0, 1]) { grid.mark(li, s, nid, R.clearance + grid.wmax / 2); markTree(li, s); }
    }
    connected.push(pi);
    addPadToTree(pi);
  }
  return failed;
}

// Route `onlyNet` or every net. Replaces previous auto-routed copper of those nets.
export function autoroute(onlyNet = null) {
  const nets = (onlyNet ? [onlyNet] : Object.keys(doc.nets)).filter((n) => (doc.nets[n] || []).length >= 2);
  const keepTracks = doc.tracks.filter((t) => !(t.auto && nets.includes(t.net)));
  const keepVias = doc.vias.filter((v) => !(v.auto && nets.includes(v.net)));
  const pads = allPads();
  const span = (n) => {
    const ps = pads.filter((p) => p.net === n);
    if (!ps.length) return 0;
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  };
  let order = [...nets].sort((a, b) => span(a) - span(b));
  let best = null;
  for (let pass = 0; pass < 4; pass++) {
    const grid = buildGrid(nets, keepTracks, keepVias);
    const newTracks = [], newVias = [], failed = [];
    for (const n of order) failed.push(...routeNet(grid, n, newTracks, newVias, keepTracks, keepVias));
    if (!best || failed.length < best.failed.length) best = { newTracks, newVias, failed };
    if (!failed.length) break;
    const bad = new Set(failed.map((f) => f.split(':')[0]));
    order = [...order.filter((n) => bad.has(n)), ...order.filter((n) => !bad.has(n))];
  }
  doc.tracks = keepTracks.concat(best.newTracks);
  doc.vias = keepVias.concat(best.newVias);
  return { nets: nets.length, tracks: best.newTracks.length, vias: best.newVias.length, failed: best.failed };
}

export function unroute(net = null) {
  const before = doc.tracks.length + doc.vias.length;
  doc.tracks = doc.tracks.filter((t) => net && t.net !== net);
  doc.vias = doc.vias.filter((v) => net && v.net !== net);
  return before - doc.tracks.length - doc.vias.length;
}
