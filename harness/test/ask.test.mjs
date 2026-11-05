import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASK = path.join(here, '..', '..', 'client', 'ask.mjs');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'fake-claude.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-'));

// fake llama-server: /health plus a streaming chat endpoint; 'unauthorized' mode answers 401
let mode = 'ok', lastRequest = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{}'); }
    if (req.url === '/v1/chat/completions') {
      lastRequest = { auth: req.headers.authorization, body: JSON.parse(body) };
      if (mode === 'unauthorized') { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['Hel', 'lo', ' world']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${server.address().port}`;
const DOWN = 'http://127.0.0.1:9';
after(() => { server.closeAllConnections(); server.close(); fs.rmSync(home, { recursive: true, force: true }); });

function ask(args, { url = UP, input = null } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ASK_URL: url, ASK_KEY: 'k1', ASK_CLAUDE: FAKE_CLAUDE };
    const c = spawn(process.execPath, [ASK, ...args], { env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== null) c.stdin.end(input);
  });
}

test('streams the local answer and sends piped input before the question', async () => {
  mode = 'ok';
  const r = await ask(['what', 'is', 'this?'], { input: 'CONTEXT' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Hello world\n');
  assert.equal(r.stderr, '');
  assert.equal(lastRequest.auth, 'Bearer k1');
  assert.equal(lastRequest.body.stream, true);
  assert.equal(lastRequest.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(lastRequest.body.messages[0].content, 'CONTEXT\n\nwhat is this?');
});

test('--think turns thinking on', async () => {
  mode = 'ok';
  await ask(['--think', 'why?']);
  assert.equal(lastRequest.body.chat_template_kwargs.enable_thinking, true);
});

test('desktop down: falls back to claude haiku and says why', async () => {
  const r = await ask(['hello'], { url: DOWN });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /local model unavailable \((ECONNREFUSED|down)\); answering with Claude haiku/);
  assert.match(r.stdout, /CLAUDE args=\[-p --model haiku\] prompt="hello"/);
});

test('wrong key: falls back and names the problem', async () => {
  mode = 'unauthorized';
  const r = await ask(['hello']);
  assert.match(r.stderr, /unauthorized: check the API key/);
  assert.match(r.stdout, /^CLAUDE/);
});

test('--claude skips the local model', async () => {
  mode = 'ok';
  lastRequest = null;
  const r = await ask(['--claude', 'hi']);
  assert.match(r.stdout, /^CLAUDE/);
  assert.equal(lastRequest, null);
});

test('image question with the desktop down fails instead of falling back', async () => {
  const img = path.join(home, 'x.png');
  fs.writeFileSync(img, Buffer.alloc(10, 1));
  const r = await ask(['--image', img, 'what is this?'], { url: DOWN });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /image questions need it/);
});
