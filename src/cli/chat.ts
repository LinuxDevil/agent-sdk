/**
 * `loushy chat <path> [--model provider/model] [--session id] [--store sqlite:<file>]`
 * - a terminal REPL for an agent (LOU-D33). The path is what `loushy dev`
 * takes (spec file, agent directory or TS module); the loop itself lives in
 * chatRepl.ts. Returns the exit code.
 */
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { CreateAgentConfig, SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { loadSpec } from '../spec/loadSpec';
import { specToAgent } from '../spec/specToAgent';
import type { AgentStore } from '../storage/agentStore';
import { runChatRepl } from './chatRepl';
import { detectTarget, loadTarget } from './devReload';

const USAGE = 'Usage: loushy chat <spec.yaml|spec.json|agent-dir|agent.ts> [--model provider/model] [--session id] [--store sqlite:<file>]';

export interface ChatArgs {
  path: string;
  model?: string;
  session?: string;
  /** The SQLite file of `--store sqlite:<file>`. */
  sqlite?: string;
}

function usageError(message: string): SDKError {
  return new SDKError(`loushy chat: ${message}`, 'LOUSHY_CONFIG_INVALID', {
    hint: USAGE,
  });
}

/** Parses the arguments after `chat`; throws `LOUSHY_CONFIG_INVALID` for a missing path, an unknown flag or a bad `--store`. */
export function parseChatArgs(args: string[]): ChatArgs {
  const flags: Record<string, string | undefined> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = /^--(model|session|store)(?:=(.*))?$/.exec(args[i]);
    if (match) flags[match[1]] = match[2] ?? args[++i];
    else if (args[i].startsWith('--')) throw usageError(`unknown option '${args[i]}'.`);
    else positional.push(args[i]);
  }
  if (positional.length !== 1) throw usageError('a path is required (a spec file, an agent directory or a .ts/.js agent module).');
  const sqlite = flags.store?.startsWith('sqlite:') ? flags.store.slice('sqlite:'.length) : undefined;
  if (flags.store !== undefined && !sqlite) throw usageError("--store must be 'sqlite:<file>'.");
  return {
    path: positional[0],
    model: flags.model,
    session: flags.session,
    sqlite,
  };
}

export interface ChatIo {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  /** `createAgent()` options that win over what the target says (tests pass a mock provider). */
  overrides?: CreateAgentConfig;
}

/** Builds the target's agent; `model` (`provider/model`) replaces the one it names. */
async function buildAgent(path: string, io: ChatIo, model?: string): Promise<SimpleAgent> {
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

/** Runs `loushy chat` with the arguments after `chat`. */
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
    if (parsed.sqlite) {
      const { SqliteStore } = await import('../storage/sqlite');
      store = new SqliteStore(parsed.sqlite);
    }
    const reader = (rl = readline.createInterface({
      input: io.stdin,
      output: io.stdout,
      terminal: io.stdin.isTTY === true,
    }));
    return await runChatRepl({
      input: reader,
      output: io.stdout,
      errorOutput: io.stderr,
      createAgent: (model) => buildAgent(parsed.path, io, model ?? parsed.model),
      store,
      model: parsed.model,
      sessionId: parsed.session,
      color: io.stdout.isTTY === true && !process.env.NO_COLOR,
      writePrompt: (text) => (reader.setPrompt(text), reader.prompt()),
    });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    rl?.close();
    store?.close();
  }
}
