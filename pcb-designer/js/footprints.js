// Footprint library. Coordinates in mm, origin at the footprint centre, y grows downward.
// pad: { num, x, y, w, h, shape: 'rect' | 'round' | 'oval', drill? }  (drill => through-hole)
// silk: array of polylines [[x,y], ...]
import { circlePoly } from './geometry.js';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const line = (x0, y0, x1, y1) => [[x0, y0], [x1, y1]];

function chip(pitch, w, h, opts = {}) {
  const pads = [
    { num: '1', x: -pitch / 2, y: 0, w, h, shape: 'rect' },
    { num: '2', x: pitch / 2, y: 0, w, h, shape: 'rect' },
  ];
  const sx = pitch / 2 + w / 2 + 0.25, sy = h / 2 + 0.25;
  const silk = [line(-sx + w + 0.1, -sy, sx - w - 0.1, -sy), line(-sx + w + 0.1, sy, sx - w - 0.1, sy)];
  if (opts.polar) {
    // cathode (pin 2) marker bar
    silk.push(line(sx, -sy, sx, sy));
    silk.push(rect(-sx, -sy, sx, sy));
  }
  return { pads, silk };
}

function tht2(pitch, pad, drill, body) {
  const pads = [
    { num: '1', x: -pitch / 2, y: 0, w: pad, h: pad, shape: 'rect', drill },
    { num: '2', x: pitch / 2, y: 0, w: pad, h: pad, shape: 'round', drill },
  ];
  return { pads, silk: body || [] };
}

function dip(n) {
  const half = n / 2, pads = [];
  for (let i = 0; i < half; i++) {
    const y = (i - (half - 1) / 2) * 2.54;
    pads.push({ num: String(i + 1), x: -3.81, y, w: 1.6, h: 1.6, shape: i === 0 ? 'rect' : 'round', drill: 0.8 });
  }
  for (let i = 0; i < half; i++) {
    const y = ((half - 1) / 2 - i) * 2.54;
    pads.push({ num: String(half + i + 1), x: 3.81, y, w: 1.6, h: 1.6, shape: 'round', drill: 0.8 });
  }
  const sy = (half * 2.54) / 2 + 0.3;
  const silk = [rect(-2.6, -sy, 2.6, sy), circlePoly(0, -sy, 0.7, 12, 0, 180)];
  return { pads, silk };
}

function soic(n) {
  const half = n / 2, pads = [];
  for (let i = 0; i < half; i++) {
    const y = (i - (half - 1) / 2) * 1.27;
    pads.push({ num: String(i + 1), x: -2.7, y, w: 1.55, h: 0.6, shape: 'rect' });
  }
  for (let i = 0; i < half; i++) {
    const y = ((half - 1) / 2 - i) * 1.27;
    pads.push({ num: String(half + i + 1), x: 2.7, y, w: 1.55, h: 0.6, shape: 'rect' });
  }
  const sy = (half * 1.27) / 2 + 0.2;
  const y1 = pads[0].y;
  return { pads, silk: [rect(-1.95, -sy, 1.95, sy), circlePoly(-3.9, y1, 0.2, 8)] };
}

function header(rows, cols) {
  const pads = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const num = rows === 1 ? c + 1 : c * 2 + r + 1;
      const x = (c - (cols - 1) / 2) * 2.54;
      const y = rows === 1 ? 0 : (r - 0.5) * 2.54;
      pads.push({ num: String(num), x, y, w: 1.7, h: 1.7, shape: num === 1 ? 'rect' : 'round', drill: 1.0 });
    }
  }
  const sx = (cols * 2.54) / 2, sy = (rows * 2.54) / 2;
  return { pads, silk: [rect(-sx, -sy, sx, sy)] };
}

function terminal(n) {
  const pads = [];
  for (let i = 0; i < n; i++) {
    pads.push({ num: String(i + 1), x: (i - (n - 1) / 2) * 5.08, y: 0, w: 2.6, h: 2.6, shape: i === 0 ? 'rect' : 'round', drill: 1.3 });
  }
  const sx = (n * 5.08) / 2;
  return { pads, silk: [rect(-sx, -4, sx, 4), line(-sx, 2.5, sx, 2.5)] };
}

const FIXED = {
  R0402: () => chip(1.0, 0.6, 0.6),
  R0603: () => chip(1.6, 0.9, 0.95),
  R0805: () => chip(1.9, 1.0, 1.3),
  R1206: () => chip(3.0, 1.2, 1.8),
  C0402: () => chip(1.0, 0.6, 0.6),
  C0603: () => chip(1.6, 0.9, 0.95),
  C0805: () => chip(1.9, 1.0, 1.3),
  C1206: () => chip(3.0, 1.2, 1.8),
  L0805: () => chip(1.9, 1.0, 1.3),
  LED0603: () => chip(1.6, 0.9, 0.95, { polar: true }),
  LED0805: () => chip(1.9, 1.0, 1.3, { polar: true }),
  SOD123: () => chip(3.3, 0.9, 1.2, { polar: true }),
  AXIAL: () => tht2(10.16, 1.8, 0.9, [rect(-3.15, -1.25, 3.15, 1.25), line(-5.08 + 1, 0, -3.15, 0), line(3.15, 0, 5.08 - 1, 0)]),
  DO41: () => tht2(10.16, 2.0, 1.0, [rect(-2.6, -1.35, 2.6, 1.35), line(1.8, -1.35, 1.8, 1.35), line(-5.08 + 1.1, 0, -2.6, 0), line(2.6, 0, 5.08 - 1.1, 0)]),
  LED_3MM: () => tht2(2.54, 1.8, 0.9, [circlePoly(0, 0, 1.9, 28, -150, 150)]),
  LED_5MM: () => tht2(2.54, 1.8, 0.9, [circlePoly(0, 0, 2.9, 32, -150, 150)]),
  CAP_RADIAL5: () => tht2(2.0, 1.6, 0.8, [circlePoly(0, 0, 2.5, 32)]),
  CP_RADIAL5: () => tht2(2.0, 1.6, 0.8, [circlePoly(0, 0, 2.5, 32), line(-2.6, -2.2, -1.6, -2.2), line(-2.1, -2.7, -2.1, -1.7)]),
  CP_RADIAL8: () => tht2(3.5, 1.8, 0.9, [circlePoly(0, 0, 4.0, 40), line(-4.1, -3.4, -3.1, -3.4), line(-3.6, -3.9, -3.6, -2.9)]),
  CAP_DISC: () => tht2(5.08, 1.6, 0.8, [rect(-3.5, -1.3, 3.5, 1.3)]),
  HC49: () => tht2(4.88, 1.5, 0.8, [rect(-5.5, -2.3, 5.5, 2.3)]),
  TACT_6MM: () => ({
    pads: [
      { num: '1', x: -3.25, y: -2.25, w: 2, h: 2, shape: 'rect', drill: 1.1 },
      { num: '2', x: 3.25, y: -2.25, w: 2, h: 2, shape: 'round', drill: 1.1 },
      { num: '3', x: -3.25, y: 2.25, w: 2, h: 2, shape: 'round', drill: 1.1 },
      { num: '4', x: 3.25, y: 2.25, w: 2, h: 2, shape: 'round', drill: 1.1 },
    ],
    silk: [rect(-3, -3, 3, 3), circlePoly(0, 0, 1.7, 24)],
  }),
  SOT23: () => ({
    pads: [
      { num: '1', x: -0.95, y: 1.05, w: 0.8, h: 0.9, shape: 'rect' },
      { num: '2', x: 0.95, y: 1.05, w: 0.8, h: 0.9, shape: 'rect' },
      { num: '3', x: 0, y: -1.05, w: 0.8, h: 0.9, shape: 'rect' },
    ],
    silk: [line(-1.5, -0.7, -0.6, -0.7), line(0.6, -0.7, 1.5, -0.7), line(-1.5, -0.7, -1.5, 0.3), line(1.5, -0.7, 1.5, 0.3)],
  }),
  TO92: () => ({
    pads: [
      { num: '1', x: -1.27, y: 0, w: 1.3, h: 1.3, shape: 'rect', drill: 0.75 },
      { num: '2', x: 0, y: 0, w: 1.3, h: 1.3, shape: 'round', drill: 0.75 },
      { num: '3', x: 1.27, y: 0, w: 1.3, h: 1.3, shape: 'round', drill: 0.75 },
    ],
    silk: [circlePoly(0, 0, 2.5, 28, 200, 340), line(-2.35, 0.85, 2.35, 0.85)],
  }),
  TO220: () => ({
    pads: [
      { num: '1', x: -2.54, y: 0, w: 1.9, h: 2.6, shape: 'rect', drill: 1.1 },
      { num: '2', x: 0, y: 0, w: 1.9, h: 2.6, shape: 'oval', drill: 1.1 },
      { num: '3', x: 2.54, y: 0, w: 1.9, h: 2.6, shape: 'oval', drill: 1.1 },
    ],
    silk: [rect(-5.2, -3.2, 5.2, 1.8), line(-5.2, -2.0, 5.2, -2.0)],
  }),
};

export const ALIASES = {
  RESISTOR: 'R0805', RES: 'R0805', R: 'R0805',
  CAPACITOR: 'C0805', CAP: 'C0805', C: 'C0805',
  ELECTROLYTIC: 'CP_RADIAL5', ECAP: 'CP_RADIAL5',
  INDUCTOR: 'L0805',
  LED: 'LED0805',
  DIODE: 'SOD123',
  BUTTON: 'TACT_6MM', SWITCH: 'TACT_6MM',
  CRYSTAL: 'HC49',
  TRANSISTOR: 'SOT23', MOSFET: 'SOT23',
  REGULATOR: 'TO220',
  HEADER: 'HDR1X2',
};

export const FOOTPRINT_NAMES = [
  ...Object.keys(FIXED),
  'DIP4..DIP40', 'SOIC8..SOIC28', 'HDR1X1..HDR1X40', 'HDR2X2..HDR2X40', 'TERM2..TERM8',
];

export function normalizeFootprint(name) {
  const up = String(name).toUpperCase().replace(/-/g, '_');
  return ALIASES[up] || up;
}

const cache = new Map();

export function getFootprint(name) {
  const key = normalizeFootprint(name);
  if (cache.has(key)) return cache.get(key);
  let fp = null, m;
  if (FIXED[key]) fp = FIXED[key]();
  else if ((m = key.match(/^DIP(\d+)$/)) && +m[1] >= 4 && +m[1] <= 64 && +m[1] % 2 === 0) fp = dip(+m[1]);
  else if ((m = key.match(/^SOIC(\d+)$/)) && +m[1] >= 4 && +m[1] <= 40 && +m[1] % 2 === 0) fp = soic(+m[1]);
  else if ((m = key.match(/^HDR([12])X(\d+)$/)) && +m[2] >= 1 && +m[2] <= 40) fp = header(+m[1], +m[2]);
  else if ((m = key.match(/^TERM(\d+)$/)) && +m[1] >= 2 && +m[1] <= 12) fp = terminal(+m[1]);
  if (!fp) return null;
  fp.name = key;
  // courtyard = bbox of pads + silk, plus margin
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of fp.pads) {
    x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2);
    y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2);
  }
  for (const pl of fp.silk) for (const [x, y] of pl) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  fp.court = [x0 - 0.25, y0 - 0.25, x1 + 0.25, y1 + 0.25];
  fp.tht = fp.pads.some((p) => p.drill);
  cache.set(key, fp);
  return fp;
}

export function refPrefix(fpName) {
  const k = normalizeFootprint(fpName);
  if (/^R\d|^AXIAL/.test(k)) return 'R';
  if (/^C\d|^CAP|^CP_/.test(k)) return 'C';
  if (/^L\d/.test(k)) return 'L';
  if (/^LED/.test(k)) return 'LED';
  if (/^SOD|^DO41/.test(k)) return 'D';
  if (/^SOT|^TO92/.test(k)) return 'Q';
  if (/^HDR|^TERM/.test(k)) return 'J';
  if (/^TACT/.test(k)) return 'SW';
  if (/^HC49/.test(k)) return 'Y';
  return 'U';
}

// Pin conventions shared with the help text and the AI prompt.
export const PIN_NOTES = [
  'Two-pin parts (R, C, L): pins 1 and 2.',
  'LED*, SOD123, DO41, LED_3MM/5MM: pin 1 = anode (A), pin 2 = cathode (K).',
  'CP_RADIAL*: pin 1 = +, pin 2 = -.',
  'SOT23: 1 = base/gate, 2 = emitter/source, 3 = collector/drain (pin 3 is the single pin on top).',
  'TO92: pins 1-2-3 left to right. TO220 regulator (78xx): 1 = IN, 2 = GND, 3 = OUT.',
  'DIPn/SOICn: pin 1 top-left, counting down the left side then up the right side.',
  'HDR1xN: pins 1..N left to right. HDR2xN: odd pins top row, even pins bottom row.',
  'TACT_6MM: pins 1-2 are always connected, pins 3-4 are always connected; pressing joins the pairs.',
];
