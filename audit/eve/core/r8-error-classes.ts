// CORE: which error class/code does a caller actually get? (deterministic)
// Run: npx tsx eve/core/r8-error-classes.ts
import { createAgent, RateLimitError, TimeoutError, LLMProviderError } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const cases: Array<[string, Error]> = [
  ['429', Object.assign(new Error('Rate limit reached for requests'), { statusCode: 429, responseHeaders: { 'retry-after': '0' } })],
  ['timeout (ETIMEDOUT)', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
  ['401', Object.assign(new Error('Incorrect API key'), { statusCode: 401 })],
  ['context overflow', Object.assign(new Error("This model's maximum context length is 128000 tokens"), { statusCode: 400 })],
];
for (const [label, err] of cases) {
  const agent = createAgent({ provider: mockModel([{ error: err }], { onExhausted: 'repeat-last' }), retry: { maxRetries: 1, backoff: { initialMs: 1 } } });
  try {
    await agent.send('x');
  } catch (e: any) {
    console.log(
      '%s -> name=%s code=%s category=%s retryable=%s | instanceof RateLimitError=%s TimeoutError=%s LLMProviderError=%s',
      label.padEnd(20), e.name, e.code, e.compacted?.category, e.compacted?.retryable,
      e instanceof RateLimitError, e instanceof TimeoutError, e instanceof LLMProviderError
    );
  }
}
