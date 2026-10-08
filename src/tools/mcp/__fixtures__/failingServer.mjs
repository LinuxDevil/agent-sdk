// A stdio "MCP server" that never works, for connect.test.ts (audit D4).
// FIXTURE_MODE=exit: writes to stderr and exits with code 3. FIXTURE_MODE=silent: never answers.
if (process.env.FIXTURE_MODE === 'silent') {
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  for (let i = 1; i <= 30; i++) process.stderr.write(`log line ${i}\n`);
  process.stderr.write('npm error 404 Not Found - GET https://registry.npmjs.org/no-such-mcp\n');
  process.exit(3);
}
