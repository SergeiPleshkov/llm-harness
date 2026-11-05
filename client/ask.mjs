#!/usr/bin/env node
// ask: one-shot question to the local Qwen on the desktop, streamed to the terminal. When the desktop model is
// unreachable it falls back to `claude -p --model haiku`. Self-contained (Node 18+, no dependencies): copy this file.
//   ask "question"
//   cat file | ask "summarize this"        piped input goes before the question
//   ask --image shot.png "what is wrong here?"
//   options: --think (reason first), --claude (skip the local model), --system "<text>"
// Config: ~/.llm-harness/client.json {"url", "model", "keyFile" | "keyCommand"}; ASK_URL / ASK_KEY override it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const CONFIG = path.join(os.homedir(), '.llm-harness', 'client.json');
const DEFAULTS = { url: 'http://127.0.0.1:8080', model: 'qwen3.8-27b', fallbackModel: 'haiku', probeTimeoutMs: 3000 };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* defaults */ }
  const cfg = { ...DEFAULTS, ...c };
  if (process.env.ASK_URL) cfg.url = process.env.ASK_URL;
  return cfg;
}

function readKey(cfg) {
  if (process.env.ASK_KEY) return process.env.ASK_KEY.trim();
  if (cfg.keyCommand) return execSync(cfg.keyCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (cfg.keyFile) return fs.readFileSync(cfg.keyFile.replace(/^~/, os.homedir()), 'utf8').split(/\r?\n/)[0].trim();
  return '';
}

function parseArgs(argv) {
  const o = { think: false, claude: false, image: null, system: null, words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--think') o.think = true;
    else if (a === '--claude') o.claude = true;
    else if (a === '--image') o.image = argv[++i];
    else if (a === '--system') o.system = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else o.words.push(a);
  }
  return o;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

// Returns null when the local model answered, otherwise the reason to fall back.
async function askLocal(cfg, messages, think) {
  let key;
  try { key = readKey(cfg); } catch (e) { return `no key (${e.message.split('\n')[0]})`; }
  const headers = { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  try {
    const h = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(cfg.probeTimeoutMs) });
    if (!h.ok) return h.status === 503 ? 'model loading' : `health HTTP ${h.status}`;
  } catch (e) { return e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.cause?.errors?.[0]?.code || 'down'); }

  let r;
  try {
    r = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: 'POST', headers, signal: AbortSignal.timeout(15 * 60000),
      body: JSON.stringify({ model: cfg.model, messages, stream: true, chat_template_kwargs: { enable_thinking: think } }),
    });
  } catch (e) { return e.cause?.code || e.message; }
  if (r.status === 401 || r.status === 403) return 'unauthorized: check the API key';
  if (!r.ok) return `HTTP ${r.status}`;

  const dec = new TextDecoder();
  let buf = '', wrote = false;
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const text = JSON.parse(data).choices?.[0]?.delta?.content;
        if (text) { process.stdout.write(text); wrote = true; }
      }
    }
  } catch (e) {
    if (!wrote) return `stream failed (${e.message})`;
    process.stderr.write(`\n[ask: stream interrupted: ${e.message}]\n`);
  }
  process.stdout.write('\n');
  return null;
}

// Known install locations first (a fresh install may not be on PATH yet), then PATH.
function claudeBin() {
  if (process.env.ASK_CLAUDE) return process.env.ASK_CLAUDE;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'), path.join(home, '.local', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find((c) => fs.existsSync(c)) || 'claude';
}

function askClaude(cfg, prompt, reason) {
  process.stderr.write(`[ask: local model unavailable (${reason}); answering with Claude ${cfg.fallbackModel}]\n`);
  const bin = claudeBin();
  const [cmd, args] = /\.m?js$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
  return new Promise((resolve) => {
    const c = spawn(cmd, [...args, '-p', '--model', cfg.fallbackModel], { stdio: ['pipe', 'inherit', 'inherit'] });
    c.on('error', (e) => { process.stderr.write(`ask: cannot start claude: ${e.message}\n`); resolve(1); });
    c.on('close', (code) => resolve(code ?? 1));
    c.stdin.end(prompt);
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const question = o.words.join(' ').trim();
  if (o.help || (!question && process.stdin.isTTY)) {
    console.log('usage: ask [--think] [--claude] [--image file] [--system text] "question"   (stdin is sent before the question)');
    return o.help ? 0 : 2;
  }
  const cfg = loadConfig();
  const piped = await readStdin();
  const text = [piped.trimEnd(), question].filter(Boolean).join('\n\n');

  const messages = [];
  if (o.system) messages.push({ role: 'system', content: o.system });
  if (o.image) {
    const mime = MIME[path.extname(o.image).toLowerCase()];
    if (!mime) { console.error(`ask: unsupported image type: ${o.image}`); return 2; }
    const data = fs.readFileSync(o.image).toString('base64');
    messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }, { type: 'text', text }] });
  } else {
    messages.push({ role: 'user', content: text });
  }

  const reason = o.claude ? 'skipped with --claude' : await askLocal(cfg, messages, o.think);
  if (reason === null) return 0;
  if (o.image) { console.error(`ask: local model unavailable (${reason}); image questions need it`); return 1; }
  return askClaude(cfg, o.system ? `${o.system}\n\n${text}` : text, reason);
}

process.exitCode = await main();
