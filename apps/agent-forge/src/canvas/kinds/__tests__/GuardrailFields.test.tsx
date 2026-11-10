import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../../AgentNode';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, GraphNode, GuardrailNodeData } from '../../../graph/v2/types';
import type { CatalogState } from '../../useCatalog';
import type { CatalogGuardrail } from '../../../../shared/wireTypes';

const catalogs = vi.hoisted(() => {
  const PII_SCHEMA = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['block', 'rewrite'] }, types: { type: 'array' } },
  };
  const PI_SCHEMA = { type: 'object', properties: { model: { type: 'string' } } };
  const ML_SCHEMA = { type: 'object', properties: { maxChars: { type: 'number' } } };
  const GUARDRAILS: CatalogGuardrail[] = [
    {
      name: 'pii',
      description: 'Finds personal data.',
      on: ['input', 'output'],
      optionsJsonSchema: PII_SCHEMA,
      canRewrite: true,
      canRunInParallel: false,
    },
    {
      name: 'prompt-injection',
      description: 'Flags attempts to override instructions.',
      on: ['input'],
      optionsJsonSchema: PI_SCHEMA,
      canRewrite: false,
      canRunInParallel: true,
    },
    {
      name: 'max-length',
      description: 'Blocks long text.',
      on: ['input', 'output'],
      optionsJsonSchema: ML_SCHEMA,
      canRewrite: false,
      canRunInParallel: false,
    },
  ];
  return {
    schemas: { pii: PII_SCHEMA, promptInjection: PI_SCHEMA, maxLength: ML_SCHEMA },
    entries: GUARDRAILS,
    guardrails: { data: GUARDRAILS, error: undefined, loading: false } as CatalogState<
      CatalogGuardrail[]
    >,
  };
});

const PII_SCHEMA = catalogs.schemas.pii;
const PI_SCHEMA = catalogs.schemas.promptInjection;

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'guard:g1',
  setGraph: vi.fn(),
}));

const schemaForm = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

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

vi.mock('../../useCatalog', () => ({
  useCatalog: () => catalogs.guardrails,
  refreshCatalog: vi.fn(),
}));

vi.mock('../../../ui/schemaForm/SchemaForm', () => ({
  SchemaForm: (props: Record<string, unknown>) => {
    schemaForm.calls.push(props);
    return null;
  },
}));

function specOf(guardrails: Record<string, unknown>[]): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', guardrails } as unknown as AgentSpecV2;
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

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as GuardrailNodeData).item;

function useGuardrail(guardrails: Record<string, unknown>[], nodeId = 'guard:g1') {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf(guardrails));
}

const BASE: Record<string, unknown> = { id: 'g1', name: 'pii', on: 'input' };

/** Mounts `node`'s NodeCard and answers the value of one `.node-row` (or the chip/title). */
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
  app.selectedNodeId = 'guard:g1';
  app.graph = specToGraph(specOf([BASE]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
  catalogs.guardrails = { data: catalogs.entries, error: undefined, loading: false };
  schemaForm.calls.length = 0;
});

describe('guardrail Inspector: name picker', () => {
  it('lists the catalog entries with their descriptions as titles', () => {
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-guard-name').querySelectorAll('option')];
    expect(options.map((o) => o.textContent)).toEqual(['Pick a guardrail', 'pii', 'prompt-injection', 'max-length']);
    expect(options[2].title).toBe('Flags attempts to override instructions.');
    expect(container.textContent).toContain('Finds personal data.');
  });

  it('changing the guardrail clears the options and shows the new options form', () => {
    useGuardrail([{ ...BASE, options: { action: 'rewrite', types: ['email'] } }]);
    renderInspector();
    choose('node-guard-name', 'prompt-injection');
    expect(item().name).toBe('prompt-injection');
    expect(item().options).toBeUndefined();
    flush();
    expect(schemaForm.calls.at(-1)?.['schema']).toBe(PI_SCHEMA);
  });

  it('flags an empty name', () => {
    useGuardrail([{ id: 'g1', name: '' }]);
    renderInspector();
    expect(container.textContent).toContain('Pick a guardrail');
  });
});

describe('guardrail Inspector: checks side', () => {
  it('writes input, output and both', () => {
    renderInspector();
    choose('node-guard-on', '2');
    expect(item().on).toBe('output');
    flush();
    choose('node-guard-on', '3');
    expect(item().on).toStrictEqual(['input', 'output']);
    flush();
    choose('node-guard-on', '1');
    expect(item().on).toBe('input');
  });

  it('disables a side the catalog entry does not support and says why', () => {
    useGuardrail([{ id: 'g1', name: 'prompt-injection', on: 'input' }]);
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-guard-on').querySelectorAll('option')];
    expect(options[1].disabled).toBe(true);
    expect(options[1].title).toBe('This guardrail cannot check output');
    expect(options[2].disabled).toBe(true);
    expect(options[2].title).toBe('This guardrail cannot check both');
  });

  it('hints that a tools-side guardrail is not editable here', () => {
    useGuardrail([{ id: 'g1', name: 'pii', on: 'tools' }]);
    renderInspector();
    expect(container.textContent).toContain('checks the tools side');
  });
});

describe('guardrail Inspector: parallel and trip behaviour', () => {
  it('disables Run in parallel for pii and says why', () => {
    renderInspector();
    const toggle = field<HTMLButtonElement>('node-guard-parallel');
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe('Only prompt-injection and moderation can run in parallel, on input');
  });

  it('toggles runInParallel for prompt-injection on the input side', () => {
    useGuardrail([{ id: 'g1', name: 'prompt-injection', on: 'input' }]);
    renderInspector();
    const toggle = field<HTMLButtonElement>('node-guard-parallel');
    expect(toggle.disabled).toBe(false);
    click(toggle);
    expect(item().runInParallel).toBe(true);
    flush();
    click(field<HTMLButtonElement>('node-guard-parallel'));
    expect(item().runInParallel).toBeUndefined();
  });

  it('disables rewrite while parallel and says why', () => {
    useGuardrail([{ id: 'g1', name: 'prompt-injection', on: 'input', runInParallel: true }]);
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-guard-tripped').querySelectorAll('option')];
    const rewrite = options.find((o) => o.textContent === 'Rewrite the text')!;
    expect(rewrite.disabled).toBe(true);
    expect(rewrite.title).toBe('A parallel check cannot rewrite');
  });

  it('keeps warn listed but disabled — the SDK rejects it', () => {
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-guard-tripped').querySelectorAll('option')];
    const warn = options.find((o) => o.textContent === 'Warn only')!;
    expect(warn.disabled).toBe(true);
    expect(warn.title).toBe("'warn' is not supported; use 'block' or 'rewrite'");
  });

  it('disables rewrite for a built-in that cannot rewrite and says why', () => {
    useGuardrail([{ id: 'g1', name: 'max-length', on: 'input' }]);
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-guard-tripped').querySelectorAll('option')];
    const rewrite = options.find((o) => o.textContent === 'Rewrite the text')!;
    expect(rewrite.disabled).toBe(true);
    expect(rewrite.title).toBe('This guardrail cannot rewrite');
  });

  it('enables rewrite for a rewritable built-in', () => {
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-guard-tripped').querySelectorAll('option')];
    const rewrite = options.find((o) => o.textContent === 'Rewrite the text')!;
    expect(rewrite.disabled).toBe(false);
  });

  it('writes onTripped and clears it to Default', () => {
    renderInspector();
    choose('node-guard-tripped', '3');
    expect(item().onTripped).toBe('rewrite');
    flush();
    choose('node-guard-tripped', '0');
    expect(item().onTripped).toBeUndefined();
  });
});

describe('guardrail Inspector: options form', () => {
  it('feeds the entry schema and the item options to the schema form', () => {
    useGuardrail([{ ...BASE, options: { action: 'block' } }]);
    renderInspector();
    const props = schemaForm.calls.at(-1)!;
    expect(props['schema']).toBe(PII_SCHEMA);
    expect(props['value']).toStrictEqual({ action: 'block' });
    expect(props['idPrefix']).toBe('node-guard-opt');
  });

  it('deletes options when the form emits an empty object', () => {
    useGuardrail([{ ...BASE, options: { action: 'block' } }]);
    renderInspector();
    const props = schemaForm.calls.at(-1)!;
    act(() => {
      (props['onChange'] as (next: unknown) => void)({});
    });
    expect(item().options).toBeUndefined();
  });

  it('shows skeleton rows while the catalog loads', () => {
    catalogs.guardrails = { data: undefined, error: undefined, loading: true };
    renderInspector();
    expect(container.querySelector('.skeleton')).not.toBeNull();
    expect(schemaForm.calls).toHaveLength(0);
  });

  it('falls back to a JSON field on catalog error', () => {
    catalogs.guardrails = { data: undefined, error: 'server down', loading: false };
    useGuardrail([{ ...BASE, options: { action: 'block' } }]);
    renderInspector();
    expect(schemaForm.calls).toHaveLength(0);
    expect(field<HTMLTextAreaElement>('node-guard-opt').tagName).toBe('TEXTAREA');
  });
});

describe('guardrail Inspector: id', () => {
  it('flags an id outside the spec pattern and a duplicate', () => {
    renderInspector();
    type('node-guard-id', 'has space');
    expect(item().id).toBe('has space');
    flush();
    expect(container.textContent).toContain('letters, digits, dot, dash or underscore');
    useGuardrail([BASE, { id: 'g2', name: 'max-length' }]);
    renderInspector();
    type('node-guard-id', 'g2');
    flush();
    expect(container.textContent).toContain('Another guardrail uses this id');
  });
});

describe('guardrail card', () => {
  it('chips the checked sides and rows the trip behaviour and parallel mode', () => {
    const graph = specToGraph(
      specOf([
        { id: 'g1', name: 'pii', on: ['input', 'output'], onTripped: 'rewrite' },
        { id: 'g2', name: 'prompt-injection', on: 'input', runInParallel: true },
      ]),
    );
    const [g1, g2] = graph.nodes.filter((n) => n.kind === 'guardrail');
    expect(cardRow(g1, 'title')).toBe('pii');
    expect(cardRow(g1, 'chip')).toBe('both');
    expect(cardRow(g1, 'on trip')).toBe('rewrite');
    expect(cardRow(g1, 'mode')).toBeUndefined();
    expect(cardRow(g2, 'chip')).toBe('input');
    expect(cardRow(g2, 'mode')).toBe('parallel');
  });

  it('titles an unpicked guardrail "(pick one)"', () => {
    const graph = specToGraph(specOf([{ id: 'g1', name: '' }]));
    const g1 = graph.nodes.find((n) => n.kind === 'guardrail')!;
    expect(cardRow(g1, 'title')).toBe('(pick one)');
  });
});
