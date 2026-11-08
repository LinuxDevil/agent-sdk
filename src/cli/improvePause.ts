import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { pauseImprove, resumeImprove } from '../improve/pause';
import { parseCommand, stringValue, usageError, type CommandSpec, type ParsedCommand } from './args';

interface PauseIo {
  stdout: Writable;
  stderr: Writable;
}

const PAUSE: CommandSpec = {
  command: 'improve pause',
  usage: 'Usage: lousho improve pause <agent-dir> [--reason text] [--by <name>]',
  positionals: 1,
  options: { reason: { type: 'string' }, by: { type: 'string' } },
};
const RESUME: CommandSpec = { command: 'improve resume', usage: 'Usage: lousho improve resume <agent-dir> [--by <name>]', positionals: 1, options: { by: { type: 'string' } } };

function dirOf(spec: CommandSpec, args: readonly string[], io: PauseIo): { dir: string; values: ParsedCommand['values'] } | undefined {
  const { values, positionals, help } = parseCommand(spec, [...args]);
  if (help) {
    io.stdout.write(`${spec.usage}\n`);
    return undefined;
  }
  if (positionals.length !== 1) throw usageError(spec, 'an agent directory is required.');
  return { dir: path.resolve(positionals[0]), values };
}

export async function pause(args: readonly string[], io: PauseIo): Promise<number> {
  const parsed = dirOf(PAUSE, args, io);
  if (!parsed) return 0;
  const by = stringValue(parsed.values.by);
  const reason = stringValue(parsed.values.reason);
  const done = await pauseImprove(parsed.dir, { ...(by !== undefined && { by }), ...(reason !== undefined && { reason }) });
  io.stdout.write(done ? `Paused self-healing in ${parsed.dir}: wrote .lousho/improve.stop. A running watcher stops at its next tick.\n` : `Self-healing in ${parsed.dir} was already paused.\n`);
  return 0;
}

export async function resume(args: readonly string[], io: PauseIo): Promise<number> {
  const parsed = dirOf(RESUME, args, io);
  if (!parsed) return 0;
  const by = stringValue(parsed.values.by);
  const done = await resumeImprove(parsed.dir, by !== undefined ? { by } : {});
  io.stdout.write(done ? `Resumed self-healing in ${parsed.dir}: removed .lousho/improve.stop.\n` : `Self-healing in ${parsed.dir} was not paused by the stop file.\n`);
  return 0;
}
