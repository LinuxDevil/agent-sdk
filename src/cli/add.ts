/**
 * `lousho add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--allow <list>] [--overwrite] [--dry-run]`
 * installs a tool, skill, channel, schedule or memory slot from a JSON registry
 * into an agent directory as source you own (LOU-D50). It prints the item's
 * permission manifest and the files first, refuses an item whose code reaches for
 * something the manifest does not declare (M7a, addCheck.ts), then asks; with
 * `--yes`, elevated permissions need `--allow`. After writing it records the item
 * in `lousho-registry.json` (addReceipt.ts). Nothing from the registry is
 * executed, and dependencies are only printed as an `npm install` line.
 * `lousho add --list` prints the registry's index. See docs/registry.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { SDKError } from '../execution/errors';
import { checkItem, formatFinding } from './addCheck';
import { readReceipt, RECEIPT_FILE, writeReceipt } from './addReceipt';
import { checkTargets, planFiles, writeFiles, type PlannedFile } from './addWrite';
import { parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { loadIndex, loadItem, registrySource, type RegistryIndex, type RegistryItem, type RegistryOptions } from './registry';

const USAGE = 'Usage: lousho add <name> [--registry <url-or-path>] [--dir <agent-dir>] [--yes] [--allow exec,fs-write,network,env] [--overwrite] [--dry-run]\n       lousho add --list [--registry <url-or-path>]';

const SPEC: CommandSpec = {
  command: 'add',
  usage: USAGE,
  positionals: 1,
  options: {
    registry: { type: 'string' },
    dir: { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    allow: { type: 'string' },
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

/** The permissions `--yes` does not grant on its own; each needs its name in `--allow`. */
const ELEVATED = ['exec', 'fs-write', 'network', 'env'] as const;
type Elevated = (typeof ELEVATED)[number];

function parseAllow(value: string | undefined): Elevated[] {
  if (value === undefined) return [];
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.find((name) => !(ELEVATED as readonly string[]).includes(name));
  if (unknown !== undefined) throw usageError(SPEC, `--allow takes a comma-separated list of ${ELEVATED.join(', ')}; got '${unknown}'.`);
  return names as Elevated[];
}

/** The elevated permissions `item`'s manifest asks for, in `--allow` names. */
function elevatedPermissions(item: RegistryItem): Elevated[] {
  const { exec, filesystem, network, env } = item.permissions;
  const asked: Record<Elevated, boolean> = { exec: exec === true, 'fs-write': filesystem === 'write', network: (network?.length ?? 0) > 0, env: (env?.length ?? 0) > 0 };
  return ELEVATED.filter((name) => asked[name]);
}

interface AddArgs {
  name?: string;
  registry?: string;
  dir: string;
  yes: boolean;
  /** `--allow`: the elevated permissions `--yes` may grant. */
  allow: Elevated[];
  overwrite: boolean;
  dryRun: boolean;
  list: boolean;
  help: boolean;
}

/** Parses the arguments after `add`; throws `LOUSHO_CONFIG_INVALID` for a bad flag or when neither a name nor `--list` is given. */
export function parseAddArgs(args: string[]): AddArgs {
  const { values, positionals, help } = parseCommand(SPEC, args);
  const parsed: AddArgs = {
    name: positionals[0],
    registry: stringValue(values.registry),
    dir: stringValue(values.dir) ?? '.',
    yes: values.yes === true,
    allow: parseAllow(stringValue(values.allow)),
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
  const elevated = elevatedPermissions(item);
  const mark = (name: Elevated) => (elevated.includes(name) ? `  [elevated: ${name}]` : '');
  return [
    `${item.type} '${item.name}': ${item.description}`,
    'Permissions it asks for:',
    `  network:    ${network?.length ? network.join(', ') : 'none'}${mark('network')}`,
    `  env vars:   ${env?.length ? env.join(', ') : 'none'}${mark('env')}`,
    `  filesystem: ${filesystem ?? 'none'}${mark('fs-write')}`,
    `  exec:       ${exec ? 'yes (runs commands)' : 'no'}${mark('exec')}`,
    `  approval:   ${needsApproval ? 'its tools ask for approval before they run' : 'its tools run without asking'}`,
  ];
}

/** Refuses an item whose code reaches for something its manifest does not declare; prints the notes. */
function enforceManifest(item: RegistryItem, io: AddIo): void {
  const findings = checkItem(item);
  const refused = findings.filter((finding) => finding.level === 'refuse');
  for (const note of findings.filter((finding) => finding.level === 'note')) io.stdout.write(`Note: ${formatFinding(note)}\n`);
  if (refused.length === 0) return;
  throw new SDKError(
    `lousho add: the code of '${item.name}' does not match its permission manifest:\n${refused.map((finding) => `  ${formatFinding(finding)}`).join('\n')}`,
    'LOUSHO_REGISTRY_MANIFEST_MISMATCH'
  );
}

/** With `--yes`, every elevated permission must be named in `--allow`. */
function enforceAllow(args: AddArgs, item: RegistryItem): void {
  const elevated = elevatedPermissions(item);
  const missing = elevated.filter((name) => !args.allow.includes(name));
  if (missing.length === 0) return;
  throw usageError(
    SPEC,
    `'${item.name}' asks for elevated permissions that --yes does not grant on its own (missing: --allow ${missing.join(',')}); pass --allow ${elevated.join(',')} to install it without asking.`
  );
}

function planLines(files: PlannedFile[], overwrite: boolean): string[] {
  const note = (file: PlannedFile) =>
    file.exists ? (overwrite ? ' (exists - will be overwritten)' : ' (exists - a real install needs --overwrite)') : '';
  return ['Files it will write:', ...files.map((file) => `  ${file.relative}${note(file)}`)];
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

async function install(args: AddArgs, registry: string, item: RegistryItem, io: AddIo): Promise<number> {
  const agentDir = path.resolve(io.cwd ?? process.cwd(), args.dir);
  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    throw new SDKError(`lousho add: the agent directory ${agentDir} does not exist.`, 'LOUSHO_CONFIG_INVALID', { hint: 'Create it, or pass --dir <agent-dir>.' });
  }
  const files = planFiles(item, agentDir);
  // A dry run writes nothing, so an existing file is reported, not refused.
  await checkTargets(item, files, agentDir, args.overwrite || args.dryRun);
  const receipt = await readReceipt(agentDir);
  const lines = [...manifestLines(item), ...planLines(files, args.overwrite)];
  if (item.dependencies?.length) lines.push('Dependencies (not installed; run this yourself):', `  npm install ${item.dependencies.join(' ')}`);
  io.stdout.write(`${lines.join('\n')}\n`);
  enforceManifest(item, io);
  if (args.dryRun) {
    io.stdout.write('Dry run: nothing was written.\n');
    return 0;
  }
  if (args.yes) {
    enforceAllow(args, item);
  } else {
    if (!io.stdin.isTTY) throw usageError(SPEC, 'stdin is not interactive, so it cannot ask for confirmation; pass --yes to install without asking.');
    const elevated = elevatedPermissions(item);
    if (elevated.length > 0) io.stdout.write(`It asks for elevated permissions: ${elevated.join(', ')}.\n`);
    if (!(await confirm(io, `Write ${files.length} file(s) into ${agentDir}? [y/N] `))) {
      io.stdout.write('Cancelled: nothing was written.\n');
      return 1;
    }
  }
  await writeFiles(files);
  await writeReceipt(agentDir, receipt, item, files, registry);
  io.stdout.write(`Added ${item.name}: ${files.length} file(s) written, recorded in ${RECEIPT_FILE}.\n`);
  return 0;
}

async function runParsed(args: AddArgs, io: AddIo): Promise<number> {
  const registry = registrySource({ registry: args.registry, env: io.env });
  const index = await loadIndex(registry, io);
  if (args.list || !args.name) {
    io.stdout.write(`${listLines(index).join('\n')}\n`);
    return 0;
  }
  return install(args, registry, await loadItem(registry, index, args.name, io), io);
}

/** Runs `lousho add` with the arguments after `add`; resolves with the exit code. */
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
