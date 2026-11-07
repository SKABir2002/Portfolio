// Interactive editing on the canvas: select / move parts, tracks and vias, draw tracks, place vias.
// Every finished edit is either run as a command or logged, and is one undo step.
import { doc, snapshot, replaceDoc, allPads, trackSegments, viaShape, netOfPin, netWidth } from './state.js';
import { shapeDist, ptSegDist, shapeBBox, bboxOverlap } from './geometry.js';
import { toWorld, hitComponent, hitPad, COLORS } from './render.js';
import { execLine } from './commands.js';
import { ratsnest } from './drc.js';

const f3 = (v) => Math.round(v * 1000) / 1000;
const fmtP = ([x, y]) => `${f3(x)},${f3(y)}`;
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const dedupe = (pts) => pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
const other = (l) => (l === 'top' ? 'bottom' : 'top');

export function createEditor(env) {
  const { canvas, view, ui, log, refresh, draw, run, ctx, onToolChange } = env;
  ui.tool = 'select';
  ui.drawLayer = 'top';
  ui.selTrack = null; // { ti, si }
  ui.selVia = null; // index
  let draft = null; // { net, startPin, endPin, runs: [{ layer, pts }], vias: [{x,y}] }
  let cursor = null; // snapped target under the mouse
  let drag = null;
  let posture = 0; // 0: straight then 45°, 1: 45° then straight
  let warn = null;
  let obstacles = [];
  let hint = '';

  const TOL = 6; // px
  const g = () => doc.grid || 0.5;
  const snapV = (v) => f3(Math.round(v / g()) * g());
  const frontLayer = () => (ui.layer === 'bottom' ? 'bottom' : 'top');
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wy] = toWorld(view, sx, sy);
    return { sx, sy, wx, wy };
  };

  // ------------------------------------------------------------- hit tests
  function hitVia(wx, wy) {
    const tol = TOL / view.scale;
    for (let i = doc.vias.length - 1; i >= 0; i--) {
      const v = doc.vias[i];
      if (Math.hypot(v.x - wx, v.y - wy) <= v.dia / 2 + tol * 0.5) return i;
    }
    return -1;
  }
  function hitSeg(wx, wy, prefer, onlyLayer = null) {
    const tol = TOL / view.scale;
    let best = null;
    doc.tracks.forEach((t, ti) => {
      if (onlyLayer && t.layer !== onlyLayer) return;
      for (let si = 0; si + 1 < t.pts.length; si++) {
        const d = ptSegDist(wx, wy, ...t.pts[si], ...t.pts[si + 1]) - t.width / 2;
        if (d > tol) continue;
        const score = Math.max(d, 0) - (t.layer === prefer ? 1e-3 : 0);
        if (!best || score < best.score) best = { ti, si, score };
      }
    });
    return best;
  }

  // Where a click in track/via mode lands: pad centre, track vertex, via, point on a track, or the grid.
  function snapTarget(wx, wy) {
    const pad = hitPad(wx, wy);
    if (pad) return { x: pad.x, y: pad.y, pad, net: pad.net, layers: pad.layers, label: `pad ${pad.id}` };
    const tol = TOL / view.scale;
    for (const v of doc.vias) {
      if (Math.hypot(v.x - wx, v.y - wy) <= v.dia / 2 + tol * 0.5) return { x: v.x, y: v.y, via: v, net: v.net, layers: ['top', 'bottom'], label: 'via' };
    }
    for (const t of doc.tracks) {
      if (t.layer !== ui.drawLayer) continue;
      for (const p of t.pts) if (Math.hypot(p[0] - wx, p[1] - wy) <= tol) return { x: p[0], y: p[1], track: t, net: t.net, layers: [t.layer], label: 'track' };
    }
    const s = hitSeg(wx, wy, ui.drawLayer, ui.drawLayer);
    if (s) {
      const t = doc.tracks[s.ti];
      const [ax, ay] = t.pts[s.si], [bx, by] = t.pts[s.si + 1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const k = L2 ? Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy) / L2)) : 0;
      return { x: f3(ax + k * dx), y: f3(ay + k * dy), track: t, net: t.net, layers: [t.layer], label: 'track' };
    }
    return { x: snapV(wx), y: snapV(wy), net: null, layers: ['top', 'bottom'] };
  }

  // ------------------------------------------------------------- tool + layer state
  function setTool(t) {
    if (draft) cancelDraft();
    ui.tool = t;
    if (t !== 'select') { ui.selTrack = null; ui.selVia = null; }
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    updateHint();
    onToolChange?.();
    draw();
  }
  function setDrawLayer(l) {
    ui.drawLayer = l;
    ui.layer = l;
    onToolChange?.();
    draw();
  }

  // ------------------------------------------------------------- track drawing
  const curRun = () => draft.runs[draft.runs.length - 1];
  const lastPt = () => { const r = curRun(); return r.pts[r.pts.length - 1]; };

  function previewPts(c) {
    const p = lastPt();
    const dx = c[0] - p[0], dy = c[1] - p[1];
    const ad = Math.min(Math.abs(dx), Math.abs(dy));
    const sx = Math.sign(dx), sy = Math.sign(dy);
    const corner = posture === 0 ? [c[0] - sx * ad, c[1] - sy * ad] : [p[0] + sx * ad, p[1] + sy * ad];
    return dedupe([p, corner, c].map((q) => [f3(q[0]), f3(q[1])]));
  }

  function buildObstacles() {
    const items = [];
    for (const p of allPads()) for (const layer of p.layers) items.push({ layer, net: p.net, id: p.id, shape: p.shape, label: `pad ${p.id}` });
    for (const s of trackSegments()) items.push({ layer: s.layer, net: s.net, shape: s.shape, label: `track${s.net ? ' ' + s.net : ''}` });
    for (const v of doc.vias) for (const layer of ['top', 'bottom']) items.push({ layer, net: v.net, shape: viaShape(v), label: `via${v.net ? ' ' + v.net : ''}` });
    for (const it of items) it.bb = shapeBBox(it.shape);
    return items;
  }

  function checkClearance(pts, layer, skipId) {
    const w = netWidth(draft.net), clr = doc.rules.clearance;
    for (let i = 0; i + 1 < pts.length; i++) {
      const s = { kind: 'cap', ax: pts[i][0], ay: pts[i][1], bx: pts[i + 1][0], by: pts[i + 1][1], r: w / 2 };
      const bb = shapeBBox(s);
      for (const it of obstacles) {
        if (it.layer !== layer || !bboxOverlap(bb, it.bb, clr)) continue;
        if (draft.net && it.net === draft.net) continue;
        if (it.id && (it.id === draft.startPin || it.id === skipId)) continue;
        if (shapeDist(s, it.shape) < clr - 1e-4) return it.label;
      }
    }
    return null;
  }

  function startDraft(tg) {
    if (!tg.layers.includes(ui.drawLayer)) setDrawLayer(tg.layers[0]);
    draft = { net: tg.net || null, startPin: tg.pad?.id || null, endPin: null, runs: [{ layer: ui.drawLayer, pts: [[tg.x, tg.y]] }], vias: [] };
    obstacles = buildObstacles();
    ui.hoverNet = draft.net;
    onToolChange?.();
  }

  function addPoint(tg) {
    const run0 = curRun();
    const isObject = tg.pad || tg.track || tg.via;
    if (isObject) {
      if (tg.net && draft.net && tg.net !== draft.net) { flash(`✖ ${tg.label} is on net ${tg.net}; this track is ${draft.net}. That would be a short.`); return; }
      if (!tg.layers.includes(run0.layer)) { flash(`✖ ${tg.label} is only on the ${tg.layers[0]} layer — press V to drop a via and switch layers first.`); return; }
    }
    const pts = previewPts([tg.x, tg.y]);
    run0.pts.push(...pts.slice(1));
    if (tg.net && !draft.net) { draft.net = tg.net; ui.hoverNet = tg.net; }
    if (isObject && pts.length > 1) {
      if (tg.pad) draft.endPin = tg.pad.id;
      finishDraft();
    }
  }

  function insertVia() {
    if (!draft) return;
    const p = lastPt();
    if (draft.vias.some((v) => same([v.x, v.y], p))) return;
    draft.vias.push({ x: p[0], y: p[1] });
    const nl = other(curRun().layer);
    draft.runs.push({ layer: nl, pts: [[p[0], p[1]]] });
    setDrawLayer(nl);
  }

  function undoPoint() {
    if (!draft) return;
    const r = curRun();
    if (r.pts.length > 1) r.pts.pop();
    else if (draft.runs.length > 1) { draft.runs.pop(); draft.vias.pop(); setDrawLayer(curRun().layer); }
    else cancelDraft();
    draw();
  }

  function cancelDraft() {
    draft = null; warn = null; ui.hoverNet = null;
    onToolChange?.();
    draw();
  }

  function finishDraft() {
    if (!draft) return;
    const d = draft;
    draft = null; warn = null; ui.hoverNet = null;
    onToolChange?.();
    const runs = d.runs.map((r) => ({ layer: r.layer, pts: dedupe(r.pts) })).filter((r) => r.pts.length >= 2);
    if (!runs.length) { draw(); return; }
    snapshot();
    const lines = [];
    const exec = (line) => { execLine(line, ctx, { record: false }); lines.push(line); };
    let net = d.net;
    try {
      const pins = [...new Set([d.startPin, d.endPin].filter(Boolean))];
      if (!net) net = pins.map(netOfPin).find(Boolean) || null;
      if (net) { for (const p of pins) if (!netOfPin(p)) exec(`net ${net} ${p}`); }
      else if (pins.length === 2) { exec(`connect ${pins[0]} ${pins[1]}`); net = netOfPin(pins[0]); }
      const w = netWidth(net);
      for (const r of runs) exec(`track ${r.pts.map(fmtP).join(' ')} layer ${r.layer} width ${w}${net ? ' net ' + net : ''}`);
      for (const v of d.vias) exec(`via ${fmtP([v.x, v.y])}${net ? ' net ' + net : ''}`);
    } catch (e) { log('err', e.message); }
    for (const l of lines) log('cmd', l);
    if (lines.length) log('info', 'Track drawn — Ctrl+Z removes it.');
    refresh();
  }

  // ------------------------------------------------------------- select-mode editing
  function commitEdit(before, text, kind = 'cmd') {
    const after = JSON.stringify(doc);
    replaceDoc(JSON.parse(before));
    snapshot();
    replaceDoc(JSON.parse(after));
    log(kind, text);
    refresh();
  }

  function onDown(e) {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (e.button !== 0) { drag = { kind: 'pan', button: e.button, sx: p.sx, sy: p.sy, ox: view.ox, oy: view.oy, moved: false }; return; }

    if (ui.tool === 'track') {
      const tg = snapTarget(p.wx, p.wy);
      if (!draft) startDraft(tg); else addPoint(tg);
      draw();
      return;
    }
    if (ui.tool === 'via') {
      const tg = snapTarget(p.wx, p.wy);
      if (tg.pad) { flash('✖ Put the via next to the pad, not on it.'); return; }
      run(`via ${fmtP([tg.x, tg.y])}${tg.net ? ' net ' + tg.net : ''}`);
      return;
    }

    // select tool
    const before = JSON.stringify(doc);
    if (ui.selTrack) {
      const t = doc.tracks[ui.selTrack.ti];
      const k = t ? t.pts.findIndex((q) => Math.hypot(q[0] - p.wx, q[1] - p.wy) * view.scale <= TOL + 2) : -1;
      if (k >= 0) { drag = { kind: 'vertex', ti: ui.selTrack.ti, k, before, moved: false }; return; }
    }
    const vi = hitVia(p.wx, p.wy);
    if (vi >= 0) {
      const v = doc.vias[vi];
      const attached = [];
      doc.tracks.forEach((t, ti) => t.pts.forEach((q, k) => { if ((k === 0 || k === t.pts.length - 1) && same(q, [v.x, v.y])) attached.push([ti, k]); }));
      ui.selVia = vi; ui.selTrack = null; ui.selected = null;
      drag = { kind: 'via', vi, attached, before, moved: false };
      draw();
      return;
    }
    const s = hitSeg(p.wx, p.wy, frontLayer());
    if (s) {
      const t = doc.tracks[s.ti];
      ui.selTrack = { ti: s.ti, si: s.si }; ui.selVia = null; ui.selected = null;
      drag = { kind: 'seg', ti: s.ti, si: s.si, a0: [...t.pts[s.si]], b0: [...t.pts[s.si + 1]], wx0: p.wx, wy0: p.wy, before, moved: false };
      draw();
      return;
    }
    ui.selTrack = null; ui.selVia = null;
    const comp = hitComponent(p.wx, p.wy);
    if (comp) {
      ui.selected = comp.ref;
      drag = { kind: 'comp', comp, dx: p.wx - comp.x, dy: p.wy - comp.y, x0: comp.x, y0: comp.y, before, moved: false };
    } else {
      ui.selected = null;
      drag = { kind: 'pan', button: 0, sx: p.sx, sy: p.sy, ox: view.ox, oy: view.oy, moved: false };
    }
    draw();
  }

  function onMove(e) {
    const p = pos(e);
    let hud = `x ${p.wx.toFixed(2)}  y ${p.wy.toFixed(2)}`;
    if (drag?.kind === 'pan') {
      if (Math.hypot(p.sx - drag.sx, p.sy - drag.sy) > 3) drag.moved = true;
      view.ox = drag.ox + p.sx - drag.sx; view.oy = drag.oy + p.sy - drag.sy;
    } else if (drag?.kind === 'comp') {
      drag.comp.x = snapV(p.wx - drag.dx); drag.comp.y = snapV(p.wy - drag.dy);
      drag.moved = drag.comp.x !== drag.x0 || drag.comp.y !== drag.y0;
      ui.rats = ratsnest();
    } else if (drag?.kind === 'seg') {
      const t = doc.tracks[drag.ti];
      const dx = snapV(p.wx - drag.wx0), dy = snapV(p.wy - drag.wy0);
      t.pts[drag.si] = [f3(drag.a0[0] + dx), f3(drag.a0[1] + dy)];
      t.pts[drag.si + 1] = [f3(drag.b0[0] + dx), f3(drag.b0[1] + dy)];
      drag.moved = dx !== 0 || dy !== 0;
      ui.rats = ratsnest();
    } else if (drag?.kind === 'vertex') {
      const t = doc.tracks[drag.ti];
      const pad = hitPad(p.wx, p.wy);
      t.pts[drag.k] = pad && pad.layers.includes(t.layer) ? [pad.x, pad.y] : [snapV(p.wx), snapV(p.wy)];
      drag.moved = true;
      ui.rats = ratsnest();
    } else if (drag?.kind === 'via') {
      const v = doc.vias[drag.vi];
      v.x = snapV(p.wx); v.y = snapV(p.wy);
      for (const [ti, k] of drag.attached) doc.tracks[ti].pts[k] = [v.x, v.y];
      drag.moved = true;
      ui.rats = ratsnest();
    } else if (ui.tool === 'track' || ui.tool === 'via') {
      cursor = snapTarget(p.wx, p.wy);
      if (cursor.label) hud += `  ·  ${cursor.label}${cursor.net ? ' (' + cursor.net + ')' : ''}`;
      if (draft) {
        const pts = previewPts([cursor.x, cursor.y]);
        warn = checkClearance(pts, curRun().layer, cursor.pad?.id);
        const len = pts.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0), 0);
        hud += `  ·  ${len.toFixed(2)} mm`;
        if (warn) hud += `  ·  ⚠ too close to ${warn}`;
      }
    } else {
      // hover feedback in select mode
      const pad = hitPad(p.wx, p.wy);
      const net = pad ? pad.net : null;
      if (pad) hud += `  ·  ${pad.id}${net ? '  net ' + net : '  (no net)'}`;
      else {
        const s = hitSeg(p.wx, p.wy, frontLayer());
        const vi = s ? -1 : hitVia(p.wx, p.wy);
        if (s) { const t = doc.tracks[s.ti]; hud += `  ·  ${t.layer} track ${t.width} mm${t.net ? '  net ' + t.net : ''}`; }
        else if (vi >= 0) hud += `  ·  via${doc.vias[vi].net ? '  net ' + doc.vias[vi].net : ''}`;
        else { const c = hitComponent(p.wx, p.wy); if (c) hud += `  ·  ${c.ref} ${c.fp} ${c.value || ''}`; }
        canvas.style.cursor = s || vi >= 0 || hitComponent(p.wx, p.wy) ? 'move' : 'default';
      }
      ui.hoverNet = net;
    }
    env.setHud(hud);
    draw();
  }

  function onUp() {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'pan' && d.button === 2 && !d.moved) {
      // right-click: finish the track being drawn, or go back to the select tool
      if (draft) finishDraft(); else if (ui.tool !== 'select') setTool('select');
      return;
    }
    if (!d.moved) return;
    if (d.kind === 'comp') commitEdit(d.before, `move ${d.comp.ref} to ${d.comp.x},${d.comp.y}`);
    else if (d.kind === 'seg') commitEdit(d.before, `Moved a ${doc.tracks[d.ti].layer} track segment (Ctrl+Z to undo).`, 'info');
    else if (d.kind === 'vertex') commitEdit(d.before, `Moved a track corner to ${fmtP(doc.tracks[d.ti].pts[d.k])} (Ctrl+Z to undo).`, 'info');
    else if (d.kind === 'via') commitEdit(d.before, `Moved a via to ${fmtP([doc.vias[d.vi].x, doc.vias[d.vi].y])} (Ctrl+Z to undo).`, 'info');
  }

  function onDblClick(e) {
    if (ui.tool === 'track') { if (draft) finishDraft(); return; }
    if (ui.tool !== 'select') return;
    const p = pos(e);
    if (hitSeg(p.wx, p.wy, frontLayer()) || hitVia(p.wx, p.wy) >= 0) return;
    const c = hitComponent(p.wx, p.wy);
    if (c) run(`info ${c.ref}`);
  }

  function deleteSelection() {
    if (ui.selVia != null && doc.vias[ui.selVia]) {
      const v = doc.vias[ui.selVia];
      ui.selVia = null;
      run(`erase ${fmtP([v.x, v.y])}`);
      return true;
    }
    if (ui.selTrack && doc.tracks[ui.selTrack.ti]) {
      const t = doc.tracks[ui.selTrack.ti];
      const a = t.pts[ui.selTrack.si], b = t.pts[ui.selTrack.si + 1];
      ui.selTrack = null;
      run(`erase ${fmtP([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])} ${t.layer}`);
      return true;
    }
    if (ui.selected) { run(`delete ${ui.selected}`); return true; }
    return false;
  }

  // Returns true when the key was used.
  function onKey(e) {
    const k = e.key;
    if (draft) {
      if (k === 'Escape') { cancelDraft(); return true; }
      if (k === 'Enter') { finishDraft(); return true; }
      if (k === 'Backspace' || k === 'Delete') { undoPoint(); return true; }
      if (k === 'v' || k === 'V' || k === 'l' || k === 'L') { insertVia(); draw(); return true; }
      if (k === '/') { posture ^= 1; draw(); return true; }
      return false;
    }
    if (k === 'Escape') {
      if (ui.tool !== 'select') setTool('select');
      ui.selected = null; ui.selTrack = null; ui.selVia = null; ui.markers = null; draw();
      return true;
    }
    if (k === 'w' || k === 'W') { setTool('track'); return true; }
    if (k === 'v' || k === 'V') { setTool('via'); return true; }
    if (k === 's' || k === 'S') { setTool('select'); return true; }
    if (k === 'l' || k === 'L') { setDrawLayer(other(ui.drawLayer)); return true; }
    if (k === '/') { posture ^= 1; return true; }
    if (k === 'Delete' || k === 'Backspace') return deleteSelection();
    if (ui.selected && (k === 'r' || k === 'R')) { run(`rotate ${ui.selected}`); return true; }
    if (ui.selected && (k === 'f' || k === 'F')) { run(`flip ${ui.selected}`); return true; }
    return false;
  }

  // ------------------------------------------------------------- overlay drawing
  function overlay(c, v) {
    const S = v.scale, X = (x) => x * S + v.ox, Y = (y) => y * S + v.oy;
    const line = (pts, col, w, dash = null) => {
      c.save(); c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
      if (dash) c.setLineDash(dash);
      c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y)))); c.stroke(); c.restore();
    };
    // selection
    if (ui.selTrack && doc.tracks[ui.selTrack.ti]) {
      const t = doc.tracks[ui.selTrack.ti];
      line(t.pts.slice(ui.selTrack.si, ui.selTrack.si + 2), 'rgba(255,255,255,0.9)', t.width * S + 4);
      line(t.pts.slice(ui.selTrack.si, ui.selTrack.si + 2), COLORS[t.layer], Math.max(1, t.width * S));
      c.fillStyle = '#fff';
      for (const [x, y] of t.pts) c.fillRect(X(x) - 4, Y(y) - 4, 8, 8);
    }
    if (ui.selVia != null && doc.vias[ui.selVia]) {
      const via = doc.vias[ui.selVia];
      c.strokeStyle = '#fff'; c.lineWidth = 2;
      c.beginPath(); c.arc(X(via.x), Y(via.y), (via.dia / 2) * S + 4, 0, 7); c.stroke();
    }
    // track being drawn
    if (draft) {
      const w = netWidth(draft.net);
      for (const r of draft.runs) if (r.pts.length > 1) line(r.pts, COLORS[r.layer], Math.max(1, w * S));
      if (cursor) {
        const pts = previewPts([cursor.x, cursor.y]);
        if (pts.length > 1) {
          c.globalAlpha = 0.65;
          line(pts, warn ? '#ff9f0a' : COLORS[curRun().layer], Math.max(1, w * S));
          c.globalAlpha = 1;
          if (warn) line(pts, '#ffffff', 1, [5, 4]);
        }
      }
      for (const via of draft.vias) {
        c.fillStyle = COLORS.via; c.beginPath(); c.arc(X(via.x), Y(via.y), (doc.rules.viaDia / 2) * S, 0, 7); c.fill();
        c.fillStyle = COLORS.drill; c.beginPath(); c.arc(X(via.x), Y(via.y), (doc.rules.viaDrill / 2) * S, 0, 7); c.fill();
      }
    }
    // crosshair
    if ((ui.tool === 'track' || ui.tool === 'via') && cursor) {
      const x = X(cursor.x), y = Y(cursor.y);
      c.strokeStyle = cursor.label ? '#ffffff' : 'rgba(255,255,255,0.7)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - 8, y); c.lineTo(x + 8, y); c.moveTo(x, y - 8); c.lineTo(x, y + 8); c.stroke();
      if (cursor.label) { c.beginPath(); c.arc(x, y, 6, 0, 7); c.stroke(); }
    }
  }

  // ------------------------------------------------------------- hints
  function updateHint() {
    if (ui.tool === 'track') hint = draft
      ? 'Click to add a corner · click a pad to finish · double-click / right-click / Enter finishes · V = via + switch layer · / = bend style · Backspace = undo point · Esc = cancel'
      : 'Track: click a pad (or anywhere) to start drawing on the ' + ui.drawLayer + ' layer · L switches layer';
    else if (ui.tool === 'via') hint = 'Via: click where it should go (on a track to join that net) · Esc = back to Select';
    else hint = 'Select: drag parts, track segments, corners or vias · Delete removes · R rotate · F flip · W draw track · V via';
    return hint;
  }
  function flash(msg) { log(msg.startsWith('✖') ? 'err' : 'info', msg); }

  function validate() {
    if (ui.selTrack && !doc.tracks[ui.selTrack.ti]?.pts[ui.selTrack.si + 1]) ui.selTrack = null;
    if (ui.selVia != null && !doc.vias[ui.selVia]) ui.selVia = null;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    setTool, setDrawLayer, onKey, overlay, validate, finishDraft, cancelDraft, insertVia, deleteSelection,
    get drawing() { return !!draft; },
    get hint() { return updateHint(); },
  };
}
