// AI assistant: turns plain-language requests into designer commands using the Claude API.
// Runs fully in the browser with the user's own API key (stored only in this browser).
import { doc, allPads } from './state.js';
import { COMMANDS, helpGroups } from './commands.js';
import { FOOTPRINT_NAMES, PIN_NOTES } from './footprints.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.2.0/+esm';
export const DEFAULT_MODEL = 'claude-opus-5-5';

let SDK = null;
const history = []; // append-only conversation (keeps follow-up requests in context)

export function resetAIHistory() { history.length = 0; }

function commandReference() {
  const lines = [];
  for (const [group, specs] of Object.entries(helpGroups())) {
    if (group === 'AI' || group === 'Files' || group === 'View') continue;
    lines.push(`# ${group}`);
    for (const s of specs) if (!['help', 'demo', 'undo', 'redo'].includes(s.names[0])) lines.push(`${s.usage}  — ${s.desc}`);
  }
  return lines.join('\n');
}

function systemPrompt() {
  return `You are the design engine inside "PCB Command Designer", a browser PCB layout tool controlled by text commands (similar to EasyEDA, but command driven).
The user describes what they want in plain language (often English, Bangla or Banglish). You reply with the exact commands that make it happen, plus a short explanation in the user's language.

Coordinates are millimetres. Origin (0,0) is the top-left corner of the board; x grows right, y grows down. Pins are written REF.PIN, e.g. R1.2 or U1.8.

COMMANDS
${commandReference()}

FOOTPRINT LIBRARY
${FOOTPRINT_NAMES.join(', ')}
Pin conventions:
${PIN_NOTES.map((n) => '- ' + n).join('\n')}

HOW TO WORK
- Output only commands from the list above, one command per array item, no comments, no numbering.
- Prefer named nets (VCC, GND, 3V3, OUT ...) using "net NAME pins..."; use "connect" for simple one-off links.
- When creating a circuit: set a sensible board size first, place every part with explicit "at X,Y" coordinates, keep parts at least 2 mm apart and 3 mm from the board edge, place connected parts near each other, keep decoupling capacitors next to the IC power pins, and orient parts so their connected pins face each other.
- Use real, correct circuits: check datasheet pinouts (e.g. NE555: 1 GND, 2 TRIG, 3 OUT, 4 RESET, 5 CTRL, 6 THR, 7 DIS, 8 VCC; LM7805 TO220: 1 IN, 2 GND, 3 OUT; AMS1117 is not in the library, use TO220 with the same 1 IN/2 GND/3 OUT mapping or say so).
- Use wider tracks for power nets (e.g. "width GND 0.6") before routing.
- End a full design with "route" then "drc". For small edits, only route if the user asks or the edit changes connections that were already routed.
- Only refer to parts and pins that exist (see the current design) or that your own commands create earlier in the list.
- If the request is unclear or impossible with this tool, return an empty command list and explain why in the explanation.`;
}

function designSummary() {
  const pads = allPads();
  const lines = [`Board: ${doc.board.w} x ${doc.board.h} mm, grid ${doc.grid}. Name: ${doc.name}.`];
  lines.push(`Rules: clearance ${doc.rules.clearance}, width ${doc.rules.width}, via ${doc.rules.viaDia}/${doc.rules.viaDrill}.`);
  if (!doc.components.length) lines.push('Parts: none (empty board).');
  else {
    lines.push('Parts:');
    for (const c of doc.components) {
      const pins = pads.filter((p) => p.comp === c).map((p) => `${p.pad.num}@${p.x.toFixed(1)},${p.y.toFixed(1)}${p.net ? '=' + p.net : ''}`).join(' ');
      lines.push(`- ${c.ref} ${c.fp} "${c.value || ''}" at ${c.x},${c.y} rot ${c.rot || 0} ${c.side || 'top'} | pins ${pins}`);
    }
  }
  const nets = Object.entries(doc.nets);
  if (nets.length) lines.push('Nets:', ...nets.map(([n, p]) => `- ${n}: ${p.join(' ')}`));
  lines.push(`Tracks: ${doc.tracks.length}, vias: ${doc.vias.length}, holes: ${doc.holes.length}, texts: ${doc.texts.length}.`);
  return lines.join('\n');
}

const SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'Short explanation for the user, in their language.' },
    commands: { type: 'array', items: { type: 'string' }, description: 'Commands to run, in order.' },
  },
  required: ['explanation', 'commands'],
  additionalProperties: false,
};

export async function askAI(request, { apiKey, model }) {
  if (!apiKey) throw new Error('No API key yet. Click "AI settings" and paste your Anthropic API key.');
  if (!SDK) {
    try { SDK = await import(SDK_URL); }
    catch (e) { throw new Error(`Could not load the Anthropic SDK from the CDN (${e.message}). Check your internet connection.`); }
  }
  const Anthropic = SDK.default || SDK.Anthropic;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const userMsg = { role: 'user', content: `CURRENT DESIGN\n${designSummary()}\n\nREQUEST\n${request}` };
  const messages = [...history, userMsg];

  let resp;
  try {
    resp = await client.beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: systemPrompt(),
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages,
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('The API key was rejected. Check it in "AI settings".');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the API — wait a moment and try again.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Claude API. Check your connection.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }

  if (resp.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (resp.stop_reason === 'max_tokens') throw new Error('The answer was too long — try asking for a smaller step.');
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('The AI reply was not valid JSON. Please try again.'); }
  history.push(userMsg, { role: 'assistant', content: resp.content });
  const valid = [], skipped = [];
  for (const c of out.commands || []) {
    const name = String(c).trim().split(/\s+/)[0]?.toLowerCase();
    if (COMMANDS[name] && !['ai', 'ask', 'open', 'export', 'demo'].includes(name)) valid.push(String(c).trim());
    else if (c.trim()) skipped.push(c);
  }
  return { explanation: out.explanation || '', commands: valid, skipped, model: resp.model };
}
