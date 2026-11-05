// Installs the harness into this machine's user-level Claude Code config:
//   - ~/.llm-harness/config.json: the llama-server endpoint (kept if it exists). On the desktop it is derived from
//     C:\llm\server.json; with --remote (the laptop) it is the desktop's Tailscale URL, key from the macOS Keychain
//   - SessionStart and PreToolUse(Read) hooks + statusLine in ~/.claude/settings.json (a timestamped backup is written first)
//   - skills from harness/skills linked into ~/.claude/skills; ~/.llm-harness/repo linked to this repo (skills use it)
// Re-running is safe. Other hooks and a custom statusLine are left alone.
//   node install.mjs [--remote http://<desktop-tailscale-ip>:8080] [--uninstall]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessHome } from './harness/lib/backend.mjs';

const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
const remote = argv.includes('--remote') ? argv[argv.indexOf('--remote') + 1] : null;
if (argv.includes('--remote') && !/^https?:\/\/\S+$/.test(remote || '')) {
  console.error('usage: node install.mjs [--remote http://<desktop>:8080] [--uninstall]');
  process.exit(2);
}
const KEYCHAIN = 'security find-generic-password -a "$USER" -s llm-harness -w';
const repo = path.dirname(fileURLToPath(import.meta.url));
const fwd = (p) => p.replace(/\\/g, '/');
// absolute node path: a GUI-started Claude Code (macOS Finder, Windows Start menu) may not have node on PATH
const node = `"${fwd(process.execPath)}"`;
const HOOKS = [
  { event: 'SessionStart', script: 'harness/hooks/session-start.mjs', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Read', script: 'harness/hooks/pre-read.mjs', timeout: 5 },
];
const SKILLS = ['qexec', 'shunt'];
const STATUS_SCRIPT = 'harness/statusline.mjs';
const isOurs = (cmd, script) => typeof cmd === 'string' && fwd(cmd).includes(`/${script}`);

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`cannot parse ${file}: ${e.message}`);
  }
}

// 1. settings.json: back up, then replace our entries
const settings = readJson(settingsFile, {});
if (fs.existsSync(settingsFile)) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${settingsFile}.bak-llm-harness-${stamp}`;
  fs.copyFileSync(settingsFile, backup);
  console.log(`backup: ${backup}`);
}

settings.hooks ??= {};
for (const h of HOOKS) {
  const groups = (settings.hooks[h.event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((x) => !isOurs(x.command, h.script)) }))
    .filter((g) => g.hooks.length);
  if (!uninstall) {
    groups.push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: `${node} "${fwd(path.join(repo, h.script))}"`, timeout: h.timeout }] });
  }
  if (groups.length) settings.hooks[h.event] = groups; else delete settings.hooks[h.event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

const statusOurs = isOurs(settings.statusLine?.command, STATUS_SCRIPT);
if (uninstall) {
  if (statusOurs) delete settings.statusLine;
} else if (!settings.statusLine || statusOurs) {
  settings.statusLine = { type: 'command', command: `${node} "${fwd(path.join(repo, STATUS_SCRIPT))}"`, padding: 0, refreshInterval: 30 };
} else {
  console.log('statusLine: a custom one is already configured, left as is');
}

fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log(`${uninstall ? 'removed from' : 'updated'}: ${settingsFile}`);

// 2. links (a junction on Windows, no admin needed): skills into ~/.claude/skills, and ~/.llm-harness/repo -> this
// repo, so SKILL.md can name scripts as "$HOME/.llm-harness/repo/..." on every machine
const links = [
  ...SKILLS.map((name) => ({ what: `skill ${name}`, target: path.join(repo, 'harness', 'skills', name), link: path.join(claudeDir, 'skills', name) })),
  { what: 'repo link', target: repo, link: path.join(harnessHome(), 'repo') },
];
for (const { what, target, link } of links) {
  let current = null;
  try { current = fs.lstatSync(link).isSymbolicLink() ? path.resolve(path.dirname(link), fs.readlinkSync(link)) : 'not-a-link'; } catch { /* absent */ }
  const ours = current && current !== 'not-a-link' && path.relative(current, target) === '';
  if (uninstall) {
    if (ours) { fs.unlinkSync(link); console.log(`${what} removed: ${link}`); }
  } else if (current === 'not-a-link' || (current && !ours)) {
    console.log(`${what}: ${link} already exists and is not ours, left as is`);
  } else if (!ours) {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'junction');
    console.log(`${what} linked: ${link} -> ${target}`);
  } else {
    console.log(`${what} already linked: ${link}`);
  }
}

// 3. harness config (install only; never overwritten, never removed)
if (!uninstall) {
  const cfgFile = path.join(harnessHome(), 'config.json');
  if (fs.existsSync(cfgFile)) {
    console.log(`config kept: ${cfgFile}`);
  } else {
    const server = remote ? {} : readJson('C:\\llm\\server.json', {});
    const endpoint = remote
      ? { name: 'desktop', url: remote.replace(/\/+$/, ''), model: 'qwen3.8-27b', keyCommand: KEYCHAIN }
      : { name: 'desktop', url: `http://127.0.0.1:${server.port ?? 8080}`, model: server.alias ?? 'qwen3.8-27b',
          keyFile: server.apiKeyFile ?? 'C:\\llm\\secrets\\api-key.txt' };
    const cfg = { endpoints: [endpoint], probeTimeoutMs: 1500, cacheTtlMs: 30000 };
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`config written: ${cfgFile}`);
  }
  // 4. Qwen Code (the qexec executor): no usage statistics, telemetry or self-updates; written only if absent
  const qwenFile = path.join(os.homedir(), '.qwen', 'settings.json');
  if (!fs.existsSync(qwenFile)) {
    const qwen = { privacy: { usageStatisticsEnabled: false }, telemetry: { enabled: false }, general: { enableAutoUpdate: false }, $version: 4 };
    fs.mkdirSync(path.dirname(qwenFile), { recursive: true });
    fs.writeFileSync(qwenFile, JSON.stringify(qwen, null, 2) + '\n');
    console.log(`qwen-code settings written: ${qwenFile}`);
  }
}
console.log(uninstall ? 'uninstalled (~/.llm-harness logs are kept)' : 'installed: start a new Claude Code session to pick up the hook');
