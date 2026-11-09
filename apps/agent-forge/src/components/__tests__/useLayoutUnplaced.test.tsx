import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, rerender } from '../../ui/__tests__/render';
import { useLayoutUnplaced } from '../CanvasArea';
import { setCollapsed } from '../../graph/v2/mutations';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { Graph } from '../../graph/v2/types';

/**
 * `useLayoutUnplaced` (C17): lays out `graph.unplaced` once every visible
 * node is measured, merges positions onto the LATEST graph without
 * dirtying, cancels only on agent switch/unmount, and retries after a
 * failure. `autoLayout` and `useToast` are mocked; `applyLayoutResult`
 * stays real so the merge is exercised end to end.
 */

const mocks = vi.hoisted(() => ({
  autoLayout: vi.fn(),
  show: vi.fn(),
}));

vi.mock('../../canvas/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../canvas/layout')>();
  return { ...actual, autoLayout: mocks.autoLayout };
});

vi.mock('../../ui/Toast', () => ({
  useToast: () => ({ show: mocks.show, dismiss: vi.fn() }),
}));

const SPEC = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'hi',
  tools: [{ builtin: 'http' }],
  triggers: [{ id: 't1', type: 'chat' }],
  subagents: {
    research: {
      inline: {
        name: 'research',
        description: 'd',
        model: 'mock/mock-1',
        instructions: 'x',
        tools: [{ builtin: 'web-fetch' }],
      },
    },
  },
} as const;

const GROUP_ID = 'sub:research';
const GROUP_TOOL_ID = 'sub:research/tool:web-fetch';

type Measured = Record<string, { width: number; height: number }>;
type SetGraph = (updater: (g: Graph) => Graph, options?: { dirty?: boolean }) => void;

/** A graph whose only unplaced node is `trigger:t1`. */
function graphA(collapsed = false): Graph {
  const g = specToGraph(SPEC as never, {
    schemaVersion: 1,
    nodes: {
      agent: { x: 40, y: 60 },
      'tool:http': { x: 300, y: 60 },
      [GROUP_ID]: { x: 560, y: 60 },
      [GROUP_TOOL_ID]: { x: 20, y: 100 },
    },
    notes: [],
  });
  return collapsed ? setCollapsed(g, GROUP_ID, true) : g;
}

function measuredOf(g: Graph, skip: string[] = []): Measured {
  return Object.fromEntries(g.nodes.filter((n) => !skip.includes(n.id)).map((n) => [n.id, { width: 208, height: 96 }]));
}

/** What `autoLayout(g, 'unplaced')` would return: trigger moved, unplaced cleared. */
function laidOutVersion(g: Graph): Graph {
  return {
    ...g,
    unplaced: [],
    nodes: g.nodes.map((n) => (n.id === 'trigger:t1' ? { ...n, position: { x: 640, y: 480 } } : n)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let current: Graph;
let applied: Graph | undefined;
let appliedOptions: { dirty?: boolean } | undefined;

const setGraph: SetGraph = (updater, options) => {
  current = updater(current);
  applied = current;
  appliedOptions = options;
};

function Probe({ agentId, graph, measured }: { agentId: string; graph: Graph | undefined; measured: Measured }) {
  useLayoutUnplaced(agentId, graph, measured, setGraph);
  return null;
}

const positionOf = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)?.position;

beforeEach(() => {
  mocks.autoLayout.mockReset();
  mocks.show.mockReset();
  applied = undefined;
  appliedOptions = undefined;
});

describe('useLayoutUnplaced', () => {
  it('waits for every visible node to be measured, then merges positions without dirtying', async () => {
    const g = graphA();
    current = g;
    const d = deferred<Graph>();
    mocks.autoLayout.mockReturnValue(d.promise);

    const measured = measuredOf(g);
    render(<Probe agentId="a" graph={g} measured={{}} />);
    expect(mocks.autoLayout).not.toHaveBeenCalled();

    rerender(<Probe agentId="a" graph={g} measured={measured} />);
    expect(mocks.autoLayout).toHaveBeenCalledTimes(1);
    expect(mocks.autoLayout).toHaveBeenCalledWith(g, 'unplaced', measured);

    // A dep change mid-flight must not cancel the run.
    const edited = { ...current, viewport: { x: 1, y: 2, zoom: 1 } };
    current = edited;
    rerender(<Probe agentId="a" graph={edited} measured={{ ...measured }} />);

    await act(async () => {
      d.resolve(laidOutVersion(g));
    });
    expect(applied).toBeDefined();
    expect(appliedOptions).toEqual({ dirty: false });
    expect(positionOf(applied!, 'trigger:t1')).toStrictEqual({ x: 640, y: 480 });
    expect(applied!.unplaced).toEqual([]);
    // Still exactly one layout run for this agent.
    rerender(<Probe agentId="a" graph={applied!} measured={measured} />);
    expect(mocks.autoLayout).toHaveBeenCalledTimes(1);
  });

  it('does not let an unmeasured node hidden under a collapsed group block the layout', async () => {
    const g = graphA(true);
    current = g;
    const d = deferred<Graph>();
    mocks.autoLayout.mockReturnValue(d.promise);

    render(<Probe agentId="a" graph={g} measured={measuredOf(g, [GROUP_TOOL_ID])} />);
    expect(mocks.autoLayout).toHaveBeenCalledTimes(1);
    await act(async () => {
      d.resolve(laidOutVersion(g));
    });
    expect(positionOf(applied!, 'trigger:t1')).toStrictEqual({ x: 640, y: 480 });
  });

  it('keeps a position the user changed while elkjs ran', async () => {
    const g = graphA();
    current = g;
    const d = deferred<Graph>();
    mocks.autoLayout.mockReturnValue(d.promise);
    render(<Probe agentId="a" graph={g} measured={measuredOf(g)} />);

    // The layout moved tool:http too, but the user dragged it after the
    // request left - the user's position wins.
    const laidOut: Graph = {
      ...g,
      unplaced: [],
      nodes: g.nodes.map((n) => {
        if (n.id === 'trigger:t1') return { ...n, position: { x: 640, y: 480 } };
        if (n.id === 'tool:http') return { ...n, position: { x: 500, y: 500 } };
        return n;
      }),
    };
    current = {
      ...current,
      nodes: current.nodes.map((n) => (n.id === 'tool:http' ? { ...n, position: { x: 3, y: 4 } } : n)),
    };
    await act(async () => {
      d.resolve(laidOut);
    });
    expect(positionOf(applied!, 'trigger:t1')).toStrictEqual({ x: 640, y: 480 });
    expect(positionOf(applied!, 'tool:http')).toStrictEqual({ x: 3, y: 4 });
  });

  it('drops the result when the agent switches mid-flight, and runs for the new agent', async () => {
    const g = graphA();
    current = g;
    const first = deferred<Graph>();
    const second = deferred<Graph>();
    mocks.autoLayout.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const measured = measuredOf(g);

    render(<Probe agentId="a" graph={g} measured={measured} />);
    expect(mocks.autoLayout).toHaveBeenCalledTimes(1);

    rerender(<Probe agentId="b" graph={g} measured={measured} />);
    expect(mocks.autoLayout).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(laidOutVersion(g));
    });
    expect(applied).toBeUndefined();

    await act(async () => {
      second.resolve(laidOutVersion(g));
    });
    expect(applied).toBeDefined();
    expect(appliedOptions).toEqual({ dirty: false });
  });

  it('toasts on failure and retries on the next measured/graph change', async () => {
    const g = graphA();
    current = g;
    const failing = deferred<Graph>();
    mocks.autoLayout.mockReturnValueOnce(failing.promise).mockResolvedValue(laidOutVersion(g));

    render(<Probe agentId="a" graph={g} measured={measuredOf(g)} />);
    await act(async () => {
      failing.reject(new Error('Layout timed out'));
    });
    expect(mocks.show).toHaveBeenCalledWith({ message: "Couldn't lay out the canvas.", tone: 'error' });
    expect(applied).toBeUndefined();

    rerender(<Probe agentId="a" graph={g} measured={{ ...measuredOf(g) }} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.autoLayout).toHaveBeenCalledTimes(2);
    expect(applied).toBeDefined();
  });
});
