import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, HandoffNodeData } from '../../../graph/v2/types';
import type { AgentListItem } from '../../../../shared/wireTypes';

const app = vi.hoisted(() => {
  const agents: AgentListItem[] = ['open-agent', 'billing-svc', 'search-svc'].map((id) => ({
    id,
    name: id,
    description: '',
    model: 'mock/mock-1',
    enabled: true,
    labels: [],
    updatedAt: '',
    publishedVersion: null,
    counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  }));
  return {
    graph: undefined as Graph | undefined,
    selectedNodeId: 'handoff:billing',
    agentId: 'open-agent',
    agents,
    setGraph: vi.fn(),
  };
});

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    displayGraph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    agentId: app.agentId,
    agents: app.agents,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

function specOf(
  handoffs: Record<string, unknown>[],
  subagents: Record<string, unknown> = { billing: { ref: 'agents/billing.yaml' } },
): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', subagents, handoffs } as unknown as AgentSpecV2;
}

let container: HTMLDivElement;

function renderInspector() {
  container = mount(<Inspector />);
}

/** Re-render so the Inspector sees the graph `setGraph` just produced. */
function flush() {
  act(() => rerender(<Inspector />));
}

function field<T extends Element = HTMLInputElement>(id: string): T {
  return container.querySelector(`#${id}`) as T;
}

function type(id: string, value: string) {
  act(() => {
    const el = field<HTMLInputElement | HTMLTextAreaElement>(id);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function blur(id: string) {
  act(() => field(id).dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as HandoffNodeData).item;

beforeEach(() => {
  app.selectedNodeId = 'handoff:billing';
  app.graph = specToGraph(specOf([{ agent: 'billing' }]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('handoff Inspector: target', () => {
  it('groups the options under Subagents and Agents, excluding the open agent', () => {
    renderInspector();
    const select = field<HTMLSelectElement>('node-handoff-agent');
    const labels = [...select.querySelectorAll('optgroup')].map((g) => g.label);
    expect(labels).toEqual(['Subagents', 'Agents']);
    const subs = [...select.querySelectorAll<HTMLOptionElement>('optgroup[label="Subagents"] option')].map((o) => o.value);
    expect(subs).toEqual(['billing']);
    const workspace = [...select.querySelectorAll<HTMLOptionElement>('optgroup[label="Agents"] option')].map(
      (o) => o.value,
    );
    expect(workspace).toEqual(['billing-svc', 'search-svc']);
    const flat = [...select.children].filter((el) => el.tagName === 'OPTION').map((o) => o.textContent);
    expect(flat).toEqual(['Other…']);
  });

  it('writes the picked sibling key or workspace id into item.agent', () => {
    renderInspector();
    choose('node-handoff-agent', 'billing-svc');
    expect(item().agent).toBe('billing-svc');
    choose('node-handoff-agent', 'billing');
    expect(item().agent).toBe('billing');
  });

  it('shows the free input for a target the select does not list', () => {
    app.graph = specToGraph(specOf([{ agent: 'custom-thing' }]));
    app.selectedNodeId = 'handoff:custom-thing';
    renderInspector();
    expect(field('node-handoff-agent-other')).not.toBeNull();
    type('node-handoff-agent-other', 'other-target');
    expect(item().agent).toBe('other-target');
  });

  it('flags an empty target', () => {
    app.graph = specToGraph(specOf([{ agent: '' }]));
    app.selectedNodeId = 'handoff:new';
    renderInspector();
    expect(container.textContent).toContain('Pick who takes over');
  });
});

describe('handoff Inspector: tool name, description, filter and schema', () => {
  it('flags an invalid tool name and accepts a valid one', () => {
    renderInspector();
    type('node-handoff-tool', 'not a name');
    flush();
    expect(container.textContent).toContain('Use letters, digits, dash or underscore (max 64)');
    type('node-handoff-tool', 'transfer_to_billing_v2');
    expect(item().toolName).toBe('transfer_to_billing_v2');
  });

  it('removes toolName when the input is cleared', () => {
    app.graph = specToGraph(specOf([{ agent: 'billing', toolName: 'transfer_to_billing' }]));
    renderInspector();
    type('node-handoff-tool', '');
    expect('toolName' in item()).toBe(false);
  });

  it('writes the description', () => {
    renderInspector();
    type('node-handoff-description', 'When the caller asks about invoices');
    expect(item().description).toBe('When the caller asks about invoices');
  });

  it('writes removeToolCalls from the filter choice and clears it on Default', () => {
    renderInspector();
    // ChoiceField with allowUnset: 0 = Default, 1 = removeToolCalls, 2 = lastUserMessage.
    choose('node-handoff-filter', '1');
    expect(item().inputFilter).toBe('removeToolCalls');
    choose('node-handoff-filter', '0');
    expect('inputFilter' in item()).toBe(false);
  });

  it('rejects a non-object schema and writes a valid one', () => {
    renderInspector();
    type('node-handoff-schema', '{"type":"string"}');
    blur('node-handoff-schema');
    expect(container.textContent).toContain('Use a JSON Schema with type: object');
    expect(item().inputJsonSchema).toBeUndefined();
    type('node-handoff-schema', '{"type":"object","properties":{"reason":{"type":"string"}}}');
    blur('node-handoff-schema');
    expect(item().inputJsonSchema).toStrictEqual({
      type: 'object',
      properties: { reason: { type: 'string' } },
    });
  });
});
