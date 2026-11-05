import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, '..', 'hooks', 'pre-read.mjs');
const SHUNT = path.join(here, '..', 'shunt', 'shunt.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shunt-test-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.LLM_HARNESS_HOME = home;
const { collectFiles, buildReadInput, buildLogInput } = await import('../shunt/shunt.mjs');

const KEY = 'k-test';
const keyFile = path.join(tmp, 'key.txt');
fs.writeFileSync(keyFile, KEY);

// fake llama-server with an OpenAI-style chat endpoint that records the last request
let lastRequest = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] })); }
    if (req.url === '/v1/chat/completions') {
      lastRequest = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'ANSWER at big.txt:2' } }], usage: { prompt_tokens: 123, completion_tokens: 7 } }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const upUrl = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function setBackend(url) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    endpoints: [{ name: 't', url, model: 'qwen3.8-27b', keyFile }], cacheTtlMs: 0, shunt: { readThresholdKB: 1 },
  }));
}
const DOWN_URL = 'http://127.0.0.1:9'; // discard port: nothing listens

// async spawn so the fake server in this process can answer
function runNode(script, args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { env: { ...process.env, LLM_HARNESS_HOME: home, ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
    c.stdin.end(input);
  });
}

const big = path.join(tmp, 'big.txt');
fs.writeFileSync(big, Array.from({ length: 400 }, (_, i) => `line ${i + 1} some text here`).join('\n'));
const small = path.join(tmp, 'small.txt');
fs.writeFileSync(small, 'tiny\n');
const hookCall = (file, session, extra = {}) => runNode(HOOK, [], {
  input: JSON.stringify({ session_id: session, tool_name: 'Read', tool_input: { file_path: file, ...extra } }),
});

test('hook: large text file while Qwen is up -> deny with shunt command, once per session', async () => {
  setBackend(upUrl);
  const r = await hookCall(big, 's1');
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /shunt\.mjs" read/);
  assert.match(out.permissionDecisionReason, /big\.txt/);
  assert.equal((await hookCall(big, 's1')).stdout, '', 'second attempt in the same session passes');
  assert.match((await hookCall(big, 's2')).stdout, /deny/, 'a new session is turned away again');
});

test('hook: passes targeted reads, small, binary and image files, and when disabled', async () => {
  setBackend(upUrl);
  assert.equal((await hookCall(big, 's3', { offset: 1, limit: 50 })).stdout, '');
  assert.equal((await hookCall(small, 's3')).stdout, '');
  const bin = path.join(tmp, 'blob.dat');
  fs.writeFileSync(bin, Buffer.concat([Buffer.alloc(10, 0), Buffer.alloc(5000, 65)]));
  assert.equal((await hookCall(bin, 's3')).stdout, '');
  const png = path.join(tmp, 'shot.png');
  fs.writeFileSync(png, Buffer.alloc(5000, 1));
  assert.equal((await hookCall(png, 's3')).stdout, '');
  const off = await runNode(HOOK, [], { input: JSON.stringify({ session_id: 's3', tool_name: 'Read', tool_input: { file_path: big } }), env: { LLM_HARNESS_SHUNT: 'off' } });
  assert.equal(off.stdout, '');
});

test('hook: Qwen down, missing file or garbage input -> pass, exit 0', async () => {
  setBackend(DOWN_URL);
  assert.equal((await hookCall(big, 's4')).stdout, '');
  setBackend(upUrl);
  const missing = await hookCall(path.join(tmp, 'nope.txt'), 's4');
  assert.equal(missing.code, 0);
  assert.equal(missing.stdout, '');
  const garbage = await runNode(HOOK, [], { input: 'not json' });
  assert.equal(garbage.code, 0);
  assert.equal(garbage.stdout, '');
});

test('buildReadInput numbers lines and reports cuts over budget', () => {
  const r = buildReadInput([small, big], 1e6, tmp);
  assert.match(r.text, /=== small\.txt \(2 lines\) ===\n1\| tiny/);
  assert.match(r.text, /400\| line 400/);
  const cut = buildReadInput([big, small], 3000, tmp);
  assert.deepEqual(cut.truncated, ['big.txt']);
  assert.match(cut.text, /truncated: file continues to line 400/);
  assert.deepEqual(cut.skipped, ['small.txt (over budget)']);
});

test('buildLogInput keeps head, tail and signal lines with original numbers', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `ok ${i + 1}`);
  lines[2499] = 'ERROR: database connection refused';
  const r = buildLogInput(lines.join('\n'), 20000);
  assert.equal(r.reduced, true);
  assert.match(r.text, /2500\| ERROR: database connection refused/);
  assert.match(r.text, /lines omitted/);
  assert.match(r.text, /5000\| ok 5000/);
  assert.equal(buildLogInput('a\nb', 1000).reduced, false);
});

test('collectFiles walks directories, skips node_modules, expands globs', () => {
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(proj, 'src', 'b.ts'), 'b');
  fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'i.js'), 'x');
  const all = collectFiles(['proj'], tmp).map((f) => path.basename(f)).sort();
  assert.deepEqual(all, ['a.js', 'b.ts']);
  assert.deepEqual(collectFiles(['proj/src/*.ts'], tmp).map((f) => path.basename(f)), ['b.ts']);
  assert.throws(() => collectFiles(['proj/missing/*.zz'], tmp), /no such file/);
});

test('shunt read sends numbered content with the key and prints answer and footer', async () => {
  setBackend(upUrl);
  const r = await runNode(SHUNT, ['read', 'What is on line 2?', big]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ANSWER at big\.txt:2/);
  assert.match(r.stdout, /\[shunt read: qwen3\.8-27b, 1 file\(s\), 123 tokens in, 7 out/);
  assert.equal(lastRequest.auth, `Bearer ${KEY}`);
  const user = lastRequest.body.messages[1].content;
  assert.match(user, /^Question: What is on line 2\?/);
  assert.match(user, /\n2\| line 2 some text here/);
  assert.equal(lastRequest.body.chat_template_kwargs.enable_thinking, false);
});

test('shunt exits 3 when the local model is down', async () => {
  setBackend(DOWN_URL);
  const r = await runNode(SHUNT, ['logs', 'Any errors?', big]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /local model unavailable/);
});
