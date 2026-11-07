// UI wiring: canvas interaction, console, panels, dialogs.
import { doc, replaceDoc, snapshot, undo, redo, findComp } from './state.js';
import { execLine, splitScript, helpGroups, COMMANDS } from './commands.js';
import { render, makeView, fitView, toWorld } from './render.js';
import { createEditor } from './tools.js';
import { ratsnest, netIslands } from './drc.js';
import { gerberFiles, makeZip, toSVG, toBOM } from './export.js';
import { askAI, DEFAULT_MODEL } from './ai.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#board'), wrap = $('#canvasWrap'), logEl = $('#log'), input = $('#cmd');
const view = makeView();
const ui = { layer: 'all', selected: null, hoverNet: null, markers: null, rats: [], mode: 'cmd', busy: false };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const ai = { key: store.get('pcbcd.aiKey') || '', model: store.get('pcbcd.aiModel') || DEFAULT_MODEL };

// ---------------------------------------------------------------- logging
function log(kind, text, html = false) {
  if (text == null || text === '') return;
  const d = document.createElement('div');
  d.className = kind.split(' ').map((k) => 'l-' + k).join(' ');
  if (html) d.innerHTML = text; else d.textContent = text;
  logEl.appendChild(d);
  const panel = $('#panel-console');
  panel.scrollTop = panel.scrollHeight;
  return d;
}

// ---------------------------------------------------------------- refresh
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(canvas, view, ui); }); }

function refresh({ keepMarkers = false } = {}) {
  if (!keepMarkers) ui.markers = null;
  const islands = netIslands();
  ui.rats = ratsnest(islands);
  if (ui.selected && !findComp(ui.selected)) ui.selected = null;
  editor.validate();
  const unrouted = ui.rats.length;
  $('#status').textContent = `${doc.name} · ${doc.board.w}×${doc.board.h} mm · ${doc.components.length} parts · ${Object.keys(doc.nets).length} nets · ${doc.tracks.length} tracks · ${unrouted ? unrouted + ' unrouted' : 'all routed'}`;
  renderPanels();
  store.set('pcbcd.autosave', JSON.stringify(doc));
  draw();
}

function renderPanels() {
  const parts = $('#panel-parts'), nets = $('#panel-nets');
  if (!doc.components.length) parts.innerHTML = '<p class="empty">No parts yet. Type <code>add R0805 R1 10k</code> or click Demo.</p>';
  else {
    const rows = doc.components.map((c) => `<tr data-ref="${esc(c.ref)}"><td>${esc(c.ref)}</td><td>${esc(c.fp)}</td><td>${esc(c.value || '')}</td><td>${c.x},${c.y}${c.rot ? ' ↻' + c.rot : ''}${c.side === 'bottom' ? ' B' : ''}</td></tr>`).join('');
    parts.innerHTML = `<table class="list"><thead><tr><th>Ref</th><th>Footprint</th><th>Value</th><th>Pos</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const entries = Object.entries(doc.nets);
  if (!entries.length) nets.innerHTML = '<p class="empty">No nets yet. Type <code>connect R1.1 LED1.1</code>.</p>';
  else {
    const rows = entries.map(([n, p]) => `<tr data-net="${esc(n)}"><td>${esc(n)}</td><td>${p.map(esc).join(' ')}</td></tr>`).join('');
    nets.innerHTML = `<table class="list"><thead><tr><th>Net</th><th>Pins</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- command context
const ctx = {
  showHelp,
  setMarkers(m) { ui.markers = m; },
  select(ref) { ui.selected = ref; draw(); },
  setView(l) {
    if (['top', 'bottom'].includes(l)) editor.setDrawLayer(l); else ui.layer = 'all';
    syncPalette(); draw();
  },
  zoom(k) {
    if (k === 'in' || k === 'out') zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, k === 'in' ? 1.25 : 0.8);
    else fitView(view, wrap.clientWidth, wrap.clientHeight);
    draw();
  },
  exportFile,
  saveLocal() { store.set('pcbcd.saved', JSON.stringify(doc)); return 'Saved in this browser. Use "load" to restore it.'; },
  loadLocal() {
    const s = store.get('pcbcd.saved');
    if (!s) return 'Nothing saved yet.';
    snapshot(); replaceDoc(JSON.parse(s)); ctx.zoom('fit');
    return `Loaded "${doc.name}".`;
  },
  openFile() { $('#fileInput').click(); },
  runScript,
  askAI: runAI,
};

function run(line, { echo = true } = {}) {
  line = line.trim();
  if (!line) return;
  if (ui.mode === 'ai' && !/^(undo|redo|help)\b/i.test(line)) { runAI(line); return; }
  const parts = splitScript(line);
  if (parts.length > 1) { runScript(parts.join('\n'), null); return; }
  if (echo) log('cmd', line);
  const boardBefore = `${doc.board.w}x${doc.board.h}`;
  try {
    const r = execLine(line, ctx);
    if (r.text) log(/^✖/.test(r.text) ? 'err' : /^Could not|did not fit/.test(r.text) ? 'info' : 'ok', r.text);
    refresh({ keepMarkers: /^(drc|check)\b/i.test(line) });
    if (`${doc.board.w}x${doc.board.h}` !== boardBefore || /^(new|clear)\b/i.test(line)) ctx.zoom('fit');
  } catch (e) {
    if (e.unknown && ai.key) { log('info', 'Not a command — asking the AI…'); runAI(line, { echo: false }); return; }
    log('err', e.message);
  }
}

function runScript(text, label) {
  const lines = splitScript(text);
  if (label) log('info', `Running ${label} (${lines.length} commands)…`);
  snapshot();
  let errors = 0;
  for (const line of lines) {
    log('cmd', line);
    try {
      const r = execLine(line, ctx, { record: false });
      if (r.text) log(/^✖/.test(r.text) ? 'err' : 'ok', r.text);
    } catch (e) { errors++; log('err', e.message); }
  }
  refresh({ keepMarkers: /(^|\n)\s*(drc|check)\s*$/i.test(text) });
  ctx.zoom('fit');
  if (errors) log('err', `${errors} command(s) failed. "undo" reverts the whole batch.`);
  else if (lines.length > 1) log('info', `Done. "undo" reverts the whole batch.`);
}

async function runAI(request, { echo = true } = {}) {
  if (ui.busy) { log('info', 'The AI is still working on the previous request…'); return; }
  if (echo) log('ai cmd', request);
  if (!ai.key) { log('err', 'Add your Anthropic API key first (button "AI settings").'); openAIDialog(); return; }
  ui.busy = true;
  const wait = log('info', 'Thinking…');
  const t0 = performance.now();
  try {
    const r = await askAI(request, ai);
    wait.remove();
    if (r.explanation) log('ai', r.explanation);
    if (r.skipped.length) log('info', `Ignored ${r.skipped.length} unsupported line(s): ${r.skipped.join(' | ')}`);
    if (r.commands.length) runScript(r.commands.join('\n'), `AI plan (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    wait.remove();
    log('err', e.message);
  } finally { ui.busy = false; }
}

// ---------------------------------------------------------------- export
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportFile(kind) {
  const base = (doc.name || 'board').replace(/[^\w-]+/g, '_');
  if (kind === 'gerber' || kind === 'gerbers' || kind === 'zip') {
    if (ui.rats.length) log('info', `Note: ${ui.rats.length} connection(s) are still unrouted.`);
    const files = gerberFiles();
    download(`${base}-gerbers.zip`, makeZip(files));
    log('ok', `Exported ${files.length} files: ${files.map((f) => f[0]).join(', ')}`);
  } else if (kind === 'svg') { download(`${base}.svg`, new Blob([toSVG()], { type: 'image/svg+xml' })); log('ok', 'Exported SVG.'); }
  else if (kind === 'png') { canvas.toBlob((b) => { download(`${base}.png`, b); }); log('ok', 'Exported PNG of the current view.'); }
  else if (kind === 'bom' || kind === 'csv') { download(`${base}-bom.csv`, new Blob([toBOM()], { type: 'text/csv' })); log('ok', 'Exported BOM.'); }
  else if (kind === 'json') { download(`${base}.json`, new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' })); log('ok', 'Exported project JSON.'); }
  else throw new Error('Export what? gerber, svg, png, bom or json');
}

// ---------------------------------------------------------------- help
function showHelp() {
  const groups = helpGroups();
  let html = '<p>Type a command and press Enter. Separate several commands with <code>;</code>. Points are <code>X,Y</code> in mm from the top-left corner; pins are <code>REF.PIN</code> (e.g. <code>U1.8</code>). Switch to <b>AI ✦</b> mode, or start with <code>ai</code>, to ask in plain words.</p>';
  for (const [g, specs] of Object.entries(groups)) {
    html += `<h3>${esc(g)}</h3>`;
    for (const s of specs) html += `<div class="help-cmd"><code>${esc(s.usage)}</code><span>${esc(s.desc)}${s.names.length > 1 ? ' Aliases: ' + esc(s.names.slice(1).join(', ')) : ''}</span></div>`;
  }
  html += '<h3>Drawing with the mouse</h3>'
    + '<div class="help-cmd"><code>S · Select</code><span>Drag parts, track segments or vias. Click a track, then drag its white corner handles. Delete removes the selected part, segment or via. R rotates, F flips. Drag empty space (or right/middle-drag) to pan; the wheel zooms.</span></div>'
    + '<div class="help-cmd"><code>W · Track</code><span>Click a pad to start, click to add corners, click the target pad to finish (or double-click / right-click / Enter). V drops a via and switches layer, / changes the bend style, Backspace removes the last corner, Esc cancels. The preview turns orange when it gets too close to other copper. Drawing between pads also connects them in the netlist.</span></div>'
    + '<div class="help-cmd"><code>V · Via</code><span>Click to place a via; on a track it joins that net.</span></div>'
    + '<div class="help-cmd"><code>L · Layer</code><span>Switch between drawing on the top and bottom copper.</span></div>'
    + '<div class="help-cmd"><span>Every mouse edit is one undo step (Ctrl+Z / Ctrl+Y) and shows up in the console. ↑/↓ recalls earlier commands, Tab completes command names. Mouse and commands can be mixed freely — e.g. autoroute, then fix one track by hand.</span></div>';
  $('#helpBody').innerHTML = html;
  $('#helpDialog').showModal();
}
$('#helpClose').onclick = () => $('#helpDialog').close();

// ---------------------------------------------------------------- AI dialog
function openAIDialog() {
  $('#aiKey').value = ai.key; $('#aiModel').value = ai.model; $('#aiRemember').checked = !!store.get('pcbcd.aiKey');
  $('#aiDialog').showModal();
}
$('#aiBtn').onclick = openAIDialog;
$('#aiDialog').addEventListener('close', () => {
  if ($('#aiDialog').returnValue !== 'save') return;
  ai.key = $('#aiKey').value.trim(); ai.model = $('#aiModel').value;
  store.set('pcbcd.aiModel', ai.model);
  if ($('#aiRemember').checked && ai.key) store.set('pcbcd.aiKey', ai.key); else store.del('pcbcd.aiKey');
  log('info', ai.key ? `AI ready (${ai.model}). Switch to "AI ✦" mode or start a line with "ai".` : 'AI key cleared.');
});

// ---------------------------------------------------------------- input box
const hist = JSON.parse(store.get('pcbcd.history') || '[]');
let hi = hist.length;
$('#cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!v) return;
  if (hist[hist.length - 1] !== v) hist.push(v);
  if (hist.length > 200) hist.shift();
  store.set('pcbcd.history', JSON.stringify(hist));
  hi = hist.length; input.value = '';
  run(v);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && hi > 0) { hi--; input.value = hist[hi]; e.preventDefault(); }
  else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  else if (e.key === 'Tab' && ui.mode === 'cmd') {
    const v = input.value;
    if (!v.includes(' ')) {
      const m = Object.keys(COMMANDS).filter((k) => k.startsWith(v.toLowerCase()));
      if (m.length === 1) { input.value = m[0] + ' '; e.preventDefault(); }
      else if (m.length > 1) { log('info', m.join('  ')); e.preventDefault(); }
    }
  }
});
document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(m) {
  ui.mode = m;
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('#cmdForm').classList.toggle('ai-mode', m === 'ai');
  $('#prompt').textContent = m === 'ai' ? '✦' : '›';
  input.placeholder = m === 'ai' ? 'Describe it… e.g. "5V theke 3.3V regulator banao, caps soho"' : 'add R0805 R1 10k at 10,10';
  input.focus();
  if (m === 'ai' && !ai.key) openAIDialog();
}

// toolbar
document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
  $('#exportMenu').hidden = true; $('#exportBtn').setAttribute('aria-expanded', 'false');
  const prev = ui.mode; ui.mode = 'cmd'; run(b.dataset.cmd); ui.mode = prev;
}));
$('#exportBtn').onclick = (e) => {
  e.stopPropagation();
  const m = $('#exportMenu'); m.hidden = !m.hidden; $('#exportBtn').setAttribute('aria-expanded', String(!m.hidden));
};
document.addEventListener('click', () => { $('#exportMenu').hidden = true; $('#exportBtn').setAttribute('aria-expanded', 'false'); });
$('#layerSel').onchange = (e) => ctx.setView(e.target.value);
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  for (const p of ['console', 'parts', 'nets']) $('#panel-' + p).hidden = p !== t.dataset.tab;
}));
$('#panel-parts').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-ref]'); if (tr) { ui.selected = tr.dataset.ref; draw(); } });
$('#panel-nets').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-net]'); if (tr) { ui.hoverNet = ui.hoverNet === tr.dataset.net ? null : tr.dataset.net; draw(); } });
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.board || !Array.isArray(d.components)) throw new Error('Not a PCB Command Designer project.');
    snapshot(); replaceDoc(d); refresh(); ctx.zoom('fit'); log('ok', `Opened ${f.name}.`);
  } catch (err) { log('err', `Could not open ${f.name}: ${err.message}`); }
  e.target.value = '';
});
logEl.addEventListener('click', (e) => {
  const ex = e.target.closest('.example');
  if (ex) { input.value = ex.dataset.cmd; input.focus(); }
});

// ---------------------------------------------------------------- canvas interaction
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(wrap.clientWidth * dpr); canvas.height = Math.round(wrap.clientHeight * dpr);
  draw();
}
new ResizeObserver(resize).observe(wrap);

function zoomAt(sx, sy, f) {
  const [wx, wy] = toWorld(view, sx, sy);
  view.scale = Math.min(200, Math.max(0.5, view.scale * f));
  view.ox = sx - wx * view.scale; view.oy = sy - wy * view.scale;
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  draw();
}, { passive: false });

function runCmd(line) { const prev = ui.mode; ui.mode = 'cmd'; run(line); ui.mode = prev; }

const editor = createEditor({
  canvas, view, ui, log, refresh, draw, ctx,
  run: runCmd,
  setHud(text) { $('#hud').textContent = text; },
  onToolChange: syncPalette,
});
ui.overlay = editor.overlay;

function syncPalette() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === ui.tool));
  document.querySelectorAll('[data-dl]').forEach((b) => b.classList.toggle('active', b.dataset.dl === ui.drawLayer));
  $('#draftBtns').hidden = !editor.drawing;
  $('#layerSel').value = ui.layer;
  $('#hint').textContent = editor.hint;
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { editor.setTool(b.dataset.tool); canvas.focus(); }));
document.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => {
  if (editor.drawing) { if (b.dataset.dl !== ui.drawLayer) editor.insertVia(); } else editor.setDrawLayer(b.dataset.dl);
  canvas.focus();
}));
$('#finishBtn').onclick = () => { editor.finishDraft(); canvas.focus(); };
$('#cancelBtn').onclick = () => { editor.cancelDraft(); canvas.focus(); };
$('#viaBtn').onclick = () => { editor.insertVia(); canvas.focus(); };

document.addEventListener('keydown', (e) => {
  if (e.target === input || e.target.closest('dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (editor.drawing) editor.cancelDraft(); if (e.shiftKey) redo(); else undo(); refresh(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); refresh(); return; }
  if (mod || e.altKey) return;
  // drawing shortcuts work while the canvas has focus (or a track is being drawn)
  if (document.activeElement === canvas || editor.drawing) {
    if (editor.onKey(e)) { e.preventDefault(); syncPalette(); return; }
  } else if (e.key === 'Escape') { ui.selected = null; ui.markers = null; draw(); return; }
  if (e.key.length === 1 && /[a-z?]/i.test(e.key)) input.focus();
});

// ---------------------------------------------------------------- start
function welcome() {
  const ex = (c) => `<span class="example" data-cmd="${esc(c)}"><code>${esc(c)}</code></span>`;
  log('welcome', `<b>PCB Command Designer</b> — design a board by typing.<br>
Try ${ex('demo')} for a finished 555 blinker, or build one yourself:<br>
${ex('board 60x40')} · ${ex('add R0805 R1 10k at 15,20')} · ${ex('add LED0805 LED1 at 25,20')} · ${ex('connect R1.2 LED1.1')} · ${ex('route')} · ${ex('drc')} · ${ex('export gerber')}<br>
With an API key you can just say what you want: ${ex('ai make a 5V to 3.3V regulator board with input and output headers')}<br>
Prefer the mouse? Pick <b>Track</b> (W) above the board and click pad → pad to draw, or drag parts, tracks and vias in <b>Select</b> mode.<br>
Type ${ex('help')} for every command, ${ex('footprints')} for the parts library.`, true);
}

const saved = store.get('pcbcd.autosave');
if (saved) { try { replaceDoc(JSON.parse(saved)); } catch { /* ignore broken autosave */ } }
welcome();
if (saved && doc.components.length) log('info', `Restored your last design "${doc.name}" (${doc.components.length} parts). Type "new" to start over.`);
resize();
fitView(view, wrap.clientWidth, wrap.clientHeight);
refresh();
syncPalette();
input.focus();
window.pcb = { doc, view, run: runCmd }; // handy for scripting from the browser console
