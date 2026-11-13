import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServeStatus, StudioEvent } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  getServe: vi.fn(),
  putServe: vi.fn(),
  serveToken: vi.fn(),
  rotateServeToken: vi.fn(),
  mcpStatus: vi.fn(),
  startMcp: vi.fn(),
  stopMcp: vi.fn(),
  createWidgetKey: vi.fn(),
  revokeWidgetKey: vi.fn(),
  eventHandlers: [] as Array<(event: StudioEvent) => void>,
  writeText: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../runtime/runtimeClient')>();
  return {
    ...actual,
    runtimeClient: {
      getServe: mocks.getServe,
      putServe: mocks.putServe,
      serveToken: mocks.serveToken,
      rotateServeToken: mocks.rotateServeToken,
      mcpStatus: mocks.mcpStatus,
      startMcp: mocks.startMcp,
      stopMcp: mocks.stopMcp,
      createWidgetKey: mocks.createWidgetKey,
      revokeWidgetKey: mocks.revokeWidgetKey,
    },
  };
});

vi.mock('../../../state/useStudioEvents', () => ({
  useStudioEvents: (handler: (event: StudioEvent) => void) => {
    mocks.eventHandlers.push(handler);
  },
}));

import { ServeCard } from '../ServeCard';

function status(overrides: Partial<ServeStatus> = {}): ServeStatus {
  return {
    agentId: 'support-bot',
    enabled: true,
    allowedOrigins: ['http://localhost:3000'],
    publishedVersion: 3,
    tokenMasked: 'abcd…wxyz',
    widgetKeyMasked: null,
    baseUrl: '/serve/support-bot',
    ...overrides,
  };
}

function renderCard() {
  return render(
    <ToastProvider>
      <ServeCard agentId="support-bot" />
    </ToastProvider>,
  );
}

/** Lets the mount fetch settle. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const el = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (el === undefined) throw new Error(`no button containing "${label}"`);
  return el as HTMLButtonElement;
}

function switchEl(host: HTMLElement): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>('[role="switch"]');
  if (el === null) throw new Error('no switch');
  return el;
}

describe('ServeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandlers.length = 0;
    mocks.getServe.mockResolvedValue(status());
    mocks.putServe.mockImplementation(async (_id: string, patch: object) => status({ ...patch } as Partial<ServeStatus>));
    mocks.serveToken.mockResolvedValue({ token: 'raw-token-1234' });
    mocks.rotateServeToken.mockResolvedValue({ token: 'rotated-token' });
    mocks.mcpStatus.mockResolvedValue({ running: false, url: null, port: null, version: null, toolName: null });
    mocks.startMcp.mockResolvedValue({
      running: true,
      url: 'http://127.0.0.1:41234/mcp',
      port: 41234,
      version: 3,
      toolName: 'support_bot',
    });
    mocks.stopMcp.mockResolvedValue({ running: false, url: null, port: null, version: null, toolName: null });
    mocks.createWidgetKey.mockResolvedValue({ widgetKey: 'fwk_test-key-1' });
    mocks.revokeWidgetKey.mockResolvedValue(undefined);
    mocks.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: mocks.writeText }, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a skeleton while the status loads', async () => {
    mocks.getServe.mockReturnValue(new Promise(() => {}));
    const host = renderCard();
    expect(host.querySelector('.skeleton-rows')).not.toBeNull();
    await flush();
  });

  it('shows the load error with a working Retry', async () => {
    mocks.getServe.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(status());
    const host = renderCard();
    await flush();
    expect(host.textContent).toContain('Could not load serve settings: boom');
    await act(async () => {
      button(host, 'Retry').click();
    });
    await flush();
    expect(host.querySelector('.serve-card')).not.toBeNull();
  });

  it('disables the switch with a title when nothing is published', async () => {
    mocks.getServe.mockResolvedValue(status({ publishedVersion: null, enabled: false }));
    const host = renderCard();
    await flush();
    const sw = switchEl(host);
    expect(sw.disabled).toBe(true);
    expect(sw.title).toBe('Publish a version first');
    expect(host.querySelector('.serve-card-version')?.textContent).toBe('Not published');
    expect(host.querySelector('.serve-card-facts')).toBeNull();
    expect(host.querySelector('.serve-card-snippet')).toBeNull();
  });

  it('greys the facts and hides the snippet while serving is disabled', async () => {
    mocks.getServe.mockResolvedValue(status({ enabled: false }));
    const host = renderCard();
    await flush();
    expect(host.querySelector('.serve-card-facts')?.getAttribute('data-disabled')).toBe('true');
    expect(host.querySelector('.serve-card-version')?.textContent).toBe('v3');
    expect(host.querySelector('.serve-card-snippet')).toBeNull();
    expect(host.querySelector('.serve-card-origins')).not.toBeNull();
  });

  it('shows the endpoint, masked token and curl snippet when enabled', async () => {
    const host = renderCard();
    await flush();
    const endpoint = `${location.origin}/serve/support-bot/chat`;
    expect(host.querySelector('.serve-card-code')?.textContent).toBe(endpoint);
    expect(host.textContent).toContain('abcd…wxyz');
    const pre = host.querySelector('.serve-card-pre')?.textContent ?? '';
    expect(pre).toContain(endpoint);
    expect(pre).toContain('$LOUSHO_SERVE_TOKEN');
    expect(pre).not.toContain('raw-token-1234');
  });

  it('toggles serving through PUT and re-renders from the response', async () => {
    mocks.getServe.mockResolvedValue(status({ enabled: false }));
    const host = renderCard();
    await flush();
    expect(host.querySelector('.serve-card-snippet')).toBeNull();
    await act(async () => {
      switchEl(host).click();
    });
    await flush();
    expect(mocks.putServe).toHaveBeenCalledWith('support-bot', { enabled: true });
    expect(host.querySelector('.serve-card-snippet')).not.toBeNull();
  });

  it('reveals the raw token, hides on Hide, and auto-hides after 30 s', async () => {
    const host = renderCard();
    await flush();
    vi.useFakeTimers();
    await act(async () => {
      button(host, 'Reveal').click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.serveToken).toHaveBeenCalledWith('support-bot');
    expect(host.textContent).toContain('raw-token-1234');
    expect(button(host, 'Hide')).toBeDefined();
    await act(async () => {
      button(host, 'Hide').click();
    });
    expect(host.textContent).not.toContain('raw-token-1234');
    await act(async () => {
      button(host, 'Reveal').click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(host.textContent).toContain('raw-token-1234');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(host.textContent).not.toContain('raw-token-1234');
    expect(host.textContent).toContain('abcd…wxyz');
  });

  it('rotates the token with a warning toast and the new masked token', async () => {
    const host = renderCard();
    await flush();
    mocks.getServe.mockResolvedValue(status({ tokenMasked: 'rot9…ated' }));
    await act(async () => {
      button(host, 'Rotate').click();
    });
    await flush();
    expect(mocks.rotateServeToken).toHaveBeenCalledWith('support-bot');
    expect(document.body.textContent).toContain('Token rotated. Update any app that used the old one.');
    expect(host.textContent).toContain('rot9…ated');
  });

  it('saves allowed origins parsed one-per-line and shows a 400 as the field error', async () => {
    const host = renderCard();
    await flush();
    const area = host.querySelector<HTMLTextAreaElement>('.serve-card-origins');
    expect(area).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, ' https://a.example \n\nhttp://b.example:8080 ');
      area!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button(host, 'Save origins').click();
    });
    await flush();
    expect(mocks.putServe).toHaveBeenCalledWith('support-bot', {
      allowedOrigins: ['https://a.example', 'http://b.example:8080'],
    });
  });

  it('shows the server message when saving origins fails', async () => {
    const { RuntimeApiError } = await import('../../../runtime/runtimeClient');
    mocks.putServe.mockRejectedValueOnce(new RuntimeApiError('origin not allowed', 400));
    const host = renderCard();
    await flush();
    await act(async () => {
      button(host, 'Save origins').click();
    });
    await flush();
    expect(host.textContent).toContain('origin not allowed');
  });

  it('copies the endpoint and toasts Copied', async () => {
    const host = renderCard();
    await flush();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Copy endpoint"]')!.click();
    });
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith(`${location.origin}/serve/support-bot/chat`);
    expect(document.body.textContent).toContain('Copied');
  });

  it('copies the real token via serveToken, never the masked text', async () => {
    const host = renderCard();
    await flush();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Copy token"]')!.click();
    });
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith('raw-token-1234');
  });

  it('toasts Copy failed when the clipboard rejects', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('denied'));
    const host = renderCard();
    await flush();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Copy endpoint"]')!.click();
    });
    await flush();
    expect(document.body.textContent).toContain('Copy failed');
  });

  it('refreshes when an agent.changed version/meta event arrives for this agent', async () => {
    renderCard();
    await flush();
    const before = mocks.getServe.mock.calls.length;
    await act(async () => {
      const event = { type: 'agent.changed' as const, agentId: 'support-bot', reason: 'version' as const };
      for (const handler of mocks.eventHandlers) handler(event);
    });
    await flush();
    const after = mocks.getServe.mock.calls.length;
    expect(after).toBeGreaterThan(before);
    await act(async () => {
      for (const handler of mocks.eventHandlers) handler({ type: 'agent.changed', agentId: 'other-agent', reason: 'meta' });
      for (const handler of mocks.eventHandlers) handler({ type: 'agent.changed', agentId: 'support-bot', reason: 'draft' });
    });
    await flush();
    expect(mocks.getServe.mock.calls.length).toBe(after);
  });

  describe('MCP server (X03)', () => {
    it('starts the MCP server and shows URL, tool and snippets', async () => {
      const host = renderCard();
      await flush();
      expect(host.textContent).toContain('Start MCP server');
      await act(async () => {
        button(host, 'Start MCP server').click();
      });
      await flush();
      expect(mocks.startMcp).toHaveBeenCalledWith('support-bot');
      expect(host.textContent).toContain('http://127.0.0.1:41234/mcp');
      expect(host.textContent).toContain('support_bot');
      expect(host.textContent).toContain('Stop MCP server');
      const pres = [...host.querySelectorAll('.serve-card-pre')].map((p) => p.textContent ?? '');
      expect(pres.some((p) => p.includes('claude mcp add --transport http support-bot http://127.0.0.1:41234/mcp'))).toBe(true);
      expect(pres.some((p) => p.includes('lousho mcp .lousho/agents/support-bot/published.yaml'))).toBe(true);
      expect(pres.join('\n')).toContain('$LOUSHO_SERVE_TOKEN');
      expect(pres.join('\n')).not.toContain('raw-token-1234');
      expect(host.textContent).toContain('The port changes each time the server starts.');
    });

    it('stops the MCP server', async () => {
      mocks.mcpStatus.mockResolvedValue({ running: true, url: 'http://127.0.0.1:41234/mcp', port: 41234, version: 3, toolName: 'support_bot' });
      const host = renderCard();
      await flush();
      await act(async () => {
        button(host, 'Stop MCP server').click();
      });
      await flush();
      expect(mocks.stopMcp).toHaveBeenCalledWith('support-bot');
      expect(host.textContent).toContain('Start MCP server');
    });

    it('disables Start with a title when nothing is published', async () => {
      mocks.getServe.mockResolvedValue(status({ publishedVersion: null, enabled: false }));
      const host = renderCard();
      await flush();
      const start = button(host, 'Start MCP server');
      expect(start.disabled).toBe(true);
      expect(start.title).toBe('Publish a version first');
    });
  });

  describe('Embed on a page (X04b)', () => {
    it('is hidden while serving is disabled', async () => {
      mocks.getServe.mockResolvedValue(status({ enabled: false }));
      const host = renderCard();
      await flush();
      expect(host.textContent).not.toContain('Embed on a page');
    });

    it('creates a widget key and shows the placeholder snippet + note', async () => {
      mocks.getServe
        .mockResolvedValueOnce(status())
        .mockResolvedValue(status({ widgetKeyMasked: 'fwk_…-key' }));
      const host = renderCard();
      await flush();
      expect(host.textContent).toContain('Embed on a page');
      await act(async () => {
        button(host, 'Create widget key').click();
      });
      await flush();
      expect(mocks.createWidgetKey).toHaveBeenCalledWith('support-bot');
      const pre = host.querySelector('.serve-card-embed .serve-card-pre')!.textContent!;
      expect(pre).toContain('/serve/support-bot/widget.js');
      expect(pre).toContain('token="YOUR_WIDGET_KEY"');
      expect(pre).toContain('endpoint="');
      expect(pre).not.toContain('raw-token-1234');
      expect(host.textContent).toContain('The widget key can only chat with this agent');
    });

    it('disables Create widget key with the reason while no origin is allowed', async () => {
      mocks.getServe.mockResolvedValue(status({ allowedOrigins: [] }));
      const host = renderCard();
      await flush();
      const create = button(host, 'Create widget key');
      expect(create.disabled).toBe(true);
      expect(create.title).toBe('Add an allowed origin first');
    });

    it('Copy with key stays disabled until a key exists, then copies the real key', async () => {
      mocks.getServe
        .mockResolvedValueOnce(status({ widgetKeyMasked: 'fwk_…-key' }))
        .mockResolvedValue(status({ widgetKeyMasked: 'fwk_…-key' }));
      const host = renderCard();
      await flush();
      const copyWithKey = button(host, 'Copy with key');
      expect(copyWithKey.disabled).toBe(true);
      await act(async () => {
        button(host, 'Rotate key').click();
      });
      await flush();
      expect(mocks.createWidgetKey).toHaveBeenCalledWith('support-bot');
      expect(button(host, 'Copy with key').disabled).toBe(false);
      await act(async () => {
        button(host, 'Copy with key').click();
      });
      await flush();
      expect(mocks.writeText).toHaveBeenCalledWith(expect.stringContaining('token="fwk_test-key-1"'));
    });

    it('revokes the key and returns to the create state', async () => {
      mocks.getServe
        .mockResolvedValueOnce(status({ widgetKeyMasked: 'fwk_…-key' }))
        .mockResolvedValue(status({ widgetKeyMasked: null }));
      const host = renderCard();
      await flush();
      await act(async () => {
        button(host, 'Revoke').click();
      });
      await flush();
      expect(mocks.revokeWidgetKey).toHaveBeenCalledWith('support-bot');
      expect(button(host, 'Create widget key')).toBeDefined();
    });
  });
});
