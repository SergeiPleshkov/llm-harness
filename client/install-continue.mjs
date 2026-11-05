#!/usr/bin/env node
// install-continue: points the Continue extension (VS Code, Cursor) at the desktop's Qwen for chat, edit and apply.
// Writes ~/.continue/config.yaml (the old one is backed up) and puts the API key into ~/.continue/.env
// (LLM_HARNESS_KEY, readable only by you); the config refers to it as ${{ secrets.LLM_HARNESS_KEY }}.
// URL and key source come from ~/.llm-harness/client.json (written by install-mac.sh), so on the laptop:
//   node client/install-continue.mjs                    (or --url http://<desktop-tailscale-ip>:8080 --key-file <path>)
// Options: --url <server>, --key-file <path>, --inline-key (key in config.yaml if Continue does not resolve secrets).
// Autocomplete is left to the editor (Cursor Tab, Copilot): a 27B model over the network is too slow for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SECRET = 'LLM_HARNESS_KEY';

function readKey(src) {
  if (src.keyCommand) return execSync(src.keyCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (src.keyFile) return fs.readFileSync(src.keyFile.replace(/^~/, os.homedir()), 'utf8').split(/\r?\n/)[0].trim();
  return '';
}

export function buildConfig({ url, model, apiKey }) {
  const qwen = (name, roles, thinking) => `  - name: ${name}
    provider: openai
    model: ${model}
    apiBase: ${url}/v1
    apiKey: ${apiKey}
    roles:
${roles.map((r) => `      - ${r}`).join('\n')}
    defaultCompletionOptions:
      contextLength: 131072
      maxTokens: 8192
    requestOptions:
      extraBodyProperties:
        chat_template_kwargs:
          enable_thinking: ${thinking}
`;
  return `name: local-qwen
version: 0.0.2
schema: v1

# Qwen3.8-27B on the desktop's llama-server (start it with the "LLM - start" shortcut on the PC).
# Written by llm-harness/client/install-continue.mjs; the key lives in ~/.continue/.env.
models:
${qwen('Qwen3.8 27B', ['chat'], true)}
${qwen('Qwen3.8 27B fast', ['chat', 'edit', 'apply'], false)}
context:
  - provider: file
  - provider: code
  - provider: diff
  - provider: terminal
  - provider: codebase
`;
}

// Sets NAME=value in .env text, keeping every other line.
export function setEnvLine(text, name, value) {
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/).filter((l) => !l.startsWith(`${name}=`)) : [];
  return [...lines, `${name}=${value}`].join('\n') + '\n';
}

async function check(url, model, key) {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    if (r.status === 401) return 'the server rejected the key';
    if (!r.ok) return `HTTP ${r.status}`;
    const ids = ((await r.json()).data || []).map((m) => m.id);
    return ids.includes(model) ? null : `model ${model} not served (${ids.join(', ')})`;
  } catch (e) { return `not reachable (${e.cause?.code || e.name}); is the PC on and the server started?`; }
}

async function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  let client = {};
  try { client = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.llm-harness', 'client.json'), 'utf8')); } catch { /* flags only */ }
  const url = (opt('--url') || client.url || '').replace(/\/+$/, '');
  if (!url) {
    console.error('install-continue: no server URL. Run client/install-mac.sh first or pass --url http://<desktop>:8080.');
    return 2;
  }
  const model = client.model || 'qwen3.8-27b';
  const src = opt('--key-file') ? { keyFile: opt('--key-file') } : client;
  let key;
  try { key = readKey(src); } catch { key = ''; }
  if (!key) {
    console.error('install-continue: no API key. On the Mac put it into the Keychain (service llm-harness) and run '
      + 'client/install-mac.sh first, or pass --key-file <path>.');
    return 1;
  }

  const dir = path.join(os.homedir(), '.continue');
  fs.mkdirSync(dir, { recursive: true });
  const inline = argv.includes('--inline-key');
  const cfgFile = path.join(dir, 'config.yaml');
  if (fs.existsSync(cfgFile)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    fs.copyFileSync(cfgFile, `${cfgFile}.bak-llm-harness-${stamp}`);
    console.log(`backup: ${cfgFile}.bak-llm-harness-${stamp}`);
  }
  fs.writeFileSync(cfgFile, buildConfig({ url, model, apiKey: inline ? key : `\${{ secrets.${SECRET} }}` }), { mode: 0o600 });
  fs.chmodSync(cfgFile, 0o600);
  console.log(`written: ${cfgFile} (${url}/v1, key ${inline ? 'inline' : `from .env ${SECRET}`})`);
  if (!inline) {
    const envFile = path.join(dir, '.env');
    const old = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    fs.writeFileSync(envFile, setEnvLine(old, SECRET, key), { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);
    console.log(`written: ${envFile} (${SECRET}, mode 600)`);
  }
  const problem = await check(url, model, key);
  console.log(problem ? `warning: ${problem}` : `server check: ${model} answers at ${url}`);
  console.log('Restart the editor (Continue reads .env at startup), then pick "Qwen3.8 27B" in the Continue chat.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
