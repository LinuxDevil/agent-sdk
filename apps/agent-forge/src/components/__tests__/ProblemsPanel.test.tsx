import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';
import type { Graph, Problem } from '../../graph/v2/types';

const state = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  problems: [] as Problem[],
  setSelectedNodeId: vi.fn(),
}));

vi.mock('../../state/AppState', () => ({
  useAppState: () => ({
    graph: state.graph,
    problems: state.problems,
    setSelectedNodeId: state.setSelectedNodeId,
  }),
}));

import { ProblemsPanel } from '../debug/ProblemsPanel';

function graphOf(): Graph {
  return specToGraph({
    version: 2,
    name: 'a',
    model: 'mock/mock-1',
    instructions: 'x',
    tools: [{ builtin: 'http_request' }],
  } as unknown as AgentSpecV2);
}

function problem(over: Partial<Problem>): Problem {
  return { nodeId: 'agent', severity: 'error', message: 'm', ...over };
}

const rows = () => [...document.body.querySelectorAll<HTMLElement>('tr, [role="row"]')];

describe('ProblemsPanel', () => {
  beforeEach(() => {
    state.graph = graphOf();
    state.problems = [];
    state.setSelectedNodeId.mockReset();
  });

  it('shows the empty state when there are no problems', () => {
    render(<ProblemsPanel />);
    expect(document.body.textContent).toContain('No problems');
    expect(document.body.textContent).toContain('Everything on the canvas is valid.');
  });

  it('lists problems errors first, then node walk order, with severity, node, message and field', () => {
    // Walk order puts 'agent' before 'tool:http_request'; a warning on the
    // tool must still sort after every error regardless of walk position.
    state.problems = [
      problem({ nodeId: 'tool:http_request', severity: 'warning', message: 'warn here', fieldPath: 'tools[0].approval' }),
      problem({ nodeId: 'tool:http_request', severity: 'error', message: 'err on tool', fieldPath: 'tools[0].builtin' }),
      problem({ nodeId: 'agent', severity: 'error', message: 'err on agent' }),
    ];
    render(<ProblemsPanel />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Error');
    expect(text).toContain('Warning');
    expect(text.indexOf('err on agent')).toBeLessThan(text.indexOf('err on tool'));
    expect(text.indexOf('err on tool')).toBeLessThan(text.indexOf('warn here'));
    expect(text).toContain('tools[0].builtin');
  });

  it('opening a row selects the node', () => {
    state.problems = [problem({ nodeId: 'tool:http_request', message: 'err on tool' })];
    render(<ProblemsPanel />);
    const row = rows().find((r) => r.textContent?.includes('err on tool'))!;
    act(() => {
      (row as HTMLElement).click();
    });
    expect(state.setSelectedNodeId).toHaveBeenCalledWith('tool:http_request');
  });
});
