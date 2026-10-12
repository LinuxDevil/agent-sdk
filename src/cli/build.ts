/**
 * `lousho build --target=<name> --agent=<path> [--out=<dir>]` (LOU-I1).
 *
 * Looks the target up in the DeploymentAdapter registry (src/deploy/types.ts)
 * and drives it through scaffold() -> build() -> describe(), printing the
 * describe() output (the command to run/deploy the artifact) to stdout.
 *
 * Flags are parsed by the shared helper in args.ts, so `--target=stub` and
 * `--target stub` both work.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DeploymentAdapter,
  getAdapter,
  listAdapters,
  registerAdapter,
  registerBuiltInAdapters,
} from '../deploy';
import { findSdkRoot } from '../deploy/bundle';
import { USAGE_EXIT_CODE, exitCodeFor, parseCommand, stringValue, type CommandSpec } from './args';
import { missingProviderPeerWarning } from './buildPeers';

export interface BuildArgs {
  target?: string;
  agent?: string;
  out?: string;
  /** `-h` / `--help` was given: print the usage, run nothing. */
  help?: boolean;
}

const USAGE = 'Usage: lousho build <agent-dir|spec|agent.ts> --target=<node-server|cloudflare-worker|docker> [--out=<dir>]   (or --agent=<path>)';

const HELP = `${USAGE}

Bundles an agent spec (agent.yaml / agent.json), an agent directory or (node-server, docker) a .ts/.js
module exporting createAgent() options or an agent, for deployment.

Targets:
  node-server        a self-contained Node HTTP server (dist/server.js)
  cloudflare-worker  a module Worker, wrangler.toml and dist/worker.js (needs tsup and wrangler)
  docker             the node-server build plus a Dockerfile

Options:
  --target=<name>    the deployment target (required)
  --out=<dir>        where to write the build (default: .lousho/build/<target>)
  --agent=<path>     the spec file, agent directory or module (or pass it as the first argument)
  -h, --help         show this help`;

const SPEC: CommandSpec = {
  command: 'build',
  usage: USAGE,
  positionals: 1,
  options: { target: { type: 'string' }, agent: { type: 'string' }, out: { type: 'string' } },
};

/** Parses `lousho build` arguments (`--flag=value` or `--flag value`); throws `LOUSHO_CONFIG_INVALID` for an unknown flag or a flag without its value. */
export function parseBuildArgs(argv: string[]): BuildArgs {
  const { values, positionals, help } = parseCommand(SPEC, argv);
  // `lousho build <agent-dir|spec>` is `--agent=<path>`.
  return { target: stringValue(values.target), agent: stringValue(values.agent) ?? positionals[0], out: stringValue(values.out), help: help || undefined };
}

/**
 * Test-only adapter, registered under 'stub' only when LOUSHO_BUILD_STUB_ADAPTER=1
 * (the subprocess test sets it; in-process tests register it): each lifecycle
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
if (process.env.LOUSHO_BUILD_STUB_ADAPTER === '1') registerAdapter('stub', stubAdapter);

export interface BuildIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Where the agent's provider package is looked up (default: the SDK's own folder, as the bundler does). */
  resolveFrom?: string;
}

const defaultIO: BuildIO = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

/**
 * Runs `lousho build` for the given argv (everything after `build`) and
 * resolves with the process exit code (0 on success, 2 for a usage error, 1 for
 * any other error).
 * Never throws - adapter errors are reported on stderr.
 */
export async function runBuild(argv: string[], io: BuildIO = defaultIO): Promise<number> {
  let args: BuildArgs;
  try {
    args = parseBuildArgs(argv);
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}`);
    return exitCodeFor(error);
  }
  if (args.help) {
    io.stdout(HELP);
    return 0;
  }

  if (!args.target) {
    io.stderr(`Error: --target is required. ${USAGE}`);
    return USAGE_EXIT_CODE;
  }

  const adapter = getAdapter(args.target);
  if (!adapter) {
    io.stderr(
      `Error: unknown target "${args.target}". Known targets: ${listAdapters().join(', ')}`
    );
    return USAGE_EXIT_CODE;
  }

  if (!args.agent) {
    io.stderr(`Error: an agent path is required. ${USAGE}`);
    return USAGE_EXIT_CODE;
  }

  try {
    io.stdout(await driveAdapter(adapter, args, args.target, io));
    return 0;
  } catch (error) {
    io.stderr(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/** Runs scaffold() -> build() -> describe() and returns where it wrote plus describe()'s output (the command to run there). */
async function driveAdapter(adapter: DeploymentAdapter, args: BuildArgs, target: string, io: BuildIO): Promise<string> {
  const agentPath = path.resolve(args.agent ?? '');
  const outDir = path.resolve(args.out || path.join('.lousho', 'build', target));
  if (args.out && isNonEmptyDir(outDir)) {
    io.stderr(`Warning: --out ${args.out} is not empty; files the build writes replace the ones there.`);
  }
  const peerWarning = missingProviderPeerWarning(agentPath, io.resolveFrom ?? findSdkRoot(), target);
  if (peerWarning) io.stderr(peerWarning);
  await adapter.scaffold(agentPath, outDir);
  await adapter.build(outDir);
  const shown = path.relative(process.cwd(), outDir) || '.';
  return `Built ${target} in ${shown}. From there, run:\n${adapter.describe(outDir)}`;
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
