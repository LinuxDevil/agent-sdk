// Repro (no model): withFallback() keeps ONE mutable `active` provider for all calls. Under concurrent
// calls (a batch sharing one provider), onFallback reports the wrong `from`, and the wrapper's
// name/defaultModel - which the executor reads to label each call - belong to some other call.
import { createAgent, withFallback, type LLMProvider } from '@lousho/build-ai-agent';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function mock(name: string, defaultModel: string, behave: (prompt: string) => Promise<void>): LLMProvider & { seen: Array<string | undefined> } {
  const seen: Array<string | undefined> = [];
  return {
    name, defaultModel, seen,
    async generate(o: any) {
      seen.push(o.model);
      const prompt = JSON.stringify(o.messages.at(-1)?.content);
      await behave(prompt);
      return { text: `${name} served ${prompt}`, finishReason: 'stop', usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 } } as any;
    },
    async stream() { throw new Error('n/a'); },
    supportsTools: () => true, supportsStreaming: () => false, getModels: async () => [defaultModel],
  };
}

// primary: request "A" fails after 10 ms, "B" fails after 100 ms, "C" succeeds after 50 ms
const p1 = mock('primary', 'gpt-4o-mini', async (p) => {
  if (p.includes('A')) { await sleep(10); throw Object.assign(new Error('503 overloaded (A)'), { statusCode: 503 }); }
  if (p.includes('B')) { await sleep(100); throw Object.assign(new Error('503 overloaded (B)'), { statusCode: 503 }); }
  await sleep(50);
});
const p2 = mock('fallback', 'gpt-4o', async () => { await sleep(300); });
const fallbacks: string[] = [];
const provider = withFallback([p1, p2], { onFallback: ({ from, to, error }) => fallbacks.push(`${from} -> ${to} (${(error as Error).message})`) });

const agent = createAgent({ provider, instructions: 'x', retry: false } as any);
const [a, b, c] = await Promise.all([
  agent.send('A'),
  agent.send('B'),
  sleep(150).then(() => agent.send('C')), // starts while A and B are being served by the fallback
]);
console.log('onFallback reports:');
for (const f of fallbacks) console.log('  ', f);
for (const [label, r] of [['A', a], ['B', b], ['C', c]] as const) {
  console.log(`${label}: text=${JSON.stringify(r.text)} byModel=${JSON.stringify(Object.keys(r.usage.byModel ?? {}))} costUsd=${r.usage.costUsd}`);
}
console.log('models the primary was asked for:', p1.seen, ' fallback:', p2.seen);
