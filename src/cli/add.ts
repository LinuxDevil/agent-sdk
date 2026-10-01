/**
 * `loushy add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--overwrite] [--dry-run]`
 * installs a tool, skill, channel, schedule or memory slot from a JSON registry
 * into an agent directory as source you own (LOU-D50). It prints the item's
 * permission manifest and the files first, then asks. Nothing from the registry
 * is executed, and dependencies are only printed as an `npm install` line.
 * `loushy add --list` prints the registry's index. See docs/registry.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { SDKError } from '../execution/errors';
import { checkTargets, planFiles, writeFiles, type PlannedFile } from './addWrite';
import { parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { loadIndex, loadItem, registrySource, type RegistryIndex, type RegistryItem, type RegistryOptions } from './registry';

const USAGE = 'Usage: loushy add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--overwrite] [--dry-run]\n       loushy add --list [--registry <url-or-path>]';

const SPEC: CommandSpec = {
  command: 'add',
  usage: USAGE,
  positionals: 1,
  options: {
    registry: { type: 'string' },
    dir: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    overwrite: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    list: { type: 'boolean' },
  },
};

export interface AddIo extends RegistryOptions {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  /** The directory `--dir` is relative to (default: the process's). */
  cwd?: string;
}

interface AddArgs {
  name?: string;
  registry?: string;
  dir: string;
  yes: boolean;
  overwrite: boolean;
  dryRun: boolean;
  list: boolean;
  help: boolean;
}

/** Parses the arguments after `add`; throws `LOUSHY_CONFIG_INVALID` for a bad flag or when neither a name nor `--list` is given. */
export function parseAddArgs(args: string[]): AddArgs {
  const { values, positionals, help } = parseCommand(SPEC, args);
  const parsed: AddArgs = {
    name: positionals[0],
    registry: stringValue(values.registry),
    dir: stringValue(values.dir) ?? '.',
    yes: values.yes === true,
    overwrite: values.overwrite === true,
    dryRun: values['dry-run'] === true,
    list: values.list === true,
    help,
  };
  if (!help && !parsed.list && !parsed.name) throw usageError(SPEC, 'an item name is required (or --list).');
  return parsed;
}

function listLines(index: RegistryIndex): string[] {
  if (index.items.length === 0) return ['The registry has no items.'];
  const width = Math.max(...index.items.map((item) => item.name.length));
  return index.items.map((item) => `${item.name.padEnd(width)}  ${item.type.padEnd(8)}  ${item.description}`);
}

function manifestLines(item: RegistryItem): string[] {
  const { network, env, filesystem, exec, needsApproval } = item.permissions;
  return [
    `${item.type} '${item.name}': ${item.description}`,
    'Permissions it asks for:',
    `  network:    ${network?.length ? network.join(', ') : 'none'}`,
    `  env vars:   ${env?.length ? env.join(', ') : 'none'}`,
    `  filesystem: ${filesystem ?? 'none'}`,
    `  exec:       ${exec ? 'yes (runs commands)' : 'no'}`,
    `  approval:   ${needsApproval ? 'its tools ask for approval before they run' : 'its tools run without asking'}`,
  ];
}

function planLines(files: PlannedFile[]): string[] {
  return ['Files it will write:', ...files.map((file) => `  ${file.relative}`)];
}

async function confirm(io: AddIo, question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question(question, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function install(args: AddArgs, item: RegistryItem, io: AddIo): Promise<number> {
  const agentDir = path.resolve(io.cwd ?? process.cwd(), args.dir);
  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    throw new SDKError(`loushy add: the agent directory ${agentDir} does not exist.`, 'LOUSHY_CONFIG_INVALID', { hint: 'Create it, or pass --dir <agent-dir>.' });
  }
  const files = planFiles(item, agentDir);
  await checkTargets(item, files, agentDir, args.overwrite);
  const lines = [...manifestLines(item), ...planLines(files)];
  if (item.dependencies?.length) lines.push('Dependencies (not installed; run this yourself):', `  npm install ${item.dependencies.join(' ')}`);
  io.stdout.write(`${lines.join('\n')}\n`);
  if (args.dryRun) {
    io.stdout.write('Dry run: nothing was written.\n');
    return 0;
  }
  if (!args.yes) {
    if (!io.stdin.isTTY) throw usageError(SPEC, 'stdin is not interactive, so it cannot ask for confirmation; pass --yes to install without asking.');
    if (!(await confirm(io, `Write ${files.length} file(s) into ${agentDir}? [y/N] `))) {
      io.stdout.write('Cancelled: nothing was written.\n');
      return 1;
    }
  }
  await writeFiles(files);
  io.stdout.write(`Added ${item.name}: ${files.length} file(s) written.\n`);
  return 0;
}

async function runParsed(args: AddArgs, io: AddIo): Promise<number> {
  const registry = registrySource({ registry: args.registry, env: io.env });
  const index = await loadIndex(registry, io);
  if (args.list || !args.name) {
    io.stdout.write(`${listLines(index).join('\n')}\n`);
    return 0;
  }
  return install(args, await loadItem(registry, index, args.name, io), io);
}

/** Runs `loushy add` with the arguments after `add`; resolves with the exit code. */
export async function runAdd(args: string[], io: AddIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  try {
    const parsed = parseAddArgs(args);
    if (parsed.help) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    return await runParsed(parsed, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
