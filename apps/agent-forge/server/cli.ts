/**
 * `lousho-studio` - the packaged Studio's own command.
 *
 * Bundled by `server/tsup.config.ts` to `dist-server/cli.cjs` (the package's
 * `bin`), it parses its flags, starts the same `startStudioServer()` the
 * `lousho studio` launcher spawns, prints the tokened URL and shuts down
 * cleanly on SIGINT/SIGTERM.
 *
 *   Usage: lousho-studio [--workspace <dir>] [--port N] [--host H]
 *
 *   Options:
 *     --workspace <dir>  a project folder to open (default: the current folder)
 *     --port N           the port (default 4750)
 *     --host H           the interface to listen on (default 127.0.0.1)
 *     -v, --version      print the version
 *     -h, --help         show this help
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shutdownOnSignals, startStudioServer } from './index';

export const USAGE = `Usage: lousho-studio [--workspace <dir>] [--port N] [--host H]

Opens Lousho Studio. It prints a URL with a per-launch token; every API and WebSocket request needs that token.

Options:
  --workspace <dir>  a project folder to open (default: the current folder); it is added to your workspaces
  --port N           the port (default 4750)
  --host H           the interface to listen on (default 127.0.0.1)
  -v, --version      print the version
  -h, --help         show this help`;

export interface StudioCliArgs {
  workspace?: string;
  port?: number;
  host?: string;
  version?: boolean;
  help?: boolean;
}

/** Thrown for a bad flag/value: the message is printed after `lousho-studio: ` with the usage. */
export class StudioCliUsageError extends Error {}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new StudioCliUsageError('--port must be an integer between 0 and 65535.');
  }
  return port;
}

/** Parses `lousho-studio` argv (without the node/script entries). Throws StudioCliUsageError on bad input. */
export function parseStudioCliArgs(argv: string[]): StudioCliArgs {
  let values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        workspace: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new StudioCliUsageError((error as Error).message);
  }
  const workspace = values.workspace as string | undefined;
  const host = values.host as string | undefined;
  const port = parsePort(values.port as string | undefined);
  return {
    ...(workspace !== undefined ? { workspace } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(values.version === true ? { version: true } : {}),
    ...(values.help === true ? { help: true } : {}),
  };
}

/** The installed package's version: `../package.json` from both `server/` (tsx) and `dist-server/` (the bundle). */
export function studioVersion(moduleDir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(moduleDir, '..', 'package.json'), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

async function main(): Promise<void> {
  let args: StudioCliArgs;
  try {
    args = parseStudioCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`lousho-studio: ${(error as Error).message}`);
    console.error(USAGE);
    process.exit(2);
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(studioVersion(moduleDir));
    return;
  }
  let workspaceDir = process.cwd();
  if (args.workspace !== undefined) {
    workspaceDir = path.resolve(args.workspace);
    if (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory()) {
      console.error(`lousho-studio: --workspace '${args.workspace}' is not a folder.`);
      process.exit(2);
    }
  }
  const port = args.port ?? 4750;
  const host = args.host ?? '127.0.0.1';
  let handle;
  try {
    handle = await startStudioServer({ port, host, baseDir: workspaceDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already in use/.test(message)) {
      console.error(`lousho-studio: port ${port} is in use. Is Studio already running? Start this one with --port ${port + 1}.`);
    } else {
      console.error(`lousho-studio: ${message}`);
    }
    process.exit(1);
  }
  console.log(`Lousho Studio ${studioVersion(moduleDir)}: ${handle.url}`);
  console.log(`Workspace: ${workspaceDir}`);
  shutdownOnSignals(handle);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  void main();
}
