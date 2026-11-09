import path from 'node:path';
import type { GuardCorpusResult } from './corpusGuard';
import { usageToday } from './cycles';
import { canaryRunning, canaryVerdict, settleCanary, type CanarySettlement } from './trafficCanary';
import type { WatchOptions } from './watch';
import { guardNow, type WatchContext } from './watchSteps';

function capSpent(options: WatchOptions, now: number): boolean {
  const { dir, settings, db } = options;
  if (settings.approval !== 'auto' || usageToday(dir, now).applies < settings.budget.maxAppliesPerDay) return false;
  return canaryVerdict(db, dir, settings, now).state === 'promote';
}

function notifySettled(dir: string, settled: CanarySettlement, notify: WatchContext['notify']): void {
  const { applied, queued, verdict } = settled;
  if (settled.outcome === 'applied' && applied) notify({ type: 'improve.applied', reason: `The traffic canary promoted ${applied.to.slice(0, 12)}: ${settled.reason}`, from: applied.from, to: applied.to });
  else if (settled.outcome === 'queued' && queued) notify({ type: 'improve.pending', reason: `The traffic canary passed and ${queued.id} waits for approval: ${settled.reason}`, card: path.join(path.resolve(dir), '.lousho', 'proposals', `${queued.id}.json`) });
  else if (settled.outcome === 'retired') notify({ type: 'improve.canary', reason: `The traffic canary was retired: ${verdict.reason}` });
}

export async function settleTraffic(options: WatchOptions, now: number, context: Pick<WatchContext, 'notify' | 'signal'>): Promise<{ canary?: CanarySettlement; guard?: GuardCorpusResult }> {
  if (!canaryRunning(options.dir) || capSpent(options, now)) return {};
  const canary = await settleCanary(options.db, options.dir, options.settings, now);
  notifySettled(options.dir, canary, context.notify);
  if (canary.outcome !== 'applied') return { canary };
  const guard = await guardNow(options, now, context);
  return { canary, ...(guard && { guard }) };
}
