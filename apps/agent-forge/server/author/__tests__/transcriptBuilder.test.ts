import { describe, it, expect } from 'vitest';
import { TranscriptBuilder } from '../transcriptBuilder';

/**
 * TranscriptBuilder: folds one turn's AgentEvents into the ordered parts of
 * the assistant message the session store persists (text deltas merge into
 * one text part until a tool part interrupts; tool parts settle into
 * 'done' | 'pending' | 'error').
 */
describe('TranscriptBuilder', () => {
  const META = { id: 'm_assistant', at: '2026-10-30T00:00:00.000Z', requestId: 'req_1', finishReason: 'stop' };

  it('merges consecutive text deltas into one text part', () => {
    const builder = new TranscriptBuilder();
    builder.text('Hello ');
    builder.text('big ');
    builder.text('world');
    const message = builder.message(META);
    expect(message).toEqual({
      id: 'm_assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hello big world' }],
      at: '2026-10-30T00:00:00.000Z',
      requestId: 'req_1',
      finishReason: 'stop',
    });
  });

  it('a text delta after a tool part starts a new text part', () => {
    const builder = new TranscriptBuilder();
    builder.text('Let me check. ');
    builder.toolStart('call_1', 'listAgents', {});
    builder.toolDone('call_1', { ok: true, items: [] }, false);
    builder.text('Done.');
    const message = builder.message(META);
    expect(message.parts).toEqual([
      { type: 'text', text: 'Let me check. ' },
      { type: 'tool', toolCallId: 'call_1', name: 'listAgents', input: {}, output: { ok: true, items: [] }, state: 'done' },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('a tool part starts pending and settles done with its output', () => {
    const builder = new TranscriptBuilder();
    builder.toolStart('call_1', 'getCurrentSpec', { agentId: 'a' });
    let message = builder.message(META);
    expect(message.parts[0]).toEqual({
      type: 'tool',
      toolCallId: 'call_1',
      name: 'getCurrentSpec',
      input: { agentId: 'a' },
      output: undefined,
      state: 'pending',
    });
    builder.toolDone('call_1', { ok: true }, false);
    message = builder.message(META);
    expect(message.parts[0]).toMatchObject({ output: { ok: true }, state: 'done' });
  });

  it('toolDone with pending=true keeps the part pending (client-answered card)', () => {
    const builder = new TranscriptBuilder();
    builder.toolStart('call_1', 'requestSecret', { name: 'KEY', why: 'w' });
    builder.toolDone('call_1', { status: 'pending' }, true);
    const message = builder.message(META);
    expect(message.parts[0]).toMatchObject({ output: { status: 'pending' }, state: 'pending' });
  });

  it('toolError marks the part error with its output payload', () => {
    const builder = new TranscriptBuilder();
    builder.toolStart('call_1', 'saveAgent', { proposalId: 'p' });
    builder.toolError('call_1', { ok: false, code: 'TOOL_ERROR', error: 'boom' });
    const message = builder.message(META);
    expect(message.parts[0]).toEqual({
      type: 'tool',
      toolCallId: 'call_1',
      name: 'saveAgent',
      input: { proposalId: 'p' },
      output: { ok: false, code: 'TOOL_ERROR', error: 'boom' },
      state: 'error',
    });
  });

  it('a turn with no events produces an empty-parts message', () => {
    const builder = new TranscriptBuilder();
    expect(builder.message(META).parts).toEqual([]);
  });
});
