// P6 (offline): retry classification + backoff against scripted HTTP failures.
// Run: npx tsx eve/providers/p6-retry-classification.ts
import { OpenRouterProvider, withRetry, compactProviderError } from '@lousho/build-ai-agent';
import { report } from '../../_shared/env.ts';

function scripted(status: number, body: unknown, headers: Record<string, string> = {}) {
  let calls = 0;
  const f: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { f, calls: () => calls };
}

async function probe(label: string, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = scripted(status, body, headers);
  const ac = new AbortController();
  const delays: number[] = [];
  let retried: unknown;
  const p = withRetry(new OpenRouterProvider({ apiKey: 'k', defaultModel: 'openai/gpt-4o-mini', fetch: s.f }), {
    maxRetries: 2,
    backoff: { maxMs: 30_000 }, // documented: "Upper bound for the computed delay"
    signal: ac.signal,
    onRetry: (i) => {
      delays.push(i.delayMs);
      retried ??= i.error;
      ac.abort(); // don't actually wait
    },
  });
  let err: any;
  try {
    await p.generate({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (e) {
    err = e;
  }
  const c = compactProviderError(retried ?? err);
  console.log(`${label.padEnd(44)} calls=${s.calls()} category=${c.category} retryable=${c.retryable} firstDelayMs=${delays[0] ?? '-'}`);
  return { delays, c };
}

const big = await probe('429 + Retry-After: 3600', 429, { error: { message: 'Rate limit exceeded', code: 429 } }, { 'retry-after': '3600' });
report('Retry-After is capped by backoff.maxMs (30s)', (big.delays[0] ?? 0) <= 30_000, `waits ${big.delays[0]}ms = ${(big.delays[0] ?? 0) / 60000} min`);

const quota = await probe('429 insufficient_quota (OpenAI billing)', 429, {
  error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' },
});
report('insufficient_quota is not retried', !quota.c.retryable, `category=${quota.c.category}`);

await probe('402 OpenRouter insufficient credits', 402, { error: { message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', code: 402 } });
const ms = await probe('503 + retry-after-ms: 2000 (OpenAI style)', 503, { error: { message: 'Service Unavailable', code: 503 } }, { 'retry-after-ms': '2000', 'retry-after': '2' });
report('503 Retry-After honored', ms.delays[0] === 2000, `firstDelay=${ms.delays[0]} (header said 2000ms)`);
await probe('529 Anthropic overloaded via 200-less body', 529, { error: { message: 'Overloaded', code: 529 } });
