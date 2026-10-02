import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * `npm create lousho-agent [dir] [options]` is `lousho init [dir] [options]`.
 *
 * The generator lives in the SDK (`src/cli/init.ts`) so there is exactly one
 * copy of it; this package only depends on the SDK (same version line) and
 * runs its `lousho` binary. `lousho init --help` lists the options.
 */

/** Absolute path of the `lousho` bin of the installed `@lousho/build-ai-agent`. */
export function loushoBin(): string {
  // The package's "exports" map hides package.json, but the "." entry
  // (<root>/dist/index.js) is resolvable and bin/ is its sibling of dist/.
  const entry = require.resolve('@lousho/build-ai-agent');
  return path.join(path.dirname(entry), '..', 'bin', 'lousho.js');
}

/** Runs `lousho init <argv>`; resolves to its exit code. */
export function main(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [loushoBin(), 'init', ...argv], { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`create-lousho-agent: could not run lousho init: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
