// P7 (offline): withRetry({ timeoutMs }) is documented as bounding stream() only
// "up to its first chunk" - does a healthy, steadily streaming response survive past it?
// Run: npx tsx eve/providers/p7-stream-timeout.ts
import { OpenRouterProvider, withRetry } from '@lousho/build-ai-agent';
import { report } from '../../_shared/env.ts';

let calls = 0;
const sse: typeof fetch = async (_u, init) => {
  calls++;
  const enc = new TextEncoder();
  const signal = init?.signal as AbortSignal | undefined;
  const body = new ReadableStream({
    async start(ctrl) {
      const chunk = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      for (let i = 0; i < 8; i++) {
        if (signal?.aborted) return ctrl.error(signal.reason);
        chunk({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: `w${i} ` }, finish_reason: null }] });
        await new Promise((r) => setTimeout(r, 300)); // a token every 300ms: healthy stream, 2.4s total
      }
      chunk({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 } });
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const p = withRetry(new OpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch: sse }), { timeoutMs: 1000, maxRetries: 0 });
const s = await p.stream({ messages: [{ role: 'user', content: 'hi' }] });
let text = '';
let error: unknown;
try {
  for await (const c of s.fullStream) {
    if (c.type === 'text-delta') text += c.textDelta;
    if (c.type === 'error') error = c.error;
  }
} catch (e) {
  error = e;
}
console.log({ calls, text, error: error && String((error as any).message ?? error).slice(0, 120) });
report('a stream that started within timeoutMs runs to completion', !error && text.includes('w7'), `got "${text.trim()}"`);
