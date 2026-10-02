/**
 * `lousho chat <path> [--model provider/model] [--session id] [--store sqlite:<file>]`
 * - a terminal REPL for an agent (LOU-D33). The path is what `lousho dev`
 * takes (spec file, agent directory or TS module); the loop itself lives in
 * chatRepl.ts. Returns the exit code.
 */
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { CreateAgentConfig, SimpleAgent } from '../createAgent';
import { loadSpec } from '../spec/loadSpec';
import { specToAgent } from '../spec/specToAgent';
import type { AgentStore } from '../storage/agentStore';
import { parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { runChatRepl } from './chatRepl';
import { detectTarget, loadTarget } from './devReload';

const USAGE = 'Usage: lousho chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>]';

export interface ChatArgs {
  path: string;
  model?: string;
  session?: string;
  /** The SQLite file of `--store sqlite:<file>`. */
  sqlite?: string;
  /** `-h` / `--help` was given: print the usage, run nothing. */
  help?: boolean;
}

const SPEC: CommandSpec = {
  command: 'chat',
  usage: USAGE,
  positionals: 1,
  options: { model: { type: 'string' }, session: { type: 'string' }, store: { type: 'string' } },
};

/** Parses the arguments after `chat`; throws `LOUSHO_CONFIG_INVALID` for a missing path, an unknown flag, a flag without its value or a bad `--store`. */
export function parseChatArgs(args: string[]): ChatArgs {
  const { values, positionals, help } = parseCommand(SPEC, args);
  if (help) return { path: '', help };
  if (positionals.length !== 1) throw usageError(SPEC, 'a path is required (a spec file, an agent directory or a .ts/.js agent module).');
  const store = stringValue(values.store);
  const sqlite = store?.startsWith('sqlite:') ? store.slice('sqlite:'.length) : undefined;
  if (store !== undefined && !sqlite) throw usageError(SPEC, "--store must be 'sqlite:<file>'.");
  return { path: positionals[0], model: stringValue(values.model), session: stringValue(values.session), sqlite };
}

export interface ChatIo {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  /** `createAgent()` options that win over what the target says (tests pass a mock provider). */
  overrides?: CreateAgentConfig;
}

/** Builds the target's agent; `model` (`provider/model`) replaces the one it names. Shared with `lousho acp`. */
export async function buildAgent(path: string, io: Pick<ChatIo, 'overrides'>, model?: string): Promise<SimpleAgent> {
  const target = detectTarget(path);
  if (target.kind === 'spec' && model) {
    const spec = loadSpec(target.path);
    const [type, ...name] = model.split('/');
    return specToAgent({ ...spec, provider: { type, model: name.join('/') } });
  }
  const overrides = {
    ...io.overrides,
    ...(model && { model, provider: undefined }),
  } as CreateAgentConfig;
  return loadTarget(target, { overrides });
}

/** Runs `lousho chat` with the arguments after `chat`. */
export async function runChat(
  args: string[],
  io: ChatIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }
): Promise<number> {
  let store: (Required<AgentStore> & { close(): void }) | undefined;
  let rl: readline.Interface | undefined;
  try {
    const parsed = parseChatArgs(args);
    if (parsed.help) {
      io.stdout.write(`${USAGE}
`);
      return 0;
    }
    if (parsed.sqlite) {
      const { SqliteStore } = await import('../storage/sqlite');
      store = new SqliteStore(parsed.sqlite);
    }
    const reader = (rl = readline.createInterface({
      input: io.stdin,
      output: io.stdout,
      terminal: io.stdin.isTTY === true,
    }));
    let closed = false;
    reader.once('close', () => (closed = true));
    return await runChatRepl({
      input: reader,
      output: io.stdout,
      errorOutput: io.stderr,
      createAgent: (model) => buildAgent(parsed.path, io, model ?? parsed.model),
      store,
      model: parsed.model,
      sessionId: parsed.session,
      color: io.stdout.isTTY === true && !process.env.NO_COLOR,
      // Piped input can end (closing readline) while queued lines are still being
      // answered; prompt() throws on a closed interface on newer Node versions.
      writePrompt: (text) => (closed ? void io.stdout.write(text) : (reader.setPrompt(text), reader.prompt())),
    });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    rl?.close();
    store?.close();
  }
}
