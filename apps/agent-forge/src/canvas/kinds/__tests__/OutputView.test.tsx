import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';
import { Inspector } from '../../../components/Inspector';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, NodeOfKind, OutputNodeData } from '../../../graph/v2/types';
import { OUTPUT_VIEW } from '../output';

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'output',
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

const OUTPUT = {
  jsonSchema: {
    type: 'object',
    properties: {
      priority: { type: 'string', enum: ['low', 'urgent'] },
      summary: { type: 'string', description: 'One sentence' },
    },
    required: ['priority', 'summary'],
    additionalProperties: false,
  },
};

function specOf(output: Record<string, unknown> = OUTPUT): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', output } as unknown as AgentSpecV2;
}

let container: HTMLDivElement;

function renderInspector() {
  container = mount(<Inspector />);
}

function flush() {
  act(() => rerender(<Inspector />));
}

function field<T extends Element = HTMLInputElement>(id: string): T {
  return container.querySelector(`#${id}`) as T;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function choose(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === 'output')!.data as OutputNodeData).item;

beforeEach(() => {
  vi.restoreAllMocks();
  app.selectedNodeId = 'output';
  app.graph = specToGraph(specOf());
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('output card', () => {
  const node = (): NodeOfKind<'output'> =>
    app.graph!.nodes.find((n) => n.id === 'output') as NodeOfKind<'output'>;

  it('titles Output and rows the top-level properties with required markers', () => {
    expect(OUTPUT_VIEW.title(node())).toBe('Output');
    expect(OUTPUT_VIEW.rows(node())).toEqual([
      { k: 'priority', v: 'string' },
      { k: 'summary', v: 'string' },
    ]);
  });

  it('marks optional properties with ? and collapses past four rows', () => {
    app.graph = specToGraph(
      specOf({
        jsonSchema: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            b: { type: 'number' },
            c: { type: 'boolean' },
            d: { type: 'array' },
            e: { type: 'object' },
            f: { type: 'integer' },
          },
          required: ['a'],
        },
      }),
    );
    expect(OUTPUT_VIEW.rows(node())).toEqual([
      { k: 'a', v: 'string' },
      { k: 'b', v: 'number?' },
      { k: 'c', v: 'boolean?' },
      { k: 'd', v: 'array?' },
      { k: '…', v: '2 more' },
    ]);
  });

  it('chips the schema delivery only when it is not the default', () => {
    expect(OUTPUT_VIEW.chip?.(node())).toBeUndefined();
    app.graph = specToGraph(specOf({ ...OUTPUT, promptSchema: false }));
    expect(OUTPUT_VIEW.chip?.(node())).toBe('format only');
    app.graph = specToGraph(specOf({ ...OUTPUT, responseFormat: 'always' }));
    expect(OUTPUT_VIEW.chip?.(node())).toBe('every call');
  });

  it('palette entry creates the default answer schema and refuses a second output', () => {
    const entry = OUTPUT_VIEW.palette[0];
    expect(entry.group).toBe('Output');
    // A graph without an output node can take one; this graph already has `output`.
    const bare = specToGraph({
      version: 2,
      name: 'a',
      model: 'mock/mock-1',
      instructions: 'x',
    } as AgentSpecV2);
    expect(entry.unavailable?.(bare, 'agent')).toBeUndefined();
    const created = entry.create(bare, 'agent');
    expect(created.kind).toBe('output');
    expect((created.data as OutputNodeData).item.jsonSchema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' } },
    });
    expect(entry.unavailable?.(app.graph!, 'agent')).toBe('This agent already has an output schema');
  });
});

describe('output Inspector', () => {
  it('shows the field table, the JSON schema and the delivery options', () => {
    renderInspector();
    expect(container.querySelectorAll('input.output-field-name')).toHaveLength(2);
    expect(field('node-output-schema').tagName).toBe('TEXTAREA');
    expect(field('node-output-prompt-schema')).not.toBeNull();
    expect(field('node-output-response-format')).not.toBeNull();
  });

  it('writes promptSchema: false when the prompt switch goes off and deletes it back on', () => {
    renderInspector();
    click(field('node-output-prompt-schema'));
    expect(item().promptSchema).toBe(false);
    flush();
    click(field('node-output-prompt-schema'));
    expect('promptSchema' in item()).toBe(false);
  });

  it('writes responseFormat and deletes it back to the SDK default', () => {
    renderInspector();
    choose('node-output-response-format', '2'); // Every model call
    expect(item().responseFormat).toBe('always');
    flush();
    choose('node-output-response-format', '0'); // Default
    expect('responseFormat' in item()).toBe(false);
  });

  it('keeps the table and the JSON editor on the same jsonSchema', () => {
    renderInspector();
    // A table edit (add field) is visible in the schema textarea's draft on re-render.
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Add field'))!;
    click(add);
    expect((item().jsonSchema as { properties: Record<string, unknown> }).properties.field_1).toEqual({
      type: 'string',
    });
    flush();
    expect(field<HTMLTextAreaElement>('node-output-schema').value).toContain('field_1');
  });
});
