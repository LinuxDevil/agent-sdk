import { describe, it, expect } from 'vitest';
import type { Message } from '@linuxdevil/lousho';
import { reconcileChatMessages, markSteerInputs } from '../chatReconcile';
import type { ChatMessage, SteerInfo } from '../../shared/wireTypes';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-01T00:00:05.000Z';

function chatMsg(m: Message & { content: string }, id: string, timestamp = T1): ChatMessage {
  return { ...m, id, timestamp };
}

describe('reconcileChatMessages', () => {
  it('preserves the optimistic user message id/timestamp on the very first turn, despite AgentExecutor prepending a system message', () => {
    const prev: ChatMessage[] = [chatMsg({ role: 'user', content: 'hi' }, 'user-1', T1)];
    const next: Message[] = [
      { role: 'system', content: 'You are a helpful agent.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ];

    const result = reconcileChatMessages(prev, next, T2);

    expect(result).toHaveLength(3);
    // The leading system message (not present in `prev` at all) is new.
    expect(result[0]).toMatchObject({ role: 'system', timestamp: T2 });
    // The user message is recognized as the SAME message sendMessage()
    // pushed optimistically - its id/timestamp carry over unchanged.
    expect(result[1]).toMatchObject({ id: 'user-1', timestamp: T1, content: 'hi' });
    // The assistant's reply is genuinely new.
    expect(result[2]).toMatchObject({ content: 'Hello!', timestamp: T2 });
    expect(result[2].id).not.toBe('user-1');
  });

  it('preserves ids/timestamps for a matched tail and only stamps genuinely new messages', () => {
    const prev: ChatMessage[] = [
      chatMsg({ role: 'system', content: 'sys' }, 'sys-1', T1),
      chatMsg({ role: 'user', content: 'first' }, 'user-1', T1),
      chatMsg({ role: 'assistant', content: 'reply one' }, 'asst-1', T1),
    ];
    const next: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply two' },
    ];

    const result = reconcileChatMessages(prev, next, T2);

    expect(result).toHaveLength(5);
    // The first three carry over their original ids/timestamps unchanged.
    expect(result[0]).toMatchObject({ id: 'sys-1', timestamp: T1 });
    expect(result[1]).toMatchObject({ id: 'user-1', timestamp: T1 });
    expect(result[2]).toMatchObject({ id: 'asst-1', timestamp: T1 });
    // The two new messages get fresh ids and the settle timestamp.
    expect(result[3]).toMatchObject({ content: 'second', timestamp: T2 });
    expect(result[4]).toMatchObject({ content: 'reply two', timestamp: T2 });
    expect(result[3].id).not.toBe('user-1');
  });

  it('preserves a tool-call/tool-result pair by role+content+toolCallId, not just content', () => {
    const prev: ChatMessage[] = [
      chatMsg(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'current-date', arguments: '{}' } }],
        },
        'asst-1',
        T1
      ),
      chatMsg({ role: 'tool', content: '"2026-01-01"', toolCallId: 'call_1', toolName: 'current-date' }, 'tool-1', T1),
    ];
    const next: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'current-date', arguments: '{}' } }],
      },
      { role: 'tool', content: '"2026-01-01"', toolCallId: 'call_1', toolName: 'current-date' },
      { role: 'assistant', content: 'The date is 2026-01-01.' },
    ];

    const result = reconcileChatMessages(prev, next, T2);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('asst-1');
    expect(result[1].id).toBe('tool-1');
    expect(result[2].timestamp).toBe(T2);
  });

  it('returns an empty array unchanged', () => {
    expect(reconcileChatMessages([], [], T2)).toEqual([]);
  });
});

describe('markSteerInputs', () => {
  const steer = (message: string, delivery: SteerInfo['delivery']): SteerInfo => ({
    id: `steer-${message}`,
    message,
    at: T1,
    delivery,
    mode: 'queued',
  });

  it('tags a new user message whose content equals a delivered steer message', () => {
    const prev: ChatMessage[] = [chatMsg({ role: 'user', content: 'hi' }, 'user-1', T1)];
    const messages: ChatMessage[] = [
      ...prev,
      chatMsg({ role: 'assistant', content: 'ok' }, 'asst-1', T2),
      chatMsg({ role: 'user', content: 'use Paris instead' }, 'user-2', T2),
      chatMsg({ role: 'assistant', content: 'noted' }, 'asst-2', T2),
    ];

    const result = markSteerInputs(messages, prev, [steer('use Paris instead', 'delivered')]);

    expect(result[2]).toMatchObject({ id: 'user-2', source: 'steer' });
    // Everything else is untouched - no source invented elsewhere.
    expect(result[0].source).toBeUndefined();
    expect(result[1].source).toBeUndefined();
    expect(result[3].source).toBeUndefined();
  });

  it('does not tag queued or undelivered steers, non-user roles, or non-matching content', () => {
    const prev: ChatMessage[] = [];
    const messages: ChatMessage[] = [
      chatMsg({ role: 'user', content: 'queued one' }, 'u1', T2),
      chatMsg({ role: 'user', content: 'undelivered one' }, 'u2', T2),
      chatMsg({ role: 'user', content: 'typed by hand' }, 'u3', T2),
      chatMsg({ role: 'assistant', content: 'delivered one' }, 'a1', T2),
    ];
    const steering = [
      steer('queued one', 'queued'),
      steer('undelivered one', 'undelivered'),
      steer('delivered one', 'delivered'),
    ];

    const result = markSteerInputs(messages, prev, steering);

    expect(result.every((m) => m.source === undefined)).toBe(true);
  });

  it('does not re-tag a matching user message that was already in prev', () => {
    // The user typed the same text the steer carried; the OLD bubble keeps
    // no source - only the new turn the steer added gets tagged.
    const prev: ChatMessage[] = [chatMsg({ role: 'user', content: 'same words' }, 'user-old', T1)];
    const messages: ChatMessage[] = [
      ...prev,
      chatMsg({ role: 'assistant', content: 'ok' }, 'asst-1', T2),
      chatMsg({ role: 'user', content: 'same words' }, 'user-new', T2),
    ];

    const result = markSteerInputs(messages, prev, [steer('same words', 'delivered')]);

    expect(result[0]).toMatchObject({ id: 'user-old' });
    expect(result[0].source).toBeUndefined();
    expect(result[2]).toMatchObject({ id: 'user-new', source: 'steer' });
  });

  it('returns the messages unchanged when no steer was delivered', () => {
    const messages: ChatMessage[] = [chatMsg({ role: 'user', content: 'hi' }, 'u1', T2)];
    expect(markSteerInputs(messages, [], [])).toBe(messages);
    expect(markSteerInputs(messages, [], [steer('hi', 'queued')])).toBe(messages);
  });
});
