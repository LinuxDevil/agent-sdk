import { createAgent, memoryStore } from '../../src/index';
import { defineTool } from '../../src/tools/defineTool';
import { mockModel } from '../../src/testing/index';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});

async function r1_discardPendingZombie() {
  console.log('=== R1: discardPending leaves armed approval; resolve clobbers transcript ===');
  const store = memoryStore();
  const agent = createAgent({
    provider: mockModel([
      { toolCalls: [{ name: 'send_email', args: { to: 'a@x.com' } }] },
      'done with email',
      'second turn answer',
    ]),
    tools: [sendEmail],
    store,
  });
  const s = agent.session({ id: 'sess1' });
  const paused = await s.send('email a');
  console.log('paused:', paused.finishReason, paused.approvalId);
  await s.discardPending();
  console.log('after discard pending:', await s.pending());
  // move transcript forward
  const r2 = await s.send('say something else');
  console.log('after new send, transcript length:', s.messages.length, 'text:', r2.text);
  // now resolve the zombie approval
  try {
    const res = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    console.log('resolve result:', res.finishReason, JSON.stringify(res.text));
  } catch (e) {
    console.log('resolve threw:', (e as Error).name, (e as Error).message);
  }
  console.log('final transcript roles:', s.messages.map((m) => m.role + ':' + String(m.content).slice(0, 30)));
  console.log('pending:', await s.pending());
}

async function r2_turnNamespaceInjection() {
  console.log('\n=== R2: send({sessionId: sess.turn-N}) injects into a session ===');
  const store = memoryStore();
  const agent = createAgent({
    provider: mockModel(['first answer', 'foreign run answer', 'third answer']),
    store,
  });
  const s = agent.session({ id: 'victim' });
  await s.send('hello'); // transcript len becomes 2 -> next turn key = victim.turn-2
  console.log('transcript len:', s.messages.length);
  // foreign durable run claiming the session's next turn key
  const foreign = await agent.send('FORGED', { sessionId: 'victim.turn-2' });
  console.log('foreign run done:', foreign.finishReason);
  // victim session's next send adopts the foreign 'finished' checkpoint
  const pending = await s.pending();
  console.log('pending:', pending);
  console.log('victim transcript now:', s.messages.map((m) => `${m.role}:${String(m.content).slice(0, 40)}`));
}

async function r3_dynamicAgentLosesApproval() {
  console.log('\n=== R3: dynamic config throw during resolve loses the approval forever ===');
  const store = memoryStore();
  let failResolve = false;
  const agent = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'b@x.com' } }] }]),
    tools: [sendEmail],
    instructions: () => {
      if (failResolve) throw new Error('config backend down');
      return 'You send emails.';
    },
    store,
  });
  const s = agent.session({ id: 'sess3' });
  const paused = await s.send('email b');
  console.log('paused:', paused.finishReason, paused.approvalId);
  failResolve = true;
  try {
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
  } catch (e) {
    console.log('resolve threw:', (e as Error).name, (e as { code?: string }).code, (e as Error).message.slice(0, 80));
  }
  failResolve = false;
  // try again now that backend is back
  try {
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    console.log('second resolve worked');
  } catch (e) {
    console.log('second resolve threw:', (e as Error).name, (e as { code?: string }).code);
  }
  console.log('approvals.list:', (await agent.approvals.list()).length);
  console.log('get:', await agent.approvals.get(paused.approvalId!));
  // session still says awaiting-approval forever
  const p = await s.pending();
  console.log('session pending:', p);
  try {
    await s.send('are you there?');
  } catch (e) {
    console.log('send threw:', (e as Error).name, (e as { code?: string }).code);
  }
}

async function r4_sessionBudgetLostOnResume() {
  console.log('\n=== R4: session limits dropped on approval-resumed turn ===');
  const store = memoryStore();
  const lookup = defineTool({
    name: 'lookup', description: 'look up', input: z.object({ q: z.string() }),
    execute: async ({ q }) => `result ${q}`,
  });
  const agent = createAgent({
    provider: mockModel([
      { toolCalls: [{ name: 'send_email', args: { to: 'c@x.com' } }], usage: { inputTokens: 100, outputTokens: 100 } },
      { toolCalls: [{ name: 'lookup', args: { q: 'x' } }], usage: { inputTokens: 100, outputTokens: 100 } },
      'final', // would be step 3
    ]),
    tools: [sendEmail, lookup],
    store,
  });
  // session limit: 150 tokens total. Turn1 pauses after spending 200 already.
  const s = agent.session({ id: 'sess4', limits: { maxTokens: 150 } });
  const paused = await s.send('email then lookup');
  console.log('paused:', paused.finishReason);
  // resume: the continuation should trip the session budget immediately (200 > 150 spent)
  const res = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
  console.log('resumed finishReason:', res.finishReason, 'steps:', res.steps, 'tokens:', res.usage.totalTokens);
}

async function r5_crossProcessTranscriptLoss() {
  console.log('\n=== R5: durable approvals + non-durable sessions -> resolve loses the turn ===');
  const approvalsStore = store_of_memory().approvals;
  function store_of_memory() { return memoryStore(); }
  const sessions1 = store_of_memory().sessions;
  // process 1: agent with durable approvals, session store, NO checkpoints
  const agent1 = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'd@x.com' } }] }, 'sent!']),
    tools: [sendEmail],
    store: { sessions: sessions1, approvals: approvalsStore },
  });
  const s1 = agent1.session({ id: 'sess5' });
  const paused = await s1.send('email d');
  console.log('paused:', paused.finishReason, 'transcript len:', s1.messages.length);
  // process 2: new agent, same stores
  const agent2 = createAgent({
    provider: mockModel(['resumed answer']),
    tools: [sendEmail],
    store: { sessions: sessions1, approvals: approvalsStore },
  });
  const res = await agent2.approvals.resolve({ id: paused.approvalId!, approved: true });
  console.log('resolved:', res.finishReason, JSON.stringify(res.text));
  // open the session again - does the transcript have the turn?
  const s2 = agent2.session({ id: 'sess5' });
  await s2.load();
  console.log('transcript after resolve:', s2.messages.map((m) => `${m.role}:${String(m.content).slice(0, 40)}`));
}

async function main() {
  await r1_discardPendingZombie().catch((e) => console.log('R1 FAILED', e));
  await r2_turnNamespaceInjection().catch((e) => console.log('R2 FAILED', e));
  await r3_dynamicAgentLosesApproval().catch((e) => console.log('R3 FAILED', e));
  await r4_sessionBudgetLostOnResume().catch((e) => console.log('R4 FAILED', e));
  await r5_crossProcessTranscriptLoss().catch((e) => console.log('R5 FAILED', e));
}
main();
