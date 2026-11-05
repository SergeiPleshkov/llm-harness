import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-harness-test-'));
process.env.LLM_HARNESS_HOME = home;
const { probeEndpoint, resolveBackend, harnessHome } = await import('../lib/backend.mjs');

const KEY = 'test-key';
const keyFile = path.join(home, 'key.txt');
fs.writeFileSync(keyFile, `${KEY}\r\n`);
const wrongKeyFile = path.join(home, 'wrong-key.txt');
fs.writeFileSync(wrongKeyFile, 'nope\n');

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(home, { recursive: true, force: true }); });

// Minimal llama-server imitation: /health and an authenticated /v1/models.
function llamaLike({ healthStatus = 200, delayMs = 0, models = ['qwen3.8-27b'] } = {}) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => setTimeout(() => {
      if (req.url === '/health') { res.writeHead(healthStatus, { 'content-type': 'application/json' }); return res.end('{}'); }
      if (req.url === '/v1/models') {
        if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      }
      res.writeHead(404); res.end();
    }, delayMs));
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
}

async function closedPortUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
  return url;
}

const ep = (url, extra = {}) => ({ name: 'test', url, model: 'qwen3.8-27b', keyFile, ...extra });

test('healthy server -> ok', async () => {
  const r = await probeEndpoint(ep(await llamaLike()));
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.ok(r.latencyMs >= 0);
});

test('nothing listening -> down', async () => {
  const r = await probeEndpoint(ep(await closedPortUrl()));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'down');
});

test('slow server -> timeout', async () => {
  const r = await probeEndpoint(ep(await llamaLike({ delayMs: 600 })), { timeoutMs: 150 });
  assert.equal(r.reason, 'timeout');
});

test('wrong key -> unauthorized', async () => {
  const r = await probeEndpoint(ep(await llamaLike(), { keyFile: wrongKeyFile }));
  assert.equal(r.reason, 'unauthorized');
});

test('model still loading (503) -> loading', async () => {
  const r = await probeEndpoint(ep(await llamaLike({ healthStatus: 503 })));
  assert.equal(r.reason, 'loading');
});

test('different model served -> nomodel', async () => {
  const r = await probeEndpoint(ep(await llamaLike({ models: ['other'] })));
  assert.equal(r.reason, 'nomodel');
});

test('missing key file -> nokey', async () => {
  const r = await probeEndpoint(ep(await llamaLike(), { keyFile: path.join(home, 'missing.txt') }));
  assert.equal(r.reason, 'nokey');
});

test('keyCommand supplies the key (macOS Keychain style); a failing command -> nokey', async () => {
  const url = await llamaLike();
  const print = (s) => `"${process.execPath}" -e "process.stdout.write('${s}\\n')"`;
  assert.equal((await probeEndpoint(ep(url, { keyFile: undefined, keyCommand: print(KEY) }))).reason, 'ok');
  assert.equal((await probeEndpoint(ep(url, { keyFile: undefined, keyCommand: `"${process.execPath}" -e "process.exit(44)"` }))).reason, 'nokey');
});

test('resolve picks the first healthy endpoint in order', async () => {
  const down = await closedPortUrl();
  const up = await llamaLike();
  const r = await resolveBackend({ useCache: false, config: { probeTimeoutMs: 1000, cacheTtlMs: 0, endpoints: [ep(down, { name: 'a' }), ep(up, { name: 'b' })] } });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'b');
});

test('resolve with no healthy endpoint reports the failures', async () => {
  const r = await resolveBackend({ useCache: false, config: { probeTimeoutMs: 1000, cacheTtlMs: 0, endpoints: [ep(await closedPortUrl())] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'down');
  assert.equal(r.tried.length, 1);
});

test('cache is used within TTL and bypassed after it', async () => {
  fs.rmSync(path.join(harnessHome(), 'cache'), { recursive: true, force: true });
  const s = await llamaLike();
  const config = { probeTimeoutMs: 1000, cacheTtlMs: 60000, endpoints: [ep(s)] };
  assert.equal((await resolveBackend({ config })).ok, true);
  const srv = servers[servers.length - 1];
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
  const cached = await resolveBackend({ config });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  const fresh = await resolveBackend({ config: { ...config, cacheTtlMs: 0 } });
  assert.equal(fresh.ok, false);
});

test('scripts start when run through a linked repo path, as the skills do via ~/.llm-harness/repo', () => {
  const link = path.join(home, 'repo-link');
  fs.symlinkSync(repoRoot, link, 'junction');
  try {
    for (const [script, expected] of [
      ['harness/qexec/qexec.mjs', /usage: qexec\.mjs/],
      ['harness/shunt/shunt.mjs', /usage: shunt\.mjs/],
      ['harness/lib/backend.mjs', /no local backend/],
    ]) {
      const r = spawnSync(process.execPath, [path.join(link, script)], { encoding: 'utf8', env: { ...process.env, LLM_HARNESS_HOME: home } });
      assert.match(r.stdout + r.stderr, expected, script);
    }
  } finally {
    fs.unlinkSync(link); // remove the link itself before the temp dir cleanup
  }
});
