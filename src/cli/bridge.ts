/**
 * `lousho bridge` — Studio's project bridge (W10a): speaks the NDJSON
 * protocol of `src/bridge/server.ts` on stdin/stdout so Studio can build
 * and run this project's agents with this project's own SDK and
 * dependencies. Studio starts it; nobody runs it by hand. `--help` prints
 * usage; every other argument is a usage error. `.env` is loaded by the
 * `bin/lousho.js` command table (`env: true`).
 */
import { exitCodeFor, parseCommand, type CommandSpec } from './args';
import { serveBridge, type BridgeIo } from '../bridge/server';

const USAGE = 'Usage: lousho bridge';

const HELP = `${USAGE}

Speaks Lousho Studio's bridge protocol (NDJSON) on stdin/stdout, so Studio can build and run this
project's agents with this project's own SDK and dependencies. Studio starts it; you do not need to.
./.env is loaded when it exists (variables already set win).

Options:
  -h, --help  show this help`;

const SPEC: CommandSpec = { command: 'bridge', usage: USAGE, positionals: 0, options: {} };

const DEFAULT_IO: BridgeIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };

/** Runs `lousho bridge` until shutdown or stdin ends; resolves with the exit code. */
export async function runBridge(args: string[], io: BridgeIo = DEFAULT_IO): Promise<number> {
  try {
    const { help } = parseCommand(SPEC, args);
    if (help) {
      io.stdout.write(`${HELP}\n`);
      return 0;
    }
    return await serveBridge({ ...io, root: io.root ?? process.cwd() });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return exitCodeFor(error);
  }
}
