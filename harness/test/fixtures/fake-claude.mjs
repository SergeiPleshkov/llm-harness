// Stand-in for `claude -p` in ask tests: echoes its arguments and the prompt it got on stdin.
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { console.log(`CLAUDE args=[${process.argv.slice(2).join(' ')}] prompt=${JSON.stringify(input)}`); });
