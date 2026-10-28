import { describe, it, expect } from 'vitest';
import { nodeRunStatuses } from '../nodeStatus';
import { specToGraph } from '../../graph/specToGraph';
import type { AgentRunStatusPayload, SpanEvent } from '../../../shared/wireTypes';

const graph = specToGraph({
  name: 'bot',
  prompt: 'p',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['http'],
});
const llmId = graph.nodes.find((n) => n.type === 'llm')!.id;
const toolId = graph.nodes.find((n) => n.type === 'tool')!.id;

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
    const statuses = nodeRunStatuses(graph, [], undefined);
    expect(graph.nodes.every((n) => statuses[n.id] === 'idle')).toBe(true);
  });

  it('marks the node of an open span running, and a finished one done', () => {
    const statuses = nodeRunStatuses(graph, [chat({ endTime: 5 }), tool()], status('running'));
    expect(statuses[llmId]).toBe('done');
    expect(statuses[toolId]).toBe('running');
  });

  it('marks a failed span error', () => {
    const statuses = nodeRunStatuses(graph, [chat({ endTime: 5, status: { code: 'error' } })], status('error'));
    expect(statuses[llmId]).toBe('error');
    expect(statuses[toolId]).toBe('idle');
  });

  it('marks the tool awaiting approval paused', () => {
    const paused = status('paused', { pendingApproval: { toolName: 'http', args: {} } as AgentRunStatusPayload['pendingApproval'] });
    const statuses = nodeRunStatuses(graph, [chat({ endTime: 5 })], paused);
    expect(statuses[toolId]).toBe('paused');
  });
});
