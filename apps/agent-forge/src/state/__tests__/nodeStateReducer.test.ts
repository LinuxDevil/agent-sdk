import { describe, it, expect } from 'vitest';
import { applyNodeState, isNewRun } from '../nodeStateReducer';
import type { AgentRunStatusPayload, NodeStatePayload } from '../../../shared/wireTypes';

const frame = (over: Partial<NodeStatePayload> = {}): NodeStatePayload => ({
  nodeId: 'agent',
  state: 'running',
  spanId: 'span-1',
  at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const status = (s: AgentRunStatusPayload['status']): AgentRunStatusPayload =>
  ({ agentId: 'bot', status: s, updatedAt: '' }) as AgentRunStatusPayload;

describe('applyNodeState', () => {
  it('stores the first frame for a node', () => {
    const f = frame();
    expect(applyNodeState({}, f)).toEqual({ agent: f });
  });

  it('keeps frames for different nodes side by side', () => {
    const a = frame({ nodeId: 'agent' });
    const b = frame({ nodeId: 'tool:http', spanId: 'span-2' });
    const states = applyNodeState(applyNodeState({}, a), b);
    expect(states.agent).toBe(a);
    expect(states['tool:http']).toBe(b);
  });

  it('a later `at` frame for the same node wins', () => {
    const start = frame({ state: 'running', at: '2026-01-01T00:00:01.000Z' });
    const end = frame({ state: 'done', at: '2026-01-01T00:00:02.000Z' });
    const states = applyNodeState(applyNodeState({}, start), end);
    expect(states.agent.state).toBe('done');
  });

  it('an older `at` frame for the same node is ignored and returns the same object', () => {
    const end = frame({ state: 'done', at: '2026-01-01T00:00:02.000Z' });
    const late = frame({ nodeId: 'tool:http', state: 'running', spanId: 'span-9', at: '2026-01-01T00:00:01.000Z' });
    const states = applyNodeState(applyNodeState({}, end), late);
    // `late` is a different node - it lands; an older frame for `agent` does not.
    expect(states['tool:http']).toBe(late);
    const stale = frame({ state: 'running', spanId: 'span-8', at: '2026-01-01T00:00:00.500Z' });
    expect(applyNodeState(states, stale)).toBe(states);
    expect(states.agent.state).toBe('done');
  });

  it('a frame for the same span id overrides the earlier one even on an older `at`', () => {
    const start = frame({ state: 'running', at: '2026-01-01T00:00:02.000Z' });
    const end = frame({ state: 'done', at: '2026-01-01T00:00:01.000Z' });
    const states = applyNodeState(applyNodeState({}, start), end);
    expect(states.agent).toBe(end);
  });
});

describe('isNewRun', () => {
  it.each<[AgentRunStatusPayload | undefined, AgentRunStatusPayload, boolean]>([
    [undefined, status('running'), true],
    [status('idle'), status('running'), true],
    [status('done'), status('running'), true],
    [status('running'), status('running'), false],
    [status('paused'), status('running'), false],
    [status('done'), status('paused'), false],
  ])('prev %s -> next %s = %s', (prev, next, expected) => {
    expect(isNewRun(prev, next)).toBe(expected);
  });
});
