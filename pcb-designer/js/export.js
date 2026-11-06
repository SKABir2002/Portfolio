// Fabrication + image exports: Gerber RS-274X, Excellon drill, SVG, BOM, JSON.
import { doc, allPads, silkOf, courtyard, padShape } from './state.js';
import { textStrokes, strokeWidth } from './font.js';
import { COLORS } from './render.js';

const SOFTWARE = 'PCB Command Designer';

// ---------------- Gerber ----------------
class Gerber {
  constructor(fileFunction, polarity = 'Positive') {
    this.ff = fileFunction; this.pol = polarity; this.aps = new Map(); this.body = []; this.cur = null; this.H = doc.board.h;
  }
  c(v) { return String(Math.round(v * 1e6)); }
  xy(x, y) { return `X${this.c(x)}Y${this.c(this.H - y)}`; }
  circle(d) {
    const key = `C${d.toFixed(4)}`;
    if (!this.aps.has(key)) this.aps.set(key, { code: 10 + this.aps.size, def: `C,${d.toFixed(6)}` });
    const code = this.aps.get(key).code;
    if (this.cur !== code) { this.body.push(`D${code}*`); this.cur = code; }
  }
  flash(x, y, d) { this.circle(d); this.body.push(`${this.xy(x, y)}D03*`); }
  stroke(pts, w) {
    if (pts.length < 2) return;
    this.circle(w);
    this.body.push(`${this.xy(...pts[0])}D02*`);
    for (const p of pts.slice(1)) this.body.push(`${this.xy(...p)}D01*`);
  }
  region(pts) {
    this.body.push('G36*', `${this.xy(...pts[0])}D02*`);
    for (const p of pts.slice(1)) this.body.push(`${this.xy(...p)}D01*`);
    this.body.push(`${this.xy(...pts[0])}D01*`, 'G37*');
  }
  shape(s, grow = 0) {
    if (s.kind === 'poly') this.region(s.pts);
    else if (s.ax === s.bx && s.ay === s.by) this.flash(s.ax, s.ay, 2 * s.r + grow);
    else this.stroke([[s.ax, s.ay], [s.bx, s.by]], 2 * s.r + grow);
  }
  toString() {
    const head = [
      `G04 ${SOFTWARE} - ${doc.name}*`,
      `%TF.GenerationSoftware,${SOFTWARE},1.0*%`,
      `%TF.FileFunction,${this.ff}*%`,
      `%TF.FilePolarity,${this.pol}*%`,
      '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%',
    ];
    for (const a of this.aps.values()) head.push(`%ADD${a.code}${a.def}*%`);
    head.push('G01*');
    return head.concat(this.body, ['M02*']).join('\n') + '\n';
  }
}

function copperLayer(layer) {
  const g = new Gerber(layer === 'top' ? 'Copper,L1,Top' : 'Copper,L2,Bot');
  for (const t of doc.tracks) if (t.layer === layer) g.stroke(t.pts, t.width);
  for (const p of allPads()) if (p.layers.includes(layer)) g.shape(p.shape);
  for (const v of doc.vias) g.flash(v.x, v.y, v.dia);
  return g.toString();
}

function maskLayer(layer) {
  const g = new Gerber(layer === 'top' ? 'Soldermask,Top' : 'Soldermask,Bot', 'Negative');
  const ex = 0.05;
  for (const p of allPads()) {
    if (!p.layers.includes(layer)) continue;
    if (p.shape.kind === 'poly') g.region(padShape(p.comp, { ...p.pad, w: p.pad.w + 2 * ex, h: p.pad.h + 2 * ex }).pts);
    else g.shape(p.shape, 2 * ex);
  }
  return g.toString();
}

function silkLayer(side) {
  const g = new Gerber(side === 'top' ? 'Legend,Top' : 'Legend,Bot');
  for (const c of doc.components) {
    if ((c.side || 'top') !== side) continue;
    for (const pl of silkOf(c)) g.stroke(pl, 0.15);
    const bb = courtyard(c);
    const size = Math.min(1.2, Math.max(0.8, (bb[2] - bb[0]) / 4));
    for (const pl of textStrokes(c.ref, c.x, bb[1] - size * 0.75, size, side === 'bottom')) g.stroke(pl, strokeWidth(size));
  }
  for (const t of doc.texts) {
    if ((t.side || 'top') !== side) continue;
    for (const pl of textStrokes(t.text, t.x, t.y, t.size, side === 'bottom')) g.stroke(pl, strokeWidth(t.size));
  }
  return g.toString();
}

function outlineLayer() {
  const g = new Gerber('Profile,NP');
  const { w, h } = doc.board;
  g.stroke([[0, 0], [w, 0], [w, h], [0, h], [0, 0]], 0.1);
  return g.toString();
}

function drillFile(plated) {
  const hits = [];
  if (plated) {
    for (const p of allPads()) if (p.drill) hits.push([p.x, p.y, p.drill]);
    for (const v of doc.vias) hits.push([v.x, v.y, v.drill]);
  } else for (const h of doc.holes) hits.push([h.x, h.y, h.d]);
  const tools = [...new Set(hits.map((h) => h[2].toFixed(3)))].sort();
  const out = ['M48', `; ${SOFTWARE} - ${doc.name}`, `; TYPE=${plated ? 'PLATED' : 'NON_PLATED'}`, 'FMAT,2', 'METRIC'];
  tools.forEach((t, i) => out.push(`T${i + 1}C${t}`));
  out.push('%', 'G90', 'G05');
  tools.forEach((t, i) => {
    out.push(`T${i + 1}`);
    for (const h of hits) if (h[2].toFixed(3) === t) out.push(`X${h[0].toFixed(3)}Y${(doc.board.h - h[1]).toFixed(3)}`);
  });
  out.push('T0', 'M30');
  return out.join('\n') + '\n';
}

export function gerberFiles() {
  const base = (doc.name || 'board').replace(/[^\w-]+/g, '_');
  return [
    [`${base}-F_Cu.gtl`, copperLayer('top')],
    [`${base}-B_Cu.gbl`, copperLayer('bottom')],
    [`${base}-F_Mask.gts`, maskLayer('top')],
    [`${base}-B_Mask.gbs`, maskLayer('bottom')],
    [`${base}-F_Silkscreen.gto`, silkLayer('top')],
    [`${base}-B_Silkscreen.gbo`, silkLayer('bottom')],
    [`${base}-Edge_Cuts.gm1`, outlineLayer()],
    [`${base}-PTH.drl`, drillFile(true)],
    [`${base}-NPTH.drl`, drillFile(false)],
  ];
}

// ---------------- ZIP (store, no compression) ----------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [name, text] of files) {
    const data = enc.encode(text), nm = enc.encode(name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nm, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------------- SVG ----------------
export function toSVG() {
  const { w, h } = doc.board, m = 2;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-m} ${-m} ${w + 2 * m} ${h + 2 * m}" width="${(w + 2 * m) * 4}mm" height="${(h + 2 * m) * 4}mm">`];
  out.push(`<rect x="${-m}" y="${-m}" width="${w + 2 * m}" height="${h + 2 * m}" fill="${COLORS.bg}"/>`);
  out.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${COLORS.board}" stroke="${COLORS.edge}" stroke-width="0.15"/>`);
  const pl = (pts) => pts.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ');
  const shape = (s, fill) => {
    if (s.kind === 'poly') return `<polygon points="${pl(s.pts)}" fill="${fill}"/>`;
    if (s.ax === s.bx && s.ay === s.by) return `<circle cx="${s.ax}" cy="${s.ay}" r="${s.r}" fill="${fill}"/>`;
    return `<line x1="${s.ax}" y1="${s.ay}" x2="${s.bx}" y2="${s.by}" stroke="${fill}" stroke-width="${2 * s.r}" stroke-linecap="round"/>`;
  };
  const pads = allPads();
  for (const [layer, op] of [['bottom', 0.8], ['top', 1]]) {
    out.push(`<g opacity="${op}">`);
    for (const t of doc.tracks) if (t.layer === layer) out.push(`<polyline points="${pl(t.pts)}" fill="none" stroke="${COLORS[layer]}" stroke-width="${t.width}" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (const p of pads) if (!p.drill && p.layers[0] === layer) out.push(shape(p.shape, COLORS[layer]));
    out.push('</g>');
  }
  for (const p of pads) if (p.drill) out.push(shape(p.shape, COLORS.tht), `<circle cx="${p.x}" cy="${p.y}" r="${p.drill / 2}" fill="${COLORS.drill}"/>`);
  for (const v of doc.vias) out.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.dia / 2}" fill="${COLORS.via}"/><circle cx="${v.x}" cy="${v.y}" r="${v.drill / 2}" fill="${COLORS.drill}"/>`);
  for (const ho of doc.holes) out.push(`<circle cx="${ho.x}" cy="${ho.y}" r="${ho.d / 2}" fill="${COLORS.hole}"/>`);
  const silk = (pts, col, sw) => `<polyline points="${pl(pts)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  for (const c of doc.components) {
    const col = c.side === 'bottom' ? COLORS.silkBottom : COLORS.silkTop;
    for (const p of silkOf(c)) out.push(silk(p, col, 0.15));
    const bb = courtyard(c);
    const size = Math.min(1.2, Math.max(0.8, (bb[2] - bb[0]) / 4));
    for (const p of textStrokes(c.ref, c.x, bb[1] - size * 0.75, size, c.side === 'bottom')) out.push(silk(p, col, strokeWidth(size)));
  }
  for (const t of doc.texts) {
    const col = t.side === 'bottom' ? COLORS.silkBottom : COLORS.silkTop;
    for (const p of textStrokes(t.text, t.x, t.y, t.size, t.side === 'bottom')) out.push(silk(p, col, strokeWidth(t.size)));
  }
  out.push('</svg>');
  return out.join('\n');
}

// ---------------- BOM ----------------
export function toBOM() {
  const groups = new Map();
  for (const c of doc.components) {
    const k = `${c.fp}|${c.value || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c.ref);
  }
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [['Designators', 'Footprint', 'Value', 'Qty'].map(q).join(',')];
  for (const [k, refs] of groups) {
    const [fp, value] = k.split('|');
    rows.push([refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(' '), fp, value, refs.length].map(q).join(','));
  }
  return rows.join('\n') + '\n';
}
