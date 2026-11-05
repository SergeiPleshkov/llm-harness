// Status line: [model] · folder · context use · local Qwen status (backend check cached for 30 s).
import path from 'node:path';
import { resolveBackend } from './lib/backend.mjs';
import { readStdinJson } from './lib/io.mjs';

const GREEN = '\x1b[32m', GRAY = '\x1b[90m', RESET = '\x1b[0m';
const d = await readStdinJson();

let qwen;
try {
  const b = await resolveBackend();
  qwen = b.ok ? `${GREEN}● Qwen${RESET}` : `${GRAY}○ Qwen: ${b.reason}${RESET}`;
} catch { qwen = `${GRAY}○ Qwen: ?${RESET}`; }

const pct = d.context_window?.used_percentage;
const parts = [
  d.model?.display_name && `[${d.model.display_name}]`,
  d.workspace?.current_dir && path.basename(d.workspace.current_dir),
  pct != null && `ctx ${Math.round(pct)}%`,
  qwen,
].filter(Boolean);
process.stdout.write(parts.join(' · '));
process.exit(0);
