// PreToolUse hook for Read: while the local model is up, turn away a whole-file read of a large text file once per
// session and point the model at shunt. Reads with offset/limit, small, binary, image or PDF files, a repeated
// attempt on the same file and any error all pass through (no output, exit 0). LLM_HARNESS_SHUNT=off disables it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessHome, loadConfig, resolveBackend, appendLog } from '../lib/backend.mjs';
import { readStdinJson } from '../lib/io.mjs';

const SHUNT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shunt', 'shunt.mjs').replace(/\\/g, '/');
const SKIP_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb|zip|gz|tgz|7z|rar|exe|dll|so|dylib|bin|gguf|safetensors|onnx|pt)$/i;
const SEEN_TTL_MS = 2 * 24 * 3600 * 1000;

function seenStore(sessionId) {
  const dir = path.join(harnessHome(), 'cache');
  const file = path.join(dir, `shunt-seen-${String(sessionId || 'nosession').replace(/[^\w-]/g, '')}.json`);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first deny in this session */ }
  return {
    has: (k) => list.includes(k),
    add: (k) => {
      list.push(k);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(list));
      // drop stores of old sessions
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (f.startsWith('shunt-seen-') && Date.now() - fs.statSync(p).mtimeMs > SEEN_TTL_MS) fs.rmSync(p, { force: true });
      }
    },
  };
}

function isBinaryFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)).includes(0);
  } finally { fs.closeSync(fd); }
}

async function decide() {
  if (process.env.LLM_HARNESS_SHUNT === 'off') return null;
  const input = await readStdinJson();
  const ti = input.tool_input ?? {};
  const file = ti.file_path;
  if (input.tool_name !== 'Read' || !file || ti.offset != null || ti.limit != null || ti.pages != null || SKIP_EXT.test(file)) return null;

  const cfg = loadConfig();
  const threshold = (cfg.shunt?.readThresholdKB ?? 128) * 1024;
  const st = fs.statSync(file);
  if (!st.isFile() || st.size < threshold || isBinaryFile(file)) return null;

  const key = path.resolve(file).toLowerCase();
  const seen = seenStore(input.session_id);
  if (seen.has(key)) return null;
  if (!(await resolveBackend()).ok) return null;
  seen.add(key);

  const kb = Math.round(st.size / 1024);
  const f = file.replace(/\\/g, '/');
  appendLog('hooks.jsonl', { event: 'PreToolUse:Read', action: 'deny', file: f, sizeKB: kb, session_id: input.session_id });
  return `${path.basename(file)} is ${kb} KB. The local model can read it and answer a specific question, which keeps this context small: ` +
    `node "${SHUNT}" read "<question>" "${f}" (for a log: node "${SHUNT}" logs "<question>" "${f}"). ` +
    'Or Read a part of it with offset/limit. Reading the whole file again is allowed if it is really needed.';
}

try {
  const reason = await decide();
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
} catch { /* fail open: let the read through */ }
process.exit(0);
