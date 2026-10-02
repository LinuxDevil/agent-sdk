/**
 * `lousho acp <path> [--model provider/model]` - serve an agent over the
 * Agent Client Protocol on stdio, for editors such as Zed (LOU-Z6). The path
 * is what `lousho chat` takes. stdout carries only protocol messages, so
 * everything else (errors, the agent's own console output) goes to stderr.
 */
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { serveAcp } from '../acp/serveAcp';
import type { CreateAgentConfig } from '../createAgent';
import { parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { buildAgent } from './chat';

const USAGE = 'Usage: lousho acp <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model]';

const SPEC: CommandSpec = { command: 'acp', usage: USAGE, positionals: 1, options: { model: { type: 'string' } } };

/** Parses the arguments after `acp`; throws `LOUSHO_CONFIG_INVALID` for a missing path, an unknown flag or a flag without its value. */
export function parseAcpArgs(args: string[]): { path: string; model?: string; help?: boolean } {
  const { values, positionals, help } = parseCommand(SPEC, args);
  if (help) return { path: '', help };
  if (positionals.length !== 1) throw usageError(SPEC, 'a path is required (a spec file, an agent directory or a .ts/.js agent module).');
  return { path: positionals[0], model: stringValue(values.model) };
}

export interface AcpIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** `createAgent()` options that win over what the target says (tests pass a mock provider). */
  overrides?: CreateAgentConfig;
}

/** Sends `console.log/info/debug` to stderr while `run` runs, so they cannot corrupt the protocol on stdout. */
async function withConsoleOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  Object.assign(console, { log: console.error, info: console.error, debug: console.error });
  try {
    return await run();
  } finally {
    Object.assign(console, saved);
  }
}

/** Runs `lousho acp` with the arguments after `acp` until stdin ends; resolves with the exit code. */
export async function runAcp(args: string[], io: AcpIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  try {
    const parsed = parseAcpArgs(args);
    if (parsed.help) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const agent = await buildAgent(parsed.path, io, parsed.model);
    const input = readline.createInterface({ input: io.stdin, crlfDelay: Infinity });
    try {
      await withConsoleOnStderr(() => serveAcp(agent, { input, write: (line) => void io.stdout.write(`${line}\n`) }));
    } finally {
      input.close();
      await agent.close().catch(() => undefined);
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
