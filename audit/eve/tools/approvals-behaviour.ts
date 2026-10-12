/* TOOLS: approval gate behaviour probes with a scripted model.
   1) needsApproval predicate throws  2) two parallel calls that both need approval
   3) once() after an `approve`-callback (non-human) approval
   Run: npx tsx eve/tools/approvals-behaviour.ts */
import { z } from 'zod';
import { createAgent, defineTool, once } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const tool = (name: string, needsApproval: any, log: string[]) => defineTool({
  name, description: name, input: z.object({ n: z.number() }), needsApproval,
  execute: async ({ n }) => { log.push(`${name}(${n})`); return 'ok'; },
});

// 1
{
  const log: string[] = [];
  const t = tool('flaky_policy', () => { throw new Error('policy backend down'); }, log);
  const model = mockModel([{ toolCalls: [{ name: 'flaky_policy', args: { n: 1 } }] }, 'done']);
  const agent = createAgent({ provider: model, instructions: 'i', tools: [t] });
  try {
    const r = await agent.send('go');
    const toolMsg: any = model.calls[1]?.messages.find((m: any) => m.role === 'tool');
    console.log('1) throwing needsApproval -> run', r.finishReason, '| executed:', log.length, '| model saw:', JSON.stringify(toolMsg?.content).slice(0, 120));
  } catch (e) {
    console.log('1) throwing needsApproval -> run THREW:', (e as Error).message.slice(0, 100));
  }
}

// 2
{
  const log: string[] = [];
  const a = tool('wire_money', true, log), b = tool('delete_db', true, log);
  const model = mockModel([{ toolCalls: [{ name: 'wire_money', args: { n: 1 } }, { name: 'delete_db', args: { n: 2 } }] }, 'done', 'done'], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: model, instructions: 'i', tools: [a, b] });
  const r = await agent.send('go');
  const pend = await agent.approvals.list();
  console.log('2) parallel approvals -> pending listed:', pend.map((p) => p.toolName).join(','), '| approvalId on result:', Boolean(r.approvalId));
  const r2 = await agent.approvals.resolve({ id: r.approvalId!, approved: true });
  const pend2 = await agent.approvals.list();
  console.log('   after approving the first -> finish', r2.finishReason, '| pending now:', pend2.map((p) => p.toolName).join(','), '| executed:', log.join(','));
}

// 3
{
  const log: string[] = [];
  const t = tool('send_email', once(), log);
  const model = mockModel([
    { toolCalls: [{ name: 'send_email', args: { n: 1 } }] },
    { toolCalls: [{ name: 'send_email', args: { n: 2 } }] },
    'done',
  ]);
  let asked = 0;
  const agent = createAgent({ provider: model, instructions: 'i', tools: [t], approve: () => { asked++; return asked === 1; } });
  const r = await agent.session({ id: 'x' }).send('go');
  console.log('3) once() + approve callback -> callback asked', asked, 'times | executed:', log.join(','), '|', r.finishReason);
}
