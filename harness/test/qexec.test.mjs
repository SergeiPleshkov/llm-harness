import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qexec-test-'));
process.env.LLM_HARNESS_HOME = path.join(tmp, 'home');
process.env.QEXEC_FAKE_EXECUTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-executor.mjs');
const { parsePlan, slugify } = await import('../qexec/plan.mjs');
const { run, discard } = await import('../qexec/qexec.mjs');

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(tmp, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), 'toy\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const PLAN = `# Write the answer file

Create answer.txt in the repository root.

## Verify
\`\`\`bash
node -e "process.exit(require('fs').existsSync('answer.txt') ? 0 : 1)"
\`\`\`
`;
const planFile = path.join(tmp, 'plan.md');
fs.writeFileSync(planFile, PLAN);

// backend config: a fake llama-server (up) or a closed port (down)
async function setBackend(up) {
  let url;
  if (up) {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
    });
    servers.push(s);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${s.address().port}`;
  } else {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${s.address().port}`;
    await new Promise((r) => s.close(r));
  }
  const home = process.env.LLM_HARNESS_HOME;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ endpoints: [{ name: 't', url, model: 'qwen3.8-27b' }], cacheTtlMs: 0 }));
}

test('parsePlan extracts title and verify command', () => {
  const p = parsePlan(PLAN);
  assert.equal(p.title, 'Write the answer file');
  assert.match(p.verify, /existsSync\('answer.txt'\)/);
});

test('parsePlan stops at the next heading and accepts "Проверка"', () => {
  assert.throws(() => parsePlan('# T\n## Verify\nrun tests\n## Notes\n```\nnot this\n```\n'), /no fenced command/);
  assert.equal(parsePlan('# T\n### Проверка\n~~~\nnpm test\n~~~\n').verify, 'npm test');
  assert.throws(() => parsePlan('# T\nno verify here\n'), /no "## Verify"/);
});

test('slugify', () => {
  assert.equal(slugify('Add slugify() to utils!'), 'add-slugify-to-utils');
  assert.equal(slugify('Тест'), 'task');
});

test('healthy local model: qwen executes, verify passes, result committed on the branch', async () => {
  await setBackend(true);
  process.env.QEXEC_FAKE_MODE = 'ok';
  const repo = makeRepo('repo-ok');
  const { report, md } = await run(planFile, { repo });
  assert.equal(report.executor.name, 'qwen');
  assert.equal(report.fallbackReason, null);
  assert.equal(report.verify.passed, true);
  assert.equal(report.committed, true);
  assert.equal(report.changes.files, 1);
  assert.match(report.executor.summary, /plan received: true/);
  assert.equal(report.executor.inTokens, 1110, 'cached prompt tokens are counted as input');
  assert.equal(git(repo, 'show', `${report.branch}:answer.txt`), 'done by qwen');
  assert.equal(fs.existsSync(path.join(repo, 'answer.txt')), false, 'main working tree must stay untouched');
  assert.match(md, /: PASS/);
  const log = fs.readFileSync(path.join(process.env.LLM_HARNESS_HOME, 'logs', 'delegations.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(log.at(-1)).id, report.id);
});

test('local model down: falls back to claude and says why', async () => {
  await setBackend(false);
  process.env.QEXEC_FAKE_MODE = 'ok';
  const { report } = await run(planFile, { repo: makeRepo('repo-down') });
  assert.equal(report.executor.name, 'claude');
  assert.match(report.fallbackReason, /unavailable: down/);
  assert.equal(report.verify.passed, true);
});

test('qwen crashes without changes: falls back to claude', async () => {
  await setBackend(true);
  process.env.QEXEC_FAKE_MODE = 'qwen-crash';
  const { report } = await run(planFile, { repo: makeRepo('repo-crash') });
  assert.equal(report.executor.name, 'claude');
  assert.match(report.fallbackReason, /exited with 3/);
  assert.equal(report.verify.passed, true);
});

test('executor changes nothing: verify fails, nothing committed', async () => {
  await setBackend(true);
  process.env.QEXEC_FAKE_MODE = 'fail';
  const { report, md } = await run(planFile, { repo: makeRepo('repo-fail') });
  assert.equal(report.verify.passed, false);
  assert.equal(report.committed, false);
  assert.equal(report.changes.files, 0);
  assert.match(md, /: FAIL/);
});

test('dirty main tree is reported; discard removes worktree and branch', async () => {
  await setBackend(true);
  process.env.QEXEC_FAKE_MODE = 'ok';
  const repo = makeRepo('repo-dirty');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'local edit\n');
  const { report } = await run(planFile, { repo });
  assert.match(report.warnings.join('\n'), /uncommitted changes/);
  assert.ok(fs.existsSync(report.worktree));
  discard(report.id);
  assert.equal(fs.existsSync(report.worktree), false);
  assert.equal(git(repo, 'branch', '--list', report.branch), '');
});
