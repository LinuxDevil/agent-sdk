import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { ConfigurationError } from '../execution/errors';
import { rollbackHarness } from '../improve/apply';
import { readAudit, verifyAudit, type AuditEntry } from '../improve/audit';
import { approvePending, isPendingId, listPending, readPendingProposal, rejectPending } from '../improve/pending';
import { currentRevision, listRevisions, type HarnessRevision } from '../improve/revisions';
import { parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { pause, resume } from './improvePause';

interface AdminIo {
  stdout: Writable;
  stderr: Writable;
}

const SHORT = 12;
const DEFAULT_REASON = 'Rolled back from the command line.';

const REVISIONS: CommandSpec = { command: 'improve revisions', usage: 'Usage: lousho improve revisions <agent-dir> [--json]', positionals: 1, options: { json: { type: 'boolean' } } };
const ROLLBACK: CommandSpec = {
  command: 'improve rollback',
  usage: 'Usage: lousho improve rollback <agent-dir> --by <name> [--to <revision>] [--reason text]',
  positionals: 1,
  options: { to: { type: 'string' }, by: { type: 'string' }, reason: { type: 'string' } },
};
const AUDIT: CommandSpec = { command: 'improve audit', usage: 'Usage: lousho improve audit <agent-dir> [--verify] [--json]', positionals: 1, options: { verify: { type: 'boolean' }, json: { type: 'boolean' } } };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const MIN_PREFIX = 4;

const safe = (value: unknown): string => String(value ?? '-').replace(CONTROL, ' ');
const safeText = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');
const short = (id: unknown): string => (typeof id === 'string' ? safe(id.slice(0, SHORT)) : '-');

function parsed(spec: CommandSpec, args: readonly string[], io: AdminIo): { values: Record<string, unknown>; dir: string; id: string } | undefined {
  const { values, positionals, help } = parseCommand(spec, args);
  if (help) {
    io.stdout.write(`${spec.usage}\n`);
    return undefined;
  }
  const wanted = spec.positionals ?? 1;
  if (positionals.length !== wanted) throw usageError(spec, wanted === 2 ? 'an agent directory and a proposal id are required.' : 'an agent directory is required.');
  return { values, dir: path.resolve(positionals[0]), id: positionals[1] ?? '' };
}

const SOURCE_ACTION: Partial<Record<HarnessRevision['source'], AuditEntry['action']>> = { apply: 'apply', rollback: 'rollback' };

function actorsOf(revisions: readonly HarnessRevision[], audit: readonly AuditEntry[]): string[] {
  const unused = [...audit].reverse();
  return revisions.map((revision) => {
    const action = SOURCE_ACTION[revision.source];
    const index = unused.findIndex((entry) => entry.action === action && entry.to === revision.id);
    if (action === undefined || index === -1) return '-';
    return unused.splice(index, 1)[0].actor;
  });
}

function revisions(args: readonly string[], io: AdminIo): number {
  const command = parsed(REVISIONS, args, io);
  if (!command) return 0;
  const list = listRevisions(command.dir);
  const current = list.length > 0 ? currentOrUndefined(command.dir) : undefined;
  const actors = actorsOf(list, readAudit(command.dir));
  const rows = list.map((revision, index) => ({ id: revision.id, parent: revision.parent, source: revision.source, at: revision.at, actor: actors[index], current: index === list.findIndex((item) => item.id === current) }));
  if (command.values.json === true) {
    io.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) io.stdout.write('No revisions yet: nothing has been applied to this directory.\n');
  else if (!rows.some((row) => row.current)) io.stdout.write('The directory holds unsaved edits that match no revision.\n');
  for (const row of rows) io.stdout.write(`${row.current ? '*' : ' '} ${short(row.id)}  ${row.source.padEnd(8)}  ${safe(row.actor).padEnd(16)}  ${row.at}\n`);
  return 0;
}

function currentOrUndefined(dir: string): string | undefined {
  try {
    return currentRevision(dir);
  } catch {
    return undefined;
  }
}

function parentOfCurrent(dir: string, current: string, list: readonly HarnessRevision[]): string {
  if (list.length === 0) throw new ConfigurationError(`lousho improve rollback: ${dir} has no earlier revision to roll back to: nothing has been applied yet.`, 'to');
  const newest = list.find((revision) => revision.id === current);
  if (!newest) throw new ConfigurationError(`lousho improve rollback: ${dir} holds hand edits that match no saved revision. Pass --to <revision> to replace them; they are saved as a revision first.`, 'to');
  if (newest.source === 'rollback') throw new ConfigurationError(`lousho improve rollback: the current revision came from a rollback, so its parent is the change that was undone. Pass --to <revision> to go further back.`, 'to');
  if (newest.parent === undefined) throw new ConfigurationError(`lousho improve rollback: ${dir} has no earlier revision to roll back to.`, 'to');
  return newest.parent;
}

function resolveTarget(dir: string, to: string | undefined, current: string): string {
  const list = listRevisions(dir);
  if (to === undefined) return parentOfCurrent(dir, current, list);
  if (to.length < MIN_PREFIX) throw new ConfigurationError(`lousho improve rollback: --to needs at least ${MIN_PREFIX} characters of a revision id.`, 'to');
  const matches = [...new Set(list.map((revision) => revision.id).filter((id) => id.startsWith(to.toLowerCase())))];
  if (matches.length === 1) return matches[0];
  const problem = matches.length === 0 ? 'matches no saved revision' : `matches ${matches.length} revisions; give more characters`;
  throw new ConfigurationError(`lousho improve rollback: --to '${safe(to)}' ${problem}. See 'lousho improve revisions'.`, 'to');
}

async function rollback(args: readonly string[], io: AdminIo): Promise<number> {
  const command = parsed(ROLLBACK, args, io);
  if (!command) return 0;
  const by = personOf(ROLLBACK, command.values);
  const current = currentRevision(command.dir);
  const target = resolveTarget(command.dir, stringValue(command.values.to as string | undefined), current);
  const reason = stringValue(command.values.reason as string | undefined) ?? DEFAULT_REASON;
  const rolled = await rollbackHarness(command.dir, target, { actor: `person:${by}`, reason, expectedFrom: current });
  io.stdout.write(`Rolled back ${short(rolled.from)} -> ${short(rolled.to)} (${rolled.written.join(', ')}).\n`);
  return 0;
}

function auditLine(entry: AuditEntry): string {
  return `${safe(entry.seq)} ${safe(entry.at)} ${safe(entry.actor)} ${safe(entry.action)} ${short(entry.from)}->${short(entry.to)} ${safe(entry.reason)}\n`;
}

function audit(args: readonly string[], io: AdminIo): number {
  const command = parsed(AUDIT, args, io);
  if (!command) return 0;
  if (command.values.verify === true) {
    const broken = verifyAudit(command.dir);
    if (broken !== undefined) {
      io.stderr.write(`lousho improve audit: the chain is broken at seq ${broken}: that line was edited, removed or cut short.\n`);
      return 1;
    }
    io.stdout.write(`The audit log is intact: ${readAudit(command.dir).length} entries.\n`);
    return 0;
  }
  const entries = readAudit(command.dir);
  io.stdout.write(command.values.json === true ? `${JSON.stringify(entries, null, 2)}\n` : entries.map(auditLine).join(''));
  return 0;
}

const PENDING: CommandSpec = { command: 'improve pending', usage: 'Usage: lousho improve pending <agent-dir> [--show <id>] [--json]', positionals: 1, options: { json: { type: 'boolean' }, show: { type: 'string' } } };
const APPROVE: CommandSpec = { command: 'improve approve', usage: 'Usage: lousho improve approve <agent-dir> <id> --by <name>', positionals: 2, options: { by: { type: 'string' } } };
const REJECT: CommandSpec = { command: 'improve reject', usage: 'Usage: lousho improve reject <agent-dir> <id> --by <name> [--reason text]', positionals: 2, options: { by: { type: 'string' }, reason: { type: 'string' } } };

function pending(args: readonly string[], io: AdminIo): number {
  const command = parsed(PENDING, args, io);
  if (!command) return 0;
  const shown = stringValue(command.values.show as string | undefined);
  if (shown !== undefined) {
    io.stdout.write(`${safeText(readPendingProposal(command.dir, idOf(PENDING, shown)).card)}\n`);
    return 0;
  }
  const queued = listPending(command.dir);
  if (command.values.json === true) {
    io.stdout.write(`${JSON.stringify(queued.map(({ id, createdAt, cycle, staleAt, failure, result }) => ({ id, createdAt, cycle, staleAt, failure, reason: result.reason })), null, 2)}\n`);
    return 0;
  }
  if (queued.length === 0) io.stdout.write('No pending proposals.\n');
  for (const item of queued) io.stdout.write(`${item.id}  ${safe(item.createdAt)}${stateOf(item)}  ${safe(item.result.reason)}\n`);
  return 0;
}

function stateOf(item: { staleAt?: string; failure?: string }): string {
  if (item.staleAt) return '  stale';
  return item.failure ? '  refused' : '';
}

function idOf(spec: CommandSpec, id: string): string {
  if (!isPendingId(id)) throw usageError(spec, "a proposal id is 12 lowercase hex characters, as 'lousho improve pending' prints them.");
  return id;
}

function personOf(spec: CommandSpec, values: Record<string, unknown>): string {
  const by = stringValue(values.by as string | undefined)?.trim();
  if (!by) throw usageError(spec, '--by <name> is required: the audit log records who did it.');
  return by;
}

async function approve(args: readonly string[], io: AdminIo): Promise<number> {
  const command = parsed(APPROVE, args, io);
  if (!command) return 0;
  const applied = await approvePending(command.dir, idOf(APPROVE, command.id), personOf(APPROVE, command.values));
  io.stdout.write(`Applied ${command.id}: ${short(applied.from)} -> ${short(applied.to)} (${applied.written.join(', ')}).\n`);
  return 0;
}

async function reject(args: readonly string[], io: AdminIo): Promise<number> {
  const command = parsed(REJECT, args, io);
  if (!command) return 0;
  const by = personOf(REJECT, command.values);
  await rejectPending(command.dir, idOf(REJECT, command.id), by, stringValue(command.values.reason as string | undefined) ?? 'Rejected from the command line.');
  io.stdout.write(`Rejected ${command.id}.\n`);
  return 0;
}

const COMMANDS: Record<string, (args: readonly string[], io: AdminIo) => number | Promise<number>> = { revisions, rollback, audit, pending, approve, reject, pause, resume };

/** Whether the arguments after `improve` name an admin subcommand rather than an agent path. */
export function isImproveAdmin(args: readonly string[]): boolean {
  return args[0] !== undefined && Object.hasOwn(COMMANDS, args[0]);
}

/** Runs `lousho improve revisions|rollback|audit|pending|approve|reject`; resolves with the exit code. */
export async function runImproveAdmin(args: readonly string[], io: AdminIo): Promise<number> {
  return COMMANDS[args[0]](args.slice(1), io);
}
