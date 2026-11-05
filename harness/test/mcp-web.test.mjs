import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', '..', 'server', 'mcp', 'web.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-web-test-'));

// DuckDuckGo-like results page: a direct link, a /l/?uddg= redirect link and an ad
const DDG_HTML = `<div id="links" class="results">
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/a">First &amp; best</a></h2>
  <a class="result__snippet" href="https://example.org/a">Snippet with <b>bold</b> text</a>
</div>
<div class="result results_links results_links_deep result--ad ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></h2>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb%3Fx%3D1&amp;rut=abc">Second</a></h2>
</div>
</div>`;

const PAGE = `<html><head><title>Test &mdash; page</title><style>.x{}</style></head><body>
<nav><a href="/">Home</a></nav>
<main>
<h1>Heading</h1>
<p>First paragraph &amp; more.</p>
<script>var hidden = 1;</script>
<table data-mw='{"wt":"<ref name=X>"}'><tr><th>Key</th><td>Value</td></tr></table>
<ul>${Array.from({ length: 10 }, (_, i) => `<li><a href="/l${i}">Lang ${i}</a></li>`).join('')}</ul>
<ul><li>kept item</li></ul>
</main>
<footer>Footer text</footer>
</body></html>`;

// "Привет" in windows-1251
const CP1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);

const server = http.createServer((req, res) => {
  if (req.url === '/search') {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => {
      server.lastSearch = new URLSearchParams(body).get('q');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DDG_HTML);
    });
  }
  if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  if (req.url === '/moved') { res.writeHead(302, { location: '/page' }); return res.end(); }
  if (req.url === '/gzip-1251') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=windows-1251', 'content-encoding': 'gzip' });
    return res.end(zlib.gzipSync(CP1251));
  }
  if (req.url === '/long') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('x'.repeat(2500)); }
  if (req.url === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF'); }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.WEB_MCP_SEARCH_URL = `${base}/search`;
const web = await import('../../server/mcp/web.mjs');
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('isPrivateAddress blocks local, private and Tailscale ranges, allows public ones', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.10', '169.254.1.1', '100.101.102.103',
    '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:120']) {
    assert.equal(web.isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '172.32.0.1', '100.128.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:808:808']) {
    assert.equal(web.isPrivateAddress(ip), false, ip);
  }
});

test('htmlToText keeps main content and drops scripts, navigation, footers and link-only lists', () => {
  const { title, text } = web.htmlToText(PAGE);
  assert.equal(title, 'Test — page');
  assert.match(text, /^# Heading\n\nFirst paragraph & more\./);
  assert.match(text, /Key \| Value/);
  assert.match(text, /- kept item/);
  for (const gone of ['hidden', 'Home', 'Footer', 'Lang 3', 'ref name', '.x{}']) assert.ok(!text.includes(gone), gone);
});

test('parseSearchResults resolves redirect links and skips ads', () => {
  const r = web.parseSearchResults(DDG_HTML);
  assert.deepEqual(r, [
    { title: 'First & best', url: 'https://example.org/a', snippet: 'Snippet with bold text' },
    { title: 'Second', url: 'https://example.com/b?x=1', snippet: '' },
  ]);
  assert.equal(web.parseSearchResults(DDG_HTML, 1).length, 1);
});

test('search posts the query and numbers the results', async () => {
  const out = await web.search({ query: 'тест query' });
  assert.equal(server.lastSearch, 'тест query');
  assert.match(out, /^Search results for "тест query" \(searched \d{4}-\d\d-\d\d\):/);
  assert.match(out, /1\. First & best\n {3}https:\/\/example\.org\/a\n {3}Snippet with bold text/);
  assert.match(out, /2\. Second\n {3}https:\/\/example\.com\/b\?x=1/);
});

test('fetchPage follows redirects, decodes gzip and charsets, pages long text', async () => {
  const page = await web.fetchPage({ url: `${base}/moved` }, { allowPrivate: true });
  assert.match(page, /^Title: Test — page\nURL: http:\/\/127\.0\.0\.1:\d+\/page\n\n# Heading/);
  assert.match(await web.fetchPage({ url: `${base}/gzip-1251` }, { allowPrivate: true }), /\n\nПривет$/);
  const first = await web.fetchPage({ url: `${base}/long`, max_chars: 1000 }, { allowPrivate: true });
  assert.match(first, /\[characters 0-1000 of 2500; next offset 1000\]/);
  const last = await web.fetchPage({ url: `${base}/long`, offset: 2000, max_chars: 1000 }, { allowPrivate: true });
  assert.match(last, /\[characters 2000-2500 of 2500\]\n\nx{500}$/);
});

test('fetchPage rejects errors, binary types, other schemes and private addresses', async () => {
  await assert.rejects(web.fetchPage({ url: `${base}/missing` }, { allowPrivate: true }), /HTTP 404/);
  await assert.rejects(web.fetchPage({ url: `${base}/pdf` }, { allowPrivate: true }), /unsupported content type application\/pdf/);
  await assert.rejects(web.fetchPage({ url: 'file:///etc/passwd' }), /only http and https/);
  await assert.rejects(web.fetchPage({ url: `${base}/page` }), /refused: 127\.0\.0\.1/);
  await assert.rejects(web.fetchPage({ url: 'http://[::ffff:127.0.0.1]/' }), /refused/);
  await assert.rejects(web.fetchPage({ url: `http://localhost:${server.address().port}/page` }), /refused: localhost resolves/);
});

test('stdio server answers the MCP handshake, lists tools and reports tool errors', async () => {
  const logFile = path.join(tmp, 'web.jsonl');
  const child = spawn(process.execPath, [WEB], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, WEB_MCP_LOG: logFile } });
  const lines = readline.createInterface({ input: child.stdout });
  const replies = [];
  const want = (n) => new Promise((resolve) => {
    const check = () => { if (replies.length >= n) resolve(); };
    lines.on('line', (l) => { replies.push(JSON.parse(l)); check(); });
    check();
  });
  const got = want(5);
  const send = (m) => child.stdin.write(typeof m === 'string' ? `${m}\n` : `${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fetch', arguments: { url: 'http://127.0.0.1:1/' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  send('not json');
  await got;
  child.stdin.end();

  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].result.protocolVersion, '2024-11-05');
  assert.deepEqual(byId[1].result.capabilities, { tools: {} });
  assert.deepEqual(byId[2].result.tools.map((t) => t.name), ['search', 'fetch']);
  assert.equal(byId[3].result.isError, true);
  assert.match(byId[3].result.content[0].text, /refused: 127\.0\.0\.1/);
  assert.equal(byId[4].error.code, -32601);
  assert.equal(byId.null.error.code, -32700);
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([log[0].tool, log[0].url, log[0].ok], ['fetch', 'http://127.0.0.1:1/', false]);
});
