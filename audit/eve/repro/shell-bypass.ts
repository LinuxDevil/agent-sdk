/* Eve repro: createShellTool allow-list bypass candidates.
   A fake ShellProvider records what execute() actually runs. */
import { createShellTool } from '../../../src/tools/workspace/shellTool';

const run: string[] = [];
const fakeShell = {
  shell: '/bin/sh',
  async exec(command: string) {
    run.push(command);
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  },
};

const tool = createShellTool(fakeShell, {
  allow: ['cat'],
  needsApproval: false,
});

const exec = (tool as any).execute ?? (tool as any).tool?.execute;

async function tryCmd(command: string) {
  run.length = 0;
  try {
    const r = await exec({ command }, {});
    console.log(`RAN      ${JSON.stringify(command)} -> exit ${r.exitCode}`);
  } catch (e) {
    console.log(`REFUSED  ${JSON.stringify(command)} -> ${e instanceof Error ? e.message : e}`);
  }
}

await tryCmd('cat ../../etc/passwd');            // control: refused
await tryCmd('cat "../../etc/passwd"');          // quoted ..
await tryCmd("cat '../../etc/passwd'");          // single-quoted ..
await tryCmd('cat ~/../../secret');              // control: ~ caught
await tryCmd('cat "~/.ssh/id_rsa"');             // quoted ~
await tryCmd('cat /etc/passwd');                 // control: abs caught
await tryCmd('cat "/etc/passwd"');               // quoted abs
await tryCmd('cat ${IFS}../../etc/passwd');      // ${IFS} separator trick
await tryCmd('cat $IFS../../etc/passwd');        // $IFS
await tryCmd('cat $IFS/etc/passwd');             // $IFS + abs
await tryCmd('cat "x"../../etc/passwd');         // quoted prefix + ..
await tryCmd('cat x/../../y');                   // control: caught
await tryCmd('cat "..\\..\\win"');               // quoted backslash ..
