import { describe, expect, it } from 'vitest';
import type { ChatMessage, SpanEvent } from '../../../shared/wireTypes';
import { lastUserInput, pinFromSpan } from '../pins';

function toolSpan(attributes: Record<string, unknown>): SpanEvent {
  return {
    id: 's1',
    name: 'execute_tool current_date',
    startTime: 1,
    attributes: { 'gen_ai.tool.name': 'current_date', ...attributes },
  };
}

describe('pinFromSpan', () => {
  it('builds a pin from a tool span with recorded args and result', () => {
    const pin = pinFromSpan(
      'tool:current-date',
      toolSpan({
        'gen_ai.tool.call.arguments': '{"format":"iso","extra":{"b":2,"a":1}}',
        'gen_ai.tool.call.result': '"2024-01-01T00:00:00Z"',
      })
    );
    expect(pin).toEqual({
      nodeId: 'tool:current-date',
      toolName: 'current_date',
      args: { format: 'iso', extra: { b: 2, a: 1 } },
      result: '2024-01-01T00:00:00Z',
    });
  });

  it('omits args when the span recorded none or non-object args', () => {
    expect(pinFromSpan('tool:t', toolSpan({ 'gen_ai.tool.call.result': '42' }))).toEqual({
      nodeId: 'tool:t',
      toolName: 'current_date',
      result: 42,
    });
    expect(
      pinFromSpan('tool:t', toolSpan({ 'gen_ai.tool.call.arguments': '"just-a-string"', 'gen_ai.tool.call.result': '1' }))
    ).toEqual({ nodeId: 'tool:t', toolName: 'current_date', result: 1 });
  });

  it('returns undefined without a recorded result', () => {
    expect(pinFromSpan('tool:t', toolSpan({ 'gen_ai.tool.call.arguments': '{}' }))).toBeUndefined();
    // A result attribute that does not decode still counts as recorded.
    expect(pinFromSpan('tool:t', toolSpan({ 'gen_ai.tool.call.result': 'not-json' }))).toEqual({
      nodeId: 'tool:t',
      toolName: 'current_date',
      result: 'not-json',
    });
  });

  it('returns undefined for non-tool spans', () => {
    const span: SpanEvent = { id: 's2', name: 'chat', startTime: 1, attributes: {} };
    expect(pinFromSpan('tool:t', span)).toBeUndefined();
    const wrongName = toolSpan({ 'gen_ai.tool.call.result': '1', 'gen_ai.tool.name': '' });
    expect(pinFromSpan('tool:t', wrongName)).toBeUndefined();
  });

  it('falls back to legacy attribute names', () => {
    const span: SpanEvent = {
      id: 's3',
      name: 'execute_tool http',
      startTime: 1,
      attributes: { toolName: 'http', args: '{"url":"u"}', result: '{"ok":true}' },
    };
    expect(pinFromSpan('tool:http', span)).toEqual({
      nodeId: 'tool:http',
      toolName: 'http',
      args: { url: 'u' },
      result: { ok: true },
    });
  });
});

describe('lastUserInput', () => {
  const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({
    id: `${role}-${content}`,
    role,
    content,
    timestamp: '2024-01-01T00:00:00Z',
  });

  it('returns the newest non-empty user message', () => {
    expect(lastUserInput([msg('user', 'first'), msg('assistant', 'a'), msg('user', 'second')])).toBe('second');
    expect(lastUserInput([msg('user', 'first'), msg('user', ''), msg('assistant', 'a')])).toBe('first');
  });

  it('returns undefined with no user turn', () => {
    expect(lastUserInput([])).toBeUndefined();
    expect(lastUserInput([msg('assistant', 'hi'), msg('system', 's')])).toBeUndefined();
  });
});
