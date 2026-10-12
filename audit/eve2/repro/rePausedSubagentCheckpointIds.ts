/**
 * REPRO: a resumed sub-agent that pauses AGAIN on a GROUP of approvals gets
 * its checkpoint written by markAwaitingApproval() (resume.ts:1298-1313),
 * which saves `approvalId` but drops `approvalIds` - while the first pause
 * (saveStepCheckpoint) and partial decisions (markGroupPending) both keep it.
 *
 * Expected: the session checkpoint names every approval the run waits on,
 *           so session.pending() / pendingTurnDiscarded / listPendingRuns see
 *           all of them.
 * Actual:   the checkpoint names only the first; the siblings are invisible
 *           to checkpoint readers (and leaked if the turn is discarded).
 */
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { defineTool } from '../../../src/tools/defineTool';
import { mockModel } from '../../../src/testing/mockModel';
import { memoryStore } from '../../../src/storage/agentStore';
import { pausedApprovalIds } from '../../../src/execution/checkpoint';

const work = defineTool({
  name: 'do_work',
  description: 'work',
  input: z.object({ n: z.number() }),
  needsApproval: true,
  execute: async ({ n }) => `did ${n}`,
});

const worker = createAgent({
  prompt: 'worker',
  description: 'a worker sub-agent',
  provider: mockModel([
    // Turn 1: two approval calls -> the lead pauses with approvalIds [a1, a2].
    { toolCalls: [{ name: 'do_work', args: { n: 1 } }, { name: 'do_work', args: { n: 2 } }] },
    // Turn 2 (after both are approved): two MORE approval calls -> pauses again on a group.
    { toolCalls: [{ name: 'do_work', args: { n: 3 } }, { name: 'do_work', args: { n: 4 } }] },
    { text: 'worker done' },
  ]),
  tools: [work],
});

const store = memoryStore();
const lead = createAgent({
  prompt: 'lead',
  provider: mockModel([
    { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'work' } }] },
    { text: 'lead done' },
  ]),
  store,
  subagents: { worker },
});

const first = await lead.send('go', { sessionId: 's1' });
console.log('first pause:', first.approvalIds);

const checkpoint1 = await store.checkpoints.load('s1');
console.log('checkpoint after first pause - pausedApprovalIds:', pausedApprovalIds(checkpoint1 ?? {}));

const [a1, a2] = first.approvalIds!;
await lead.approvals.resolve({ id: a1, approved: true });
const second = await lead.approvals.resolve({ id: a2, approved: true });

console.log('second pause (resume result):', second.finishReason, second.approvalIds);
const checkpoint2 = await store.checkpoints.load('s1');
console.log('checkpoint after re-pause   - status:', checkpoint2?.status, 'approvalId:', checkpoint2?.approvalId, 'approvalIds:', checkpoint2?.approvalIds);
const seen = pausedApprovalIds(checkpoint2 ?? {});
console.log('checkpoint after re-pause   - pausedApprovalIds:', seen);

const expected = second.approvalIds ?? [];
if (seen.length !== expected.length) {
  console.log(`BUG CONFIRMED: checkpoint under-reports the group (${seen.length} of ${expected.length} approvals named)`);
} else {
  console.log('OK: checkpoint names every pending approval');
}
