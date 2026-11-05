import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// True when this module is the script node was started with, also when started through a link such as
// ~/.llm-harness/repo: node runs the module by its real path, while argv[1] keeps the link path.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return metaUrl === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

// Reads the JSON that Claude Code pipes to hooks and the status line. Returns {} on a TTY, bad JSON or no input.
export function readStdinJson(timeoutMs = 1000) {
  if (process.stdin.isTTY) return Promise.resolve({});
  const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(parse(data)), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(parse(data)); });
  });
}
