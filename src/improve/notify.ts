import path from 'node:path';
import type { AlertEvent, Alerter } from '../observe/alerts';
import { plain } from './audit';
import type { HealCycle } from './cycles';

const MAX_REASON = 500;

export type ImproveEventType = Extract<AlertEvent['type'], `improve.${string}`>;

export interface ImproveNotice {
  type: ImproveEventType;
  reason: string;
  from?: string;
  to?: string;
  cycle?: string;
  card?: string;
}

export type Notify = (notice: ImproveNotice) => void;

export function noticeEvent(notice: ImproveNotice, target: { agent: string; dir: string }, now: number): AlertEvent {
  const dir = path.resolve(target.dir);
  return {
    type: notice.type,
    agent_id: target.agent,
    project: null,
    status: notice.type.slice('improve.'.length),
    at: now,
    details: {
      agent: target.agent,
      dir,
      from: notice.from ?? null,
      to: notice.to ?? null,
      reason: plain(notice.reason, MAX_REASON),
      cycle: notice.cycle ?? null,
      ...(notice.card !== undefined && { card: notice.card }),
    },
  };
}

function quietly(task: () => void): void {
  try {
    task();
  } catch {
    return;
  }
}

export function notifier(target: { agent: string; dir: string }, sinks: { alerter?: Alerter; log?: (line: string) => void }): Notify {
  return (notice) => {
    const event = noticeEvent(notice, target, Date.now());
    quietly(() => sinks.log?.(`lousho improve: ${event.type} ${target.agent}: ${String(event.details.reason)}\n`));
    quietly(() => void Promise.resolve(sinks.alerter?.post([event])).catch(() => undefined));
  };
}

const CYCLE_EVENTS: Partial<Record<HealCycle['outcome'], ImproveEventType>> = {
  pending: 'improve.pending',
  applied: 'improve.applied',
  'guard-rolled-back': 'improve.rolled_back',
  'canary-failed': 'improve.canary',
};

export function cycleNotice(cycle: HealCycle, dir: string): ImproveNotice | undefined {
  const type = CYCLE_EVENTS[cycle.outcome];
  if (!type) return undefined;
  const card = cycle.pending ? path.join(path.resolve(dir), '.lousho', 'proposals', `${cycle.pending}.json`) : undefined;
  const to = cycle.rolledBackTo ?? cycle.to;
  return { type, reason: cycle.reason, cycle: cycle.id, ...(cycle.from && { from: cycle.from }), ...(to && { to }), ...(card && { card }) };
}
