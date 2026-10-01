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

  it('events without ui.send still build an assistant message', () => {
    const state = reduce(...events({ type: 'text.delta', text: 'Hi' }));
    expect(state.messages).toEqual([{ id: 'm0', role: 'assistant', text: 'Hi', toolCalls: [] }]);
  });
});
