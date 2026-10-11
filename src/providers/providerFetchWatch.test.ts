/**
 * The response watching of the built-in providers' `fetch` (providerFetch):
 * in-response failures, unique tool-call ids and the idle `timeout`, on
 * hand-made responses.
 */
import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { chatCompletionFailure, chatCompletionWatch, providerFetch, uniqueToolCallIds } from './providerFetch';

const sse = (...payloads: unknown[]) => payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

/** A `send` answering with `body` (an event stream when it starts with `data:`), its chunks `gapMs` apart. */
function sendOf(body: string, { gapMs = 0, chunks = [body] }: { gapMs?: number; chunks?: string[] } = {}) {
  return () => async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const piece of chunks) {
            if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
            controller.enqueue(new TextEncoder().encode(piece));
          }
          controller.close();
        },
      }),
      { headers: { 'content-type': body.startsWith('data:') ? 'text/event-stream' : 'application/json' } }
    );
}

describe('chatCompletionFailure', () => {
  it("reads finish_reason 'error' and an error object; leaves normal chunks and Responses API events alone", () => {
    expect(chatCompletionFailure(JSON.stringify({ choices: [{ finish_reason: 'error' }] }))).toMatchObject({ status: 502 });
    expect(chatCompletionFailure(JSON.stringify({ error: { code: 429, message: 'slow down' }, choices: [] }))).toEqual({
      status: 429,
      message: 'The provider reported an error mid-response: slow down',
    });
    expect(chatCompletionFailure(JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content: 'the "error" word' } }] }))).toBeUndefined();
    expect(chatCompletionFailure(JSON.stringify({ type: 'error', message: 'x', error: { message: 'x' } }))).toBeUndefined();
  });
});

describe('providerFetch', () => {
  it("turns a JSON reply with finish_reason 'error' into a 502 error response", async () => {
    const fetch = providerFetch({ send: sendOf(JSON.stringify({ choices: [{ finish_reason: 'error', message: { content: 'cut' } }] })), watch: chatCompletionWatch });
    const response = await fetch('https://x/v1/chat/completions');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("finish reason 'error'") } });
  });

  it('errors an event stream at the failing line, after the lines before it', async () => {
    const body = sse({ choices: [{ delta: { content: 'Partial' } }] }, { error: { message: 'Upstream died' }, choices: [{ finish_reason: 'error' }] });
    const response = await providerFetch({ send: sendOf(body), watch: chatCompletionWatch })('https://x/v1/chat/completions');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('Partial');
    const error = await reader.read().catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ statusCode: 502, isRetryable: true, message: expect.stringContaining('Upstream died') });
  });

  it('passes a normal event stream through, split lines included', async () => {
    const body = sse({ choices: [{ delta: { content: 'hello' } }] }, '[DONE]');
    const response = await providerFetch({ send: sendOf(body, { chunks: [body.slice(0, 7), body.slice(7)] }), watch: chatCompletionWatch })('https://x');
    expect(await response.text()).toBe(body);
  });

  it('fails a body that stalls longer than timeoutMs with a TimeoutError', async () => {
    const body = sse({ choices: [{ delta: { content: 'a' } }] });
    const response = await providerFetch({ send: sendOf(body, { gapMs: 200, chunks: [body, body] }), timeoutMs: 50 })('https://x');
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('fails a response whose headers take longer than timeoutMs', async () => {
    const slow = () => (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('{}')), 500);
        init?.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(init.signal?.reason)));
      });
    await expect(providerFetch({ send: slow, timeoutMs: 50 })('https://x')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('uniqueToolCallIds', () => {
  it('suffixes a repeated id in a message, and keeps a stream call\'s id across its deltas', () => {
    const rewrite = uniqueToolCallIds();
    const message = { choices: [{ message: { tool_calls: [{ id: 'dup' }, { id: 'dup' }] } }] };
    expect(JSON.parse(rewrite(JSON.stringify(message))!)).toEqual({ choices: [{ message: { tool_calls: [{ id: 'dup' }, { id: 'dup_2' }] } }] });

    const stream = uniqueToolCallIds();
    const delta = (index: number, id: string) => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, id }] } }] });
    expect(stream(delta(0, 'c'))).toBeUndefined();
    expect(stream(delta(0, 'c'))).toBeUndefined(); // the same call repeating its id
    expect(JSON.parse(stream(delta(1, 'c'))!).choices[0].delta.tool_calls[0].id).toBe('c_2');
    expect(JSON.parse(stream(delta(1, 'c'))!).choices[0].delta.tool_calls[0].id).toBe('c_2');
  });
});
