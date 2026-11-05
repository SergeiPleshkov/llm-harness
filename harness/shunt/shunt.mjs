// shunt: hand a large reading job to the local Qwen and get a short answer back, so the planning model does not
// spend its context on raw files. File contents travel in the request body, never on the command line.
//   node shunt.mjs read "<question>" <file|dir|glob>...   answer a question about files, citing path:line
//   node shunt.mjs logs "<question>" <file|->              digest a log file (or stdin)
//   node shunt.mjs vision "<question>" <image>             answer a question about an image
//   options: --think (let the model reason first: slower, better for root-cause questions)
// Exit codes: 0 answered, 2 usage or input error, 3 local model unavailable (do the work yourself).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveBackend, readKey, appendLog } from '../lib/backend.mjs';
import { isMain } from '../lib/io.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const LOG_SIGNAL = /error|exception|fail|fatal|panic|traceback|critical|warn|denied|refused|timeout/i;
const DEFAULT_BUDGET = 320_000; // characters of input, roughly 90-100k tokens: fits one 128k slot with room to answer

const SYSTEM = [
  'You read material on behalf of another AI model that cannot see it and will act on your answer.',
  'Answer the question precisely and tersely. Cite evidence as path:line (line numbers are given at the start of each line).',
  'If the material does not contain the answer, say so plainly. Never invent code, values or line numbers.',
  'Keep the answer under about 300 words unless the question asks for a full list.',
].join(' ');

const isBinary = (buf) => buf.subarray(0, 4096).includes(0);

export function collectFiles(args, cwd = process.cwd()) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) if (!SKIP_DIRS.has(e)) walk(path.join(p, e));
    } else if (st.isFile()) out.push(p);
  };
  for (const a of args) {
    const abs = path.resolve(cwd, a);
    if (fs.existsSync(abs)) { walk(abs); continue; }
    const matches = fs.globSync(a.replace(/\\/g, '/'), { cwd });
    if (!matches.length) throw new Error(`no such file or pattern: ${a}`);
    for (const m of matches) walk(path.resolve(cwd, m));
  }
  return [...new Set(out)];
}

const numbered = (text, from = 1) => text.replace(/\r\n/g, '\n').split('\n').map((l, i) => `${from + i}| ${l}`).join('\n');

// Files in order until the budget is used; the last one may be cut, the rest are listed as skipped.
export function buildReadInput(files, budget = DEFAULT_BUDGET, cwd = process.cwd()) {
  const parts = [], skipped = [], truncated = [];
  let used = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const rel = path.relative(cwd, f).replace(/\\/g, '/') || f;
    if (isBinary(buf)) { skipped.push(`${rel} (binary)`); continue; }
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    let body = numbered(lines.join('\n'));
    const header = `=== ${rel} (${lines.length} lines) ===\n`;
    if (used + header.length + body.length > budget) {
      const room = budget - used - header.length;
      if (room < 2000) { skipped.push(`${rel} (over budget)`); continue; }
      body = body.slice(0, room);
      body = body.slice(0, body.lastIndexOf('\n')) + `\n[... truncated: file continues to line ${lines.length}]`;
      truncated.push(rel);
    }
    parts.push(header + body);
    used += header.length + body.length;
  }
  return { text: parts.join('\n\n'), skipped, truncated, files: parts.length };
}

// Whole log when it fits; otherwise the head, the tail and every signal line in between, with original line numbers.
export function buildLogInput(text, budget = DEFAULT_BUDGET) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const full = numbered(lines.join('\n'));
  if (full.length <= budget) return { text: full, reduced: false, lines: lines.length };
  const keep = new Set();
  for (let i = 0; i < Math.min(100, lines.length); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - 400); i < lines.length; i++) keep.add(i);
  for (let i = 0; i < lines.length; i++) if (LOG_SIGNAL.test(lines[i])) keep.add(i);
  const idx = [...keep].sort((a, b) => a - b);
  const out = [];
  let used = 0, prev = -1;
  for (const i of idx) {
    if (prev >= 0 && i > prev + 1) out.push(`[... ${i - prev - 1} lines omitted]`);
    const l = `${i + 1}| ${lines[i]}`;
    if (used + l.length > budget) { out.push('[... budget reached, remaining signal lines omitted]'); break; }
    out.push(l); used += l.length + 1; prev = i;
  }
  return { text: out.join('\n'), reduced: true, lines: lines.length };
}

export async function ask(endpoint, messages, { think = false, maxTokens = 1500, timeoutMs = 300000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const key = readKey(endpoint);
    const r = await fetch(`${endpoint.url}/v1/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: endpoint.model, messages, max_tokens: maxTokens, temperature: think ? 0.6 : 0.2,
        chat_template_kwargs: { enable_thinking: think } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    return { answer: (j.choices?.[0]?.message?.content ?? '').trim(), inTokens: j.usage?.prompt_tokens, outTokens: j.usage?.completion_tokens };
  } finally { clearTimeout(timer); }
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

export async function main(argv) {
  const think = argv.includes('--think');
  const [mode, question, ...targets] = argv.filter((a) => a !== '--think');
  if (!['read', 'logs', 'vision'].includes(mode) || !question || !targets.length) {
    console.error('usage: shunt.mjs read|logs|vision "<question>" <targets...> [--think]');
    return 2;
  }
  const b = await resolveBackend();
  if (!b.ok) { console.error(`shunt: local model unavailable (${b.reason}); read the material yourself`); return 3; }
  const cfg = loadConfig();
  const endpoint = { ...cfg.endpoints.find((e) => e.url === b.url), ...b };
  const budget = cfg.shunt?.maxInputChars ?? DEFAULT_BUDGET;

  let content, note = '', count = 0;
  try {
    if (mode === 'read') {
      const r = buildReadInput(collectFiles(targets), budget);
      if (!r.files) throw new Error(`nothing readable: ${r.skipped.join(', ')}`);
      content = `Question: ${question}\n\n${r.text}`;
      count = r.files;
      if (r.truncated.length || r.skipped.length) note = ` | cut: ${r.truncated.join(', ') || '-'} | skipped: ${r.skipped.join(', ') || '-'}`;
    } else if (mode === 'logs') {
      const text = targets[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(targets[0], 'utf8');
      const r = buildLogInput(text, budget);
      content = `Question: ${question}\n\nLog (${r.lines} lines${r.reduced ? ', reduced to head, tail and error/warning lines' : ''}):\n${r.text}`;
      count = 1;
      if (r.reduced) note = ' | log reduced to head, tail and signal lines';
    } else {
      const file = targets[0], mime = MIME[path.extname(file).toLowerCase()];
      if (!mime) throw new Error(`unsupported image type: ${file}`);
      const data = fs.readFileSync(file).toString('base64');
      content = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }, { type: 'text', text: question }];
      count = 1;
    }
  } catch (e) { console.error(`shunt: ${e.message}`); return 2; }

  const started = Date.now();
  let res;
  try {
    res = await ask(endpoint, [{ role: 'system', content: SYSTEM }, { role: 'user', content }], { think });
  } catch (e) {
    console.error(`shunt: request to the local model failed (${e.name === 'AbortError' ? 'timeout' : e.message}); read the material yourself`);
    appendLog('shunt.jsonl', { mode, ok: false, error: e.message });
    return 3;
  }
  const ms = Date.now() - started;
  appendLog('shunt.jsonl', { mode, ok: true, files: count, inTokens: res.inTokens, outTokens: res.outTokens, ms });
  process.stdout.write(`${res.answer}\n\n[shunt ${mode}: ${endpoint.model}, ${count} file(s), ${res.inTokens ?? '?'} tokens in, ${res.outTokens ?? '?'} out, ${(ms / 1000).toFixed(1)} s${note}]\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
