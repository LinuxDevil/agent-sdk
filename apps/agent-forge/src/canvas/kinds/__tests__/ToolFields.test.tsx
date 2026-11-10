import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../../AgentNode';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, GraphNode, ToolNodeData } from '../../../graph/v2/types';
import type { CatalogState } from '../../useCatalog';
import type { AgentListItem, CatalogModel, CatalogTool } from '../../../../shared/wireTypes';

const app = vi.hoisted(() => {
  const agents: AgentListItem[] = ['open-agent'].map((id) => ({
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
    selectedNodeId: 'tool:web_fetch',
    agentId: 'open-agent',
    agents,
    setGraph: vi.fn(),
  };
});

const catalogs = vi.hoisted(() => {
  const TOOLS: CatalogTool[] = [
    {
      name: 'web_fetch',
      description: 'Fetches a URL',
      inputJsonSchema: {},
      needsCredentials: [],
      mutating: false,
      optionsJsonSchema: null,
      toolNames: ['web_fetch'],
    },
    {
      name: 'http_request',
      description: 'Calls an HTTP endpoint',
      inputJsonSchema: {},
      needsCredentials: [],
      mutating: true,
      optionsJsonSchema: null,
      toolNames: ['http_request'],
    },
  ];
  const MODELS: CatalogModel[] = [
    {
      id: 'mock/mock-1',
      modelId: 'mock-1',
      provider: 'mock',
      contextWindow: 1000,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        structuredOutput: true,
        hostedTools: ['web_search'],
      },
      available: true,
    },
  ];
  return {
    tools: { data: TOOLS, error: undefined, loading: false } as CatalogState<CatalogTool[]>,
    models: { data: MODELS, error: undefined, loading: false } as CatalogState<CatalogModel[]>,
    refresh: vi.fn(),
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

vi.mock('../../useCatalog', () => ({
  useCatalog: (kind: string) => (kind === 'tools' ? catalogs.tools : catalogs.models),
  refreshCatalog: catalogs.refresh,
}));

function specOf(tools: Record<string, unknown>[]): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', tools } as AgentSpecV2;
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

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as ToolNodeData).item;

function useTool(tools: Record<string, unknown>[], nodeId: string) {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf(tools));
}

/** Mounts `node`'s NodeCard and answers its title — the far end of the "pick in the Inspector → card updates" path. */
function cardTitle(node: GraphNode): string | undefined {
  const Card = NODE_TYPES[flowNodeType(node.kind)];
  const data: CanvasNodeData = { graphNode: node };
  const props = { id: node.id, type: flowNodeType(node.kind), data, selected: false } as unknown as NodeProps;
  const card = mount(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  return card.querySelector('.rf-node-title')?.textContent ?? undefined;
}

beforeEach(() => {
  app.selectedNodeId = 'tool:web_fetch';
  app.graph = specToGraph(specOf([{ builtin: 'web_fetch' }]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
  catalogs.tools = { data: catalogs.tools.data, error: undefined, loading: false };
  catalogs.models = { data: catalogs.models.data, error: undefined, loading: false };
});

// Type option indexes: 1 builtin, 2 registry, 3 file, 4 integration, 5 openapi, 6 hosted, 7 hub.
describe('tool Inspector: Type switch', () => {
  it('replaces the item with the new form\'s empty value', () => {
    renderInspector();
    choose('node-tool-form', '3');
    expect(item()).toStrictEqual({ file: '' });
  });

  it('keeps id, approval and deferLoading across the switch', () => {
    useTool([{ builtin: 'web_fetch', approval: 'always', deferLoading: true, id: 'fetch' }], 'tool:fetch');
    renderInspector();
    choose('node-tool-form', '3');
    expect(item()).toStrictEqual({ file: '', approval: 'always', deferLoading: true, id: 'fetch' });
  });

  it('keeps id but drops approval and deferLoading for forms that cannot carry them', () => {
    useTool([{ builtin: 'web_fetch', approval: 'always', deferLoading: true, id: 'fetch' }], 'tool:fetch');
    renderInspector();
    choose('node-tool-form', '6');
    expect(item()).toStrictEqual({ hosted: '', id: 'fetch' });
  });
});

describe('tool Inspector: catalog pick', () => {
  it('writes the picked name as builtin and the card re-titles to it', () => {
    renderInspector();
    const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.querySelector('.tool-option-name')?.textContent === 'http_request',
    )!;
    act(() => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(item()).toStrictEqual({ builtin: 'http_request' });
    const node = app.graph!.nodes.find((n) => n.id === 'tool:web_fetch')!;
    expect(cardTitle(node)).toBe('http_request');
  });
});

describe('tool Inspector: per-form fields', () => {
  it('writes the registry name and version', () => {
    useTool([{ registry: 'github-issues' }], 'tool:github-issues');
    renderInspector();
    type('node-tool-version', '1.2.0');
    expect(item()).toStrictEqual({ registry: 'github-issues', version: '1.2.0' });
  });

  it('writes the file path', () => {
    useTool([{ file: '' }], 'tool:new');
    renderInspector();
    type('node-tool-file', 'tools/search.ts');
    expect(item()).toStrictEqual({ file: 'tools/search.ts' });
  });

  it('switches the integration service and resets credentials to its suggested keys', () => {
    useTool([{ integration: 'github', credentials: { token: { env: 'GH_TOKEN' } } }], 'tool:github');
    renderInspector();
    choose('node-tool-service', '2'); // jira
    expect(item()).toStrictEqual({ integration: 'jira', credentials: {} });
  });

  it('prefills the suggested credential keys when the map is empty', () => {
    useTool([{ integration: 'github', credentials: {} }], 'tool:github');
    renderInspector();
    const keys = [...container.querySelectorAll<HTMLInputElement>('.kv-row input[placeholder="Name"]')]
      .map((input) => input.value);
    expect(keys).toEqual(['token', 'owner', 'repo']);
  });

  it('shows only the real credential rows when the map is not empty', () => {
    useTool([{ integration: 'github', credentials: { token: { env: 'GH_TOKEN' } } }], 'tool:github');
    renderInspector();
    const keys = [...container.querySelectorAll<HTMLInputElement>('.kv-row input[placeholder="Name"]')]
      .map((input) => input.value);
    expect(keys).toEqual(['token']);
  });

  it('writes only filled credential values to the spec, not the blank suggested rows', () => {
    useTool([{ integration: 'github', credentials: {} }], 'tool:github');
    renderInspector();
    choose('node-tool-credentials-value-0-mode', 'env');
    const input = container.querySelector<HTMLInputElement>('.kv-row input[placeholder="GITHUB_TOKEN"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'GH_TOKEN');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(item()).toStrictEqual({ integration: 'github', credentials: { token: { env: 'GH_TOKEN' } } });
  });

  it('keeps a removed suggested row removed', () => {
    useTool([{ integration: 'github', credentials: {} }], 'tool:github');
    renderInspector();
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove owner"]')!;
    act(() => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const keys = [...container.querySelectorAll<HTMLInputElement>('.kv-row input[placeholder="Name"]')]
      .map((input) => input.value);
    expect(keys).toEqual(['token', 'repo']);
    expect(item()).toStrictEqual({ integration: 'github', credentials: {} });
  });

  it('writes the OpenAPI url and keeps the rest of the object', () => {
    useTool([{ openapi: { url: '', include: ['getOrder'] } }], 'tool:openapi');
    renderInspector();
    type('node-tool-openapi-url', 'https://api.example.com/openapi.json');
    expect(item()).toStrictEqual({
      openapi: { url: 'https://api.example.com/openapi.json', include: ['getOrder'] },
    });
  });

  it('writes the hosted tool name', () => {
    useTool([{ hosted: '' as never }], 'tool:new');
    renderInspector();
    choose('node-tool-hosted', '3'); // file_search
    expect(item()).toStrictEqual({ hosted: 'file_search' });
  });
});

describe('tool Inspector: hosted warning', () => {
  it('warns when the root model does not offer the picked hosted tool', () => {
    useTool([{ hosted: 'file_search' }], 'tool:file_search');
    renderInspector();
    expect(container.textContent).toContain('The selected model does not offer this tool');
  });

  it('does not warn when the model offers it', () => {
    useTool([{ hosted: 'web_search' }], 'tool:web_search');
    renderInspector();
    expect(container.textContent).not.toContain('The selected model does not offer this tool');
  });
});

describe('tool Inspector: Behaviour section', () => {
  it('writes approval, deferLoading and id', () => {
    renderInspector();
    choose('node-tool-approval', '1'); // Always ask
    expect(item()).toMatchObject({ approval: 'always' });
    act(() => {
      field<HTMLButtonElement>('node-tool-defer').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(item()).toMatchObject({ deferLoading: true });
    type('node-tool-id', 'fetch-docs');
    expect(item()).toMatchObject({ id: 'fetch-docs' });
  });

  it('flags an invalid node id', () => {
    renderInspector();
    type('node-tool-id', 'bad id!');
    flush();
    expect(container.textContent).toContain('Use letters, digits, dash or underscore');
  });
});
