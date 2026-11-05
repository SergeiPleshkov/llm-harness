import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'hooks', 'session-start.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-test-'));

// healthy llama-server imitation; the key comes from a keyCommand, as on the laptop
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('{}'); }
  if (req.headers.authorization !== 'Bearer k-test') { res.writeHead(401); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function runHook(name, endpoint) {
  const home = path.join(tmp, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ endpoints: [endpoint], probeTimeoutMs: 300, cacheTtlMs: 0 }));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [HOOK], { env: { ...process.env, LLM_HARNESS_HOME: home } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, context: JSON.parse(out).hookSpecificOutput.additionalContext }));
    c.stdin.end(JSON.stringify({ source: 'startup', session_id: 's1', cwd: tmp }));
  });
}

test('model up: status plus the delegation policy', async () => {
  const keyCommand = `"${process.execPath}" -e "process.stdout.write('k-test')"`;
  const r = await runHook('up', { name: 'pc', url: `http://127.0.0.1:${server.address().port}`, model: 'qwen3.8-27b', keyCommand });
  assert.equal(r.code, 0);
  assert.match(r.context, /^Local model qwen3\.8-27b is running on this PC/);
  assert.match(r.context, /Delegation policy/);
  assert.match(r.context, /qexec skill/);
  assert.match(r.context, /shunt skill/);
});

test('remote model down: says where it lives and to do the work yourself', async () => {
  // TEST-NET-1 address: never answers, like the desktop when it is off
  const r = await runHook('down', { name: 'pc', url: 'http://192.0.2.1:8080', model: 'qwen3.8-27b', keyCommand: `"${process.execPath}" -e "process.stdout.write('k')"` });
  assert.equal(r.code, 0);
  assert.match(r.context, /desktop PC, reached over Tailscale\) is not reachable right now \((timeout|down)\)/);
  assert.match(r.context, /Do the work yourself/);
  assert.doesNotMatch(r.context, /Delegation policy/);
});
