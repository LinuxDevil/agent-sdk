/**
 * Shell tool on Windows: quoting under cmd.exe vs bash, env isolation, exit
 * codes, and how far a string `allow` prefix reaches.
 *   npx tsx coding-agent/repro/shell-windows.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShellTool, NodeWorkspace } from '@lousho/build-ai-agent';

const base = mkdtempSync(path.join(tmpdir(), 'lousho-shell-'));
const root = path.join(base, 'root');
mkdirSync(path.join(root, 'test'), { recursive: true });
writeFileSync(path.join(root, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}');
writeFileSync(path.join(root, 'test', 'a.test.js'), "import {test} from 'node:test'; test('a', () => {});\n");
process.env.FAKE_SECRET_TOKEN = 'sk-should-not-leak';
const ctx = { toolCallId: 't', abortSignal: new AbortController().signal } as never;
type R = { exitCode: number | null; stdout: string; stderr: string };

async function run(label: string, ws: NodeWorkspace, command: string, allow?: string[]) {
  const tool = createShellTool(ws, { needsApproval: false, allow }) as unknown as { execute: (a: unknown, c: unknown) => Promise<R> };
  try {
    const r = await tool.execute({ command }, ctx);
    console.log(`[${label}] ${command}\n    exit=${r.exitCode} out=${JSON.stringify(r.stdout.trim().slice(0, 140))} err=${JSON.stringify(r.stderr.trim().slice(0, 120))}`);
  } catch (e) {
    console.log(`[${label}] ${command}\n    REFUSED ${(e as Error).message.slice(0, 160)}`);
  }
}

const cmd = new NodeWorkspace({ root });
console.log('--- default shell (cmd.exe) ---');
await run('cmd', cmd, 'echo "double" \'single\'');
await run('cmd', cmd, 'node -e "console.log(process.argv.slice(1))" "a b" \'c d\'');
await run('cmd', cmd, 'node --test "test/a.test.js"');
await run('cmd', cmd, "node --test 'test/a.test.js'");
await run('cmd', cmd, 'echo %USERPROFILE% %FAKE_SECRET_TOKEN%');
await run('cmd', cmd, 'set');
await run('cmd', cmd, 'ls');
await run('cmd', cmd, 'exit 3');
await run('cmd', cmd, 'definitely-not-a-command');

const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
if (existsSync(bashPath)) {
  console.log('--- NodeWorkspace({ shell: bash }) ---');
  const bash = new NodeWorkspace({ root, shell: bashPath });
  await run('bash', bash, "echo 'single' \"double\" $HOME");
  await run('bash', bash, 'node --test test/a.test.js');
  await run('bash', bash, 'ls');
}

console.log('--- string allow prefixes accept any trailing arguments ---');
const allow = ['node --test', 'npm test', 'git diff'];
await run('allow', cmd, 'node --test --test-reporter=spec --test-reporter-destination=../escaped-report.txt', allow);
await run('allow', cmd, 'node --test --import=data:text/javascript,import("node:fs").then(function(f){f.writeFileSync("../escaped-import.txt","code ran")})', allow);
await run('allow', cmd, 'git diff --no-index --output=../escaped-diff.txt package.json test/a.test.js', allow);
await run('allow', cmd, 'npm test -- --test-reporter-destination=../escaped-npm.txt', allow);
await run('allow', cmd, 'node --test ^& echo chained', allow);
await run('allow', cmd, 'node --test %COMSPEC%', allow);
for (const f of ['escaped-report.txt', 'escaped-import.txt', 'escaped-diff.txt', 'escaped-npm.txt']) console.log(`  outside root: ${f} exists=${existsSync(path.join(base, f))}`);
rmSync(base, { recursive: true, force: true });
