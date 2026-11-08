import { describe, it, expect } from 'vitest';
import { nodeRunStatuses } from '../nodeStatus';
import type { NodeStates } from '../../state/nodeStateReducer';
import type { AgentRunStatusPayload, NodeStatePayload, NodeRunState } from '../../../shared/wireTypes';

const status = (s: AgentRunStatusPayload['status'], over: Partial<AgentRunStatusPayload> = {}): AgentRunStatusPayload =>
  ({ agentId: 'bot', status: s, updatedAt: '', ...over }) as AgentRunStatusPayload;

const frame = (nodeId: string, state: NodeRunState, at = '2026-01-01T00:00:00.000Z'): NodeStatePayload => ({
  nodeId,
  state,
  spanId: `${nodeId}:${state}`,
  at,
});

const states = (...frames: NodeStatePayload[]): NodeStates =>
  Object.fromEntries(frames.map((f) => [f.nodeId, f]));

// A flat graph's ids plus a collapsed subagent group and one of its children.
const NODE_IDS = ['agent', 'tool:http', 'sub:research', 'sub:research/tool:web_fetch'];

describe('nodeRunStatuses', () => {
  it('is idle for every node before any run', () => {
    const statuses = nodeRunStatuses(NODE_IDS, {}, undefined);
    expect(NODE_IDS.every((id) => statuses[id] === 'idle')).toBe(true);
  });

  it('lights the run up frame by frame: agent running, tool running, tool done, agent done', () => {
    const ids = ['agent', 'tool:web-fetch'];
    let s = nodeRunStatuses(ids, states(frame('agent', 'running')), status('running'));
    expect(s.agent).toBe('running');
    expect(s['tool:web-fetch']).toBe('idle');

    s = nodeRunStatuses(ids, states(frame('agent', 'running'), frame('tool:web-fetch', 'running', '2026-01-01T00:00:01.000Z')), status('running'));
    expect(s['tool:web-fetch']).toBe('running');

    s = nodeRunStatuses(
      ids,
      states(frame('agent', 'running'), frame('tool:web-fetch', 'done', '2026-01-01T00:00:02.000Z')),
      status('running')
    );
    expect(s['tool:web-fetch']).toBe('done');
    expect(s.agent).toBe('running');

    s = nodeRunStatuses(
      ids,
      states(frame('agent', 'done', '2026-01-01T00:00:03.000Z'), frame('tool:web-fetch', 'done', '2026-01-01T00:00:02.000Z')),
      status('done')
    );
    expect(s.agent).toBe('done');
    expect(s['tool:web-fetch']).toBe('done');
  });

  it.each<[NodeRunState, AgentRunStatusPayload['status'] | undefined, string]>([
    ['running', 'running', 'running'],
    ['running', 'paused', 'paused'],
    ['running', 'stopped', 'idle'],
    ['running', 'done', 'idle'],
    ['running', undefined, 'idle'],
    ['waiting', 'paused', 'paused'],
    ['waiting', 'running', 'paused'],
    ['done', 'done', 'done'],
    ['error', 'error', 'error'],
  ])('frame %s with run %s maps to %s', (state, run, expected) => {
    const runStatus = run === undefined ? undefined : status(run);
    expect(nodeRunStatuses(['agent'], states(frame('agent', state)), runStatus).agent).toBe(expected);
  });

  it('a waiting frame shows the node paused (the warning ring status)', () => {
    const s = nodeRunStatuses(['tool:http'], states(frame('tool:http', 'waiting')), status('paused'));
    expect(s['tool:http']).toBe('paused');
  });

  it('raises the subagent group node from a child frame', () => {
    const s = nodeRunStatuses(NODE_IDS, states(frame('sub:research/tool:web_fetch', 'running')), status('running'));
    expect(s['sub:research/tool:web_fetch']).toBe('running');
    expect(s['sub:research']).toBe('running');
    expect(s.agent).toBe('idle');
  });

  it('raises a nested group path only to its immediate owner', () => {
    const s = nodeRunStatuses(
      ['sub:a', 'sub:a/sub:b', 'sub:a/sub:b/tool:x'],
      states(frame('sub:a/sub:b/tool:x', 'error')),
      status('error')
    );
    expect(s['sub:a/sub:b']).toBe('error');
    expect(s['sub:a']).toBe('idle');
  });

  it('the highest rank wins when several child frames raise one group', () => {
    // done (1) vs error (2) vs running (4) on children of the same group.
    const group = nodeRunStatuses(
      ['sub:g', 'sub:g/tool:a', 'sub:g/tool:b'],
      states(
        frame('sub:g/tool:a', 'done'),
        frame('sub:g/tool:b', 'error', '2026-01-01T00:00:01.000Z')
      ),
      status('error')
    );
    expect(group['sub:g']).toBe('error');
    const running = nodeRunStatuses(
      ['sub:g', 'sub:g/tool:a', 'sub:g/tool:b'],
      states(frame('sub:g/tool:a', 'done'), frame('sub:g/tool:b', 'running', '2026-01-01T00:00:01.000Z')),
      status('running')
    );
    expect(running['sub:g']).toBe('running');
  });

  it('ignores frames for node ids the graph does not have', () => {
    const s = nodeRunStatuses(['agent'], states(frame('ghost:node', 'error'), frame('agent', 'done')), status('done'));
    expect(s.agent).toBe('done');
    expect(Object.keys(s)).toEqual(['agent']);
  });
});
