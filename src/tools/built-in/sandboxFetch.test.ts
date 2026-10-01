import { describe, it, expect, vi } from 'vitest';
import type { SandboxAdapter, SandboxRunOptions, SandboxResult } from '../../security/sandboxCore';
import { NoopSandbox } from '../../security/sandboxCore';
import { sandboxHttpFetch } from './sandboxFetch';
import { createHttpTool } from './http';
import { createSlackTool } from './slack';

const REQUEST = { url: 'https://example.test/hook', method: 'GET' };
const OK_RESULT: SandboxResult = {
  stdout: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: 'hi' }),
  stderr: '',
  exitCode: 0,
};

type RunArgs = [string, string[], SandboxRunOptions];

/** The options object `run` was called with the first time. */
function firstRunOptions(run: { mock: { calls: unknown[][] } }): SandboxRunOptions {
  return (run.mock.calls[0] as unknown as RunArgs)[2];
}

/** A sandbox whose run() never settles on its own (no network involved). */
function hangingSandbox() {
  const run = vi.fn(() => new Promise<SandboxResult>(() => undefined));
  const sandbox: SandboxAdapter = { name: 'hang', run, writeFile: async () => undefined };
  return { sandbox, run };
}

describe('sandboxHttpFetch cancellation (LOU-U17)', () => {
  it('(a) an already-aborted signal rejects with an AbortError without running anything', async () => {
    const { sandbox, run } = hangingSandbox();
    const controller = new AbortController();
    controller.abort();

    await expect(sandboxHttpFetch(sandbox, REQUEST, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('(b) aborting mid-flight rejects promptly with an AbortError', async () => {
    const { sandbox, run } = hangingSandbox();
    const controller = new AbortController();
    const pending = sandboxHttpFetch(sandbox, REQUEST, { signal: controller.signal, timeoutMs: 60_000 });
    expect(run).toHaveBeenCalledTimes(1);

    const start = Date.now();
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('(c) the signal reaches sandbox.run() options', async () => {
    const run = vi.fn(async () => OK_RESULT);
    const controller = new AbortController();

    const response = await sandboxHttpFetch({ name: 'spy', run, writeFile: async () => undefined }, REQUEST, {
      signal: controller.signal,
    });

    expect(await response.text()).toBe('hi');
    expect(firstRunOptions(run).signal).toBe(controller.signal);
  });

  it('without a signal behaves as before', async () => {
    const run = vi.fn(async () => OK_RESULT);
    const response = await sandboxHttpFetch({ name: 'spy', run, writeFile: async () => undefined }, REQUEST);
    expect(response.status).toBe(200);
  });

  it('NoopSandbox kills the child process when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = NoopSandbox.run('node', ['-e', 'setTimeout(() => {}, 30000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('http tool sandboxExecute forwards its abortSignal to the sandbox', async () => {
    const { sandbox, run } = hangingSandbox();
    const controller = new AbortController();
    const pending = createHttpTool().sandboxExecute!({ url: 'http://93.184.216.34/', method: 'GET' }, sandbox, {
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(firstRunOptions(run).signal).toBeDefined();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('slack tool sandboxExecute forwards its abortSignal to the sandbox', async () => {
    const { sandbox, run } = hangingSandbox();
    const controller = new AbortController();
    const descriptor = createSlackTool({ webhookUrl: 'https://hooks.slack.test/services/mock' });
    const pending = descriptor.sandboxExecute!({ channel: '#c', message: 'm', approvalId: 'a' }, sandbox, {
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(firstRunOptions(run).signal).toBe(controller.signal);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('slack tool execute passes its abortSignal to the fetch implementation', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }) as Response);
    const controller = new AbortController();
    await createSlackTool({
      webhookUrl: 'https://hooks.slack.test/services/mock',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).tool.execute!(
      { channel: '#c', message: 'm', approvalId: 'a' },
      { toolCallId: 't', messages: [], abortSignal: controller.signal }
    );
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBe(controller.signal);
  });
});
