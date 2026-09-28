import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { buildSlackAlertPayload, createSlackTool, postSlackAlert } from './slack';
import { NoopSandbox } from '../../security/sandboxCore';
import type { SandboxAdapter } from '../../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../../execution/sandboxGuard';

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

describe('slack tool sandbox seam (LOU-K2)', () => {
  it('flags requiresSandbox and implements sandboxExecute', () => {
    const descriptor = createSlackTool({ webhookUrl: 'https://hooks.slack.test/services/mock' });
    expect(descriptor.requiresSandbox).toBe(true);
    expect(typeof descriptor.sandboxExecute).toBe('function');
  });

  it('(a) NoopSandbox: sandboxExecute() posts the same payload to a real local webhook, unchanged from execute()', async () => {
    let received: any;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    const webhookUrl = `http://127.0.0.1:${port}/`;

    try {
      const descriptor = createSlackTool({ webhookUrl });
      const result = await executeToolWithSandboxGuard(
        'slack',
        descriptor,
        { channel: '#incidents', message: 'Deploy failed', approvalId: 'approval-123' },
        NoopSandbox
      );

      expect(result).toEqual({ ok: true });
      expect(received.channel).toBe('#incidents');
      expect(received.blocks[1].elements[0].value).toBe('approval-123');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('(b) a custom SandboxAdapter actually gets invoked for the webhook POST', async () => {
    const runSpy = vi.fn(async (cmd: string) => {
      expect(cmd).toBe('node');
      return { stdout: JSON.stringify({ status: 200, statusText: 'OK', headers: {}, body: '' }), stderr: '', exitCode: 0 };
    });
    const customSandbox: SandboxAdapter = { name: 'custom-test-sandbox', run: runSpy, writeFile: vi.fn() };

    const descriptor = createSlackTool({ webhookUrl: 'https://hooks.slack.test/services/mock' });
    const result = await executeToolWithSandboxGuard(
      'slack',
      descriptor,
      { channel: '#incidents', message: 'hi', approvalId: 'approval-1' },
      customSandbox
    );

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it('(c) fails closed when requiresSandbox is true but sandboxExecute is missing', async () => {
    const descriptor = createSlackTool({ webhookUrl: 'https://hooks.slack.test/services/mock' });
    const broken = { ...descriptor, sandboxExecute: undefined };

    await expect(
      executeToolWithSandboxGuard(
        'slack',
        broken,
        { channel: '#incidents', message: 'hi', approvalId: 'approval-1' },
        NoopSandbox
      )
    ).rejects.toThrow(/requiresSandbox but does not implement sandboxExecute/);
  });
});
