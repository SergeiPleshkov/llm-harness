import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', '..', 'client', 'install-continue.mjs');
const { buildConfig, setEnvLine } = await import('../../client/install-continue.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-continue-test-'));
const KEY = 'k-secret-123';
const keyFile = path.join(tmp, 'key.txt');
fs.writeFileSync(keyFile, `${KEY}\n`);

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function run(home, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

test('buildConfig: two Qwen models on the server URL, key reference, no autocomplete', () => {
  const y = buildConfig({ url: 'http://100.64.0.10:8080', model: 'qwen3.8-27b', apiKey: '${{ secrets.LLM_HARNESS_KEY }}' });
  assert.equal(y.match(/apiBase: http:\/\/100\.64\.0\.10:8080\/v1/g).length, 2);
  assert.equal(y.match(/apiKey: \$\{\{ secrets\.LLM_HARNESS_KEY \}\}/g).length, 2);
  assert.match(y, /name: Qwen3\.8 27B\n[\s\S]*enable_thinking: true/);
  assert.match(y, /name: Qwen3\.8 27B fast\n[\s\S]*- edit\n {6}- apply\n[\s\S]*enable_thinking: false/);
  assert.doesNotMatch(y, /autocomplete/);
});

test('setEnvLine replaces only its own variable', () => {
  assert.equal(setEnvLine('', 'A', '1'), 'A=1\n');
  assert.equal(setEnvLine('X=9\nA=old\r\nY=8\n', 'A', '2'), 'X=9\nY=8\nA=2\n');
});

test('writes config and .env, backs up the old config, checks the server, never prints the key', async () => {
  const home = path.join(tmp, 'home1');
  fs.mkdirSync(path.join(home, '.continue'), { recursive: true });
  fs.writeFileSync(path.join(home, '.continue', 'config.yaml'), 'name: old\n');
  fs.writeFileSync(path.join(home, '.continue', '.env'), 'OTHER=1\n');
  const r = await run(home, ['--url', url, '--key-file', keyFile]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(KEY), 'key printed');
  assert.match(r.out, /server check: qwen3\.8-27b answers/);
  const dir = path.join(home, '.continue');
  const cfg = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
  assert.match(cfg, new RegExp(`apiBase: ${url}/v1`));
  assert.ok(!cfg.includes(KEY), 'key in config.yaml');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), `OTHER=1\nLLM_HARNESS_KEY=${KEY}\n`);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.yaml.bak-llm-harness-'));
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), 'name: old\n');
});

test('no server URL (no client.json, no --url) -> exit 2', async () => {
  const r = await run(path.join(tmp, 'home4'), ['--key-file', keyFile]);
  assert.equal(r.code, 2);
  assert.match(r.out, /no server URL/);
});

test('--inline-key puts the key into config.yaml; no key at all -> exit 1', async () => {
  const home = path.join(tmp, 'home2');
  const r = await run(home, ['--url', url, '--key-file', keyFile, '--inline-key']);
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(home, '.continue', 'config.yaml'), 'utf8'), new RegExp(`apiKey: ${KEY}`));
  assert.ok(!fs.existsSync(path.join(home, '.continue', '.env')));
  const none = await run(path.join(tmp, 'home3'), ['--url', url]);
  assert.equal(none.code, 1);
  assert.match(none.out, /no API key/);
});
