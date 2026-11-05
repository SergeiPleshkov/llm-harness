#!/usr/bin/env node
// web: MCP server (stdio, NDJSON) that gives the local model internet access in the llama-server web UI.
// llama-server spawns it from --mcp-servers-config and names the tools after the server key: web_search, web_fetch.
//   search  DuckDuckGo results (title, url, snippet), no API key
//   fetch   a public web page as plain text. Localhost, private-network and Tailscale addresses are refused,
//           for literal IPs, after every redirect and at connect time, so the model cannot reach this PC or the LAN.
// Self-contained (Node 18+, no dependencies). stdout is the protocol channel; WEB_MCP_LOG=<file> appends a JSONL log.
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const SEARCH_URL = process.env.WEB_MCP_SEARCH_URL || 'https://html.duckduckgo.com/html/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 20000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_CHARS = 20000;
const MAX_CHARS = 60000;

export const TOOLS = [
  {
    name: 'search',
    description: 'Search the web with DuckDuckGo. Returns titles, URLs and snippets; read a result with the fetch tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search query' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'number of results, default 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Download a public web page and return its readable text (HTML stripped). '
      + 'Long pages are cut; call again with offset to read further.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http or https URL' },
        offset: { type: 'integer', minimum: 0, description: 'character offset to start from, default 0' },
        max_chars: { type: 'integer', minimum: 1000, maximum: MAX_CHARS, description: `default ${DEFAULT_CHARS}` },
      },
      required: ['url'],
    },
  },
];

// IPv4: loopback, private, CGNAT/Tailscale, link-local, benchmarking, multicast/reserved. IPv6: only global unicast
// (2000::/3) is public; IPv4-mapped addresses are checked as IPv4.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v6);
  if (mapped) {
    if (mapped[1]) return isPrivateAddress(mapped[1]);
    const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = v6.startsWith('::') ? 0 : parseInt(v6.split(':')[0], 16);
  return !(first >= 0x2000 && first <= 0x3fff);
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(new Error(`refused: ${hostname} resolves to a local or private address (${bad.address})`));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function decompress(res) {
  const enc = (res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

// One HTTP exchange; resolves {status, headers, body, url} or {location} for a redirect.
function request(url, { method = 'GET', body = null, headers = {}, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`invalid URL: ${url}`)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(`only http and https URLs are supported: ${url}`));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(new Error(`refused: ${host} is a local or private address`));

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en;q=1.0, *;q=0.5', ...headers },
      lookup: allowPrivate ? undefined : safeLookup,
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ location: new URL(res.headers.location, u).href });
      }
      const chunks = [];
      let size = 0;
      const stream = decompress(res);
      stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { stream.destroy(); res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: u.href });
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', (e) => (chunks.length ? done() : reject(e)));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${TIMEOUT_MS / 1000} s`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function get(url, opts) {
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await request(url, opts);
    if (!r.location) return r;
    url = r.location;
  }
  throw new Error(`too many redirects: ${url}`);
}

function decodeBody(buf, contentType = '') {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!cs && /html/i.test(contentType)) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®',
  trade: '™', times: '×', deg: '°', euro: '€' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch { return m; }
  });
}

// Attributes of a tag, allowing quoted values that contain '>' (Wikipedia keeps wikitext JSON in data-mw).
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tag = (name, flags = 'gi') => new RegExp(`<${name}${ATTRS}>`, flags);
const TAG = tag('', 'g');
const inline = (s) => decodeEntities(s.replace(TAG, '')).replace(/\s+/g, ' ').trim();

// Readable text of an HTML page: <main> when present, without scripts, styles, navigation and footers.
export function htmlToText(html) {
  const title = inline(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  const main = new RegExp(`<main\\b${ATTRS}>([\\s\\S]*)</main>`, 'i').exec(s);
  if (main) s = main[1];
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1>/gi, '')
    // innermost lists of 8+ items with no text outside links: menus and language pickers
    .replace(new RegExp(`<(ul|ol)\\b${ATTRS}>((?:(?!<[uo]l\\b)[\\s\\S])*?)</\\1>`, 'gi'), (m, name, body) => {
      const items = (body.match(/<li\b/gi) || []).length;
      const rest = body.replace(/<a\b[\s\S]*?<\/a>/gi, '').replace(TAG, '');
      return items >= 8 && !/[\p{L}\p{N}]/u.test(rest) ? '' : m;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(tag('li\\b'), '\n- ')
    .replace(tag('h([1-6])\\b'), (m, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(tag('/?(?:p|div|section|article|header|main|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|dl|dt|dd)\\b'), '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(TAG, '');
  const text = decodeEntities(s).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n')
    .replace(/(?: ?\| ?)+$/gm, '').replace(/^\| /gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

function resultUrl(href) {
  const u = new URL(decodeEntities(href), 'https://duckduckgo.com');
  if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/' && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
  return u.hostname.endsWith('duckduckgo.com') ? null : u.href;
}

// Organic results from the DuckDuckGo HTML page; ads and DuckDuckGo's own links are skipped.
export function parseSearchResults(html, max = 8) {
  const out = [];
  for (const block of html.split(/<div class="result /).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = resultUrl(a[1]);
    if (!url) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] || '';
    out.push({ title: inline(a[2]), url, snippet: inline(snippet) });
    if (out.length >= max) break;
  }
  return out;
}

export async function search({ query, max_results: max = 8 } = {}) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const n = Math.min(Math.max(Number(max) || 8, 1), 10);
  const r = await request(SEARCH_URL, {
    method: 'POST', allowPrivate: true, body: new URLSearchParams({ q: query }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (r.location) throw new Error('DuckDuckGo redirected the query; try again later');
  const html = decodeBody(r.body, r.headers['content-type']);
  const results = parseSearchResults(html, n);
  if (!results.length && (r.status !== 200 || /anomaly|captcha|challenge/i.test(html))) {
    throw new Error(`DuckDuckGo refused the query (HTTP ${r.status}, bot check); try again in a minute`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!results.length) return `No results for "${query}" (searched ${today}).`;
  return `Search results for "${query}" (searched ${today}):\n\n`
    + results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.snippet ? `\n   ${x.snippet}` : ''}`).join('\n\n');
}

export async function fetchPage({ url, offset = 0, max_chars: maxChars = DEFAULT_CHARS } = {}, { allowPrivate = false } = {}) {
  if (!url || typeof url !== 'string') throw new Error('url is required');
  const r = await get(url, { allowPrivate });
  if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${r.url}`);
  const type = String(r.headers['content-type'] || '').toLowerCase();
  let title = '', text;
  if (!type || type.includes('html')) {
    ({ title, text } = htmlToText(decodeBody(r.body, type || 'text/html')));
  } else if (/^text\/|json|xml|javascript|yaml|csv/.test(type)) {
    text = decodeBody(r.body, type);
  } else {
    throw new Error(`unsupported content type ${type.split(';')[0]} at ${r.url}`);
  }
  const start = Math.max(Number(offset) || 0, 0);
  const n = Math.min(Math.max(Number(maxChars) || DEFAULT_CHARS, 1000), MAX_CHARS);
  const part = text.slice(start, start + n);
  const head = [title && `Title: ${title}`, `URL: ${r.url}`];
  if (start > 0 || start + n < text.length) {
    head.push(`[characters ${start}-${start + part.length} of ${text.length}${start + n < text.length ? `; next offset ${start + n}` : ''}]`);
  }
  return `${head.filter(Boolean).join('\n')}\n\n${part || '(no text)'}`;
}

function log(entry) {
  if (!process.env.WEB_MCP_LOG) return;
  try { fs.appendFileSync(process.env.WEB_MCP_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ }
}

async function callTool(name, args) {
  const started = Date.now();
  const target = name === 'search' ? { query: args.query } : { url: args.url };
  try {
    const text = name === 'search' ? await search(args) : name === 'fetch' ? await fetchPage(args) : null;
    if (text === null) throw new Error(`unknown tool: ${name}`);
    log({ tool: name, ...target, ok: true, chars: text.length, ms: Date.now() - started });
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    log({ tool: name, ...target, ok: false, error: e.message, ms: Date.now() - started });
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
}

// One JSON-RPC message in, the reply out (null for notifications).
export async function handle(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'llm-harness-web', version: '1.0.0' } });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': return ok(await callTool(params?.name, params?.arguments || {}));
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
    }
    const reply = await handle(msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
}

// realpath: node runs a module by its real path, argv[1] may be a link to it
const startedAs = () => { try { return pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return null; } };
if (process.argv[1] && import.meta.url === startedAs()) main();
