/**
 * `loushy build --target=<name> --agent=<path> [--out=<dir>]` (LOU-I1).
 *
 * Looks the target up in the DeploymentAdapter registry (src/deploy/types.ts)
 * and drives it through scaffold() -> build() -> describe(), printing the
 * describe() output (the command to run/deploy the artifact) to stdout.
 *
 * Flags are parsed by the shared helper in args.ts, so `--target=stub` and
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
import { parseCommand, stringValue, type CommandSpec } from './args';

export interface BuildArgs {
  target?: string;
  agent?: string;
  out?: string;
  /** `-h` / `--help` was given: print the usage, run nothing. */
  help?: boolean;
}

const USAGE = 'Usage: loushy build --target=<name> --agent=<path> [--out=<dir>]';

const SPEC: CommandSpec = {
  command: 'build',
  usage: USAGE,
  options: { target: { type: 'string' }, agent: { type: 'string' }, out: { type: 'string' } },
};

/** Parses `loushy build` arguments (`--flag=value` or `--flag value`); throws `LOUSHY_CONFIG_INVALID` for an unknown flag or a flag without its value. */
export function parseBuildArgs(argv: string[]): BuildArgs {
  const { values, help } = parseCommand(SPEC, argv);
  return { target: stringValue(values.target), agent: stringValue(values.agent), out: stringValue(values.out), help: help || undefined };
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

/**
 * Runs `loushy build` for the given argv (everything after `build`) and
 * resolves with the process exit code (0 on success, 1 on any error).
 * Never throws - adapter errors are reported on stderr.
 */
export async function runBuild(argv: string[], io: BuildIO = defaultIO): Promise<number> {
  let args: BuildArgs;
  try {
    args = parseBuildArgs(argv);
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}`);
    return 1;
  }
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }

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

  try {
    io.stdout(await driveAdapter(adapter, args, args.target));
    return 0;
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/** Runs scaffold() -> build() -> describe() and returns describe()'s output. */
async function driveAdapter(adapter: DeploymentAdapter, args: BuildArgs, target: string): Promise<string> {
  const agentPath = args.agent ? path.resolve(args.agent) : '';
  const outDir = path.resolve(args.out || path.join('.loushy', 'build', target));
  await adapter.scaffold(agentPath, outDir);
  await adapter.build(outDir);
  return adapter.describe(outDir);
}
