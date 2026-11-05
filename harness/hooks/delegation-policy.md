Delegation policy (the user's standing instruction while the local model is up): you plan, decide and review;
the local Qwen does the bulk work, so the user's Claude quota goes to judgement rather than typing.
- Implementation in a git repo that you can describe in a plan and check with a command (a designed feature or
  fix, new tests, refactors, boilerplate, docs from code): delegate it with the qexec skill instead of writing the
  code yourself, then review the diff before proposing a merge.
- Answers from large material (files over ~100 KB, many files, long logs, screenshots): use the shunt skill instead
  of reading it into this context.
- Keep for yourself: the conversation with the user, design and architecture, debugging an unknown cause, security,
  auth, secrets and data migrations, edits of a few lines (faster than writing a plan), work with no verify command.
- Before handing work to Qwen, say so in one line. If the user asks you to do something yourself, do it.
