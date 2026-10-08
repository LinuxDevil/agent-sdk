// Repro (deterministic mock model): one createAgent() instance shared by many parallel send()s - with `output`,
// and with approvals paused concurrently and resolved out of order. Any state bleed between runs?
import { createAgent, defineTool, type LLMProvider } from '@lousho/build-ai-agent';
import { z } from 'zod';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastUser = (msgs: any[]) => { const m = [...msgs].reverse().find((x) => x.role === 'user'); return typeof m.content === 'string' ? m.content : JSON.stringify(m.content); };
const docOf = (s: string) => /DOC-(\d+)/.exec(s)?.[0] ?? 'none';

// --- 1) structured output: the model echoes the doc id from the latest user message after a random delay
const echo: LLMProvider = {
  name: 'echo', defaultModel: 'm',
  async generate(o: any) {
    await sleep(Math.random() * 40);
    const doc = docOf(String(o.messages.find((m: any) => m.role === 'user').content));
    // every 5th doc answers invalid first, to exercise the repair step concurrently
    const firstTry = !o.messages.some((m: any) => typeof m.content === 'string' && m.content.startsWith('[output-invalid]'));
    const n = Number(doc.split('-')[1]);
    const text = firstTry && n % 5 === 0 ? '{"docId":42}' : JSON.stringify({ docId: doc, seenUserMsgs: o.messages.filter((m: any) => m.role === 'user').length });
    return { text, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } as any;
  },
  async stream() { throw new Error('n/a'); }, supportsTools: () => true, supportsStreaming: () => false, getModels: async () => ['m'],
};
const extractor = createAgent({ provider: echo, output: z.object({ docId: z.string(), seenUserMsgs: z.number() }) });
const N = 40;
const results = await Promise.all(Array.from({ length: N }, (_, i) => extractor.send(`Extract DOC-${i}`)));
const wrong = results.filter((r, i) => r.object?.docId !== `DOC-${i}`);
const foreign = results.filter((r, i) => r.messages.some((m) => m.role === 'user' && /DOC-\d+/.test(String(m.content)) && docOf(String(m.content)) !== `DOC-${i}`));
const repaired = results.filter((r) => r.steps === 2).length;
console.log(`output: ${N} parallel sends, wrong object ${wrong.length}, foreign messages ${foreign.length}, repaired ${repaired} (expected ${N / 5}), max user msgs seen ${Math.max(...results.map((r) => r.object?.seenUserMsgs ?? 0))}`);

// --- 2) approvals: 12 runs pause concurrently on the same agent; resolve them in reverse order
const paid: string[] = [];
const pay = defineTool({ name: 'pay', description: 'pay', input: z.object({ docId: z.string() }), needsApproval: true, execute: async ({ docId }) => { paid.push(docId); return `paid ${docId}`; } });
const caller: LLMProvider = {
  name: 'caller', defaultModel: 'm',
  async generate(o: any) {
    await sleep(Math.random() * 30);
    const last = o.messages.at(-1);
    if (last.role === 'tool') return { text: `done: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}`, finishReason: 'stop' } as any;
    const doc = docOf(lastUser(o.messages));
    return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: `call_${doc}`, type: 'function', function: { name: 'pay', arguments: JSON.stringify({ docId: doc }) } }] } as any;
  },
  async stream() { throw new Error('n/a'); }, supportsTools: () => true, supportsStreaming: () => false, getModels: async () => ['m'],
};
const payments = createAgent({ provider: caller, tools: [pay] });
const paused = await Promise.all(Array.from({ length: 12 }, (_, i) => payments.send(`Pay DOC-${i}`)));
const pending = await payments.approvals.list();
console.log(`approvals: ${paused.filter((p) => p.finishReason === 'awaiting-approval').length} paused, ${pending.length} pending, unique ids ${new Set(pending.map((p) => p.id)).size}`);
const mism: string[] = [];
for (const p of [...pending].reverse()) {
  const want = (p.args as any).docId;
  const r = await payments.approvals.resolve({ id: p.id, approved: Number(want.split('-')[1]) % 2 === 0, note: 'odd docs rejected' });
  if (!r.text.includes(want) && !r.text.includes('odd docs rejected') && !/reject|denied/i.test(r.text)) mism.push(`${want}: ${r.text}`);
  if (r.messages.some((m) => m.role === 'user' && docOf(String(m.content)) !== want && /DOC-/.test(String(m.content)))) mism.push(`${want}: foreign transcript`);
}
console.log(`approvals resolved in reverse order: paid ${paid.sort().join(',')}; mismatches ${mism.length}${mism.length ? ': ' + mism.join(' / ') : ''}`);
// resolve() result typing: is `object` typed on an agent with output? (see typing.ts)
