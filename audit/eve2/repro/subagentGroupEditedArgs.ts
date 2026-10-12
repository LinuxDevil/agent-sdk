/**
 * REPRO: approve-with-edits on a sub-agent's GROUPED approval skips schema
 * validation, so a tool executes with args that violate its zod schema.
 *
 * Flow under test:
 *   - Worker emits TWO calls to `add(a, b)` (a,b: numbers) in one turn ->
 *     the lead pauses once with approvalIds=[id1, id2] (snapshot.subagent +
 *     approvalGroup).
 *   - resolve() stores decision.args RAW for sub-agent snapshots
 *     (resume.ts groupDecision: `snapshot.subagent ? decision.args : withEditedArgs(...)`).
 *   - On resume, the sub-agent's nested resume takes `mine` from the stored
 *     member decision and NEVER calls withEditedArgs() -> no validation.
 *   - executeToolWithSandboxGuard() does not validate either -> the tool's
 *     execute() runs with garbage args.
 *
 * Expected: an invalid edit is rejected (LOUSHO_TOOL_ARGS_INVALID), as it is
 * for top-level approvals and for single (non-grouped) sub-agent approvals.
 * Actual:   tool runs with `a: 'not-a-number'`.
 */
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { defineTool } from '../../../src/tools/defineTool';
import { mockModel } from '../../../src/testing/mockModel';

const seen: unknown[] = [];
const add = defineTool({
  name: 'add',
  description: 'add two numbers',
  input: z.object({ a: z.number(), b: z.number() }),
  needsApproval: true,
  execute: async (args) => {
    seen.push(args);
    // If validation ran, `a` is always a number; guard catches the leak.
    if (typeof (args as { a: unknown }).a !== 'number') return 'RAN-WITH-UNVALIDATED-ARGS';
    return (args.a + args.b).toString();
  },
});

const worker = createAgent({
  prompt: 'worker',
  description: 'a worker sub-agent',
  provider: mockModel([
    {
      toolCalls: [
        { name: 'add', args: { a: 1, b: 2 } },
        { name: 'add', args: { a: 3, b: 4 } },
      ],
    },
    { text: 'worker done' },
  ]),
  tools: [add],
});

const lead = createAgent({
  prompt: 'lead',
  provider: mockModel([
    { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'add' } }] },
    { text: 'lead done' },
  ]),
  subagents: { worker },
});

const paused = await lead.send('go');
console.log('pause:', paused.finishReason, 'ids:', paused.approvalIds);
if (paused.finishReason !== 'awaiting-approval' || (paused.approvalIds?.length ?? 0) !== 2) {
  throw new Error(`expected a group of 2 pending approvals, got ${JSON.stringify(paused.approvalIds)}`);
}

// Approve member 1 normally; approve member 2 with args that VIOLATE the
// tool's zod schema (`a` must be a number). Order reversed to prove the
// stored-decision path, not decision order, decides.
const [id1, id2] = paused.approvalIds!;
const still = await lead.approvals.resolve({ id: id2, approved: true, args: { a: 'not-a-number', b: 4 } });
console.log('after resolving id2 (edited args):', still.finishReason, still.approvalIds);
const done = await lead.approvals.resolve({ id: id1, approved: true });
console.log('final:', done.finishReason, '| tool args seen:', JSON.stringify(seen));

const bad = seen.some((a) => typeof (a as { a?: unknown }).a !== 'number');
if (bad) {
  console.log('BUG CONFIRMED: tool executed with schema-invalid args on a sub-agent grouped approval');
} else {
  console.log('OK: edited args were validated/rejected');
}
