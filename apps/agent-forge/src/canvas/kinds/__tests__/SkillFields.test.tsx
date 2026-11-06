import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../../AgentNode';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2, SkillRef } from '../../../graph/v2/specTypes';
import type { Graph, GraphNode, SkillNodeData } from '../../../graph/v2/types';
import type { CatalogState } from '../../useCatalog';
import type { AgentListItem, CatalogSkill } from '../../../../shared/wireTypes';

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
    selectedNodeId: 'skill:changelog',
    agentId: 'open-agent',
    agents,
    setGraph: vi.fn(),
  };
});

const catalogs = vi.hoisted(() => {
  const SKILLS: CatalogSkill[] = [
    { name: 'changelog', description: 'Writes the changelog', ref: { registry: 'changelog' } },
    { name: 'code-review', description: 'Reviews a diff', ref: { registry: 'code-review' } },
  ];
  return {
    skills: { data: SKILLS, error: undefined, loading: false } as CatalogState<CatalogSkill[]>,
    refresh: vi.fn(),
  };
});

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
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
  useCatalog: () => catalogs.skills,
  refreshCatalog: catalogs.refresh,
}));

function specOf(skills: Record<string, unknown>[]): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', skills } as AgentSpecV2;
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

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as SkillNodeData).item;
const inline = () => (item() as { inline: { name: string; description: string; content: string } }).inline;

function useSkill(skills: Record<string, unknown>[], nodeId: string) {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf(skills));
}

/** Mounts `node`'s NodeCard and answers its chip text — the far end of the card contract. */
function cardChip(node: GraphNode): string | undefined {
  const Card = NODE_TYPES[flowNodeType(node.kind)];
  const data: CanvasNodeData = { graphNode: node };
  const props = { id: node.id, type: flowNodeType(node.kind), data, selected: false } as unknown as NodeProps;
  const card = mount(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  return card.querySelector('.node-chip')?.textContent ?? undefined;
}

beforeEach(() => {
  app.selectedNodeId = 'skill:changelog';
  app.graph = specToGraph(specOf([{ registry: 'changelog' }]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
  catalogs.skills = { data: catalogs.skills.data, error: undefined, loading: false };
});

// Source option indexes: 1 = Folder, 2 = Registry, 3 = Written here.
describe('skill Inspector: Source switch', () => {
  it('replaces the item with the folder form', () => {
    renderInspector();
    choose('node-skill-source', '1');
    expect(item()).toStrictEqual({ dir: '' });
  });

  it('replaces the item with the registry form', () => {
    useSkill([{ dir: 'skills/tone' }], 'skill:tone');
    renderInspector();
    choose('node-skill-source', '2');
    expect(item()).toStrictEqual({ registry: '' });
  });

  it('seeds the inline name from the current node name', () => {
    useSkill([{ dir: 'skills/tone' }], 'skill:tone');
    renderInspector();
    choose('node-skill-source', '3');
    expect(item()).toStrictEqual({ inline: { name: 'tone', description: '', content: '' } });
  });

  it('seeds the inline name "skill" when there is no name to keep', () => {
    useSkill([{ dir: '' }], 'skill:new');
    renderInspector();
    choose('node-skill-source', '3');
    expect(item()).toStrictEqual({ inline: { name: 'skill', description: '', content: '' } });
  });
});

describe('skill Inspector: folder', () => {
  it('writes the folder path and flags one outside the agent folder', () => {
    useSkill([{ dir: 'skills/review' }], 'skill:review');
    renderInspector();
    type('node-skill-dir', '../escape');
    flush();
    expect(container.textContent).toContain('Use a folder inside the agent folder');
    type('node-skill-dir', 'skills/checklist');
    expect(item()).toStrictEqual({ dir: 'skills/checklist' });
  });
});

describe('skill Inspector: registry', () => {
  it('writes the picked registry name', () => {
    useSkill([{ registry: '' }], 'skill:new');
    renderInspector();
    choose('node-skill-registry', 'code-review');
    expect(item()).toStrictEqual({ registry: 'code-review' });
  });

  it('shows the picked entry\'s description as help', () => {
    renderInspector();
    expect(container.textContent).toContain('Writes the changelog');
  });

  it('shows the free input for a name the catalog does not list', () => {
    useSkill([{ registry: 'house-style' }], 'skill:house-style');
    renderInspector();
    expect(field('node-skill-registry-other')).not.toBeNull();
    type('node-skill-registry-other', 'other-skill');
    expect(item()).toStrictEqual({ registry: 'other-skill' });
  });

  it('flags an empty registry name', () => {
    useSkill([{ registry: '' }], 'skill:new');
    renderInspector();
    expect(container.textContent).toContain('Pick a skill');
  });
});

describe('skill Inspector: inline', () => {
  it('writes the name, description and content through', () => {
    useSkill([{ inline: { name: 'tone', description: 'd', content: 'c' } }], 'skill:tone');
    renderInspector();
    type('node-skill-name', 'voice');
    expect(inline().name).toBe('voice');
    type('node-skill-description', 'How we write to customers');
    expect(inline().description).toBe('How we write to customers');
    type('node-skill-content', '# Voice\nBe brief and kind.');
    expect(inline().content).toBe('# Voice\nBe brief and kind.');
  });

  it('flags a name outside the skill-name pattern', () => {
    useSkill([{ inline: { name: 'Bad Name', description: 'd', content: 'c' } }], 'skill:Bad Name');
    renderInspector();
    expect(container.textContent).toContain('Use lower-case letters, digits, dash or underscore');
  });

  it('flags an empty description and empty content', () => {
    useSkill([{ inline: { name: 'tone', description: '', content: '' } }], 'skill:tone');
    renderInspector();
    expect(container.textContent).toContain('The model reads this to decide when to load the skill');
    expect(container.textContent).toContain("Write the skill's instructions");
  });
});

describe('skill card', () => {
  it('renders the worked example\'s three nodes with the listed chips', () => {
    const graph = specToGraph(
      specOf([
        { dir: 'skills/code-review' },
        { registry: 'changelog' },
        { inline: { name: 'tone', description: 'How we write', content: '# Tone' } } as SkillRef,
      ]),
    );
    const chips = graph.nodes.filter((n) => n.kind === 'skill').map((n) => cardChip(n));
    expect(chips).toEqual(['folder', 'registry', 'inline']);
  });
});
