import { describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import type { ChatMessage } from '../../../shared/wireTypes';

const at = '2026-10-29T10:00:00.000Z';
// What the mock provider leaves after an approved `demo-approval` call: the call, its result, then the reply.
const MESSAGES: ChatMessage[] = [
  { id: 's', role: 'system', content: 'You are helpful.', timestamp: at },
  { id: 'u', role: 'user', content: 'Please call demo-approval.', timestamp: at },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'demo-approval', arguments: '{"input":"x"}' } }],
    timestamp: at,
  },
  { id: 't1', role: 'tool', content: '{"done":true}', toolCallId: 'call_1', timestamp: at },
  { id: 't2', role: 'tool', content: 'orphan result', toolCallId: 'call_9', toolName: 'lookup', timestamp: at },
  { id: 'a2', role: 'assistant', content: 'This is a mock response.', timestamp: at },
];

vi.mock('../../state/AppState', () => ({
  useAppState: () => ({
    chat: { sessionId: 's1', messages: MESSAGES },
    chatSessions: [],
    viewedChatSession: undefined,
    runStatus: undefined,
    chatActionError: undefined,
    startNewChat: vi.fn(),
    viewChatSession: vi.fn(),
    returnToLiveChat: vi.fn(),
    sendChatMessage: vi.fn(),
  }),
}));

import { ChatPanel } from '../ChatPanel';
import { logTitle } from '../debug/LogsPanel';
import { stepTone } from '../debug/TonePill';

describe('ChatPanel', () => {
  it('draws a paired tool result under its call, an unpaired one as a tool block, and names every sender', () => {
    // jsdom has no scrolling; the thread scrolls itself to the newest message.
    Element.prototype.scrollTo = () => {};
    const container = render(<ChatPanel />);
    const bubbles = [...container.querySelectorAll('.chat-msg')];
    expect(bubbles.map((b) => b.className)).toEqual(['chat-msg user', 'chat-msg agent', 'chat-msg tool', 'chat-msg agent']);
    // The paired result shows once, under its call's mono block.
    expect(bubbles[1].querySelector('.chat-bubble-tool .chat-tool-result')?.textContent).toBe('= {"done":true}');
    expect(container.textContent?.match(/\{"done":true\}/g)).toHaveLength(1);
    // The unpaired result is a tool block with the Wrench header, not an agent bubble.
    expect(bubbles[2].querySelector('.chat-bubble-tool .chat-tool-name')?.textContent).toBe('lookup');
    expect(bubbles.map((b) => b.querySelector('.visually-hidden')?.textContent)).toEqual(['You: ', 'Agent: ', 'Tool: ', 'Agent: ']);
  });
});

describe('logTitle', () => {
  it('carries the full message, plus the detail when there is one', () => {
    const entry = { id: 'l', agentId: 'a', timestamp: at, level: 'info', phase: 'llm', message: 'x'.repeat(300) } as const;
    expect(logTitle(entry)).toBe(`[llm] ${'x'.repeat(300)}`);
    expect(logTitle({ ...entry, detail: { tokens: 3 } })).toBe(`[llm] ${'x'.repeat(300)}\n{"tokens":3}`);
  });
});

describe('stepTone', () => {
  it('maps checkpoint statuses to pill tones', () => {
    expect(['finished', 'in-progress', 'failed', 'paused', 'whatever'].map(stepTone)).toEqual([
      'ok',
      'running',
      'error',
      'warning',
      'neutral',
    ]);
  });
});
