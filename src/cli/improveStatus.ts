import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { improveStatus, type ImproveStatus } from '../improve/status';
import { parseCommand, usageError, type CommandSpec } from './args';

interface StatusIo {
  stdout: Writable;
  stderr: Writable;
}

const STATUS: CommandSpec = { command: 'improve status', usage: 'Usage: lousho improve status <agent-dir> [--json]', positionals: 1, options: { json: { type: 'boolean' } } };

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const safe = (value: unknown): string => String(value ?? '-').replace(CONTROL, ' ');
const short = (id: string | null): string => (id === null ? '-' : id.slice(0, 12));
const onOff = (value: boolean): string => (value ? 'on' : 'off');

function editorsLine({ editors }: ImproveStatus): string {
  return `Editors: ${editors.proposers} proposer${editors.proposers === 1 ? '' : 's'}, ${editors.mode} mode, selector ${onOff(editors.select)}, parallel ${onOff(editors.parallel)}`;
}

function lines(status: ImproveStatus): string[] {
  const { budget, canary, monitor } = status;
  return [
    `Mode: ${status.approval}${status.paused ? ` (paused: ${safe(status.paused)})` : ''}`,
    `Revision: ${short(status.revision)}`,
    `Monitor: ${monitor ? safe(monitor.state) : 'nothing applied to watch'}`,
    `Budget today: ${budget.cycles.used}/${budget.cycles.max} cycles, ${budget.applies.used}/${budget.applies.max} automatic applies, ${budget.tokens.used}/${budget.tokens.max} tokens`,
    `Cooldown: ${status.cooldownUntil ?? 'none'}`,
    editorsLine(status),
    `Canary: traffic ${canary.traffic ? `on (${canary.traffic.share} of ${canary.traffic.sessions} sessions)` : 'off'}; last replay ${canary.last ? `${canary.last.passed ? 'passed' : 'failed'}: ${safe(canary.last.reason)}` : 'none'}`,
    `Last cycle: ${status.lastCycle ? `${safe(status.lastCycle.outcome)}: ${safe(status.lastCycle.reason)}` : 'none'}`,
    `Pending: ${status.pending.length === 0 ? 'none' : status.pending.map((item) => `${item.id}${item.stale ? ' (stale)' : ''}`).join(', ')}`,
    'Recent audit:',
    ...(status.audit.length === 0 ? ['  none'] : status.audit.map((entry) => `  ${entry.seq} ${entry.at} ${safe(entry.actor)} ${entry.action}: ${safe(entry.reason)}`)),
    ...status.warnings.map((warning) => `Warning: ${safe(warning)}`),
  ];
}

export function status(args: readonly string[], io: StatusIo): number {
  const { values, positionals, help } = parseCommand(STATUS, [...args]);
  if (help) {
    io.stdout.write(`${STATUS.usage}\n`);
    return 0;
  }
  if (positionals.length !== 1) throw usageError(STATUS, 'an agent directory is required.');
  const report = improveStatus(path.resolve(positionals[0]));
  io.stdout.write(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : `${lines(report).join('\n')}\n`);
  return 0;
}
