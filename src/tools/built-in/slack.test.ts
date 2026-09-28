import { describe, it, expect, vi } from 'vitest';
import { buildSlackAlertPayload, createSlackTool, postSlackAlert } from './slack';

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
  } as Response);
}

describe('buildSlackAlertPayload', () => {
  it('produces a payload with exactly one interactive button carrying the correct approvalId', () => {
    const payload = buildSlackAlertPayload('#incidents', 'Deploy failed', 'approval-123');

    const actionsBlocks = payload.blocks.filter((b) => b.type === 'actions');
    expect(actionsBlocks).toHaveLength(1);

    const buttons = actionsBlocks[0].elements ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].action_id).toBe('fix_it');
    expect(buttons[0].value).toBe('approval-123');
    expect(buttons[0].text?.text).toBe('Fix it');
  });

  it('includes the channel and message text', () => {
    const payload = buildSlackAlertPayload('#incidents', 'Deploy failed', 'approval-123');
    expect(payload.channel).toBe('#incidents');
    expect(payload.text).toBe('Deploy failed');
  });
});

describe('postSlackAlert / createSlackTool (mocked Slack API)', () => {
  it('posts the built payload to the configured webhook URL', async () => {
    const fetchImpl = mockFetchOk();

    await postSlackAlert('#incidents', 'Deploy failed', 'approval-123', {
      webhookUrl: 'https://hooks.slack.test/services/mock',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.slack.test/services/mock');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.blocks[1].elements[0].value).toBe('approval-123');
  });

  it('throws a clear error when no webhook URL is configured', async () => {
    const original = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      await expect(
        postSlackAlert('#incidents', 'msg', 'approval-1', { fetchImpl: mockFetchOk() as unknown as typeof fetch })
      ).rejects.toThrow(/SLACK_WEBHOOK_URL/);
    } finally {
      if (original !== undefined) process.env.SLACK_WEBHOOK_URL = original;
    }
  });

  it('the ToolDescriptor wraps an AI SDK tool() with the expected required params', async () => {
    const fetchImpl = mockFetchOk();
    const descriptor = createSlackTool({
      webhookUrl: 'https://hooks.slack.test/services/mock',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(descriptor.tool).toBeDefined();
    const result = await descriptor.tool.execute!(
      { channel: '#incidents', message: 'Deploy failed', approvalId: 'approval-123' },
      {} as any
    );

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
