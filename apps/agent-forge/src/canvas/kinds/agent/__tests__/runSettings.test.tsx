import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../../ui/__tests__/render';

import { Inspector } from '../../../../components/Inspector';
import { specToGraph } from '../../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../../graph/v2/specTypes';
import type { AgentNodeData, Graph } from '../../../../graph/v2/types';
import type { CatalogModel } from '../../../../../shared/wireTypes';
import type { CatalogState } from '../../../../canvas/useCatalog';

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

vi.mock('../../../../canvas/useCatalog', () => ({
  useCatalog: () => catalog.state,
  refreshCatalog: vi.fn(),
}));

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'agent',
  setGraph: vi.fn(),
}));

vi.mock('../../../../state/AppState', () => ({
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

function click(id: string) {
  act(() => {
    field<HTMLButtonElement>(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

describe('agent run settings Inspector', () => {
  it('writes limits.maxCostUsd and deletes limits when it is the last key cleared', () => {
    renderInspector();
    type('node-agent-max-cost', '2.5');
    expect(fields().limits).toStrictEqual({ maxCostUsd: 2.5 });
    flush();
    type('node-agent-max-cost', '');
    expect(fields().limits).toBeUndefined();
  });

  it('keeps sibling limits keys when one is cleared', () => {
    app.graph = specToGraph(specOf({ limits: { maxCostUsd: 2, maxTokens: 1000 } }));
    renderInspector();
    type('node-agent-max-cost', '');
    expect(fields().limits).toStrictEqual({ maxTokens: 1000 });
  });

  it('writes maxSteps at the top level', () => {
    renderInspector();
    type('node-agent-max-steps', '12');
    expect(fields().maxSteps).toBe(12);
  });

  it('writes permissionMode plan and deletes it again for Default', () => {
    renderInspector();
    // ChoiceField options (no unset): 1 default, 2 plan, 3 acceptEdits, 4 dontAsk.
    choose('node-agent-permission-mode', '2');
    expect(fields().permissionMode).toBe('plan');
    flush();
    choose('node-agent-permission-mode', '1');
    expect(fields().permissionMode).toBeUndefined();
  });

  it('rejects an approval timeout under 30 seconds without writing it', () => {
    renderInspector();
    type('node-agent-approval-ttl', '10000');
    flush();
    expect(container.textContent).toContain('At least 30 seconds');
    expect(fields().approvalTtlMs).toBeUndefined();
  });

  it('writes approvalTtlMs once it is at least 30 seconds', () => {
    renderInspector();
    type('node-agent-approval-ttl', '60000');
    expect(fields().approvalTtlMs).toBe(60000);
  });

  it('writes askQuestion true on and deletes the key off', () => {
    renderInspector();
    click('node-agent-ask-question');
    expect(fields().askQuestion).toBe(true);
    flush();
    click('node-agent-ask-question');
    expect(fields().askQuestion).toBeUndefined();
  });

  it('writes retry:false for Off and shows the three custom fields for Custom', () => {
    renderInspector();
    // Retries ChoiceField (allowUnset): 0 Default, 1 Off, 2 Custom.
    choose('node-agent-retry', '1');
    expect(fields().retry).toBe(false);
    flush();
    choose('node-agent-retry', '2');
    expect(fields().retry).toStrictEqual({});
    flush();
    expect(field('node-agent-retry-max')).not.toBeNull();
    expect(field('node-agent-retry-backoff')).not.toBeNull();
    expect(field('node-agent-retry-timeout')).not.toBeNull();
  });

  it('writes retry.maxRetries inside the retry object', () => {
    app.graph = specToGraph(specOf({ retry: { maxRetries: 1 } }));
    renderInspector();
    type('node-agent-retry-max', '4');
    expect(fields().retry).toStrictEqual({ maxRetries: 4 });
  });

  it('keeps custom backoff sub-keys when the preset is re-picked', () => {
    app.graph = specToGraph(specOf({ retry: { backoff: { initialMs: 100, jitter: false } } }));
    renderInspector();
    // Backoff ChoiceField (allowUnset): 0 Default, 1 Exponential, 2 Linear.
    choose('node-agent-retry-backoff', '2');
    expect(fields().retry).toStrictEqual({ backoff: { initialMs: 100, jitter: false, factor: 1 } });
  });

  it('writes rateLimit.requestsPerMinute', () => {
    renderInspector();
    type('node-agent-rate-limit-rpm', '30');
    expect(fields().rateLimit).toStrictEqual({ requestsPerMinute: 30 });
  });

  it('writes compaction custom threshold and summarizer', () => {
    renderInspector();
    // Compaction ChoiceField (allowUnset): 0 Default, 1 On, 2 Off, 3 Custom.
    choose('node-agent-compaction', '3');
    expect(fields().compaction).toStrictEqual({});
    flush();
    type('node-agent-compaction-threshold', '0.8');
    expect(fields().compaction).toStrictEqual({ thresholdPercent: 0.8 });
    flush();
    // The summarizer ModelPicker is a select until "Other…" switches it to free text.
    choose('node-agent-compaction-model', '__other__');
    flush();
    type('node-agent-compaction-model', 'anthropic/claude-sonnet-5-5');
    expect(fields().compaction).toStrictEqual({
      thresholdPercent: 0.8,
      summarizer: 'anthropic/claude-sonnet-5-5',
    });
  });

  it('keeps compaction:false distinct from deleting the key', () => {
    renderInspector();
    // 2 = Off.
    choose('node-agent-compaction', '2');
    expect(fields().compaction).toBe(false);
    flush();
    choose('node-agent-compaction', '0');
    expect(fields().compaction).toBeUndefined();
  });

  it('writes promptCaching false off and deletes the key on', () => {
    renderInspector();
    click('node-agent-prompt-caching');
    expect(fields().promptCaching).toBe(false);
    flush();
    click('node-agent-prompt-caching');
    expect(fields().promptCaching).toBeUndefined();
  });

  it('writes toolSearch false off and an object on, keeping maxResults inside it', () => {
    renderInspector();
    // Absent means on (the SDK default); the first click turns it off.
    click('node-agent-tool-search');
    expect(fields().toolSearch).toBe(false);
    flush();
    expect(field('node-agent-tool-search-max-results')).toBeNull();
    click('node-agent-tool-search');
    expect(fields().toolSearch).toStrictEqual({});
    flush();
    type('node-agent-tool-search-max-results', '8');
    expect(fields().toolSearch).toStrictEqual({ maxResults: 8 });
  });

  it('reads a literal toolSearch:false as off', () => {
    app.graph = specToGraph(specOf({ toolSearch: false }));
    renderInspector();
    expect(field('node-agent-tool-search').getAttribute('aria-checked')).toBe('false');
    flush();
    // Toggling back on writes an object, never resurrects `false`.
    click('node-agent-tool-search');
    expect(fields().toolSearch).toStrictEqual({});
  });

  it('writes codeMode true on and deletes the key off', () => {
    renderInspector();
    click('node-agent-code-mode');
    expect(fields().codeMode).toBe(true);
    flush();
    click('node-agent-code-mode');
    expect(fields().codeMode).toBeUndefined();
  });

  it('writes subagentOptions.maxConcurrent and maxSubagentDepth', () => {
    renderInspector();
    type('node-agent-subagent-max-concurrent', '2');
    expect(fields().subagentOptions).toStrictEqual({ maxConcurrent: 2 });
    flush();
    type('node-agent-max-subagent-depth', '2');
    expect(fields().maxSubagentDepth).toBe(2);
    type('node-agent-max-handoffs', '5');
    expect(fields().maxHandoffs).toBe(5);
  });
});

describe('inline subagent run settings', () => {
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

  it('hides the Delegation section on an inline subagent', () => {
    renderInspector();
    const ids = [...container.querySelectorAll('.inspector-section-body')].map((el) => el.id);
    expect(ids).not.toContain('inspector-section-agent-delegation');
    expect(ids).toContain('inspector-section-agent-limits');
  });
});
