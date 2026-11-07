import { describe, it, expect } from 'vitest';
import { nodeRunStatuses } from '../nodeStatus';
import { specToGraph } from '../../graph/v2/specToGraph';
import { graphToSpec } from '../../graph/v2/graphToSpec';
import type { AgentRunStatusPayload, SpanEvent } from '../../../shared/wireTypes';

const graph = specToGraph({
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'p',
  tools: [{ builtin: 'http' }],
});
const nodeIdMap = graphToSpec(graph).nodeIdMap;
const toolId = 'tool:http';

const chat = (over: Partial<SpanEvent> = {}): SpanEvent => ({
  id: 'chat-1',
  name: 'chat',
  parentId: 'root',
  startTime: 1,
  attributes: { 'gen_ai.operation.name': 'chat' },
  ...over,
});
const tool = (over: Partial<SpanEvent> = {}): SpanEvent => ({
  id: 'tool-1',
  name: 'execute_tool http',
  parentId: 'root',
  startTime: 2,
  attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'http' },
  ...over,
});
const status = (s: AgentRunStatusPayload['status'], over: Partial<AgentRunStatusPayload> = {}): AgentRunStatusPayload =>
  ({ agentId: 'bot', status: s, updatedAt: '', ...over }) as AgentRunStatusPayload;

describe('nodeRunStatuses', () => {
  it('is idle for every node before any run', () => {
    const statuses = nodeRunStatuses(graph, [], undefined, nodeIdMap);
    expect(graph.nodes.every((n) => statuses[n.id] === 'idle')).toBe(true);
  });

  it('a span stamped with lousho.node.id lands on the graph node the id maps from', () => {
    const stamped = chat({ attributes: { 'lousho.node.id': 'tool:http', 'gen_ai.operation.name': 'chat' } });
    const statuses = nodeRunStatuses(graph, [stamped], status('running'), nodeIdMap);
    expect(statuses[toolId]).toBe('running');
    expect(statuses['agent']).toBe('idle');
  });

  it('marks the node of an open span running, and a finished one done', () => {
    const statuses = nodeRunStatuses(graph, [chat({ endTime: 5 }), tool()], status('running'), nodeIdMap);
    expect(statuses['agent']).toBe('done');
    expect(statuses[toolId]).toBe('running');
  });

  it('reads an open span as running only while the run is running', () => {
    for (const s of ['stopped', 'done', 'error', 'idle'] as const) {
      expect(nodeRunStatuses(graph, [tool()], status(s), nodeIdMap)[toolId]).toBe('idle');
    }
    expect(nodeRunStatuses(graph, [tool()], undefined, nodeIdMap)[toolId]).toBe('idle');
    expect(nodeRunStatuses(graph, [tool()], status('paused'), nodeIdMap)[toolId]).toBe('paused');
  });

  it('marks a failed span error', () => {
    const statuses = nodeRunStatuses(graph, [chat({ endTime: 5, status: { code: 'error' } })], status('error'), nodeIdMap);
    expect(statuses['agent']).toBe('error');
    expect(statuses[toolId]).toBe('idle');
  });

  it('marks the tool awaiting approval paused', () => {
    const paused = status('paused', { pendingApproval: { toolName: 'http', args: {} } as AgentRunStatusPayload['pendingApproval'] });
    const statuses = nodeRunStatuses(graph, [chat({ endTime: 5 })], paused, nodeIdMap);
    expect(statuses[toolId]).toBe('paused');
  });
});
