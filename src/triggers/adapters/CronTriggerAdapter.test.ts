import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronTriggerAdapter } from './CronTriggerAdapter';
import { ExecutionResult } from '../../execution/AgentExecutor';
import { RunnableAgent } from '../types';

function fakeResult(text: string): ExecutionResult {
  return {
    text,
    messages: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
    steps: 1,
  };
}

const noopAgent: RunnableAgent = { send: vi.fn() };

describe('CronTriggerAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has type "cron"', () => {
    expect(new CronTriggerAdapter({ intervalMs: 1000, input: 'x', onResult: vi.fn() }).type).toBe('cron');
  });

  it('throws if intervalMs is not a positive number', () => {
    expect(() => new CronTriggerAdapter({ intervalMs: 0, input: 'x', onResult: vi.fn() })).toThrow();
    expect(() => new CronTriggerAdapter({ intervalMs: -5, input: 'x', onResult: vi.fn() })).toThrow();
  });

  it('does not fire immediately by default', () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult: vi.fn() });
    adapter.listen(noopAgent, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fires immediately when fireImmediately is true', () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const adapter = new CronTriggerAdapter({
      intervalMs: 1000,
      input: 'scheduled',
      onResult: vi.fn(),
      fireImmediately: true,
    });
    adapter.listen(noopAgent, onEvent);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('scheduled', expect.objectContaining({ tick: 0 }));
  });

  it('fires onEvent on every interval tick and reports each result to onResult', async () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const onResult = vi.fn();
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult });
    adapter.listen(noopAgent, onEvent);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenNthCalledWith(1, fakeResult('tick'), undefined, expect.objectContaining({ tick: 0 }));
    expect(onResult).toHaveBeenNthCalledWith(2, fakeResult('tick'), undefined, expect.objectContaining({ tick: 1 }));
  });

  it('reports a failed run to onResult with the error and no result', async () => {
    const onEvent = vi.fn().mockRejectedValue(new Error('run failed'));
    const onResult = vi.fn();
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult });
    adapter.listen(noopAgent, onEvent);

    await vi.advanceTimersByTimeAsync(1000);

    expect(onResult).toHaveBeenCalledWith(undefined, expect.any(Error), expect.anything());
  });

  it('stop() clears the interval so no further ticks fire', async () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult: vi.fn() });
    const handle = adapter.listen(noopAgent, onEvent);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('has no reply() method (no reply target for a scheduled run)', () => {
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'x', onResult: vi.fn() });
    expect(adapter.reply).toBeUndefined();
  });
});
