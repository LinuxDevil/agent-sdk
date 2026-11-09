import { rmSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../execution/errors';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { applyProposal, type ApplyResult } from './apply';
import type { TrafficCanary } from './canaryArm';
import { folderOf, markRefused, pendingOrThrow, withProposalsLock, type PendingProposal } from './pending';
import { loadImproveSettings } from './settings';
import { startCanary } from './trafficCanary';

/** What approving a pending proposal did: applied it, or started the opt-in traffic canary on it. */
export type ApprovedPending =
  | ApplyResult
  | {
      /** The traffic canary the approval started. */
      canary: TrafficCanary;
    };

/** Options for {@link approvePending}. */
export interface ApprovePendingOptions {
  /** The observe database; needed when improve.json sets `canary.traffic`, to read the base's flagged rate. */
  db?: SqlDatabase;
}

async function approved(dir: string, pending: PendingProposal, approvedBy: string, db: SqlDatabase | undefined): Promise<ApprovedPending> {
  const input = { result: pending.result, base: pending.base, ...(pending.cycle && { cycle: pending.cycle }), ...(pending.maxAlwaysOnChars !== undefined && { maxAlwaysOnChars: pending.maxAlwaysOnChars }) };
  const settings = loadImproveSettings(dir);
  if (!settings.canary.traffic) return applyProposal(dir, input, { mode: 'manual', approvedBy });
  if (!db) throw new ConfigurationError('approvePending: improve.json turns on the traffic canary, which needs the observe database to start: pass { db }.', 'db');
  return { canary: await startCanary(db, dir, { ...input, approvedBy }, settings) };
}

/** Approves a pending proposal as a named person and removes it from the queue: applies it, or with `canary.traffic` set starts the traffic canary, whose promote then applies it without a second approval; a stale one is refused and marked stale. */
export async function approvePending(dir: string, id: string, approvedBy: string, options: ApprovePendingOptions = {}): Promise<ApprovedPending> {
  return withProposalsLock(dir, async () => {
    const pending = pendingOrThrow(dir, id);
    const file = path.join(folderOf(dir), `${pending.id}.json`);
    let result: ApprovedPending;
    try {
      result = await approved(dir, pending, approvedBy, options.db);
    } catch (error) {
      markRefused(file, pending, error);
      throw error;
    }
    rmSync(file, { force: true });
    return result;
  });
}
