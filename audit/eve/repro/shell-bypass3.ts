import { createShellTool } from '../../../src/tools/workspace/shellTool';

const fakeSh = { shell: '/bin/sh', async exec(command: string) { return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
const fakeCmd = { shell: 'cmd.exe', async exec(command: string) { return { stdout: 'ok', stderr: '', exitCode: 0 }; } };

function mk(shell: any) {
  const tool = createShellTool(shell, { allow: ['cat', 'type'], needsApproval: false });
  return (tool as any).execute ?? (tool as any).tool?.execute;
}
const shExec = mk(fakeSh);
const cmdExec = mk(fakeCmd);

async function t(exec: any, command: string) {
  try { await exec({ command }, {}); console.log(`RAN      ${JSON.stringify(command)}`); }
  catch (e) { console.log(`REFUSED  ${JSON.stringify(command)} -> ${(e instanceof Error ? e.message : e).slice(0, 70)}`); }
}

console.log('--- POSIX glob/expansion tricks ---');
await t(shExec, 'cat [.][.]/x');            // glob class -> ..
await t(shExec, 'cat [.][.]/../x');         // ../x inside
await t(shExec, 'cat ?./x');                // ?. -> ..? no: ? then . => ".." ? "..x"? matches 2-char ".."? "?." matches ".."? ? = any char, then . => e.g. ".."? len 2: ?.=> ".." yes! -> "../x"? wait "?." is 2 chars "..", then "/x"
await t(shExec, 'cat ?../x');               // ?.. -> ".../"? 
await t(shExec, 'cat .?/x');                // .? -> ".."
await t(shExec, 'cat */../../x');           // glob * then ../../
console.log('--- cmd.exe ---');
await t(cmdExec, 'type "..\\x"');           // quoted ..
await t(cmdExec, 'type ..\\x');             // control
await t(cmdExec, 'type %HOMEDRIVE%\\x');    // % blocked
await t(cmdExec, 'type "!HOME!\\x"');       // delayed expansion %!%
await t(cmdExec, 'type c:\\windows\\x');    // abs win
await t(cmdExec, 'type "c:\\windows\\x"');  // quoted abs win
