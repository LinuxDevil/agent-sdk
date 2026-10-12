// Does withRetry / createAgent({retry}) retry 5xx from a custom LLMProvider (docs: "implement the LLMProvider interface")?
import { createAgent, LLMProviderError, withRetry } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
const cases: Array<[string, () => Error]> = [
  ['plain Error status/statusCode 503', () => Object.assign(new Error('server overloaded'), { status: 503, statusCode: 503 })],
  ['SDK LLMProviderError(statusCode 503)', () => new (LLMProviderError as any)('Service Unavailable', 'custom', 503)],
  ['SDK LLMProviderError(statusCode 500) "Internal Server Error"', () => new (LLMProviderError as any)('Internal Server Error', 'custom', 500)],
  ['message "429 Too Many Requests"', () => new Error('429 Too Many Requests')],
];
for (const [label, mk] of cases) {
  const m = mockModel([{ error: mk() }, 'recovered']);
  const r = await createAgent({ provider: m, retry: { maxRetries: 2, backoff: { initialMs: 5 } } }).send('x').then((x) => 'OK ' + x.text, (e: any) => `REJECT ${e.code} category=${e.compacted?.category} retryable=${e.compacted?.retryable}`);
  console.log(`${label}: ${r} (calls=${m.calls.length})`);
}
