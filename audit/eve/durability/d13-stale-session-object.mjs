// D13: an AgentSession object caches its transcript after the first read
// (ensureLoaded runs once). Once any other session object for the same id
// (or agent.resume / agent.approvals.resolve, which open their own) commits a
// turn, the cached object is stale forever: load()/messages/history() return
// the old transcript, and its next send() fails LOUSHO_SESSION_BUSY - even
// with no concurrency at all, in one process, on one store object.
import { createAgent, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel([(r) => `ack ${r.messages.at(-1).content}`], { onExhausted: 'repeat-last' }), store: memoryStore() });
const tabA = agent.session({ id: 'user-1' });
const tabB = agent.session({ id: 'user-1' });
await tabA.send('hello from tab A');
console.log('tabB.load() after A\'s turn:', (await tabB.load()).length, 'msgs');
await tabA.send('second message from tab A');      // strictly sequential, no overlap
console.log('tabB.load() after A\'s 2nd turn:', (await tabB.load()).length, 'msgs (store has', (await agent.session({ id: 'user-1' }).load()).length, ')');
try {
  await tabB.send('hello from tab B');
  console.log('tabB.send -> ok  PASS');
} catch (e) {
  console.log('tabB.send ->', e.code, '-', e.message.slice(0, 90));
  console.log('  FAIL: sequential use of two session objects for one id breaks; the stale object can never send again');
  try { await tabB.send('retry'); console.log('  retry ok'); } catch (e2) { console.log('  retry ->', e2.code, '(permanent: the stale cache is never refreshed)'); }
}

// Same, with a side-effecting tool: the tool runs, then the commit is refused.
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
let emails = 0;
const tools = [defineTool({ name: 'send_email', description: 'send email', input: z.object({}), execute: async () => { emails++; return 'sent'; } })];
const agent2 = createAgent({ provider: mockModel([(r) => r.messages.at(-1).role === 'tool' ? 'Email sent.' : String(r.messages.at(-1).content).includes('email') ? { toolCalls: [{ name: 'send_email', args: {} }] } : 'hello'], { onExhausted: 'repeat-last' }), tools, store: memoryStore() });
const stale = agent2.session({ id: 'u2' });
await stale.load();
await agent2.session({ id: 'u2' }).send('hi');           // another request handler's object
try { await stale.send('email my boss'); } catch (e) { console.log(`\nwith a tool: send ->`, e.code, `| emails actually sent: ${emails} | stored transcript has a tool result:`, JSON.stringify((await agent2.session({ id: 'u2' }).load()).some((m) => m.role === 'tool'))); }
