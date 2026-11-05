// SessionStart hook: tells the session whether the local model is reachable (on this PC or on the desktop over
// Tailscale) and, while it is, adds the delegation policy from delegation-policy.md. Logs the check to
// ~/.llm-harness/logs/hooks.jsonl. Always exits 0 so it can never block a session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBackend, loadConfig, appendLog } from '../lib/backend.mjs';
import { readStdinJson } from '../lib/io.mjs';

const POLICY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'delegation-policy.md');

function where(url) {
  try {
    const host = new URL(url).hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return 'on this PC';
  } catch { /* fall through */ }
  return "on the user's desktop PC, reached over Tailscale";
}

try {
  const input = await readStdinJson();
  const b = await resolveBackend({ useCache: false });
  appendLog('hooks.jsonl', {
    event: 'SessionStart', source: input.source, session_id: input.session_id, cwd: input.cwd,
    ok: b.ok, reason: b.reason, latencyMs: b.latencyMs,
  });
  let context;
  if (b.ok) {
    let policy = '';
    try { policy = fs.readFileSync(POLICY, 'utf8').trim(); } catch { /* no policy file: status only */ }
    context = `Local model ${b.model} is running ${where(b.url)} (llama.cpp, OpenAI-compatible API at ${b.url}/v1).`
      + (policy ? `\n\n${policy}` : '');
  } else {
    const url = loadConfig().endpoints[0]?.url;
    context = `The local model (${url ? where(url) : 'not configured'}) is not reachable right now (${b.reason}). `
      + 'Do the work yourself; qexec would fall back to Claude Sonnet, so use it only if the user asks.';
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
} catch { /* never block session start */ }
process.exit(0);
