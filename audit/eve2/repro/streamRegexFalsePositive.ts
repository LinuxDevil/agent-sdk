/**
 * REPRO: `isStreamingRequest()` (providerFetch.ts:218) detects a streaming
 * request by regexing the RAW request body for /"stream"\s*:\s*true/ - so a
 * NON-streaming generate() call whose prompt (or tool args, or JSON-mode
 * content) merely mentions the literal text `"stream": true` is treated as
 * a streaming request.
 *
 * Consequence (providerFetch.ts:235-246): a JSON chat completion returned
 * for that call is replayed through `chatCompletionAsStream` - its body is
 * rewritten to `data: ...` SSE events and its content-type to
 * `text/event-stream`. The ai SDK's generateText() expects JSON for a
 * non-streamed call, so the call fails parsing the SSE body.
 *
 * Expected: a request that did not send `"stream": true` keeps its JSON
 *           response untouched.
 * Actual:   the JSON response is rewritten to an SSE stream.
 */
import { providerFetch, chatCompletionWatch } from '../../../src/providers/providerFetch';

const COMPLETION = JSON.stringify({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'It enables streaming.' } }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const fetchImpl = providerFetch({
  send: () => async () =>
    new Response(COMPLETION, { status: 200, headers: { 'content-type': 'application/json' } }),
  watch: () => chatCompletionWatch(),
});

// A NON-streamed request: no top-level "stream" key. A nested object field
// serializes as the literal `"stream":true` - e.g. a tool's parameters or a
// providerOptions passthrough carrying a `stream` flag (unlike the same text
// inside a string, which JSON escapes and the regex misses).
const body = JSON.stringify({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  providerOptions: { gateway: { stream: true } },
});

const response = await fetchImpl('https://api.openai.com/v1/chat/completions', { method: 'POST', body });
const contentType = response.headers.get('content-type');
const text = await response.text();

console.log(`response content-type: ${contentType}`);
console.log(`response body starts: ${JSON.stringify(text.slice(0, 80))}`);

let parses = true;
try {
  JSON.parse(text);
} catch {
  parses = false;
}

if (contentType === 'text/event-stream' || !parses) {
  console.log('BUG CONFIRMED: prompt text mentioning "stream": true rewrote the JSON reply into an SSE stream; a non-streaming consumer (ai SDK generateText) cannot parse it');
} else {
  console.log('OK: JSON response preserved');
}
