// Stand-in for qwen-code / claude in qexec tests: node fake-executor.mjs <qwen|claude>
// QEXEC_FAKE_MODE: ok (writes answer.txt so verify passes) | fail (changes nothing) | qwen-crash (qwen exits 3, claude works)
import fs from 'node:fs';

const name = process.argv[2];
const mode = process.env.QEXEC_FAKE_MODE || 'ok';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (mode === 'qwen-crash' && name === 'qwen') { console.error('API error: fetch failed (ECONNREFUSED)'); process.exit(3); }
  if (mode === 'fail') {
    console.log(JSON.stringify({ type: 'result', result: 'could not do it', num_turns: 1, usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }
  fs.writeFileSync('answer.txt', `done by ${name}\n`);
  console.log(JSON.stringify([
    { type: 'system' },
    { type: 'result', result: `wrote answer.txt as ${name}; plan received: ${input.includes('=== PLAN ===')}`, num_turns: 2,
      usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 20 } },
  ]));
});
