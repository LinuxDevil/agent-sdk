import { createShellTool } from '../../../src/tools/workspace/shellTool';

const fakeShell = {
  shell: '/bin/sh',
  async exec(command: string) {
    return { stdout: 'ok', stderr: '', exitCode: 0 };
  },
};

const tool = createShellTool(fakeShell, { allow: ['cat'], needsApproval: false });
const exec = (tool as any).execute ?? (tool as any).tool?.execute;

async function tryCmd(command: string) {
  try {
    const r = await exec({ command }, {});
    console.log(`RAN      ${JSON.stringify(command)}`);
  } catch (e) {
    console.log(`REFUSED  ${JSON.stringify(command)} -> ${(e instanceof Error ? e.message : e).slice(0, 60)}`);
  }
}

await tryCmd('cat "../x"');                 // single-segment quoted ..
await tryCmd('cat "../a/b"');               // quoted .. then more
await tryCmd('cat ".."');                   // bare quoted ..
await tryCmd('cat ${IFS}../x');             // ${IFS} + single ..
await tryCmd('cat $IFS../x');               // $IFS + single ..
await tryCmd('cat ${IFS}~/.ssh/id_rsa');    // ${IFS} + ~
await tryCmd('cat a"~"/x');                 // mid-token quoted ~ (concatenation)
await tryCmd('cat "x"~/../y');              // concat quoted + ~
await tryCmd('cat x=~/../y');               // = ~ caught?
await tryCmd('cat "--out=../x"');           // quoted whole --flag
await tryCmd('cat "~root/x"');              // ~user form
await tryCmd('cat {..,x}');                 // brace expansion ..
await tryCmd('cat [.]../x');                // glob char trick?
await tryCmd('cat .${x:-.}/../y');          // ${x:-.} -> . -> ../
await tryCmd('cat ${HOME}/x');              // ~ equivalent via $HOME
