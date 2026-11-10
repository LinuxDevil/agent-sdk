import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../../AgentNode';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2, PermissionRuleSpec } from '../../../graph/v2/specTypes';
import type { Graph, GraphNode, PermissionNodeData } from '../../../graph/v2/types';

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'perm:p1',
  setGraph: vi.fn(),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    displayGraph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

function specOf(permissions: PermissionRuleSpec[], over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', permissions, ...over } as AgentSpecV2;
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

function enter(id: string) {
  act(() => {
    field(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

function choose(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as PermissionNodeData).item;

function useRule(permissions: PermissionRuleSpec[], over: Record<string, unknown> = {}, nodeId = 'perm:p1') {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf(permissions, over));
}

const BASE: PermissionRuleSpec = { id: 'p1', tool: 'http', action: 'ask' };

/** Mounts `node`'s NodeCard and answers the value of one `.node-row` (or the chip). */
function cardRow(node: GraphNode, key: string): string | undefined {
  const Card = NODE_TYPES[flowNodeType(node.kind)];
  const data: CanvasNodeData = { graphNode: node };
  const props = { id: node.id, type: flowNodeType(node.kind), data, selected: false } as unknown as NodeProps;
  const card = mount(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>,
  );
  if (key === 'chip') return card.querySelector('.node-chip')?.textContent ?? undefined;
  if (key === 'title') return card.querySelector('.rf-node-title')?.textContent ?? undefined;
  return [...card.querySelectorAll('.node-row')]
    .find((r) => r.firstElementChild?.textContent === key)
    ?.querySelector('code')?.textContent ?? undefined;
}

beforeEach(() => {
  app.selectedNodeId = 'perm:p1';
  app.graph = specToGraph(specOf([BASE], { tools: [{ builtin: 'http' }] }));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('permission Inspector: tools', () => {
  it('writes a second tool as an array and back down to a string', () => {
    renderInspector();
    type('node-perm-tools', 'web-fetch');
    enter('node-perm-tools');
    expect(item().tool).toStrictEqual(['http', 'web-fetch']);
    flush();
    click(container.querySelector('button[aria-label="Remove web-fetch"]')!);
    expect(item().tool).toBe('http');
  });

  it('writes an empty list and flags it', () => {
    renderInspector();
    click(container.querySelector('button[aria-label="Remove http"]')!);
    expect(item().tool).toStrictEqual([]);
    flush();
    expect(container.textContent).toContain('Add a tool name or pattern');
  });

  it('offers the owner\'s tool names and mcp globs as suggestions', () => {
    useRule([BASE], { tools: [{ builtin: 'http' }, { builtin: 'web-fetch' }], mcpServers: { github: { command: 'npx' } } });
    renderInspector();
    const options = [...container.querySelectorAll('#node-perm-tools-suggestions option')].map(
      (o) => o.getAttribute('value'),
    );
    expect(options).toEqual(['http', 'web-fetch', 'github__*']);
  });
});

describe('permission Inspector: action', () => {
  it('writes the chosen action', () => {
    renderInspector();
    choose('node-perm-action', '4');
    expect(item().action).toBe('auto');
    flush();
    choose('node-perm-action', '2');
    expect(item().action).toBe('deny');
  });

  it('shows the model-decides help only for auto', () => {
    renderInspector();
    expect(container.textContent).not.toContain('It never denies');
    choose('node-perm-action', '4');
    flush();
    expect(container.textContent).toContain('It never denies');
  });
});

describe('permission Inspector: reason, TTL and id', () => {
  it('writes the reason and clears it to undefined', () => {
    renderInspector();
    type('node-perm-reason', 'Changes code');
    expect(item().reason).toBe('Changes code');
    flush();
    type('node-perm-reason', '');
    expect(item().reason).toBeUndefined();
  });

  it('shows Remember approval for on ask, hidden on allow and deny', () => {
    renderInspector();
    expect(container.querySelector('#node-perm-ttl')).not.toBeNull();
    choose('node-perm-action', '1');
    flush();
    expect(container.querySelector('#node-perm-ttl')).toBeNull();
    choose('node-perm-action', '4');
    flush();
    expect(container.querySelector('#node-perm-ttl')).not.toBeNull();
  });

  it('writes ttlMs as an integer of at least 1000', () => {
    renderInspector();
    type('node-perm-ttl', '60000');
    expect(item().ttlMs).toBe(60000);
    type('node-perm-ttl', '');
    expect(item().ttlMs).toBeUndefined();
  });

  it('flags an id outside the spec pattern and a duplicate', () => {
    renderInspector();
    type('node-perm-id', 'has space');
    expect(item().id).toBe('has space');
    flush();
    expect(container.textContent).toContain('letters, digits, dot, dash or underscore');
    useRule([BASE, { id: 'p2', tool: 'x', action: 'allow' }], {});
    renderInspector();
    type('node-perm-id', 'p2');
    flush();
    expect(container.textContent).toContain('Another rule uses this id');
  });
});

describe('permission Inspector: conditions', () => {
  it('adds a condition row and writes the matcher', () => {
    renderInspector();
    click(field<HTMLButtonElement>('node-perm-when-add'));
    flush();
    expect(container.textContent).toContain('A condition needs an argument name');
    type('node-perm-when-arg-0', 'url');
    flush();
    choose('node-perm-when-op-0', 'matches');
    flush();
    type('node-perm-when-value-0', '^https://internal\\.');
    expect(item().when).toStrictEqual({ url: { matches: '^https://internal\\.' } });
  });

  it('shows the regex error and blocks the write until it is fixed', () => {
    renderInspector();
    click(field<HTMLButtonElement>('node-perm-when-add'));
    flush();
    type('node-perm-when-arg-0', 'url');
    flush();
    choose('node-perm-when-op-0', 'matches');
    flush();
    type('node-perm-when-value-0', '[');
    flush();
    expect(container.textContent).toContain('This is not a valid regular expression');
    // The last valid emit stands; the unparseable draft is never written.
    expect(item().when).toStrictEqual({ url: { matches: '' } });
    type('node-perm-when-value-0', '^ok$');
    expect(item().when).toStrictEqual({ url: { matches: '^ok$' } });
    flush();
  });

  it('removes a condition and deletes when when none are left', () => {
    useRule([{ ...BASE, when: { url: { matches: '^x$' } } }]);
    renderInspector();
    click(container.querySelector('button[aria-label="Remove condition url"]')!);
    expect(item().when).toBeUndefined();
  });

  it('renders a multi-operator argument as one row per operator', () => {
    useRule([{ ...BASE, when: { n: { gt: 1, lt: 5 }, url: '^x$' } }]);
    renderInspector();
    expect(field<HTMLInputElement>('node-perm-when-arg-0').value).toBe('n');
    expect(field<HTMLSelectElement>('node-perm-when-op-0').value).toBe('gt');
    expect(field<HTMLInputElement>('node-perm-when-arg-1').value).toBe('n');
    expect(field<HTMLSelectElement>('node-perm-when-op-1').value).toBe('lt');
    expect(field<HTMLInputElement>('node-perm-when-arg-2').value).toBe('url');
    expect(field<HTMLSelectElement>('node-perm-when-op-2').value).toBe('pattern');
  });
});

describe('permission card', () => {
  it('titles the rule by its tool list and chips the action', () => {
    const graph = specToGraph(
      specOf(
        [
          { id: 'p1', tool: ['github__*', 'http'], action: 'ask' },
          { id: 'p2', tool: '*', action: 'auto', reason: 'Triage', ttlMs: 60000, when: { n: { gt: 1 } } },
          { id: 'p3', tool: 'http', action: 'deny' },
        ],
      ),
    );
    const [p1, p2, p3] = graph.nodes.filter((n) => n.kind === 'permission');
    expect(cardRow(p1, 'title')).toBe('github__*, http');
    expect(cardRow(p1, 'chip')).toBe('ask');
    expect(cardRow(p2, 'chip')).toBe('model decides');
    expect(cardRow(p2, 'when')).toBe('1 condition');
    expect(cardRow(p2, 'reason')).toBe('Triage');
    expect(cardRow(p2, 'remember')).toBe('60 s');
    expect(cardRow(p3, 'chip')).toBe('deny');
    expect(cardRow(p3, 'when')).toBeUndefined();
  });
});
