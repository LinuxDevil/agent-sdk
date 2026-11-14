import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../../AgentNode';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2, MemorySpec } from '../../../graph/v2/specTypes';
import type { Graph, GraphNode, MemoryNodeData } from '../../../graph/v2/types';

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'memory:notes',
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

function specOf(memory: MemorySpec[]): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', memory } as AgentSpecV2;
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

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as MemoryNodeData).item;

function useMemory(memory: MemorySpec[], nodeId: string) {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf(memory));
}

const BASE: MemorySpec = { name: 'notes', scope: 'session', provider: { type: 'in-memory' } };

/** Mounts `node`'s NodeCard and answers the value of one `.node-row` (or the chip). */
function cardRow(node: GraphNode, key: string): string | undefined {
  const Card = NODE_TYPES[flowNodeType(node.kind)];
  const data: CanvasNodeData = { graphNode: node };
  const props = { id: node.id, type: flowNodeType(node.kind), data, selected: false } as unknown as NodeProps;
  const card = mount(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  if (key === 'chip') return card.querySelector('.node-chip')?.textContent ?? undefined;
  return [...card.querySelectorAll('.node-row')]
    .find((r) => r.firstElementChild?.textContent === key)
    ?.querySelector('code')?.textContent ?? undefined;
}

beforeEach(() => {
  app.selectedNodeId = 'memory:notes';
  app.graph = specToGraph(specOf([BASE]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('memory Inspector: name and description', () => {
  it('writes the name through and flags a name outside the slot pattern', () => {
    renderInspector();
    type('node-memory-name', 'has space');
    expect(item().name).toBe('has space');
    flush();
    expect(container.textContent).toContain('Use letters, digits, dash or underscore (max 55)');
  });

  it('writes the description through and clears it to undefined', () => {
    useMemory([{ ...BASE, description: 'Facts' }], 'memory:notes');
    renderInspector();
    type('node-memory-description', 'Facts about each customer');
    expect(item().description).toBe('Facts about each customer');
    type('node-memory-description', '');
    expect(item().description).toBeUndefined();
  });
});

// Scope option indexes: 1 = Shared by everyone, 2 = One per session, 3 = metadata key.
describe('memory Inspector: Scope', () => {
  it('writes the three scope shapes', () => {
    useMemory([{ ...BASE, scope: { metadataKey: 'userId' } }], 'memory:notes');
    renderInspector();
    choose('node-memory-scope', '1');
    expect(item().scope).toBe('global');
    flush();
    choose('node-memory-scope', '2');
    expect(item().scope).toBe('session');
    flush();
    choose('node-memory-scope', '3');
    expect(item().scope).toStrictEqual({ metadataKey: '' });
  });

  it('edits the metadata key only for the third scope', () => {
    renderInspector();
    expect(container.querySelector('#node-memory-metadata-key')).toBeNull();
    choose('node-memory-scope', '3');
    flush();
    type('node-memory-metadata-key', 'userId');
    expect(item().scope).toStrictEqual({ metadataKey: 'userId' });
    flush();
    type('node-memory-metadata-key', '');
    flush();
    expect(container.textContent).toContain('Enter the metadata key, e.g. userId');
  });
});

// Storage option indexes: 1 = In memory, 2 = Files, 3 = SQLite with vector search.
describe('memory Inspector: Storage', () => {
  it('replaces the provider on a storage switch', () => {
    renderInspector();
    choose('node-memory-storage', '2');
    expect(item().provider).toStrictEqual({ type: 'file', dir: '' });
    flush();
    choose('node-memory-storage', '3');
    expect(item().provider).toStrictEqual({ type: 'sqlite-vector', embedder: '' });
    flush();
    choose('node-memory-storage', '1');
    expect(item().provider).toStrictEqual({ type: 'in-memory' });
  });

  it('edits the folder of a file provider and flags an empty one', () => {
    useMemory([{ ...BASE, provider: { type: 'file', dir: 'memory' } }], 'memory:notes');
    renderInspector();
    type('node-memory-dir', 'memory/items');
    expect(item().provider).toStrictEqual({ type: 'file', dir: 'memory/items' });
    type('node-memory-dir', '');
    flush();
    expect(container.textContent).toContain('Enter the folder for memory files');
  });

  it.each(['../escape', 'C:/abs/memory', '/abs/memory', 'a\\b'])(
    'flags the folder %j as outside the agent folder',
    (dir) => {
      useMemory([{ ...BASE, provider: { type: 'file', dir } }], 'memory:notes');
      renderInspector();
      expect(container.textContent).toContain('Use a relative path inside the agent folder');
    },
  );

  it('edits the sqlite-vector path, embedder and minimum score', () => {
    useMemory(
      [{ ...BASE, provider: { type: 'sqlite-vector', path: '.lousho/m.db', embedder: 'openai/text-embedding-3-small', minScore: 0.3 } }],
      'memory:notes',
    );
    renderInspector();
    type('node-memory-embedder', 'openai/text-embedding-3-large');
    expect(item().provider).toMatchObject({ embedder: 'openai/text-embedding-3-large' });
    flush();
    type('node-memory-minscore', '0.5');
    expect(item().provider).toMatchObject({ minScore: 0.5 });
    flush();
    type('node-memory-path', '');
    expect(item().provider).toStrictEqual({
      type: 'sqlite-vector',
      embedder: 'openai/text-embedding-3-large',
      minScore: 0.5,
    });
  });

  it('flags a database file outside the agent folder but accepts a relative one', () => {
    useMemory([{ ...BASE, provider: { type: 'sqlite-vector', path: '../m.db', embedder: 'e/m' } }], 'memory:notes');
    renderInspector();
    expect(container.textContent).toContain('Use a relative path inside the agent folder');
    type('node-memory-path', '.lousho/memory.db');
    expect(item().provider).toMatchObject({ path: '.lousho/memory.db' });
    flush();
    expect(container.textContent).not.toContain('Use a relative path inside the agent folder');
  });

  it('flags a missing embedder', () => {
    useMemory([{ ...BASE, provider: { type: 'sqlite-vector', embedder: '' } }], 'memory:notes');
    renderInspector();
    expect(container.textContent).toContain('Pick an embedding model');
  });
});

describe('memory Inspector: recall', () => {
  it('writes { query: last-input } on and deletes recall off', () => {
    renderInspector();
    click(field<HTMLButtonElement>('node-memory-recall'));
    expect(item().recall).toStrictEqual({ query: 'last-input' });
    flush();
    click(field<HTMLButtonElement>('node-memory-recall'));
    expect(item().recall).toBeUndefined();
  });

  it('keeps the other recall keys when toggled off', () => {
    useMemory([{ ...BASE, recall: { onSessionStart: true, query: 'last-input' } }], 'memory:notes');
    renderInspector();
    click(field<HTMLButtonElement>('node-memory-recall'));
    expect(item().recall).toStrictEqual({ onSessionStart: true });
  });

  it('edits the items-to-recall limit while recall is on', () => {
    useMemory([{ ...BASE, recall: { query: 'last-input' } }], 'memory:notes');
    renderInspector();
    type('node-memory-recall-limit', '5');
    expect(item().recall).toStrictEqual({ query: 'last-input', maxItems: 5 });
    flush();
    type('node-memory-recall-limit', '');
    expect(item().recall).toStrictEqual({ query: 'last-input' });
  });
});

describe('memory Inspector: model access', () => {
  it('shows read and write checked when expose is absent', () => {
    renderInspector();
    expect(field('node-memory-read').checked).toBe(true);
    expect(field('node-memory-write').checked).toBe(true);
  });

  it('writes false on uncheck, deletes the key on re-check and drops expose when empty', () => {
    renderInspector();
    click(field('node-memory-write'));
    expect(item().expose).toStrictEqual({ remember: false });
    flush();
    click(field('node-memory-read'));
    expect(item().expose).toStrictEqual({ remember: false, recall: false });
    flush();
    click(field('node-memory-write'));
    expect(item().expose).toStrictEqual({ recall: false });
    flush();
    click(field('node-memory-read'));
    expect(item().expose).toBeUndefined();
  });
});

describe('memory Inspector: item schema and key', () => {
  it('writes a JSON Schema object and refuses a non-object', () => {
    renderInspector();
    const textarea = field<HTMLTextAreaElement>('node-memory-schema');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '{ "type": "object" }',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(item().itemJsonSchema).toStrictEqual({ type: 'object' });
    flush();
    act(() => {
      const t = field<HTMLTextAreaElement>('node-memory-schema');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(t, '[1]');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    flush();
    expect(item().itemJsonSchema).toStrictEqual({ type: 'object' });
    expect(container.textContent).toContain('Use a JSON Schema object');
  });

  it('writes the item key and clears it to undefined', () => {
    useMemory([{ ...BASE, itemJsonSchema: { type: 'object' }, itemKey: 'customerId' }], 'memory:notes');
    renderInspector();
    type('node-memory-item-key', 'email');
    expect(item().itemKey).toBe('email');
    type('node-memory-item-key', '');
    expect(item().itemKey).toBeUndefined();
  });

  it('keeps an array item key an array', () => {
    useMemory([{ ...BASE, itemJsonSchema: { type: 'object' }, itemKey: ['customerId', 'region'] }], 'memory:notes');
    renderInspector();
    expect(field('node-memory-item-key').value).toBe('customerId, region');
    type('node-memory-item-key', 'customerId, region, tier');
    expect(item().itemKey).toStrictEqual(['customerId', 'region', 'tier']);
  });
});

describe('memory card', () => {
  it('renders the worked example\'s slots with the listed chips and rows', () => {
    const graph = specToGraph(
      specOf([
        {
          name: 'customers',
          scope: { metadataKey: 'userId' },
          provider: { type: 'sqlite-vector', embedder: 'openai/text-embedding-3-small' },
          recall: { query: 'last-input', maxItems: 5 },
        },
        { name: 'scratch', scope: 'session', provider: { type: 'in-memory' } },
      ]),
    );
    const [customers, scratch] = graph.nodes.filter((n) => n.kind === 'memory');
    expect(cardRow(customers, 'chip')).toBe('vector');
    expect(cardRow(customers, 'scope')).toBe('per userId');
    expect(cardRow(customers, 'recall')).toBe('last message · 5');
    expect(cardRow(customers, 'model')).toBe('read, write');
    expect(cardRow(scratch, 'chip')).toBe('in-memory');
    expect(cardRow(scratch, 'scope')).toBe('session');
    expect(cardRow(scratch, 'recall')).toBeUndefined();
    expect(cardRow(scratch, 'model')).toBe('read, write');
  });

  it('titles an unnamed slot "(unnamed)"', () => {
    const graph = specToGraph(specOf([{ ...BASE, name: '' }]));
    const node = graph.nodes.find((n) => n.kind === 'memory')!;
    const Card = NODE_TYPES[flowNodeType(node.kind)];
    const props = { id: node.id, type: flowNodeType(node.kind), data: { graphNode: node } } as unknown as NodeProps;
    const card = mount(
      <ReactFlowProvider>
        <Card {...props} />
      </ReactFlowProvider>
    );
    expect(card.querySelector('.rf-node-title')?.textContent).toBe('(unnamed)');
  });
});
