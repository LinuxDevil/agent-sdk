/* Eve multiagent repro 3: task-session bookkeeping in a long-lived lead session.
 *  A) taskId allocation re-probes task_1..task_N in the store on every new task of every turn (O(N) store reads per task).
 *  B) a failed task's id is never saved, so a later turn hands the SAME taskId to a different task.
 * Run: npx tsx eve/multiagent/r3-task-sessions.ts
 */
import { createAgent, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

// ---- A
{
  const store = memoryStore();
  let loads = 0;
  const sessions = store.sessions!;
  const counted = { ...store, sessions: { ...sessions, load: (id: string) => (id.startsWith('subagent-task-') && loads++, sessions.load(id)), save: sessions.save.bind(sessions), delete: sessions.delete.bind(sessions) } } as any;
  const child = mockModel(['ok'], { onExhausted: 'repeat-last' });
  const lead = mockModel(
    Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'p', description: 'd' } }] } : 'done'))
  );
  const worker = createAgent({ provider: child, instructions: 'w', description: 'Worker' });
  const agent = createAgent({ provider: lead, instructions: 'lead', subagents: { worker }, store: counted });
  const s = agent.session({ id: 'long-lived' });
  const marks: string[] = [];
  for (let turn = 1; turn <= 200; turn++) {
    const before = loads;
    const r = await s.send(`turn ${turn}`);
    if ([1, 10, 50, 100, 200].includes(turn)) {
      const footer = JSON.stringify(r.messages.filter((m: any) => m.role === 'tool').at(-1)?.content).match(/taskId '([^']+)'/)?.[1];
      marks.push(`turn ${turn}: ${loads - before} subagent-task store reads to allocate ${footer}`);
    }
  }
  console.log('[A]', marks.join('\n[A] '));
}

// ---- B
{
  const store = memoryStore();
  const flaky = mockModel([{ error: Object.assign(new Error('400 bad'), { status: 400 }) }, 'writer answer']);
  const lead = mockModel([
    { toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'p', description: 'd', background: true } }] },
    { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] },
    'turn 1 done',
    { toolCalls: [{ name: 'task', args: { agent: 'writer', prompt: 'p', description: 'd' } }] },
    'turn 2 done',
  ]);
  const researcher = createAgent({ provider: flaky, instructions: 'r', description: 'Researcher', retry: false } as any);
  const writer = createAgent({ provider: flaky, instructions: 'w', description: 'Writer', retry: false } as any);
  const agent = createAgent({ provider: lead, instructions: 'lead', subagents: { researcher, writer }, store });
  const s = agent.session({ id: 'b' });
  const r1 = await s.send('one');
  console.log('[B] turn 1 agent_await result:', JSON.stringify(r1.messages.filter((m: any) => m.role === 'tool').at(-1)?.content).slice(0, 140));
  const r2 = await s.send('two');
  console.log('[B] turn 2 task result:', JSON.stringify(r2.messages.filter((m: any) => m.role === 'tool').at(-1)?.content).slice(0, 160));
}
