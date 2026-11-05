---
name: shunt
description: Let the local Qwen3.8-27B read large files, many files, long logs or screenshots and return a short cited answer instead of loading the raw content into this context. Use when you need an answer from material over ~100 KB (a big source file, a build or server log, a directory you are surveying), or when a Read of a large file was turned away with a pointer to shunt.
---

# shunt: big reads through the local model

The local model reads the material and answers one question with `path:line` citations. Your context
receives only the answer. File contents go in the request body, so size is limited only by the
model's window (about 90-100k tokens of input per call).

Script: `"$HOME/.llm-harness/repo/harness/shunt/shunt.mjs"` (the installer links `~/.llm-harness/repo` to the
harness repo on every machine; keep the double quotes so the shell expands `$HOME`).

```bash
node "$HOME/.llm-harness/repo/harness/shunt/shunt.mjs" read "<question>" <file|dir|glob>...   # source files, configs, docs
node "$HOME/.llm-harness/repo/harness/shunt/shunt.mjs" logs "<question>" <file|->              # logs; huge ones are cut to head, tail and error lines
node "$HOME/.llm-harness/repo/harness/shunt/shunt.mjs" vision "<question>" <image>             # screenshots, diagrams
```

When the local model runs on the desktop and you are on the laptop, the material is sent over Tailscale;
that is fine, it never leaves the user's machines.

Add `--think` for questions that need reasoning (root cause, "why does X happen"); it is slower.
Directories skip `.git`, `node_modules`, virtualenvs and build output; binary files are skipped.
The footer line shows files, tokens and whether input was cut or skipped.

## Asking well

Ask for what you will act on, not "summarize": "Which function builds the auth header and what does it
do with an expired token? Cite lines." / "What is the first error in this log and what preceded it?" /
"List every config key read from env in these files with file:line."

## Trust, but check

The answer is a lead, not ground truth. Before you edit code or tell the user a fact that matters,
Read the cited lines yourself with `offset`/`limit` (a targeted read is never turned away).

## When it is not available

Exit code 3 means the local model is down or failed: read the material yourself, preferably in parts
with offset/limit. Exit code 2 is a usage or input error.

## The Read hook

While the local model is up, a whole-file Read of a text file over 128 KB is turned away once per
session with the exact shunt command. Retrying the same Read is allowed when you really need the full
file; reads with offset/limit are never blocked. The user can disable it with `LLM_HARNESS_SHUNT=off`.
