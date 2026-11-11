import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { render as mount, rerender } from '../../../../ui/__tests__/render';

import { specToGraph } from '../../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../../graph/v2/specTypes';
import type { Graph, NodeOfKind } from '../../../../graph/v2/types';
import type { CatalogModel } from '../../../../../shared/wireTypes';
import type { CatalogState } from '../../../useCatalog';
import { FlowStepFields } from '../FlowStepFields';
import { FlowInputsEditor } from '../FlowInputsEditor';

vi.mock('../../../useCatalog', () => ({
  useCatalog: () => ({ data: undefined, error: undefined, loading: false }) as CatalogState<CatalogModel[]>,
  refreshCatalog: vi.fn(),
}));

const SPEC = `
version: 2
name: a
model: mock/mock-1
instructions: x
flow:
  code: f
  name: F
  inputs:
    - { name: ticket, type: shortText, required: true }
  flow:
    type: sequence
    id: s1
    steps:
      - { type: llmCall, id: s2, prompt: Summarize, outputVariable: summary }
      - { type: setVariable, id: s3, variable: note, value: "hi" }
      - type: oneOf
        id: s4
        options:
          - condition: "x == 1"
            step: { type: end, id: s5, value: one }
          - step: { type: end, id: s6, value: two }
`;

let graph: Graph;
let patch: ReturnType<typeof vi.fn>;
let patchFlowMeta: ReturnType<typeof vi.fn>;
let moveChild: ReturnType<typeof vi.fn>;
let setOptionCondition: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;

function flowNode(id: string): NodeOfKind<'flow'> {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined || node.kind !== 'flow') throw new Error(`no flow node '${id}'`);
  return node;
}

function props(id: string) {
  return {
    node: flowNode(id),
    graph,
    patch,
    replace: vi.fn(),
    patchFlowMeta,
    moveChild,
    setOptionCondition,
    problems: [],
  };
}

function renderFields(id: string) {
  container = mount(<FlowStepFields {...props(id)} />);
}

function field<T extends Element = HTMLInputElement | HTMLTextAreaElement>(id: string): T {
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

beforeEach(() => {
  graph = specToGraph(parse(SPEC) as AgentSpecV2);
  patch = vi.fn();
  patchFlowMeta = vi.fn();
  moveChild = vi.fn();
  setOptionCondition = vi.fn();
});

describe('FlowStepFields dispatch', () => {
  it('renders the llmCall form for an llmCall step', () => {
    renderFields('flow:s2');
    expect(field('node-flow-s2-prompt')).not.toBeNull();
    expect(field('node-flow-s2-output')).not.toBeNull();
    expect(field('node-flow-s2-id')).not.toBeNull();
  });

  it('writes prompt edits through patch', () => {
    renderFields('flow:s2');
    type('node-flow-s2-prompt', 'New prompt');
    expect(patch).toHaveBeenCalledWith({ prompt: 'New prompt' });
  });

  it('renders the setVariable form for a setVariable step', () => {
    renderFields('flow:s3');
    expect(field('node-flow-s3-variable')).not.toBeNull();
    type('node-flow-s3-variable', 'other');
    expect(patch).toHaveBeenCalledWith({ variable: 'other' });
  });

  it('renders the router form for a oneOf step', () => {
    renderFields('flow:s4');
    expect(container.textContent).toContain('Branches');
    expect(container.textContent).toContain('Default');
    type('node-flow-s4-condition', 'x == 2');
    expect(setOptionCondition).toHaveBeenCalledWith('flow:s5', 'x == 2');
  });

  it('shows Flow settings only on the root step', () => {
    renderFields('flow:s1');
    expect(field('node-flow-s1-code')).not.toBeNull();
    renderFields('flow:s2');
    expect(container.querySelector('#node-flow-s2-code')).toBeNull();
  });

  it('writes flowMeta fields through patchFlowMeta', () => {
    renderFields('flow:s1');
    type('node-flow-s1-description', 'Triages then answers');
    expect(patchFlowMeta).toHaveBeenCalledWith({ description: 'Triages then answers' });
  });
});

describe('FlowInputsEditor', () => {
  let onChange: ReturnType<typeof vi.fn>;
  const rows = [{ name: 'ticket', type: 'shortText' as const, required: true, description: '' }];
  const editor = (inputs: unknown) => (
    <FlowInputsEditor id="inputs" inputs={inputs} onChange={onChange} />
  );

  beforeEach(() => {
    onChange = vi.fn();
    container = mount(editor(rows));
  });

  it('renders one row per input', () => {
    expect(field('inputs-name')).not.toBeNull();
    expect(field<HTMLInputElement>('inputs-name').value).toBe('ticket');
  });

  it('adds a row and reports the new inputs', () => {
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add input')!;
    act(() => add.click());
    // Controlled component: the parent feeds the new (blank) row back in.
    rerender(editor([...rows, { name: '', type: 'shortText', required: false, description: '' }]));
    type('inputs-name-1', 'count');
    expect(onChange).toHaveBeenLastCalledWith([
      { name: 'ticket', required: true, type: 'shortText' },
      { name: 'count', required: false, type: 'shortText' },
    ]);
  });
});
