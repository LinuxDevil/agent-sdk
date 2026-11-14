import { ConfigurationError } from '../execution/errors';
import { actorOf, checkedProposal, rollbackTarget, type Approval, type ApplyInput, type ApplyResult, type RollbackBy, type RollbackResult } from './apply';
import { cleanActor, type AuditEntry, type AuditInput } from './audit';
import { refusal, STALE_FIELD } from './harnessWriter';
import type { AuditLog, HarnessStore, HarnessStoreState } from './harnessStore';
import { harnessHash } from './revisions';
import type { Harness, ImproveResult } from './types';

function sameSkill(a: Harness['skills'][string] | undefined, b: Harness['skills'][string] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.description.trim() === b.description.trim() && a.content.trim() === b.content.trim();
}

function guardReadOnly(next: Harness, state: HarnessStoreState): void {
  const own = (skills: Harness['skills'], name: string) => (Object.hasOwn(skills, name) ? skills[name] : undefined);
  const touched = state.readOnly.find((name) => !sameSkill(own(next.skills, name), own(state.harness.skills, name)));
  if (touched !== undefined) throw refusal(`skill '${touched}' is read-only (its folder holds more than SKILL.md, or its name differs from its folder), so it can't be changed or removed.`);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function auditQuietly(log: AuditLog, entry: AuditInput): Promise<void> {
  try {
    await log.append(entry);
  } catch {
    return;
  }
}

async function refused(log: AuditLog, actor: AuditEntry['actor'], from: string, prefix: string, cycle: string | undefined, error: unknown): Promise<never> {
  const stale = error instanceof ConfigurationError && error.field === STALE_FIELD;
  await auditQuietly(log, { actor, action: stale ? 'stale' : 'reject', from, ...(cycle && { cycle }), reason: `${prefix}${reasonOf(error)}` });
  throw error;
}

function caseEvidence(result: ImproveResult): NonNullable<AuditEntry['evidence']>['cases'] {
  return result.cases?.map((v) => ({ caseId: v.caseId, base: `${v.base.passed}/${v.base.scored}`, final: `${v.final.passed}/${v.final.scored}` }));
}

/** `applyProposal` over any `HarnessStore`: the same checks and refusals, committed through the store. */
export async function applyProposalIn(store: HarnessStore, input: ApplyInput, approval: Approval): Promise<ApplyResult> {
  const actor = actorOf(approval);
  return store.withLock(async () => {
    const state = await store.read();
    const from = harnessHash(state.harness);
    try {
      const next = checkedProposal(input, state.harness, approval);
      guardReadOnly(next, state);
      const audit: AuditInput = { actor, action: 'apply', from, ...(input.cycle && { cycle: input.cycle }), reason: 'Applied.', evidence: { gate: input.result.reason, cases: caseEvidence(input.result) } };
      const { to, written } = await store.commit(next, { from, action: 'apply', audit });
      return { from, to, written };
    } catch (error) {
      return refused(store.audit, actor, from, '', input.cycle, error);
    }
  });
}

/** `rollbackHarness` over any `HarnessStore`: restores a saved revision as a new revision through the store. */
export async function rollbackHarnessIn(store: HarnessStore, to: string, by: RollbackBy): Promise<RollbackResult> {
  const actor = cleanActor(by.actor);
  return store.withLock(async () => {
    const state = await store.read();
    const from = harnessHash(state.harness);
    try {
      const target = rollbackTarget(await store.revisions(), store.key, to, state.harness, by.expectedFrom);
      guardReadOnly(target, state);
      const result = await store.commit(target, { from, action: 'rollback', audit: { actor, action: 'rollback', from, reason: by.reason } });
      return { from, ...result };
    } catch (error) {
      return refused(store.audit, actor, from, `Rollback to ${to.slice(0, 12)} not done: `, undefined, error);
    }
  });
}
