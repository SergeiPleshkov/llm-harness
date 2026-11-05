// Local-model backend resolver: probes the configured endpoints in order and reports the first healthy one.
// Config: ~/.llm-harness/config.json (override the directory with LLM_HARNESS_HOME). No dependencies.
//   node backend.mjs [--fresh] [--json]   exit code 0 = a backend is up, 1 = none
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { isMain } from './io.mjs';

const DEFAULTS = { probeTimeoutMs: 1500, cacheTtlMs: 30000 };

export function harnessHome() {
  return process.env.LLM_HARNESS_HOME || path.join(os.homedir(), '.llm-harness');
}

export function loadConfig(file = path.join(harnessHome(), 'config.json')) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing config = no endpoints */ }
  return { ...DEFAULTS, endpoints: [], ...cfg };
}

// keyEnv (variable name), keyCommand (prints the key, e.g. the macOS Keychain lookup) or keyFile (first line).
export function readKey(ep) {
  if (ep.keyEnv) {
    const v = process.env[ep.keyEnv];
    if (!v) throw new Error(`env ${ep.keyEnv} is not set`);
    return v.trim();
  }
  if (ep.keyCommand) {
    const v = execSync(ep.keyCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (!v) throw new Error('keyCommand printed nothing');
    return v;
  }
  if (ep.keyFile) return fs.readFileSync(ep.keyFile, 'utf8').split(/\r?\n/)[0].trim();
  return '';
}

// Probe one endpoint. reason: ok | down | timeout | loading | unauthorized | nomodel | nokey | error
export async function probeEndpoint(ep, { timeoutMs = DEFAULTS.probeTimeoutMs } = {}) {
  const base = { name: ep.name, url: ep.url, model: ep.model };
  let key;
  try { key = readKey(ep); } catch (e) { return { ...base, ok: false, reason: 'nokey', detail: e.message }; }

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const done = (ok, reason, detail) => ({ ...base, ok, reason, ...(detail ? { detail } : {}), latencyMs: Date.now() - started });
  try {
    const h = await fetch(`${ep.url}/health`, { signal: ac.signal });
    await h.body?.cancel();
    if (h.status === 503) return done(false, 'loading');
    const r = await fetch(`${ep.url}/v1/models`, { signal: ac.signal, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (r.status === 401 || r.status === 403) { await r.body?.cancel(); return done(false, 'unauthorized'); }
    if (!r.ok) { await r.body?.cancel(); return done(false, 'error', `HTTP ${r.status}`); }
    const ids = ((await r.json()).data || []).map((m) => m.id);
    if (ep.model && !ids.includes(ep.model)) return done(false, 'nomodel', `served: ${ids.join(', ') || 'none'}`);
    return done(true, 'ok');
  } catch (e) {
    if (ac.signal.aborted) return done(false, 'timeout', `no answer in ${timeoutMs} ms`);
    return done(false, 'down', e.cause?.code || e.message);
  } finally {
    clearTimeout(timer);
  }
}

function cacheFile() { return path.join(harnessHome(), 'cache', 'backend.json'); }

function readCache(sig, ttlMs) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (c.sig === sig && Date.now() - c.at < ttlMs) return { ...c.result, cached: true };
  } catch { /* no usable cache */ }
  return null;
}

function writeCache(sig, result) {
  try {
    const f = cacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), sig, result }));
    fs.renameSync(tmp, f);
  } catch { /* cache is best effort */ }
}

// First healthy endpoint, or { ok: false, reason, tried } with the last failure's reason.
export async function resolveBackend({ config = loadConfig(), useCache = true } = {}) {
  const sig = JSON.stringify(config.endpoints.map((e) => [e.url, e.model]));
  if (useCache) {
    const hit = readCache(sig, config.cacheTtlMs);
    if (hit) return hit;
  }
  const tried = [];
  for (const ep of config.endpoints) {
    const r = await probeEndpoint(ep, { timeoutMs: config.probeTimeoutMs });
    if (r.ok) { writeCache(sig, r); return r; }
    tried.push(r);
  }
  const result = { ok: false, reason: tried.length ? tried[tried.length - 1].reason : 'unconfigured', tried };
  writeCache(sig, result);
  return result;
}

export function appendLog(name, record) {
  try {
    const f = path.join(harnessHome(), 'logs', name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch { /* logging must never break a hook */ }
}

export function describe(b) {
  if (b.ok) return `${b.model || b.name} @ ${b.url}: ok (${b.latencyMs} ms)`;
  if (!b.tried?.length) return `no local backend: ${b.reason}`;
  return 'no local backend: ' + b.tried.map((t) => `${t.name || t.url} ${t.reason}${t.detail ? ` (${t.detail})` : ''}`).join('; ');
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const b = await resolveBackend({ useCache: !args.includes('--fresh') });
  console.log(args.includes('--json') ? JSON.stringify(b, null, 2) : describe(b));
  process.exit(b.ok ? 0 : 1);
}
