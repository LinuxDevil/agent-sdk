import { createShellTool } from '../../../src/tools/workspace/shellTool';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
const dir = path.dirname(ws);
const outside = path.join(dir, 'outside-secret-eve.txt');
fs.writeFileSync(outside, 'OUTSIDE-SECRET-12345');
fs.writeFileSync(path.join(ws, 'd.txt'), 'decoy');

const realShell = {
  shell: '/bin/sh',
  async exec(command: string) {
    try {
      const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: ws, encoding: 'utf8', timeout: 5000 });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (e: any) {
      return { stdout: e.stdout ?? '', stderr: String(e.message), exitCode: e.status ?? 1 };
    }
  },
};

const tool = createShellTool(realShell as any, { allow: ['cat'], needsApproval: false });
const exec = (tool as any).execute ?? (tool as any).tool?.execute;

for (const command of [
  'cat ../outside-secret-eve.txt',
  'cat $(echo ..)/outside-secret-eve.txt',
  'cat $PWD/../outside-secret-eve.txt',
  'cat ${PWD%/*}/outside-secret-eve.txt',
  'cat `echo ..`/outside-secret-eve.txt',
  'cat ~/../outside-secret-eve.txt',
  'cat [.]../outside-secret-eve.txt',
]) {
  try {
    const r = await exec({ command }, {});
    const out = (r.stdout ?? JSON.stringify(r)).toString();
    console.log(`ALLOWED ${JSON.stringify(command)} -> ${JSON.stringify(out.slice(0, 50))}${out.includes('OUTSIDE-SECRET') ? '  <== READ OUTSIDE' : ''}`);
  } catch (e) {
    console.log(`REFUSED ${JSON.stringify(command)} -> ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}`);
  }
}
