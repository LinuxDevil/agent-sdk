/**
 * `lousho prompt` - the prompt-registry command. It talks to a running
 * collector daemon (`lousho observe start`), never to the SQLite file.
 *
 *   lousho prompt push <file|-> --name N [--labels a,b] [--variables x,y]
 *   lousho prompt list [--json]
 *   lousho prompt get <name[@version]> [--json]
 *
 * `push` reads the prompt text from a file (`-` = stdin) and publishes a new
 * version; an identical republish is deduped daemon side (`created: false`).
 * `list` shows one row per name; `get` prints a version's text - `@version`
 * is an integer or `latest` (resolved daemon side, like the agents' fetch).
 *
 * The daemon is found at `--url`, else `LOUSHO_OBSERVE`'s resolution, else
 * `http://127.0.0.1:<--port|LOUSHO_OBSERVE_PORT|7777>`; `--token` /
 * `LOUSHO_OBSERVE_TOKEN` authenticates when the daemon requires it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fetchPrompt, listPrompts, parsePromptRef, publishPrompt, type PromptRef } from '../observe/promptClient';
import { OBSERVE_DEFAULT_PORT } from '../observe/envelope';
import { observeTargetFromEnv } from '../observe/emit';
import { exitCodeFor, parseCommand, portValue, stringValue, usageError, type CommandSpec } from './args';

const USAGE = `Usage: lousho prompt <command> [options]
  prompt push <file|-> --name N [--labels a,b] [--variables x,y] [--url U | --port N] [--token T]
  prompt list [--url U | --port N] [--token T] [--json]
  prompt get <name[@version]> [--url U | --port N] [--token T] [--json]`;

const HELP = `${USAGE}

Manages the prompt registry a 'lousho observe' collector serves. Agents run with
createAgent({ prompt: 'name@version' }) or LOUSHO_PROMPT=name@version and fetch their
instructions here at build (falling back to embedded instructions when the daemon is down).

Options:
  --name N       'push': the registry name (default: the file's basename, e.g. prompts/mira.txt -> mira; required for '-')
  --labels a,b   'push': comma-separated labels stored with the version
  --variables x,y  'push': comma-separated variable names stored with the version
  --url U        the daemon's base URL (default: LOUSHO_OBSERVE's resolution, else http://127.0.0.1:<port>)
  --port N       the daemon's port when no URL is given (default ${OBSERVE_DEFAULT_PORT}, or LOUSHO_OBSERVE_PORT)
  --token T      bearer token (default LOUSHO_OBSERVE_TOKEN) for a daemon that requires one
  --json         'list' and 'get': print the raw JSON
  -h, --help     show this help`;

type PromptSubcommand = 'push' | 'list' | 'get';

const DAEMON_OPTIONS = {
  url: { type: 'string' },
  port: { type: 'string' },
  token: { type: 'string' },
} as const;

const SUB_SPECS: Record<PromptSubcommand, CommandSpec> = {
  push: {
    command: 'prompt push',
    usage: 'Usage: lousho prompt push <file|-> --name N [--labels a,b] [--variables x,y] [--url U | --port N] [--token T]',
    positionals: 1,
    options: { ...DAEMON_OPTIONS, name: { type: 'string' }, labels: { type: 'string' }, variables: { type: 'string' } },
  },
  list: {
    command: 'prompt list',
    usage: 'Usage: lousho prompt list [--url U | --port N] [--token T] [--json]',
    options: { ...DAEMON_OPTIONS, json: { type: 'boolean' } },
  },
  get: {
    command: 'prompt get',
    usage: 'Usage: lousho prompt get <name[@version]> [--url U | --port N] [--token T] [--json]',
    positionals: 1,
    options: { ...DAEMON_OPTIONS, json: { type: 'boolean' } },
  },
};

const SUBCOMMANDS = new Set<string>(Object.keys(SUB_SPECS));

export interface PromptDeps {
  /** Where output goes. Default `console.log`. */
  log?: (text: string) => void;
  /** Injectable env (tests); default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable transport (tests); default the global `fetch`. */
  fetchFn?: typeof fetch;
  /** `push -`: reads stdin. Default reads the real stdin. */
  readStdin?: () => Promise<string>;
  /** Directory relative `push <file>` paths resolve against (default `process.cwd()`). */
  cwd?: string;
}

/** The daemon base URL for these commands: --url, else LOUSHO_OBSERVE, else loopback on --port/env/7777. */
function daemonUrl(values: Record<string, string | boolean | (string | boolean)[] | undefined>, spec: CommandSpec, env: NodeJS.ProcessEnv): string {
  const url = stringValue(values.url);
  if (url !== undefined) return url.replace(/\/+$/, '');
  const port = portValue(spec, values.port, envPort(env));
  // An explicit URL wins; a bare on-word (1/true/on/yes) means "the local daemon", so --port still applies.
  if (/^https?:\/\//i.test(env.LOUSHO_OBSERVE?.trim() ?? '')) return observeTargetFromEnv(env)?.url ?? `http://127.0.0.1:${port}`;
  return `http://127.0.0.1:${port}`;
}

function envPort(env: NodeJS.ProcessEnv): number {
  const raw = env.LOUSHO_OBSERVE_PORT;
  if (raw === undefined) return OBSERVE_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : OBSERVE_DEFAULT_PORT;
}

function tokenOf(values: Record<string, string | boolean | (string | boolean)[] | undefined>, env: NodeJS.ProcessEnv): string | undefined {
  return stringValue(values.token) ?? env.LOUSHO_OBSERVE_TOKEN;
}

function csvOf(value: string | boolean | (string | boolean)[] | undefined): string[] | undefined {
  const raw = stringValue(value);
  const parts = raw?.split(',').map((part) => part.trim()).filter(Boolean);
  return parts !== undefined && parts.length > 0 ? parts : undefined;
}

/** `get` takes `name[@version]`; a bare name resolves `latest` like an agent's fetch. */
function refOf(spec: CommandSpec, given: string): PromptRef {
  const at = given.indexOf('@');
  if (at === -1) return { name: given, version: 'latest' };
  const parsed = parsePromptRef(given);
  if (parsed === undefined) throw usageError(spec, `'${given}' is not a valid name@version (version is an integer or 'latest').`);
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function runPush(args: string[], deps: Required<PromptDeps>): Promise<number> {
  const spec = SUB_SPECS.push;
  const { values, positionals, help } = parseCommand(spec, args);
  if (help) {
    deps.log(HELP);
    return 0;
  }
  const file = positionals[0];
  const text = file === '-' ? await deps.readStdin() : fs.readFileSync(path.resolve(deps.cwd, file), 'utf8');
  let name = stringValue(values.name);
  if (name === undefined && file !== '-') name = path.basename(file).replace(/\.[^.]+$/, '');
  if (name === undefined) throw usageError(spec, "--name is required when pushing stdin ('-'); for a file it defaults to the basename.");
  const base = daemonUrl(values, spec, deps.env);
  const { prompt, created } = await publishPrompt(
    base,
    { name, text, ...(csvOf(values.labels) !== undefined ? { labels: csvOf(values.labels) } : {}), ...(csvOf(values.variables) !== undefined ? { variables: csvOf(values.variables) } : {}) },
    { ...(tokenOf(values, deps.env) !== undefined ? { token: tokenOf(values, deps.env) } : {}), fetchFn: deps.fetchFn }
  );
  deps.log(created ? `lousho prompt: published ${prompt.name}@${prompt.version}.` : `lousho prompt: ${prompt.name}@${prompt.version} is unchanged (same text).`);
  return 0;
}

async function runList(args: string[], deps: Required<PromptDeps>): Promise<number> {
  const spec = SUB_SPECS.list;
  const { values, help } = parseCommand(spec, args);
  if (help) {
    deps.log(HELP);
    return 0;
  }
  const base = daemonUrl(values, spec, deps.env);
  const prompts = await listPrompts(
    base,
    {},
    { ...(tokenOf(values, deps.env) !== undefined ? { token: tokenOf(values, deps.env) } : {}), fetchFn: deps.fetchFn }
  );
  if (values.json === true) {
    deps.log(JSON.stringify(prompts, null, 2));
    return 0;
  }
  if (prompts.length === 0) {
    deps.log('No prompts in the registry. Publish one with `lousho prompt push <file> --name <name>`.');
    return 0;
  }
  const header = ['NAME', 'LATEST', 'VERSIONS', 'USED BY RUNS', 'UPDATED'];
  const rows = prompts.map((prompt) => [
    prompt.name,
    `@${prompt.version}`,
    String(prompt.versions),
    String(prompt.uses),
    new Date(prompt.created_at).toISOString(),
  ]);
  const widths = header.map((_, col) => Math.max(...[header, ...rows].map((row) => row[col].length)));
  deps.log([header, ...rows].map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()).join('\n'));
  return 0;
}

async function runGet(args: string[], deps: Required<PromptDeps>): Promise<number> {
  const spec = SUB_SPECS.get;
  const { values, positionals, help } = parseCommand(spec, args);
  if (help) {
    deps.log(HELP);
    return 0;
  }
  const ref = refOf(spec, positionals[0]);
  const base = daemonUrl(values, spec, deps.env);
  const prompt = await fetchPrompt(
    base,
    ref,
    { ...(tokenOf(values, deps.env) !== undefined ? { token: tokenOf(values, deps.env) } : {}), fetchFn: deps.fetchFn }
  );
  deps.log(values.json === true ? JSON.stringify(prompt, null, 2) : (prompt.text ?? ''));
  return 0;
}

/** Turns a transport failure into the CLI's usual "is the daemon up?" message. */
function describe(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timed out/i.test(message)) {
    return `lousho prompt: no collector at ${url} (start it with 'lousho observe start', or pass --url).`;
  }
  return message;
}

/** The URL the failed subcommand aimed at, best-effort (parse may itself have failed). */
function urlGuess(sub: PromptSubcommand, args: string[], env: NodeJS.ProcessEnv): string {
  try {
    const spec = SUB_SPECS[sub];
    return daemonUrl(parseCommand(spec, args).values, spec, env);
  } catch {
    return `http://127.0.0.1:${envPort(env)}`;
  }
}

/**
 * CLI entry point. Resolves with the exit code: 0 ok, 1 the command ran and
 * failed (daemon down, prompt missing, bad body), 2 bad arguments.
 */
export async function runPrompt(rest: string[], deps: PromptDeps = {}): Promise<number> {
  const resolved: Required<PromptDeps> = {
    log: deps.log ?? ((text) => console.log(text)),
    env: deps.env ?? process.env,
    fetchFn: deps.fetchFn ?? fetch,
    readStdin: deps.readStdin ?? readStdin,
    cwd: deps.cwd ?? process.cwd(),
  };
  const [sub, ...subArgs] = rest;
  if (sub === undefined || !SUBCOMMANDS.has(sub)) {
    if (sub === '--help' || sub === '-h' || sub === undefined) {
      resolved.log(HELP);
      return sub === undefined ? 2 : 0;
    }
    console.error(`lousho prompt: unknown command '${sub}'.\n${USAGE}`);
    return 2;
  }
  try {
    switch (sub as PromptSubcommand) {
      case 'push':
        return await runPush(subArgs, resolved);
      case 'list':
        return await runList(subArgs, resolved);
      case 'get':
        return await runGet(subArgs, resolved);
    }
  } catch (error) {
    console.error(describe(error, urlGuess(sub as PromptSubcommand, subArgs, resolved.env)));
    return exitCodeFor(error);
  }
}
