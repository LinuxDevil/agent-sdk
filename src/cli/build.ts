/**
 * `loushy build --target=<name> --agent=<path> [--out=<dir>]` (LOU-I1).
 *
 * Looks the target up in the DeploymentAdapter registry (src/deploy/types.ts)
 * and drives it through scaffold() -> build() -> describe(), printing the
 * describe() output (the command to run/deploy the artifact) to stdout.
 *
 * Flag parsing deliberately follows the same hand-rolled convention
 * bin/loushy.js already uses for `loushy dev`'s --port/--host: find the
 * first arg starting with `--<name>`, take its value from after `=` or,
 * failing that, from the next argv entry. So `--target=stub` and
 * `--target stub` both work.
 */
import * as path from 'node:path';
import {
  DeploymentAdapter,
  getAdapter,
  listAdapters,
  registerAdapter,
  registerBuiltInAdapters,
} from '../deploy';

export interface BuildArgs {
  target?: string;
  agent?: string;
  out?: string;
}

function readFlag(argv: string[], name: string): string | undefined {
  const flag = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!flag) return undefined;
  const inline = flag.split('=')[1];
  if (inline) return inline;
  const next = argv[argv.indexOf(flag) + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

export function parseBuildArgs(argv: string[]): BuildArgs {
  return {
    target: readFlag(argv, 'target'),
    agent: readFlag(argv, 'agent'),
    out: readFlag(argv, 'out'),
  };
}

/**
 * Test-only adapter registered under 'stub' at CLI startup: each lifecycle
 * method records its own name in `stubAdapterCalls`, so tests can assert
 * the exact order runBuild() drives an adapter in. describe() also returns
 * the recorded order, which lets a subprocess smoke test (which can't see
 * this module's memory) observe it via stdout.
 */
export const stubAdapterCalls: string[] = [];

export const stubAdapter: DeploymentAdapter = {
  async scaffold() {
    stubAdapterCalls.push('scaffold');
  },
  async build() {
    stubAdapterCalls.push('build');
  },
  describe() {
    stubAdapterCalls.push('describe');
    return `stub adapter calls: ${stubAdapterCalls.join(',')}`;
  },
};

registerBuiltInAdapters();
registerAdapter('stub', stubAdapter);

export interface BuildIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIO: BuildIO = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

const USAGE = 'Usage: loushy build --target=<name> --agent=<path> [--out=<dir>]';

/**
 * Runs `loushy build` for the given argv (everything after `build`) and
 * resolves with the process exit code (0 on success, 1 on any error).
 * Never throws - adapter errors are reported on stderr.
 */
export async function runBuild(argv: string[], io: BuildIO = defaultIO): Promise<number> {
  const args = parseBuildArgs(argv);

  if (!args.target) {
    io.stderr(`Error: --target is required. ${USAGE}`);
    return 1;
  }

  const adapter = getAdapter(args.target);
  if (!adapter) {
    io.stderr(
      `Error: unknown target "${args.target}". Known targets: ${listAdapters().join(', ')}`
    );
    return 1;
  }

  const agentPath = args.agent ? path.resolve(args.agent) : '';
  const outDir = path.resolve(args.out || path.join('.loushy', 'build', args.target));

  try {
    await adapter.scaffold(agentPath, outDir);
    await adapter.build(outDir);
    io.stdout(adapter.describe(outDir));
    return 0;
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}`);
    return 1;
  }
}
