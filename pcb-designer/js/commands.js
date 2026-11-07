// Command language: parse a text line and apply it to the design.
import {
  doc, newDoc, replaceDoc, snapshot, undo, redo, dropLastSnapshot,
  findComp, autoRef, parsePinId, padById, netOfPin, courtyard,
} from './state.js';
import { getFootprint, normalizeFootprint, FOOTPRINT_NAMES, PIN_NOTES } from './footprints.js';
import { autoroute, unroute } from './router.js';
import { ptSegDist } from './geometry.js';
import { runDRC } from './drc.js';

const REF_RE = /^(?:R|C|L|D|LED|U|Q|J|P|SW|Y|X|F|K|BT|TP|H|IC|T|M|CN|FB|VR|RV)\d+$/i;
const num = (s, what = 'number') => {
  const v = parseFloat(String(s).replace(/mm$/i, ''));
  if (!Number.isFinite(v)) throw new Error(`Expected a ${what}, got "${s}"`);
  return v;
};
const r3 = (v) => Math.round(v * 1000) / 1000;
const fmt = (v) => String(r3(v));

export function tokenize(line) {
  const parts = line.split(/("[^"]*")/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\(\s*/g, ' ').replace(/\s*\)/g, ' ').replace(/\s*,\s*/g, ',');
  }
  const s = parts.join('');
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? { q: true, v: m[1] } : { q: false, v: m[2] });
  return out;
}

export function parsePoint(tok) {
  const pin = parsePinId(tok);
  if (pin) { const p = padById(pin); return { x: p.x, y: p.y, pin }; }
  const m = String(tok).match(/^(-?[\d.]+)(?:mm)?[,xX;](-?[\d.]+)(?:mm)?$/);
  if (!m) throw new Error(`Expected a point like 10,20 or a pin like R1.2, got "${tok}"`);
  return { x: num(m[1]), y: num(m[2]) };
}

function needComp(ref) {
  const c = findComp(ref);
  if (!c) throw new Error(`No component "${ref}". Use "list" to see the parts.`);
  return c;
}
function needPin(tok) {
  const id = parsePinId(tok);
  if (!id) throw new Error(`Unknown pin "${tok}". Pins look like R1.1 or U1.8.`);
  return id;
}
function snap(v) { const g = doc.grid || 0.5; return r3(Math.round(v / g) * g); }

function freeSpot(c) {
  const others = doc.components.filter((o) => o !== c).map(courtyard);
  const fits = () => {
    const bb = courtyard(c);
    if (bb[0] < 1 || bb[1] < 1 || bb[2] > doc.board.w - 1 || bb[3] > doc.board.h - 1) return false;
    return others.every((o) => bb[2] + 0.6 < o[0] || o[2] + 0.6 < bb[0] || bb[3] + 0.6 < o[1] || o[3] + 0.6 < bb[1]);
  };
  for (let y = 2; y < doc.board.h; y += 1) {
    for (let x = 2; x < doc.board.w; x += 1) {
      c.x = snap(x); c.y = snap(y);
      if (fits()) return true;
    }
  }
  c.x = snap(doc.board.w / 2); c.y = snap(doc.board.h / 2);
  return false;
}

function newNetName() {
  let n = 1;
  while (doc.nets[`N$${n}`]) n++;
  return `N$${n}`;
}

function removePinFromNets(id) {
  for (const [name, pins] of Object.entries(doc.nets)) {
    const i = pins.indexOf(id);
    if (i >= 0) pins.splice(i, 1);
    if (!pins.length) deleteNet(name);
  }
}
function deleteNet(name) {
  delete doc.nets[name];
  delete doc.rules.netWidth[name];
  doc.tracks = doc.tracks.filter((t) => t.net !== name);
  doc.vias = doc.vias.filter((v) => v.net !== name);
}
function renameNet(from, to) {
  if (from === to) return;
  const pins = doc.nets[from] || [];
  doc.nets[to] = [...new Set([...(doc.nets[to] || []), ...pins])];
  delete doc.nets[from];
  if (doc.rules.netWidth[from] && !doc.rules.netWidth[to]) doc.rules.netWidth[to] = doc.rules.netWidth[from];
  delete doc.rules.netWidth[from];
  for (const t of doc.tracks) if (t.net === from) t.net = to;
  for (const v of doc.vias) if (v.net === from) v.net = to;
}
function findNet(name) {
  if (doc.nets[name]) return name;
  const k = Object.keys(doc.nets).find((n) => n.toUpperCase() === String(name).toUpperCase());
  if (!k) throw new Error(`No net "${name}". Use "nets" to list them.`);
  return k;
}

// Put the given pins into one net named `name` (or an existing/auto name).
function joinPins(ids, name = null) {
  const existing = [...new Set(ids.map(netOfPin).filter(Boolean))];
  let target = name;
  if (!target) target = existing.find((n) => !n.startsWith('N$')) || existing[0] || newNetName();
  else {
    const clash = Object.keys(doc.nets).find((n) => n.toUpperCase() === target.toUpperCase());
    if (clash) target = clash;
  }
  for (const n of existing) if (n !== target) renameNet(n, target);
  doc.nets[target] = [...new Set([...(doc.nets[target] || []), ...ids])];
  return target;
}

function compSummary(c) {
  return `${c.ref.padEnd(6)} ${c.fp.padEnd(12)} ${(c.value || '').padEnd(10)} @ ${fmt(c.x)},${fmt(c.y)}${c.rot ? ` rot ${c.rot}` : ''}${c.side === 'bottom' ? ' bottom' : ''}`;
}

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------
export const COMMANDS = {};
function def(names, group, usage, desc, run, mutates = true) {
  const spec = { names, group, usage, desc, run, mutates };
  for (const n of names) COMMANDS[n] = spec;
}

def(['help', '?'], 'General', 'help [command]', 'Show all commands, or details for one.', (a, ctx) => {
  if (a[0]) {
    const c = COMMANDS[a[0].v.toLowerCase()];
    if (!c) throw new Error(`Unknown command "${a[0].v}"`);
    return `${c.usage}\n  ${c.desc}`;
  }
  ctx.showHelp();
  return null;
}, false);

def(['new', 'clear'], 'General', 'new', 'Start an empty design.', () => {
  replaceDoc(newDoc());
  return 'New empty design.';
});
def(['name'], 'General', 'name "My board"', 'Set the project name.', (a) => { doc.name = a.map((t) => t.v).join(' ') || 'Untitled'; return `Project name: ${doc.name}`; });
def(['undo'], 'General', 'undo', 'Undo the last change.', () => (undo() ? 'Undone.' : 'Nothing to undo.'), false);
def(['redo'], 'General', 'redo', 'Redo.', () => (redo() ? 'Redone.' : 'Nothing to redo.'), false);

def(['board'], 'Board', 'board <W>x<H>', 'Set the board size in mm, e.g. board 80x50.', (a) => {
  const s = a.map((t) => t.v).join(' ').replace(/^size\s+/i, '');
  const m = s.match(/^([\d.]+)\s*(?:mm)?\s*[x*, ]\s*([\d.]+)/i);
  if (!m) throw new Error('Usage: board 80x50');
  doc.board.w = num(m[1]); doc.board.h = num(m[2]);
  if (doc.board.w < 5 || doc.board.h < 5 || doc.board.w > 500 || doc.board.h > 500) throw new Error('Board must be between 5 and 500 mm.');
  return `Board is ${doc.board.w} × ${doc.board.h} mm.`;
});
def(['grid'], 'Board', 'grid <mm>', 'Placement snap grid, e.g. grid 1.27.', (a) => { doc.grid = num(a[0]?.v); return `Grid ${doc.grid} mm.`; });
def(['rules'], 'Board', 'rules [clearance X] [width X] [via DIA/DRILL] [edge X] [routegrid X]', 'Design rules in mm.', (a) => {
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].v.toLowerCase(), v = a[i + 1]?.v;
    if (k === 'clearance') doc.rules.clearance = num(v);
    else if (k === 'width') doc.rules.width = num(v);
    else if (k === 'edge') doc.rules.edge = num(v);
    else if (k === 'routegrid') doc.rules.routeGrid = Math.max(0.1, num(v));
    else if (k === 'via') { const [d, h] = String(v).split('/'); doc.rules.viaDia = num(d); if (h) doc.rules.viaDrill = num(h); }
    else throw new Error(`Unknown rule "${k}"`);
  }
  const R = doc.rules;
  return `clearance ${R.clearance}, width ${R.width}, via ${R.viaDia}/${R.viaDrill}, edge ${R.edge}, routegrid ${R.routeGrid}`;
});
def(['hole'], 'Board', 'hole X,Y [d 3.2]', 'Non-plated mounting hole.', (a) => {
  const t = a.filter((x) => x.v.toLowerCase() !== 'at');
  const p = parsePoint(t[0]?.v);
  let d = 3.2;
  const di = t.findIndex((x) => /^(d|dia|diameter)$/i.test(x.v));
  if (di >= 0) d = num(t[di + 1]?.v);
  doc.holes.push({ x: p.x, y: p.y, d });
  return `Hole ⌀${d} at ${fmt(p.x)},${fmt(p.y)}.`;
});
def(['text'], 'Board', 'text "LABEL" at X,Y [size 1.5] [bottom]', 'Silkscreen text.', (a) => {
  const label = a.find((t) => t.q)?.v ?? a[0]?.v;
  const ai = a.findIndex((t) => !t.q && t.v.toLowerCase() === 'at');
  if (!label || ai < 0) throw new Error('Usage: text "HELLO" at 10,5');
  const p = parsePoint(a[ai + 1]?.v);
  const si = a.findIndex((t) => !t.q && t.v.toLowerCase() === 'size');
  doc.texts.push({ text: label, x: p.x, y: p.y, size: si >= 0 ? num(a[si + 1]?.v) : 1.5, side: a.some((t) => !t.q && t.v.toLowerCase() === 'bottom') ? 'bottom' : 'top' });
  return `Text "${label}" added.`;
});

def(['add', 'place'], 'Parts', 'add <footprint> [REF] [value] [at X,Y] [rot DEG] [bottom]', 'Place a part, e.g. add R0805 R1 10k at 10,12.', (a) => {
  if (!a.length) throw new Error('Usage: add R0805 R1 10k at 10,12');
  const fpName = normalizeFootprint(a[0].v);
  const fp = getFootprint(fpName);
  if (!fp) throw new Error(`Unknown footprint "${a[0].v}". Type "footprints" to see the library.`);
  let ref = null, rot = 0, side = 'top', pos = null;
  const values = [];
  for (let i = 1; i < a.length; i++) {
    const t = a[i], lv = t.v.toLowerCase();
    if (!t.q && lv === 'at') { pos = parsePoint(a[++i]?.v); continue; }
    if (!t.q && (lv === 'rot' || lv === 'rotate')) { rot = num(a[++i]?.v); continue; }
    if (!t.q && (lv === 'bottom' || lv === 'top')) { side = lv; continue; }
    if (!t.q && /^value=/i.test(t.v)) { values.push(t.v.slice(6)); continue; }
    if (!t.q && !ref && !values.length && REF_RE.test(t.v)) { ref = t.v.toUpperCase(); continue; }
    if (!t.q && !pos && /^-?[\d.]+,-?[\d.]+$/.test(t.v)) { pos = parsePoint(t.v); continue; }
    values.push(t.v);
  }
  if (ref && findComp(ref)) throw new Error(`${ref} already exists.`);
  const c = { ref: ref || autoRef(fpName), fp: fpName, value: values.join(' '), x: 0, y: 0, rot: ((rot % 360) + 360) % 360, side };
  if (pos) { c.x = r3(pos.x); c.y = r3(pos.y); } else freeSpot(c);
  doc.components.push(c);
  return `Added ${c.ref} (${c.fp}${c.value ? ' ' + c.value : ''}) at ${fmt(c.x)},${fmt(c.y)}.`;
});
def(['move', 'mv'], 'Parts', 'move REF to X,Y | move REF by DX,DY | move REF left|right|up|down N', 'Move a part.', (a) => {
  const c = needComp(a[0]?.v);
  const k = a[1]?.v.toLowerCase();
  if (k === 'by') { const p = parsePoint(a[2]?.v); c.x = r3(c.x + p.x); c.y = r3(c.y + p.y); }
  else if (['left', 'right', 'up', 'down'].includes(k)) {
    const d = num(a[2]?.v ?? 1);
    if (k === 'left') c.x = r3(c.x - d); if (k === 'right') c.x = r3(c.x + d);
    if (k === 'up') c.y = r3(c.y - d); if (k === 'down') c.y = r3(c.y + d);
  } else {
    const p = parsePoint(k === 'to' ? a[2]?.v : a[1]?.v);
    c.x = r3(p.x); c.y = r3(p.y);
  }
  return `${c.ref} → ${fmt(c.x)},${fmt(c.y)}`;
});
def(['rotate', 'rot'], 'Parts', 'rotate REF [DEG=90] | rotate REF to DEG', 'Rotate a part.', (a) => {
  const c = needComp(a[0]?.v);
  if (a[1]?.v.toLowerCase() === 'to') c.rot = ((num(a[2]?.v) % 360) + 360) % 360;
  else c.rot = (((c.rot || 0) + (a[1] ? num(a[1].v) : 90)) % 360 + 360) % 360;
  return `${c.ref} rotation ${c.rot}°`;
});
def(['flip'], 'Parts', 'flip REF', 'Move a part to the other side of the board.', (a) => {
  const c = needComp(a[0]?.v);
  c.side = c.side === 'bottom' ? 'top' : 'bottom';
  return `${c.ref} is now on the ${c.side}.`;
});
def(['value', 'val'], 'Parts', 'value REF <value>', 'Set a part value.', (a) => {
  const c = needComp(a[0]?.v); c.value = a.slice(1).map((t) => t.v).join(' ');
  return `${c.ref} = ${c.value}`;
});
def(['delete', 'del', 'rm', 'remove'], 'Parts', 'delete REF [REF...]', 'Remove parts (and their connections).', (a) => {
  if (!a.length) throw new Error('Usage: delete R1');
  const done = [];
  for (const t of a) {
    const c = needComp(t.v);
    for (const p of getFootprint(c.fp).pads) removePinFromNets(`${c.ref}.${p.num}`);
    doc.components.splice(doc.components.indexOf(c), 1);
    done.push(c.ref);
  }
  return `Deleted ${done.join(', ')}.`;
});
def(['autoplace'], 'Parts', 'autoplace', 'Pack all parts onto the board, biggest first.', () => {
  const comps = [...doc.components].sort((p, q) => {
    const a = courtyard(p), b = courtyard(q);
    return (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]);
  });
  const placed = [];
  const keep = doc.components;
  doc.components = placed;
  let misses = 0;
  for (const c of comps) { placed.push(c); if (!freeSpot(c)) misses++; }
  doc.components = keep;
  return misses ? `Placed, but ${misses} part(s) did not fit — make the board bigger.` : `Placed ${comps.length} parts.`;
});

def(['connect', 'wire', 'link'], 'Nets', 'connect PIN PIN [PIN...]', 'Electrically connect pins, e.g. connect R1.2 LED1.1.', (a) => {
  if (a.length < 2) throw new Error('Usage: connect R1.2 LED1.1');
  const ids = a.map((t) => needPin(t.v));
  const n = joinPins(ids);
  return `${ids.join(', ')} → net ${n}`;
});
def(['net'], 'Nets', 'net NAME PIN [PIN...]', 'Create or extend a named net, e.g. net GND U1.4 C1.2.', (a) => {
  if (a.length < 2) throw new Error('Usage: net GND U1.4 C1.2');
  const name = a[0].v;
  if (!/^[\w$+\-/.]+$/.test(name)) throw new Error('Net names may use letters, digits and _ $ + - / .');
  const ids = a.slice(1).map((t) => needPin(t.v));
  const n = joinPins(ids, name);
  return `Net ${n}: ${doc.nets[n].join(' ')}`;
});
def(['disconnect'], 'Nets', 'disconnect PIN [PIN...]', 'Remove pins from their nets.', (a) => {
  for (const t of a) removePinFromNets(needPin(t.v));
  return `Disconnected ${a.map((t) => t.v).join(', ')}.`;
});
def(['rename'], 'Nets', 'rename NET NEWNAME', 'Rename a net.', (a) => {
  const from = findNet(a[0]?.v);
  if (!a[1]) throw new Error('Usage: rename N$1 VCC');
  renameNet(from, a[1].v);
  return `Net ${from} → ${a[1].v}`;
});
def(['width'], 'Nets', 'width NET|all <mm>', 'Track width for a net (or the default).', (a) => {
  const w = num(a[1]?.v);
  if (a[0]?.v.toLowerCase() === 'all') { doc.rules.width = w; return `Default width ${w} mm.`; }
  const n = findNet(a[0]?.v); doc.rules.netWidth[n] = w;
  return `${n} tracks: ${w} mm (run "route ${n}" to apply).`;
});

def(['route', 'autoroute'], 'Routing', 'route [NET]', 'Autoroute every net, or one net.', (a) => {
  const net = a[0] && a[0].v.toLowerCase() !== 'all' ? findNet(a[0].v) : null;
  const t0 = performance.now();
  const r = autoroute(net);
  const ms = Math.round(performance.now() - t0);
  let msg = `Routed ${r.nets} net(s): ${r.tracks} tracks, ${r.vias} vias in ${ms} ms.`;
  if (r.failed.length) msg += `\nCould not route ${r.failed.length} connection(s):\n  ` + r.failed.join('\n  ') + '\nTip: spread the parts out, make the board bigger, or lower "rules clearance".';
  return msg;
});
def(['unroute', 'ripup'], 'Routing', 'unroute [NET]', 'Delete tracks and vias (all, or one net).', (a) => {
  const net = a[0] && a[0].v.toLowerCase() !== 'all' ? findNet(a[0].v) : null;
  return `Removed ${unroute(net)} item(s).`;
});
def(['track', 'trace'], 'Routing', 'track P1 P2 [P3...] [layer top|bottom] [width W] [net NAME]', 'Draw a track through points or pins, e.g. track R1.2 20,10 LED1.1.', (a) => {
  const pts = []; let layer = 'top', width = null, net = null;
  for (let i = 0; i < a.length; i++) {
    const lv = a[i].v.toLowerCase();
    if (lv === 'layer') { layer = a[++i]?.v.toLowerCase() === 'bottom' ? 'bottom' : 'top'; continue; }
    if (lv === 'bottom' || lv === 'top') { layer = lv; continue; }
    if (lv === 'width') { width = num(a[++i]?.v); continue; }
    if (lv === 'net') { net = a[++i]?.v; continue; }
    pts.push(parsePoint(a[i].v));
  }
  if (pts.length < 2) throw new Error('A track needs at least two points.');
  if (!net) net = pts.map((p) => p.pin && netOfPin(p.pin)).find(Boolean) || null;
  else net = findNet(net);
  doc.tracks.push({ net, layer, width: width || (net && doc.rules.netWidth[net]) || doc.rules.width, pts: pts.map((p) => [r3(p.x), r3(p.y)]), auto: false });
  return `Track on ${layer}${net ? ' (' + net + ')' : ''} with ${pts.length} points.`;
});
def(['via'], 'Routing', 'via X,Y [net NAME]', 'Place a via.', (a) => {
  const t = a.filter((x) => x.v.toLowerCase() !== 'at');
  const p = parsePoint(t[0]?.v);
  const ni = t.findIndex((x) => x.v.toLowerCase() === 'net');
  doc.vias.push({ net: ni >= 0 ? findNet(t[ni + 1]?.v) : null, x: r3(p.x), y: r3(p.y), dia: doc.rules.viaDia, drill: doc.rules.viaDrill, auto: false });
  return `Via at ${fmt(p.x)},${fmt(p.y)}.`;
});
def(['erase'], 'Routing', 'erase X,Y [top|bottom]', 'Delete the via, or the track segment, under a point.', (a) => {
  const t = a.filter((x) => x.v.toLowerCase() !== 'at');
  const layer = t.find((x) => /^(top|bottom)$/i.test(x.v))?.v.toLowerCase();
  const p = parsePoint(t.find((x) => !/^(top|bottom)$/i.test(x.v))?.v);
  const vi = doc.vias.findIndex((v) => Math.hypot(v.x - p.x, v.y - p.y) <= v.dia / 2);
  const dropVia = () => { const v = doc.vias.splice(vi, 1)[0]; return `Removed via at ${fmt(v.x)},${fmt(v.y)}.`; };
  if (vi >= 0 && !layer) return dropVia();
  let best = null;
  doc.tracks.forEach((tr, ti) => {
    if (layer && tr.layer !== layer) return;
    for (let si = 0; si + 1 < tr.pts.length; si++) {
      const d = ptSegDist(p.x, p.y, ...tr.pts[si], ...tr.pts[si + 1]) - tr.width / 2;
      if (d <= 0.05 && (!best || d < best.d)) best = { ti, si, d };
    }
  });
  if (!best) { if (vi >= 0) return dropVia(); throw new Error(`Nothing to erase at ${fmt(p.x)},${fmt(p.y)}.`); }
  const tr = doc.tracks[best.ti];
  const parts = [tr.pts.slice(0, best.si + 1), tr.pts.slice(best.si + 1)].filter((q) => q.length >= 2);
  doc.tracks.splice(best.ti, 1, ...parts.map((pts) => ({ ...tr, pts })));
  return `Erased a ${tr.layer} track segment${tr.net ? ' of ' + tr.net : ''}.`;
});
def(['drc', 'check'], 'Routing', 'drc', 'Design-rule check: clearances, shorts, unrouted nets, overlaps.', (a, ctx) => {
  const errs = runDRC();
  ctx.setMarkers(errs);
  if (!errs.length) return '✔ DRC passed — no problems found.';
  return `✖ ${errs.length} problem(s):\n  ` + errs.map((e) => e.msg).join('\n  ');
}, false);

def(['list', 'ls', 'parts'], 'Info', 'list', 'List the parts.', () => {
  if (!doc.components.length) return 'No parts yet. Try: add R0805 R1 10k';
  return doc.components.map(compSummary).join('\n');
}, false);
def(['nets'], 'Info', 'nets', 'List the nets.', () => {
  const e = Object.entries(doc.nets);
  if (!e.length) return 'No nets yet. Try: connect R1.1 R2.1';
  return e.map(([n, p]) => `${n.padEnd(8)} ${p.join(' ')}`).join('\n');
}, false);
def(['info', 'show'], 'Info', 'info REF', 'Show a part with its pins and nets.', (a, ctx) => {
  const c = needComp(a[0]?.v);
  ctx.select(c.ref);
  const pins = getFootprint(c.fp).pads.map((p) => `  ${c.ref}.${p.num}  ${netOfPin(`${c.ref}.${p.num}`) || '—'}`);
  return compSummary(c) + '\n' + pins.join('\n');
}, false);
def(['footprints', 'library', 'lib'], 'Info', 'footprints', 'Show the footprint library and pin conventions.', () =>
  'Footprints: ' + FOOTPRINT_NAMES.join(', ') + '\nAliases: resistor, capacitor, led, diode, button, crystal, transistor, regulator, header, electrolytic\n' + PIN_NOTES.map((n) => '  • ' + n).join('\n'), false);
def(['select', 'sel'], 'Info', 'select REF', 'Select and highlight a part.', (a, ctx) => { const c = needComp(a[0]?.v); ctx.select(c.ref); return `Selected ${c.ref}.`; }, false);

def(['view', 'layer'], 'View', 'view top|bottom|all', 'Choose which copper layer is in front.', (a, ctx) => { ctx.setView(a[0]?.v.toLowerCase() || 'all'); return null; }, false);
def(['zoom'], 'View', 'zoom fit|in|out', 'Zoom the canvas.', (a, ctx) => { ctx.zoom(a[0]?.v.toLowerCase() || 'fit'); return null; }, false);
def(['export'], 'Files', 'export gerber|svg|png|bom|json', 'Download fabrication files or images.', (a, ctx) => { ctx.exportFile((a[0]?.v || 'gerber').toLowerCase()); return null; }, false);
def(['save'], 'Files', 'save', 'Save to this browser.', (a, ctx) => ctx.saveLocal(), false);
def(['load'], 'Files', 'load', 'Load the design saved in this browser.', (a, ctx) => ctx.loadLocal(), false);
def(['open'], 'Files', 'open', 'Open a .json design file.', (a, ctx) => { ctx.openFile(); return null; }, false);
def(['demo'], 'General', 'demo', 'Build an example: a 555 LED blinker.', (a, ctx) => { ctx.runScript(DEMO, 'demo'); return null; }, false);
def(['ai', 'ask'], 'AI', 'ai <what you want>', 'Ask the AI to design or edit, e.g. ai add a 3.3V regulator with caps.', (a, ctx) => {
  ctx.askAI(a.map((t) => (t.q ? `"${t.v}"` : t.v)).join(' '));
  return null;
}, false);

export const DEMO = `new
name "555 LED blinker"
board 52x36
rules width 0.4 clearance 0.25
add DIP8 U1 NE555 at 24,18
add R0805 R1 10k at 34,12 rot 90
add R0805 R2 47k at 38,16 rot 90
add CP_RADIAL5 C1 10uF at 14,25
add C0805 C2 10nF at 33,25
add C0805 C3 100nF at 24,8
add R0805 R3 470 at 14,13
add LED0805 LED1 red at 9,18 rot 90
add HDR1X2 J1 5V at 24,30
net VCC J1.1 U1.8 U1.4 R1.1 C3.1
net GND J1.2 U1.1 C1.2 C2.2 C3.2 LED1.2
net DIS U1.7 R1.2 R2.1
net THR U1.6 U1.2 R2.2 C1.1
net CTRL U1.5 C2.1
net OUT U1.3 R3.1
net LED R3.2 LED1.1
width VCC 0.6
width GND 0.6
hole 3.5,3.5
hole 48.5,3.5
hole 3.5,32.5
hole 48.5,32.5
text "555 BLINKER" at 37,32 size 1.4
route
drc`;

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
export function splitScript(text) {
  return String(text).split(/\r?\n|;(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((l) => l.replace(/(^|\s)(#|\/\/).*$/, '').trim()).filter(Boolean);
}

// Run one command line. Returns { ok, text }.
export function execLine(line, ctx, { record = true } = {}) {
  const toks = tokenize(line);
  if (!toks.length) return { ok: true, text: null };
  const name = toks[0].v.toLowerCase();
  const spec = COMMANDS[name];
  if (!spec) {
    const near = Object.keys(COMMANDS).filter((k) => k.startsWith(name.slice(0, 2)));
    throw Object.assign(new Error(`Unknown command "${toks[0].v}".${near.length ? ' Did you mean: ' + near.slice(0, 4).join(', ') + '?' : ''} Type "help", or start with "ai" to ask in plain words.`), { unknown: true });
  }
  const before = spec.mutates && record ? JSON.stringify(doc) : null;
  if (before) snapshot();
  try {
    const text = spec.run(toks.slice(1), ctx);
    return { ok: true, text, mutated: spec.mutates };
  } catch (e) {
    if (before) { replaceDoc(JSON.parse(before)); dropLastSnapshot(); }
    throw e;
  }
}

export function helpGroups() {
  const groups = {};
  const seen = new Set();
  for (const spec of Object.values(COMMANDS)) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    (groups[spec.group] ||= []).push(spec);
  }
  return groups;
}

