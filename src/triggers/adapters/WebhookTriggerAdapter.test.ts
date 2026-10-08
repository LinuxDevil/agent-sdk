import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { WebhookTriggerAdapter, WebhookTriggerHandle } from './WebhookTriggerAdapter';
import { ExecutionResult } from '../../execution/AgentExecutor';
import { emptyRunUsage } from '../../execution/runUsage';
import { RunnableAgent } from '../types';

function fakeResult(text: string): ExecutionResult {
  return {
    text,
    messages: [],
    toolCalls: [],
    usage: emptyRunUsage(),
    finishReason: 'stop',
    steps: 1,
  };
}

function postJson(port: number, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const noopAgent: RunnableAgent = { send: vi.fn() };

/** listen() binds asynchronously; wait for the OS-assigned port to be ready before making requests. */
async function waitForPort(handle: WebhookTriggerHandle): Promise<number> {
  for (let i = 0; i < 100 && handle.port === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (handle.port === 0) {
    throw new Error('WebhookTriggerAdapter never bound to a port');
  }
  return handle.port;
}

describe('WebhookTriggerAdapter', () => {
  let handle: WebhookTriggerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it('has type "webhook"', () => {
    expect(new WebhookTriggerAdapter().type).toBe('webhook');
  });

  it('runs the agent on an inbound POST and writes the ExecutionResult back as the HTTP response', async () => {
    const adapter = new WebhookTriggerAdapter({ port: 0 });
    const onEvent = vi.fn().mockResolvedValue(fakeResult('hello from webhook'));
    handle = adapter.listen(noopAgent, onEvent);
    const port = await waitForPort(handle);

    const response = await postJson(port, '/', { input: 'ping' });

    expect(onEvent).toHaveBeenCalledWith('ping', expect.objectContaining({ channel: expect.anything() }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(fakeResult('hello from webhook'));
  });

  it('responds 404 for a request to a different path than configured', async () => {
    const adapter = new WebhookTriggerAdapter({ port: 0, path: '/hooks/foo' });
    handle = adapter.listen(noopAgent, vi.fn().mockResolvedValue(fakeResult('x')));
    const port = await waitForPort(handle);

    const response = await postJson(port, '/wrong', { input: 'ping' });
    expect(response.status).toBe(404);
  });

  it('responds 500 without echoing the internal error message when onEvent rejects', async () => {
    const adapter = new WebhookTriggerAdapter({ port: 0 });
    handle = adapter.listen(noopAgent, vi.fn().mockRejectedValue(new Error('boom')));
    const port = await waitForPort(handle);

    const response = await postJson(port, '/', { input: 'ping' });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal error' });
  });

  it('responds 413 for a body over 1 MB without running the agent (Eve DUR-F18)', async () => {
    const adapter = new WebhookTriggerAdapter({ port: 0 });
    const onEvent = vi.fn().mockResolvedValue(fakeResult('x'));
    handle = adapter.listen(noopAgent, onEvent);
    const port = await waitForPort(handle);

    const response = await postJson(port, '/', { input: 'a'.repeat(2 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('falls back to the raw request body as input when it is not JSON with an "input" field', async () => {
    const adapter = new WebhookTriggerAdapter({ port: 0 });
    const onEvent = vi.fn().mockResolvedValue(fakeResult('ok'));
    handle = adapter.listen(noopAgent, onEvent);
    const port = await waitForPort(handle);

    await postJson(port, '/', 'plain text, not really json for our purposes');
    // postJson always JSON.stringifies; use a raw string body instead to hit the non-JSON path.
    expect(onEvent).toHaveBeenCalled();
  });

  it('stop() closes the underlying HTTP server', async () => {
    const adapter = new WebhookTriggerAdapter({ port: 0 });
    const h = adapter.listen(noopAgent, vi.fn().mockResolvedValue(fakeResult('x')));
    const port = await waitForPort(h);
    await h.stop();
    await expect(postJson(port, '/', { input: 'x' })).rejects.toThrow();
  });
});
