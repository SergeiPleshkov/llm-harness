---
name: qexec
description: Delegate a well-specified implementation step in a git repo to the local Qwen3.8-27B executor (falls back to Claude Sonnet when the local model is down). Use for implementing a planned change, writing tests, boilerplate or mechanical refactors with a clear verify command; then review the diff. Not for debugging unknown failures, architecture decisions, security-sensitive code or one-line edits.
---

# qexec: plan -> local executor -> review

You plan and review; a headless executor implements. qexec runs it in a separate git worktree on a
`qexec/<id>` branch, runs the plan's verify command, commits the result there and prints a report.
The user's working tree is never touched.

Script: `"$HOME/.llm-harness/repo/harness/qexec/qexec.mjs"` (the installer links `~/.llm-harness/repo` to the
harness repo on every machine; keep the double quotes so the shell expands `$HOME`).

## When to delegate

Delegate: implementation of a change you have already designed, new tests for known behavior,
boilerplate, mechanical refactors, docs generation from code. The task must have a command that
proves it is done (tests, build, lint, a script).

Do it yourself: debugging failures whose cause is unknown, architecture and API design, security,
auth, secrets or data-migration code, edits of a few lines, anything you cannot verify by a command.

The session-start context says whether the local model is running (on this PC or on the desktop over
Tailscale). If it is not, qexec still works but uses Claude Sonnet through the user's subscription:
tell the user before large runs.

## 1. Write the plan

Save it outside the repo, e.g. `~/.llm-harness/plans/<repo>-<short-slug>.md`. The executor sees only
this file and the repository, so make it self-contained:

````markdown
# <One-line goal>

## Context
What exists today, which files matter, conventions to follow.

## Task
Concrete steps. Name files, functions, signatures, edge cases.

## Acceptance criteria
- observable, checkable statements

## Out of scope
- what must not change

## Verify
```bash
npm ci && npm test
```
````

The `## Verify` section (also `## Проверка`) must contain a fenced command; exit code 0 means pass.
The worktree is a clean checkout: include dependency installation in the verify command when needed.
Uncommitted changes in the user's tree are not visible to the executor; commit or mention them first.

## 2. Run it

Runs take minutes (default limit 20 min), so start it in the background and wait for completion:

```bash
node "$HOME/.llm-harness/repo/harness/qexec/qexec.mjs" run "<plan.md>" --repo "<repo root>"
```

Options: `--base <ref>` (start from another commit or a previous `qexec/<id>` branch),
`--executor claude` (force Sonnet), `--timeout-min N`, `--max-turns N`.
Exit code: 0 verify passed, 1 verify failed, 2 harness error.

## 3. Review

The report gives the executor, any fallback and its reason, the verify result with the output tail,
a diff stat and the executor's own summary. Treat the summary as a claim, not evidence:

1. Read the diff: `git -C "<worktree>" diff <base> HEAD` (the report prints the exact command).
2. Check every acceptance criterion against the diff. Look for unrelated edits, deleted tests,
   weakened assertions, hard-coded expected values.
3. If needed, re-run the verify command yourself inside the worktree.

Then:
- Good: tell the user what changed and propose merging: `git -C "<repo>" merge --squash qexec/<id>`
  followed by a commit. Merge or commit only when the user agrees.
- Close but not done: write a follow-up plan and run it with `--base qexec/<id>`, or fix it yourself.
- Wrong: `node "$HOME/.llm-harness/repo/harness/qexec/qexec.mjs" discard <id>` and either re-plan or do it yourself.

Other commands: `qexec.mjs list` (all runs and their state), `qexec.mjs report <id>`.
Logs: `~/.llm-harness/runs/<id>/` (prompt, executor output, verify output, report) and
`~/.llm-harness/logs/delegations.jsonl`.
