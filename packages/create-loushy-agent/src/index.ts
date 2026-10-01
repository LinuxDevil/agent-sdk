import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * `npm create loushy-agent [dir] [options]` is `loushy init [dir] [options]`.
 *
 * The generator lives in the SDK (`src/cli/init.ts`) so there is exactly one
 * copy of it; this package only depends on the SDK (same version line) and
 * runs its `loushy` binary. `loushy init --help` lists the options.
 */

/** Absolute path of the `loushy` bin of the installed `@loushy/build-ai-agent`. */
export function loushyBin(): string {
  // The package's "exports" map hides package.json, but the "." entry
  // (<root>/dist/index.js) is resolvable and bin/ is its sibling of dist/.
  const entry = require.resolve('@loushy/build-ai-agent');
  return path.join(path.dirname(entry), '..', 'bin', 'loushy.js');
}

/** Runs `loushy init <argv>`; resolves to its exit code. */
export function main(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [loushyBin(), 'init', ...argv], { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`create-loushy-agent: could not run loushy init: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
