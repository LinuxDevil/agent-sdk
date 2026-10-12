/**
 * sec-sandbox-writefile: SandboxAdapter.writeFile is documented as writing "inside the
 * sandbox's filesystem view". SubprocessSandbox (the Docker "real isolation" adapter)
 * writes to an arbitrary HOST path, with no confinement, and no Docker needed.
 */
import { SubprocessSandbox } from '@lousho/build-ai-agent';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sandbox = new SubprocessSandbox({ network: 'none' });
// a path a model-controlled tool arg could name: outside any cwd, e.g. a startup script
const target = join(tmpdir(), '..', 'lousho-escape-proof.txt');
await sandbox.writeFile(target, 'written by SubprocessSandbox.writeFile');
console.log('host file now contains:', JSON.stringify(readFileSync(target, 'utf8')), 'at', target);
rmSync(target);
