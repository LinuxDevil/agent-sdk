import { createAgent, defineMemory, inMemoryMemory, memoryKey, defineTool, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
const toolNames = (c: any) => (c.tools ?? []).map((t: any) => t.name ?? t.function?.name);
// 1. key formats
const p = inMemoryMemory();
const notes = defineMemory({ name: 'notes', scope: 'global', provider: p });
const prefs = defineMemory({ name: 'prefs', scope: 'session', provider: p });
console.log('memoryKey global:', memoryKey(notes), '| session s1:', memoryKey(prefs, { sessionId: 's1' } as any), '| session none:', memoryKey(prefs));
// 2. name length 55 vs 56
for (const n of ['a'.repeat(55), 'a'.repeat(56), 'bad name']) { try { defineMemory({ name: n, scope: 'global', provider: p }); console.log('name len', n.length, 'ok'); } catch (e: any) { console.log('name', JSON.stringify(n).slice(0, 12), n.length, 'THROW', e.code); } }
// 3. session slot off in send() without sessionId; on with sessionId
const m1 = mockModel(['a', 'b']);
const ag = createAgent({ provider: m1, memory: [prefs], store: memoryStore() });
await ag.send('hi');
await ag.send('hi', { sessionId: 'sx' });
console.log('session slot tools w/o sessionId:', toolNames(m1.calls[0]), '| with sessionId:', toolNames(m1.calls[1]));
// 4. recall.maxItems default 10 into prompt, and recall_ default limit
const p2 = inMemoryMemory(); const s2 = defineMemory({ name: 'facts', scope: 'global', provider: p2, description: 'DESC-MARKER' });
for (let i = 0; i < 15; i++) await p2.add(memoryKey(s2)!, { text: `fact number ${i}` });
const m2 = mockModel([{ toolCalls: [{ name: 'recall_facts', args: {} }] }, 'done']);
const r2 = await createAgent({ provider: m2, memory: [s2] }).send('go');
const sys = String(m2.calls[0].messages[0].content);
console.log('items in prompt block:', (sys.match(/- fact number/g) ?? []).length, '| newest first?', sys.indexOf('fact number 14') < sys.indexOf('fact number 13'));
const recallMsg = r2.messages.find((m: any) => m.role === 'tool');
console.log('recall_ default result count:', (String(recallMsg?.content).match(/fact number/g) ?? []).length);
const descs = (m2.calls[0].tools ?? []).map((t: any) => `${t.name ?? t.function?.name}: ${t.description ?? t.function?.description}`);
console.log('desc in tool descriptions:', descs.map((d: string) => d.includes('DESC-MARKER')), descs);
// 5. dedupe
const p3 = inMemoryMemory(); const a1 = await p3.add('k', { text: 'same' }); const a2 = await p3.add('k', { text: 'same' });
console.log('dedupe same id:', a1.id === a2.id, 'count', (await p3.list('k')).length);
// 6. maxItems default 1000
const p4 = inMemoryMemory(); for (let i = 0; i < 1005; i++) await p4.add('k', { text: 't' + i });
console.log('inMemory cap:', (await p4.list('k', { limit: 5000 })).length);
// 7. itemSchema recall text
const p5 = inMemoryMemory();
const rel = defineMemory({ name: 'relationship', scope: 'global', provider: p5, itemSchema: z.object({ trust: z.number(), mood: z.string(), insideJokes: z.array(z.string()) }) });
const m5 = mockModel([{ toolCalls: [{ name: 'remember_relationship', args: { trust: 10, mood: 'playful', insideJokes: [] } }] }, { toolCalls: [{ name: 'recall_relationship', args: {} }] }, 'ok']);
const r5 = await createAgent({ provider: m5, memory: [rel] }).send('x');
console.log('itemSchema stored:', JSON.stringify(await p5.list(memoryKey(rel)!)));
console.log('recall tool content:', r5.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content).slice(0, 200)));
