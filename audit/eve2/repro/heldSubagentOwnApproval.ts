/**
 * REPRO: a model step that mixes the lead's OWN approval call with a
 * `task()` call whose sub-agent itself pauses for approval.
 *
 * The lead step emits [wire_money (lead approval), task (sub-agent pauses)].
 * subagentRuntime.ts's `settleSuspensions` marks the suspension 'held
 * pending approval of the other call' and resumes it when the lead call is
 * decided (heldSubagent path). This path has NO test in the repo.
 *
 * Expected: lead pauses on wire_money; resolving it resumes the suspended
 * sub-agent, which pauses on its own calls; resolving those completes.
 */
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { defineTool } from '../../../src/tools/defineTool';
import { mockModel } from '../../../src/testing/mockModel';
const log: string[] = [];
const say = (line: string) => {
  log.push(line);
  console.log(line);
};

const wire = defineTool({
  name: 'wire_money',
  description: 'wire funds',
  input: z.object({ amount: z.number() }),
  needsApproval: true,
  execute: async ({ amount }) => {
    say(`  TOOL wire_money(${amount}) EXECUTED`);
    return `wired ${amount}`;
  },
});

const childCall = defineTool({
  name: 'child_call',
  description: 'worker call',
  input: z.object({ n: z.number() }),
  needsApproval: true,
  execute: async ({ n }) => {
    say(`  TOOL child_call(${n}) EXECUTED`);
    return `child did ${n}`;
  },
});

const worker = createAgent({
  prompt: 'worker',
  description: 'a worker sub-agent',
  provider: mockModel([
    { toolCalls: [{ name: 'child_call', args: { n: 7 } }] },
    { text: 'worker done' },
  ]),
  tools: [childCall],
});

const lead = createAgent({
  prompt: 'lead',
  provider: mockModel([
    {
      toolCalls: [
        { name: 'wire_money', args: { amount: 100 } },
        { name: 'task', args: { agent: 'worker', prompt: 'do it' } },
      ],
    },
    { text: 'lead done' },
  ]),
  tools: [wire],
  subagents: { worker },
});

const first = await lead.send('go');
say(`1st result: finish=${first.finishReason} pending=[${(first.approvalIds ?? [first.approvalId]).join(',')}]`);

if (first.finishReason !== 'awaiting-approval') throw new Error('expected lead to pause on wire_money');
const leadId = first.approvalIds?.[0] ?? first.approvalId!;
const second = await lead.approvals.resolve({ id: leadId, approved: true });
say(`2nd result: finish=${second.finishReason} pending=[${(second.approvalIds ?? [second.approvalId]).join(',')}]`);

if (second.finishReason !== 'awaiting-approval' || (second.approvalIds ?? []).length !== 1) {
  throw new Error(`BUG: expected sub-agent pause with 1 pending call, got finish=${second.finishReason} ids=${JSON.stringify(second.approvalIds)}`);
}
const childId = second.approvalIds![0];
const third = await lead.approvals.resolve({ id: childId, approved: true });
say(`3rd result: finish=${third.finishReason}`);
say(`  last text: ${third.text}`);

if (third.finishReason !== 'stop' || third.text !== 'lead done') {
  throw new Error(`BUG: expected completed 'lead done', got finish=${third.finishReason} text=${JSON.stringify(third.text)}`);
}
say('OK: held-subagent pause chain completed');
