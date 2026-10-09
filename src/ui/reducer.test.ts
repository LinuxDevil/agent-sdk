/**
 * LOU-D15: reduceAgentEvents() over scripted event sequences, without React.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent, type AgentEventPayload } from '../execution/agentEvents';
import { initialAgentUIState, reduceAgentEvents, type AgentUIAction, type AgentUIState } from './reducer';

const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7, inputTokens: 3, outputTokens: 4, estimated: false };

function events(...payloads: AgentEventPayload[]): AgentEvent[] {
  return payloads.map(
    (payload, seq) => ({ ...payload, runId: 'r1', seq, timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION }) as AgentEvent
  );
}

function reduce(...items: (AgentEvent | AgentUIAction)[]): AgentUIState {
  return items.reduce(reduceAgentEvents, initialAgentUIState);
}

const send: AgentUIAction = { type: 'ui.send', input: 'Weather in Paris?' };

describe('reduceAgentEvents (LOU-D15)', () => {
  it('ui.send adds the user message and an empty assistant message, and starts streaming', () => {
    const state = reduce(send);
    expect(state.status).toBe('streaming');
    expect(state.messages).toEqual([
      { id: 'm0', role: 'user', text: 'Weather in Paris?', toolCalls: [] },
      { id: 'm1', role: 'assistant', text: '', toolCalls: [] },
    ]);
  });

  it('ui.send with content parts shows their text and a marker per non-text part (LOU-V12)', () => {
    const state = reduce({
      type: 'ui.send',
      input: [{ type: 'text', text: 'What is this?' }, { type: 'image', image: 'https://example.com/a.png' }],
    });
    expect(state.messages[0]).toEqual({ id: 'm0', role: 'user', text: 'What is this? [image]', toolCalls: [] });
  });

  it('ui.send with a Message[] shows its last user message', () => {
    const state = reduce({
      type: 'ui.send',
      input: [
        { role: 'user', content: 'Earlier' },
        { role: 'assistant', content: 'Ok' },
        { role: 'user', content: [{ type: 'file', data: 'https://example.com/a.pdf', mimeType: 'application/pdf' }] },
      ],
    });
    expect(state.messages[0].text).toBe('[file]');
  });

  it('accumulates text deltas, then run.done sets idle and usage', () => {
    const script = events(
      { type: 'run.start', agentName: 'a' },
      { type: 'step.start', step: 1 },
      { type: 'text.delta', text: 'It is ' },
      { type: 'text.delta', text: 'sunny.' },
      { type: 'text.done', text: 'It is sunny.' },
      { type: 'step.done', step: 1, finishReason: 'stop' },
      { type: 'run.done', finishReason: 'stop', text: 'It is sunny.', usage }
    );
    const midway = reduce(send, ...script.slice(0, 4));
    expect(midway.messages[1].text).toBe('It is sunny.');
    expect(midway.status).toBe('streaming');

    const state = reduce(send, ...script);
    expect(state.status).toBe('idle');
    expect(state.usage).toEqual(usage);
    expect(state.lastEvent?.type).toBe('run.done');
    expect(state.messages.map((m) => m.text)).toEqual(['Weather in Paris?', 'It is sunny.']);
  });

  it('tracks the tool lifecycle by toolCallId', () => {
    const [start1, start2, done2, error1] = events(
      { type: 'tool.start', toolCallId: 'c1', toolName: 'a', args: { x: 1 } },
      { type: 'tool.start', toolCallId: 'c2', toolName: 'b', args: {} },
      { type: 'tool.done', toolCallId: 'c2', toolName: 'b', result: { ok: true }, durationMs: 1 },
      { type: 'tool.error', toolCallId: 'c1', toolName: 'a', error: { name: 'Error', message: 'boom' }, durationMs: 2 }
    );
    expect(reduce(send, start1, start2).messages[1].toolCalls.map((c) => c.status)).toEqual(['running', 'running']);
    expect(reduce(send, start1, start2, done2, error1).messages[1].toolCalls).toEqual([
      { id: 'c1', name: 'a', args: { x: 1 }, status: 'error', error: { name: 'Error', message: 'boom' } },
      { id: 'c2', name: 'b', args: {}, status: 'done', result: { ok: true } },
    ]);
  });

  it('N13b: tool.partial sets the running call\'s partial; tool.done / tool.error clear it', () => {
    const [start1, start2, p0, p1, q0, done1, error2, late] = events(
      { type: 'tool.start', toolCallId: 'c1', toolName: 'a', args: {} },
      { type: 'tool.start', toolCallId: 'c2', toolName: 'b', args: {} },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'a', output: { at: 1 }, index: 0 },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'a', output: { at: 2 }, index: 1 },
      { type: 'tool.partial', toolCallId: 'c2', toolName: 'b', output: 'half', index: 0 },
      { type: 'tool.done', toolCallId: 'c1', toolName: 'a', result: { at: 2 }, durationMs: 1 },
      { type: 'tool.error', toolCallId: 'c2', toolName: 'b', error: { name: 'Error', message: 'boom' }, durationMs: 1 },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'a', output: { at: 'stale' }, index: 2 }
    );
    const midway = reduce(send, start1, start2, p0, p1, q0).messages[1].toolCalls;
    expect(midway.map((c) => [c.id, c.status, c.partial])).toEqual([
      ['c1', 'running', { at: 2 }],
      ['c2', 'running', 'half'],
    ]);

    const settled = reduce(send, start1, start2, p0, p1, q0, done1, error2, late).messages[1].toolCalls;
    expect(settled).toEqual([
      { id: 'c1', name: 'a', args: {}, status: 'done', result: { at: 2 } },
      { id: 'c2', name: 'b', args: {}, status: 'error', error: { name: 'Error', message: 'boom' } },
    ]);
    // A snapshot for a call that is not known is ignored.
    const unknown = events({ type: 'tool.partial', toolCallId: 'zz', toolName: 'a', output: 1, index: 0 });
    expect(reduce(send, ...unknown).messages[1].toolCalls).toEqual([]);
  });

  it('N13b: a call paused mid-stream (sign-in) drops its partial; a rerun starts without one', () => {
    const script = events(
      { type: 'tool.start', toolCallId: 'c1', toolName: 'list_repos', args: {} },
      { type: 'tool.partial', toolCallId: 'c1', toolName: 'list_repos', output: { status: 'connecting' }, index: 0 },
      { type: 'approval.requested', approvalId: 'ap1', toolCallId: 'c1', toolName: 'list_repos', args: {}, kind: 'sign-in' },
      { type: 'run.done', finishReason: 'awaiting-approval', text: '' }
    );
    const paused = reduce(send, ...script);
    expect(paused.messages[1].toolCalls[0]).toEqual({ id: 'c1', name: 'list_repos', args: {}, status: 'awaiting-approval' });
    const rerun = events({ type: 'tool.start', toolCallId: 'c1', toolName: 'list_repos', args: {} }, { type: 'tool.partial', toolCallId: 'c1', toolName: 'list_repos', output: { status: 'listing' }, index: 0 });
    const resumed = rerun.reduce(reduceAgentEvents, reduceAgentEvents(paused, { type: 'ui.decide', approved: true }));
    expect(resumed.messages[1].toolCalls[0]).toMatchObject({ status: 'running', partial: { status: 'listing' } });
  });

  it('approval.requested pauses; a decision and the resumed outcome finish the turn', () => {
    const paused = reduce(
      send,
      ...events(
        { type: 'text.delta', text: 'Sending.' },
        { type: 'approval.requested', approvalId: 'ap1', toolCallId: 'c1', toolName: 'send_email', args: { to: 'sam' } },
        { type: 'run.done', finishReason: 'awaiting-approval', text: '' }
      )
    );
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pendingApproval).toEqual({ id: 'ap1', toolCallId: 'c1', toolName: 'send_email', args: { to: 'sam' } });
    expect(paused.messages[1].toolCalls[0]).toMatchObject({ id: 'c1', status: 'awaiting-approval' });

    const deciding = reduceAgentEvents(paused, { type: 'ui.decide', approved: true });
    expect(deciding).toMatchObject({ status: 'streaming', pendingApproval: null });
    expect(deciding.messages[1].toolCalls[0].status).toBe('running');

    const done = reduceAgentEvents(deciding, { type: 'ui.resumed', outcome: { text: 'Sent.', finishReason: 'stop', usage } });
    expect(done).toMatchObject({ status: 'idle', usage });
    expect(done.messages[1]).toMatchObject({ text: 'Sending.\n\nSent.', toolCalls: [{ status: 'done' }] });

    const rejected = reduceAgentEvents(paused, { type: 'ui.decide', approved: false });
    expect(rejected.messages[1].toolCalls[0].status).toBe('rejected');
  });

  it("an ask_question pause exposes kind: 'question' and the question (LOU-X9)", () => {
    const question = { text: 'Which city?', options: ['Porto', 'Lisbon'], allowFreeText: false };
    const args = { question: 'Which city?', options: ['Porto', 'Lisbon'], allowFreeText: false };
    const paused = reduce(
      send,
      ...events(
        { type: 'approval.requested', approvalId: 'q1', toolCallId: 'c1', toolName: 'ask_question', args, kind: 'question', question },
        { type: 'run.done', finishReason: 'awaiting-approval', text: '' }
      )
    );
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pendingApproval).toEqual({ id: 'q1', toolCallId: 'c1', toolName: 'ask_question', args, kind: 'question', question });
    expect(paused.messages[1].toolCalls[0]).toMatchObject({ name: 'ask_question', status: 'awaiting-approval' });
  });

  it("a sign-in pause exposes kind: 'sign-in' and the link (N9b)", () => {
    const signIn = { provider: 'github', displayName: 'GitHub', url: 'https://github.example.com/login/oauth/authorize?state=s' };
    const paused = reduce(
      send,
      ...events(
        { type: 'approval.requested', approvalId: 's1', toolCallId: 'c1', toolName: 'list_repos', args: {}, kind: 'sign-in', signIn },
        { type: 'run.done', finishReason: 'awaiting-approval', text: '' }
      )
    );
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pendingApproval).toEqual({ id: 's1', toolCallId: 'c1', toolName: 'list_repos', args: {}, kind: 'sign-in', signIn });
  });

  it('a resumed run that pauses again exposes the next approval', () => {
    const next = { id: 'ap2', toolCallId: 'c2', toolName: 'pay', args: {} };
    const state = reduce(send, { type: 'ui.resumed', outcome: { text: '', finishReason: 'awaiting-approval', approval: next } });
    expect(state).toMatchObject({ status: 'awaiting-approval', pendingApproval: next });
    expect(state.messages[1].toolCalls).toEqual([{ id: 'c2', name: 'pay', args: {}, status: 'awaiting-approval' }]);
  });

  it('error events are kept; run.done with error sets the error status', () => {
    const error = { name: 'ProviderError', message: 'down' };
    const state = reduce(send, ...events({ type: 'error', error }, { type: 'run.done', finishReason: 'error', text: '' }));
    expect(state).toMatchObject({ status: 'error', error });
    expect(reduce(send, { type: 'ui.error', error })).toMatchObject({ status: 'error', error });
  });

  it('ui.stopped ends a streaming run only; sub-agent events only update lastEvent', () => {
    expect(reduce(send, { type: 'ui.stopped' }).status).toBe('idle');
    expect(reduce({ type: 'ui.stopped' })).toBe(initialAgentUIState);

    const [inner] = events({ type: 'text.delta', text: 'inner' });
    const state = reduce(send, { ...inner, subagent: { name: 'researcher', depth: 1, toolCallId: 'c1' } });
    expect(state.messages[1].text).toBe('');
    expect(state.lastEvent?.subagent?.name).toBe('researcher');
  });

  it('ui.reset (LOU-P2) goes back to the empty chat', () => {
    expect(reduce(send, ...events({ type: 'text.delta', text: 'Hi' }), { type: 'ui.reset' })).toBe(initialAgentUIState);
  });

  it('events without ui.send still build an assistant message', () => {
    const state = reduce(...events({ type: 'text.delta', text: 'Hi' }));
    expect(state.messages).toEqual([{ id: 'm0', role: 'assistant', text: 'Hi', toolCalls: [] }]);
  });

  describe('todos (N12)', () => {
    const todos = [{ id: 'todo_1', content: 'a', status: 'in_progress' as const }];
    const counts = { pending: 0, in_progress: 1, completed: 0, total: 1 };
    const updated: AgentEventPayload = { type: 'todo.updated', todos, counts, toolCallId: 'w1' };

    it('starts empty and is set by todo.updated', () => {
      expect(initialAgentUIState.todos).toEqual([]);
      expect(reduce(...events(updated)).todos).toEqual(todos);
    });

    it('is kept across run.done and a new ui.send, and cleared by ui.reset', () => {
      const state = reduce(send, ...events(updated, { type: 'run.done', finishReason: 'stop', text: '' }), { type: 'ui.send', input: 'More' });
      expect(state.todos).toEqual(todos);
      expect(reduce(...events(updated), { type: 'ui.reset' }).todos).toEqual([]);
    });

    it('ignores a sub-agent update', () => {
      const [event] = events(updated);
      expect(reduce({ ...event, subagent: { name: 'researcher', depth: 1, toolCallId: 'c1' } }).todos).toEqual([]);
    });
  });

  describe('multi-step text and endings (Eve CORE-F9)', () => {
    it('starts a new paragraph for each step instead of gluing step texts', () => {
      const state = reduce(
        send,
        ...events(
          { type: 'step.start', step: 1 },
          { type: 'text.delta', text: 'Let me check the weather.' },
          { type: 'tool.start', toolCallId: 'c1', toolName: 'weather', args: {} },
          { type: 'tool.done', toolCallId: 'c1', toolName: 'weather', result: 1, durationMs: 1 },
          { type: 'step.start', step: 2 },
          { type: 'text.delta', text: 'It is ' },
          { type: 'text.delta', text: '20C.' },
          { type: 'run.done', finishReason: 'stop', text: 'Let me check the weather.It is 20C.' }
        )
      );
      expect(state.messages[1].text).toBe('Let me check the weather.\n\nIt is 20C.');
      expect(state.messages[1]).not.toHaveProperty('stepBreak');
    });

    it('adds no separator for a tool-only step', () => {
      const state = reduce(
        send,
        ...events(
          { type: 'step.start', step: 1 },
          { type: 'tool.start', toolCallId: 'c1', toolName: 'weather', args: {} },
          { type: 'step.start', step: 2 },
          { type: 'text.delta', text: 'Done.' }
        )
      );
      expect(state.messages[1].text).toBe('Done.');
    });

    it('records finishReason and the typed object, and shows only the final reply of an output run', () => {
      const state = reduce(
        send,
        ...events(
          { type: 'step.start', step: 1 },
          { type: 'text.delta', text: 'not json' },
          { type: 'step.start', step: 2 },
          { type: 'text.delta', text: '{"a":"x"}' },
          { type: 'run.done', finishReason: 'stop', text: '{"a":"x"}', object: { a: 'x' } }
        )
      );
      expect(state.finishReason).toBe('stop');
      expect(state.status).toBe('idle');
      expect(state.messages[1]).toMatchObject({ text: '{"a":"x"}', finishReason: 'stop', object: { a: 'x' } });
    });

    it.each(['max-steps', 'output-invalid', 'budget-exceeded', 'guardrail'])('surfaces a %s ending as an error', (finishReason) => {
      const state = reduce(send, ...events({ type: 'run.done', finishReason, text: 'x', usage }));
      expect(state.status).toBe('error');
      expect(state.error).toMatchObject({ name: 'RunEndedError' });
      expect(state.finishReason).toBe(finishReason);
      expect(state.messages[1].finishReason).toBe(finishReason);
    });

    it('keeps an error event over the synthesized ending error, and clears both on the next send', () => {
      const failed = reduce(
        send,
        ...events({ type: 'error', error: { name: 'E', message: 'boom' } }, { type: 'run.done', finishReason: 'budget-exceeded', text: '' })
      );
      expect(failed.error).toEqual({ name: 'E', message: 'boom' });
      const again = reduceAgentEvents(failed, send);
      expect(again.error).toBeNull();
      expect(again.finishReason).toBeNull();
    });
  });
});
