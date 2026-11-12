import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasLayout } from '../../../shared/wireTypes';
import { graphToSpec } from '../../graph/v2/graphToSpec';
import { specToGraph } from '../../graph/v2/specToGraph';
import { cleanup, render } from '../../ui/__tests__/render';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';

const CURRENT = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'x',
  tools: [{ builtin: 'http' }],
} as unknown as AgentSpecV2;

const PROPOSED = { ...CURRENT, tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }] } as unknown as AgentSpecV2;

const mocks = vi.hoisted(() => ({
  doc: {} as Record<string, unknown>,
  saveVersion: vi.fn(),
}));

vi.mock('../useAgentDocument', () => ({ useAgentDocument: () => mocks.doc }));
vi.mock('../useAgentStream', () => ({
  useAgentStatuses: () => ({}),
  // The real stream's chat/runStatus/feed setters - usePins reads
  // `chat.messages` while rendering, so the mock must carry the shape.
  useAgentStream: () => ({
    chat: { sessionId: undefined, messages: [] },
    runStatus: undefined,
    setLogs: vi.fn(),
    setSpans: vi.fn(),
    setNodeStates: vi.fn(),
  }),
}));
vi.mock('../useAgentControls', () => ({
  useRunControls: () => ({}),
  useChatControls: () => ({}),
  useActiveProfile: () => ({ activeProfile: undefined, refreshActiveProfile: vi.fn() }),
}));
vi.mock('../../runtime/runtimeClient', () => ({ runtimeClient: { saveVersion: mocks.saveVersion } }));
vi.mock('../../persistence/HttpAgentStore', () => ({ HttpAgentStore: class {} }));

import { AppStateProvider, useAppState } from '../AppState';

type State = ReturnType<typeof useAppState>;

function Probe({ into }: { into: { current: State } }) {
  into.current = useAppState();
  return null;
}

function mount(): { current: State } {
  const result = { current: undefined as unknown as State };
  render(
    <AppStateProvider>
      <Probe into={result} />
    </AppStateProvider>
  );
  return result;
}

beforeEach(() => {
  const graph = specToGraph(CURRENT);
  const derived = graphToSpec(graph);
  mocks.saveVersion.mockReset();
  mocks.doc = {
    agentId: 'bot',
    spec: CURRENT,
    graph,
    layout: derived.layout as CanvasLayout,
    nodeIdMap: derived.nodeIdMap,
    agents: [],
    save: vi.fn(async () => undefined),
    switchAgent: vi.fn(async () => undefined),
    createAgent: vi.fn(async () => undefined),
    renameAgent: vi.fn(async () => undefined),
    deleteAgent: vi.fn(async () => undefined),
  };
});

describe('AppStateProvider proposal overlay', () => {
  it('shows the merged graph while a proposal is set and the plain graph after hiding it', () => {
    const result = mount();
    expect(result.current.proposal).toBeUndefined();
    expect(result.current.displayGraph).toBe(mocks.doc.graph);

    act(() => result.current.showProposal({ proposalId: 'p1', spec: PROPOSED }));
    expect(result.current.proposal?.proposalId).toBe('p1');
    expect(result.current.displayGraph.nodes.find((n) => n.id === 'tool:web_fetch')?.proposed).toBe('add');

    act(() => result.current.hideProposal());
    expect(result.current.proposal).toBeUndefined();
    expect(result.current.displayGraph).toBe(mocks.doc.graph);
  });

  it.each([
    ['switchAgent', (s: State) => s.switchAgent('other'), ['other']],
    ['createAgent', (s: State) => s.createAgent('new', 'blank' as never), ['new', 'blank']],
    ['renameAgent', (s: State) => s.renameAgent('bot', 'bot2'), ['bot', 'bot2']],
    ['deleteAgent', (s: State) => s.deleteAgent('bot'), ['bot']],
  ] as const)('%s clears the proposal and delegates to the document', async (name, call, args) => {
    const result = mount();
    act(() => result.current.showProposal({ proposalId: 'p1', spec: PROPOSED }));
    await act(async () => {
      await call(result.current);
    });
    expect(result.current.proposal).toBeUndefined();
    expect(mocks.doc[name]).toHaveBeenCalledWith(...args);
  });

  it('exposes a dev-only window trigger that shows a proposal and is removed on unmount', () => {
    const result = mount();
    expect(typeof window.__forgeShowProposal).toBe('function');
    act(() => window.__forgeShowProposal?.(PROPOSED));
    expect(result.current.proposal).toEqual({ proposalId: 'dev', spec: PROPOSED });
    cleanup();
    expect(window.__forgeShowProposal).toBeUndefined();
  });
});

describe('AppStateProvider saveVersion', () => {
  it('saves, records the latest version and returns the item only when created', async () => {
    const result = mount();
    expect(result.current.latestVersion).toBeNull();

    mocks.saveVersion.mockResolvedValueOnce({ item: { version: 3 }, created: true });
    let saved: unknown;
    await act(async () => {
      saved = await result.current.saveVersion();
    });
    expect(mocks.doc.save).toHaveBeenCalledTimes(1);
    expect(mocks.saveVersion).toHaveBeenCalledWith('bot');
    expect(saved).toEqual({ version: 3 });
    expect(result.current.latestVersion).toBe(3);

    mocks.saveVersion.mockResolvedValueOnce({ item: { version: 3 }, created: false });
    await act(async () => {
      saved = await result.current.saveVersion();
    });
    expect(saved).toBeUndefined();
    expect(result.current.latestVersion).toBe(3);
  });
});
