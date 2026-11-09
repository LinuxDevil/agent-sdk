import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { AgentNodeData, Graph } from '../../../graph/v2/types';
import type { CatalogModel } from '../../../../shared/wireTypes';
import type { CatalogState } from '../../useCatalog';

const catalog = vi.hoisted(() => {
  const MODELS: CatalogModel[] = [
    {
      id: 'openai/gpt-5',
      modelId: 'gpt-5',
      provider: 'openai',
      contextWindow: 400_000,
      capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] },
      available: true,
    },
  ];
  return { state: { data: MODELS, error: undefined, loading: false } as CatalogState<CatalogModel[]> };
});

vi.mock('../../useCatalog', () => ({
  useCatalog: () => catalog.state,
  refreshCatalog: vi.fn(),
}));

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'agent',
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

function specOf(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'openai/gpt-5', instructions: 'Be brief.', ...over } as AgentSpecV2;
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
    // The prototype setter bypasses React's own value tracker so the 'input'
    // event reads as a real user edit (see canvas/fields/__tests__ helpers).
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


const fields = () => (app.graph!.nodes[0].data as AgentNodeData).fields;

beforeEach(() => {
  app.selectedNodeId = 'agent';
  app.graph = specToGraph(specOf());
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('agent Inspector', () => {
  it('shows the sections in order', () => {
    renderInspector();
    const ids = [...container.querySelectorAll('.inspector-section-body')].map((el) => el.id);
    for (const id of [
      'agent-identity',
      'agent-model',
      'agent-instructions',
      'agent-limits',
      'agent-approvals',
      'agent-reliability',
      'agent-context',
      'agent-delegation',
    ]) {
      expect(ids).toContain(`inspector-section-${id}`);
    }
    // C27: the Advanced JSON editor is gone — every AGENT_FIELD_KEYS entry has a real control.
    expect(container.querySelector('#node-agent-advanced')).toBeNull();
  });

  it('writes the name field from the name input', () => {
    renderInspector();
    type('node-agent-name', 'new-name');
    expect(fields().name).toBe('new-name');
  });

  it('shows the pattern error for an invalid name and still writes it', () => {
    renderInspector();
    type('node-agent-name', 'bad!');
    expect(fields().name).toBe('bad!');
    flush();
    expect(container.textContent).toContain('Use letters, digits, space, dot, dash or underscore, up to 64 characters');
  });

  it('writes the description', () => {
    renderInspector();
    type('node-agent-description', 'Sorts tickets');
    expect(fields().description).toBe('Sorts tickets');
  });

  it('sets modelSettings.temperature and drops modelSettings when cleared', () => {
    renderInspector();
    type('node-agent-temperature', '0.3');
    expect(fields().modelSettings).toStrictEqual({ temperature: 0.3 });
    flush();
    type('node-agent-temperature', '');
    expect(fields().modelSettings).toBeUndefined();
  });

  it('keeps other model settings when one is cleared', () => {
    app.graph = specToGraph(specOf({ modelSettings: { temperature: 0.3, maxTokens: 100 } }));
    renderInspector();
    type('node-agent-temperature', '');
    expect(fields().modelSettings).toStrictEqual({ maxTokens: 100 });
  });

  it('shows the budget field for Token budget and writes { budgetTokens }', () => {
    renderInspector();
    // ChoiceField options: 0 Default, 1 Off, 2 Minimal, 3 Low, 4 Medium, 5 High, 6 Token budget.
    choose('node-agent-reasoning', '6');
    expect(fields().reasoning).toStrictEqual({ budgetTokens: 1024 });
    flush();
    expect(field('node-agent-reasoning-budget')).not.toBeNull();
    type('node-agent-reasoning-budget', '4096');
    expect(fields().reasoning).toStrictEqual({ budgetTokens: 4096 });
  });

  it('writes effort reasoning for Low and removes it for Default', () => {
    renderInspector();
    choose('node-agent-reasoning', '3');
    expect(fields().reasoning).toBe('low');
    flush();
    choose('node-agent-reasoning', '0');
    expect(fields().reasoning).toBeUndefined();
  });

  it('restores the typed text after Text → File → Text', () => {
    renderInspector();
    type('node-agent-instructions', 'You sort tickets.');
    // Source ChoiceField (no unset): 1 Text, 2 File.
    choose('node-agent-instructions-source', '2');
    flush();
    expect(field('node-agent-instructions-file')).not.toBeNull();
    choose('node-agent-instructions-source', '1');
    flush();
    expect((field('node-agent-instructions') as HTMLTextAreaElement).value).toBe('You sort tickets.');
  });

  it('rejects a file path that escapes the agent folder', () => {
    renderInspector();
    choose('node-agent-instructions-source', '2');
    flush();
    type('node-agent-instructions-file', '../outside.md');
    flush();
    expect(container.textContent).toContain('Use a path inside the agent folder');
  });

  it('writes promptRef and clears it on empty', () => {
    renderInspector();
    type('node-agent-prompt-ref', 'triage@prod');
    expect(fields().promptRef).toBe('triage@prod');
    flush();
    type('node-agent-prompt-ref', '');
    expect(fields().promptRef).toBeUndefined();
  });

  it('writes maxSteps through the Limits section instead of JSON', () => {
    renderInspector();
    const el = field<HTMLInputElement>('node-agent-max-steps');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '9');
    act(() => el.dispatchEvent(new Event('input', { bubbles: true })));
    expect(fields().maxSteps).toBe(9);
  });
});

describe('inline subagent Inspector', () => {
  beforeEach(() => {
    app.graph = specToGraph(
      specOf({
        subagents: {
          r: { inline: { name: 'r', description: 'Looks things up', model: 'openai/gpt-5', instructions: 'x' } },
        },
      })
    );
    app.selectedNodeId = 'sub:r';
  });

  const subFields = () => (app.graph!.nodes[1].data as AgentNodeData).fields;

  it('shows the Subagent name field', () => {
    renderInspector();
    expect(field('node-agent-key')).not.toBeNull();
    expect(container.textContent).toContain('Subagent name');
  });

  it('writes subagentKey through replace', () => {
    renderInspector();
    type('node-agent-key', 'research');
    expect((app.graph!.nodes[1].data as AgentNodeData).subagentKey).toBe('research');
  });

  it('requires a description', () => {
    renderInspector();
    type('node-agent-description', '');
    flush();
    expect(container.textContent).toContain('A subagent needs a description so the main agent knows when to use it');
  });

  it('writes fields on the subagent, not the root', () => {
    renderInspector();
    type('node-agent-name', 'researcher');
    expect(subFields().name).toBe('researcher');
    expect(fields().name).toBe('a');
  });
});
