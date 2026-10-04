import { describe, it, expect, vi } from 'vitest';
import { SlackTriggerAdapter } from './SlackTriggerAdapter';
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

function mockFetchOk() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);
}

const noopAgent: RunnableAgent = { send: vi.fn() };

describe('SlackTriggerAdapter', () => {
  it('has type "slack"', () => {
    expect(new SlackTriggerAdapter().type).toBe('slack');
  });

  it('handleEvent() runs the agent via onEvent and posts the reply back to the channel', async () => {
    const fetchImpl = mockFetchOk();
    const adapter = new SlackTriggerAdapter({ webhookUrl: 'https://hooks.slack.test/abc', fetchImpl });
    const onEvent = vi.fn().mockResolvedValue(fakeResult('agent reply text'));
    adapter.listen(noopAgent, onEvent);

    const result = await adapter.handleEvent({ channel: '#general', text: 'hello agent' });

    expect(onEvent).toHaveBeenCalledWith('hello agent', { channel: '#general' });
    expect(result).toEqual(fakeResult('agent reply text'));
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hooks.slack.test/abc',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel: '#general', text: 'agent reply text' }),
      })
    );
  });

  it('handleEvent() is a no-op before listen() has been called', async () => {
    const adapter = new SlackTriggerAdapter({ webhookUrl: 'https://hooks.slack.test/abc', fetchImpl: mockFetchOk() });
    const result = await adapter.handleEvent({ channel: '#general', text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('handleEvent() is a no-op after stop() has been called', async () => {
    const adapter = new SlackTriggerAdapter({ webhookUrl: 'https://hooks.slack.test/abc', fetchImpl: mockFetchOk() });
    const handle = adapter.listen(noopAgent, vi.fn().mockResolvedValue(fakeResult('x')));
    handle.stop();
    const result = await adapter.handleEvent({ channel: '#general', text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('reply() throws when no webhook URL is configured', async () => {
    const originalEnv = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      const adapter = new SlackTriggerAdapter({ fetchImpl: mockFetchOk() });
      await expect(adapter.reply('#general', 'hi')).rejects.toThrow(/no webhook URL configured/);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SLACK_WEBHOOK_URL;
      } else {
        process.env.SLACK_WEBHOOK_URL = originalEnv;
      }
    }
  });

  it('reply() throws with the response body when the webhook post fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, statusText: 'Bad Request', text: async () => 'invalid_payload' } as Response);
    const adapter = new SlackTriggerAdapter({ webhookUrl: 'https://hooks.slack.test/abc', fetchImpl });
    await expect(adapter.reply('#general', 'hi')).rejects.toThrow(/invalid_payload/);
  });
});
