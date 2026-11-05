// qexec: delegate a written plan to a headless executor in an isolated git worktree, run the plan's verify
// command, commit the result on a qexec/<id> branch and print a compact report for the reviewing model.
// Executor: Qwen Code on the local llama-server; falls back to `claude -p --model sonnet` when it is unavailable.
//   node qexec.mjs run <plan.md> [--repo DIR] [--base REF] [--executor auto|qwen|claude] [--timeout-min N] [--max-turns N]
//   node qexec.mjs list | report <id> | discard <id>
// Exit code of `run`: 0 verify passed, 1 verify failed, 2 harness error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harnessHome, loadConfig, resolveBackend, readKey, appendLog } from '../lib/backend.mjs';
import { isMain } from '../lib/io.mjs';
import { parsePlan, slugify } from './plan.mjs';

const isWin = process.platform === 'win32';
const SELF = fileURLToPath(import.meta.url);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message).trim() }; }
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const tail = (text, n) => text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-n).join('\n');
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const runsDir = () => path.join(harnessHome(), 'runs');

// Spawn with optional stdin text, tee output to files, kill the whole process tree on timeout.
function runProcess({ cmd, args, cwd, env, input, timeoutMs, outFile, errFile }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.createWriteStream(outFile), err = fs.createWriteStream(errFile);
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (isWin) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out.write(d); stdout += d; });
    child.stderr.on('data', (d) => { err.write(d); stderr += d; });
    child.on('error', (e) => { stderr += `\n[spawn error] ${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer); out.end(); err.end();
      resolve({ code: timedOut ? 124 : (code ?? 1), timedOut, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.stdin.end(input ?? '');
  });
}

function qwenEntry() {
  if (process.env.QEXEC_QWEN_ENTRY) return process.env.QEXEC_QWEN_ENTRY;
  return path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@qwen-code', 'qwen-code', 'cli-entry.js');
}
// Known install locations first (hooks and GUI apps may run with a short PATH), then PATH.
function claudeExe() {
  if (process.env.QEXEC_CLAUDE) return process.env.QEXEC_CLAUDE;
  const home = os.homedir();
  const candidates = isWin
    ? [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'), path.join(home, '.local', 'bin', 'claude.exe')]
    : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return candidates.find((c) => fs.existsSync(c)) || 'claude';
}

const EXECUTORS = {
  qwen: (ctx) => ({
    label: `${ctx.endpoint.model} via qwen-code (local)`,
    cmd: process.execPath,
    args: [qwenEntry(), '--auth-type', 'openai', '-m', ctx.endpoint.model, '-o', 'json', '--approval-mode', 'yolo',
      '--max-wall-time', `${ctx.timeoutMin}m`, '--max-session-turns', String(ctx.maxTurns), 'Execute the task described in the input above.'],
    // the key goes through the environment, never the command line
    env: { ...process.env, OPENAI_API_KEY: readKey(ctx.endpoint), OPENAI_BASE_URL: `${ctx.endpoint.url}/v1`, OPENAI_MODEL: ctx.endpoint.model },
  }),
  claude: (ctx) => ({
    label: 'claude sonnet via claude -p (subscription)',
    cmd: claudeExe(),
    args: ['-p', '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep', '--max-turns', String(ctx.maxTurns)],
    env: process.env,
  }),
};

function buildExecutor(name, ctx) {
  // tests replace the real CLIs with a script: node <fake> <executor name>
  if (process.env.QEXEC_FAKE_EXECUTOR) return { label: `fake ${name}`, cmd: process.execPath, args: [process.env.QEXEC_FAKE_EXECUTOR, name], env: process.env };
  return EXECUTORS[name](ctx);
}

// Both CLIs print a final {type: "result", result, num_turns, usage, ...} object (Qwen Code inside an event array).
function parseExecutorOutput(stdout) {
  try {
    const j = JSON.parse(stdout);
    const r = Array.isArray(j) ? j.findLast((e) => e.type === 'result') : j;
    if (!r) return {};
    // claude -p counts cached prompt tokens separately from input_tokens
    const u = r.usage ?? {};
    const inTokens = u.input_tokens == null ? undefined : u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return { summary: r.result ?? '', isError: !!r.is_error, turns: r.num_turns, inTokens, outTokens: u.output_tokens, costUsd: r.total_cost_usd };
  } catch { return { summary: tail(stdout, 20) }; }
}

function verifyShell(command) {
  if (process.env.QEXEC_SHELL) return { cmd: process.env.QEXEC_SHELL, args: ['-c', command] };
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (isWin && fs.existsSync(gitBash)) return { cmd: gitBash, args: ['-c', command] };
  if (isWin) return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  return { cmd: '/bin/sh', args: ['-c', command] };
}

function buildPrompt(plan) {
  return [
    'You are the executor in a plan -> execute -> review workflow. Another model wrote the plan below and will review your diff.',
    '',
    'Rules:',
    '- Work only inside the current directory: a fresh git worktree made for this task. Dependencies (node_modules, venv) may need installing.',
    '- Implement what the plan asks and nothing more. Do not refactor unrelated code.',
    '- Run the command from the "Verify" section and iterate until it passes or you are sure it cannot pass.',
    '- Do not commit, push or change git config: the harness commits your changes itself.',
    '- Do not touch files outside this directory and do not install global tools.',
    '- Finish with a short summary: what you changed, the verify result, anything unfinished or uncertain.',
    '',
    '=== PLAN ===',
    plan.text,
  ].join('\n');
}

function diffInfo(wt, base, committed) {
  const range = committed ? [base, 'HEAD'] : ['--cached', base];
  const numstat = git(wt, ['diff', '--numstat', ...range]);
  let added = 0, deleted = 0, files = 0;
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    files++; added += Number(a) || 0; deleted += Number(d) || 0;
  }
  return { files, added, deleted, stat: git(wt, ['diff', '--stat=100', ...range]) };
}

export async function run(planPath, opts = {}) {
  const repo = git(opts.repo || process.cwd(), ['rev-parse', '--show-toplevel']);
  const plan = parsePlan(fs.readFileSync(planPath, 'utf8'));
  const id = `${stamp()}-${slugify(plan.title, 24)}`;
  const branch = `qexec/${id}`;
  const wt = path.join(harnessHome(), 'worktrees', path.basename(repo), id);
  const runDir = path.join(runsDir(), id);
  const timeoutMin = opts.timeoutMin ?? 20, maxTurns = opts.maxTurns ?? 80;
  const warnings = [];

  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(planPath, path.join(runDir, 'plan.md'));
  const base = git(repo, ['rev-parse', opts.base || 'HEAD']);
  if (git(repo, ['status', '--porcelain'])) warnings.push(`uncommitted changes in ${repo} are not in the worktree (it starts from ${base.slice(0, 7)})`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '-q', '-b', branch, wt, base]);

  // pick the executor: local Qwen when it is healthy, otherwise Claude
  let name = opts.executor === 'claude' ? 'claude' : 'qwen', fallbackReason = null, endpoint = null;
  if (name === 'qwen') {
    const b = await resolveBackend({ useCache: false });
    if (b.ok) endpoint = { ...loadConfig().endpoints.find((e) => e.url === b.url), ...b };
    else { name = 'claude'; fallbackReason = `local model unavailable: ${b.reason}`; }
  }
  const prompt = buildPrompt(plan);
  fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);

  const attempt = async (n) => {
    const ex = buildExecutor(n, { endpoint, timeoutMin, maxTurns });
    const res = await runProcess({ cmd: ex.cmd, args: ex.args, cwd: wt, env: ex.env, input: prompt,
      timeoutMs: (timeoutMin + 1) * 60000, outFile: path.join(runDir, `${n}.out`), errFile: path.join(runDir, `${n}.err`) });
    return { name: n, label: ex.label, res, parsed: parseExecutorOutput(res.stdout) };
  };
  let exec = await attempt(name);
  if (exec.name === 'qwen' && exec.res.code !== 0 && !git(wt, ['status', '--porcelain'])) {
    // Qwen failed before changing anything (server died, API error, timeout): hand the task to Claude
    fallbackReason = `qwen-code exited with ${exec.res.code}${exec.res.timedOut ? ' (timeout)' : ''} without changes: ${tail(exec.res.stderr || exec.parsed.summary || '', 1).slice(0, 200)}`;
    exec = await attempt('claude');
  }

  const sh = verifyShell(plan.verify);
  const v = await runProcess({ cmd: sh.cmd, args: sh.args, cwd: wt, env: process.env, input: null,
    timeoutMs: (opts.verifyTimeoutMin ?? 10) * 60000, outFile: path.join(runDir, 'verify.out'), errFile: path.join(runDir, 'verify.err') });

  git(wt, ['add', '-A']);
  let head = base, committed = false;
  if (git(wt, ['diff', '--cached', '--name-only'])) {
    const c = tryGit(wt, ['commit', '-q', '-m', `qexec: ${plan.title}`, '-m', `Executor: ${exec.label}\nVerify: ${plan.verify.split('\n')[0]} -> exit ${v.code}\nRun: ${id}`]);
    if (c.ok) { committed = true; head = git(wt, ['rev-parse', 'HEAD']); }
    else warnings.push(`commit in the worktree failed, changes are only staged: ${c.out.split('\n')[0]}`);
  }

  const report = {
    id, repo, branch, worktree: wt, base, head, committed,
    plan: { title: plan.title, verify: plan.verify, path: path.resolve(planPath) },
    executor: { name: exec.name, label: exec.label, exitCode: exec.res.code, timedOut: exec.res.timedOut, ms: exec.res.ms, ...exec.parsed },
    fallbackReason,
    verify: { passed: v.code === 0, exitCode: v.code, timedOut: v.timedOut, ms: v.ms, tail: tail(`${v.stdout}\n${v.stderr}`, 25) },
    changes: diffInfo(wt, base, committed),
    warnings,
  };
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = renderReport(report);
  fs.writeFileSync(path.join(runDir, 'report.md'), md);
  appendLog('delegations.jsonl', {
    id, repo, title: plan.title, executor: exec.name, label: exec.label, fallbackReason,
    executorMs: exec.res.ms, verifyPassed: report.verify.passed, files: report.changes.files,
    added: report.changes.added, deleted: report.changes.deleted, turns: exec.parsed.turns,
    inTokens: exec.parsed.inTokens, outTokens: exec.parsed.outTokens, costUsd: exec.parsed.costUsd,
  });
  return { report, md };
}

export function renderReport(r) {
  const e = r.executor, b7 = r.base.slice(0, 7);
  const tokens = e.inTokens != null ? `, tokens ${e.inTokens}/${e.outTokens}` : '';
  const summary = (e.summary || '(no summary)').trim();
  const lines = [
    `## qexec ${r.id}: ${r.verify.passed ? 'PASS' : 'FAIL'}`,
    `- plan: ${r.plan.title}`,
    `- executor: ${e.label}, exit ${e.exitCode}${e.timedOut ? ' (timeout)' : ''}, ${fmtDur(e.ms)}${e.turns != null ? `, ${e.turns} turns` : ''}${tokens}`,
    ...(r.fallbackReason ? [`- fallback: ${r.fallbackReason}`] : []),
    `- verify: \`${r.plan.verify.split('\n')[0]}\` -> exit ${r.verify.exitCode}${r.verify.timedOut ? ' (timeout)' : ''} in ${fmtDur(r.verify.ms)}`,
    `- changes: ${r.changes.files} files, +${r.changes.added} -${r.changes.deleted} on \`${r.branch}\` (${r.head.slice(0, 7)}, base ${b7})${r.committed ? '' : ', not committed'}`,
    `- worktree: ${r.worktree}`,
    '', '### diff stat', '```', r.changes.stat || '(no changes)', '```',
    '', '### verify output (tail)', '```', r.verify.tail || '(empty)', '```',
    '', '### executor summary', summary.length > 1500 ? `${summary.slice(0, 1500)}…` : summary,
    ...(r.warnings.length ? ['', '### warnings', ...r.warnings.map((w) => `- ${w}`)] : []),
    '', '### next',
    `- review: \`git -C "${r.worktree}" diff ${b7} ${r.committed ? 'HEAD' : '--cached'}\``,
    `- merge: \`git -C "${r.repo}" merge --squash ${r.branch}\`, then commit`,
    `- discard: \`node "${SELF}" discard ${r.id}\``,
  ];
  return lines.join('\n') + '\n';
}

function readReport(id) {
  const f = path.join(runsDir(), id, 'report.json');
  if (!fs.existsSync(f)) throw new Error(`no qexec run ${id}`);
  return { f, r: JSON.parse(fs.readFileSync(f, 'utf8')) };
}

export function discard(id) {
  const { f, r } = readReport(id);
  if (fs.existsSync(r.worktree)) git(r.repo, ['worktree', 'remove', '--force', r.worktree]);
  tryGit(r.repo, ['worktree', 'prune']);
  const del = tryGit(r.repo, ['branch', '-D', r.branch]);
  r.discarded = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(r, null, 2));
  return `discarded ${id}: worktree removed, branch ${del.ok ? 'deleted' : 'already gone'} (logs kept in ${path.dirname(f)})`;
}

export function list() {
  if (!fs.existsSync(runsDir())) return 'no qexec runs';
  return fs.readdirSync(runsDir()).sort().map((id) => {
    try {
      const { r } = readReport(id);
      const state = r.discarded ? 'discarded' : fs.existsSync(r.worktree) ? 'open' : 'worktree gone';
      return `${id}  ${r.verify.passed ? 'PASS' : 'FAIL'}  ${r.executor.name}  ${state}  ${path.basename(r.repo)}`;
    } catch { return `${id}  (no report)`; }
  }).join('\n');
}

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (m) opt[m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]; else pos.push(argv[i]);
  }
  return { pos, opt };
}

if (isMain(import.meta.url)) {
  const { pos: [cmd, arg], opt } = parseArgs(process.argv.slice(2));
  try {
    if (cmd === 'run' && arg) {
      const { report, md } = await run(arg, {
        repo: opt.repo, base: opt.base, executor: opt.executor,
        timeoutMin: opt.timeoutMin ? Number(opt.timeoutMin) : undefined, maxTurns: opt.maxTurns ? Number(opt.maxTurns) : undefined,
      });
      process.stdout.write(md);
      process.exit(report.verify.passed ? 0 : 1);
    } else if (cmd === 'report' && arg) {
      process.stdout.write(fs.readFileSync(path.join(runsDir(), arg, 'report.md'), 'utf8'));
    } else if (cmd === 'discard' && arg) {
      console.log(discard(arg));
    } else if (cmd === 'list') {
      console.log(list());
    } else {
      console.log('usage: qexec.mjs run <plan.md> [--repo DIR] [--base REF] [--executor auto|qwen|claude] [--timeout-min N] [--max-turns N]\n       qexec.mjs list | report <id> | discard <id>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`qexec error: ${e.message}`);
    process.exit(2);
  }
}
