// D14: session.fork() on edge ids / steps.
import { createAgent, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const agent = createAgent({ provider: mockModel([(r) => `ack ${r.messages.at(-1).content}`], { onExhausted: 'repeat-last' }), store: memoryStore() });
// (a) a valid 128-char id (e.g. a hashed tenant/user key) cannot be forked: the default `<id>-fork-<n>` is invalid
const longId = 'u'.repeat(128);
const s = agent.session({ id: longId });
await s.send('hello');
try { const f = await s.fork({ fromStep: 1 }); console.log('(a) fork of 128-char id ->', f.id.length, 'PASS'); }
catch (e) { console.log('(a) fork of a valid 128-char id ->', e.code, '-', e.message.slice(0, 80)); }
// (b) a 120-char id: forks until `-fork-<n>` crosses 128, then breaks
const mid = agent.session({ id: 'm'.repeat(121) });
await mid.send('hi');
try { const f = await mid.fork({ fromStep: 1 }); console.log('(b) 121-char id fork ->', f.id.length); } catch (e) { console.log('(b) 121-char id fork ->', e.code); }
// (c) fork from step 0
const z = await s.history();
console.log('(c) history steps:', z.length);
