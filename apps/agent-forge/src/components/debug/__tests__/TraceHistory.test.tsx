import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { TraceHistory, LIVE_ENTRY } from '../TraceHistory';
import { TracePanel } from '../TracePanel';
import type { AgentRunStatusPayload, SpanEvent, TraceSummaryPayload } from '../../../../shared/wireTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listTraces: vi.fn(),
  readTrace: vi.fn(),
  appState: {} as Record<string, unknown>,
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { listTraces: mocks.listTraces, readTrace: mocks.readTrace },
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => mocks.appState }));

// What `GET /agents/:id/traces` returns for an agent that ran twice, the newer run failing.
const TRACES: TraceSummaryPayload[] = [
  {
    traceId: 'trace-new',
    name: 'invoke_agent weather',
    agent: 'weather',
    startTime: Date.parse('2026-10-02T10:05:00Z'),
    durationMs: 1650,
    status: 'error',
    modelCalls: 2,
    toolCalls: 1,
    inputTokens: 159,
    outputTokens: 32,
    costUsd: 0.000043,
  },
  {
    traceId: 'trace-old',
    name: 'invoke_agent weather',
    startTime: Date.parse('2026-10-02T10:00:00Z'),
    durationMs: 420,
    status: 'ok',
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
  },
];

// What `GET /agents/:id/traces/trace-new` returns: a root, a model call and a failed tool call.
const PAST_SPANS: SpanEvent[] = [
  { id: 'trace-new', name: 'invoke_agent weather', startTime: 1000, endTime: 2650, kind: 'internal', status: { code: 'error', message: 'boom' }, attributes: { 'gen_ai.operation.name': 'invoke_agent' } },
  { id: 'c1', parentId: 'trace-new', name: 'chat gpt-4o-mini', startTime: 1000, endTime: 1900, kind: 'client', attributes: { 'gen_ai.operation.name': 'chat' } },
  { id: 't1', parentId: 'trace-new', name: 'execute_tool get_weather', startTime: 1900, endTime: 1920, kind: 'internal', status: { code: 'error', message: 'boom' }, attributes: { 'gen_ai.operation.name': 'execute_tool' } },
];

const LIVE_SPANS: SpanEvent[] = [
  { id: 'live-root', name: 'invoke_agent live-run', startTime: 5000, attributes: {} },
];

const statusOf = (status: AgentRunStatusPayload['status']): AgentRunStatusPayload => ({ agentId: 'weather', status, updatedAt: '2026-10-02T10:00:00.000Z' });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TraceHistory (M5b)', () => {
  it('renders a row per trace with time, duration, model calls, tokens, cost and status', () => {
    const container = render(<TraceHistory traces={TRACES} selectedId="trace-old" liveActive={false} onSelect={() => undefined} />);
    const rows = [...container.querySelectorAll('[role=option]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('1.65s');
    expect(rows[0].textContent).toContain('2 model');
    expect(rows[0].textContent).toContain('159/32 tokens');
    expect(rows[0].textContent).toContain('$0.000043');
    expect(rows[0].textContent).toContain('error');
    expect(rows[1].textContent).toContain('420ms');
    expect(rows[1].textContent).toContain('-');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
  });

  it('shows the Live entry first only while a run is active', () => {
    const active = render(<TraceHistory traces={TRACES} selectedId={LIVE_ENTRY} liveActive onSelect={() => undefined} />);
    expect(active.querySelector('[role=option]')?.textContent).toContain('Live');
    act(() => root?.unmount());
    const idle = render(<TraceHistory traces={TRACES} selectedId={LIVE_ENTRY} liveActive={false} onSelect={() => undefined} />);
    expect(idle.textContent).not.toContain('Live');
  });

  it('calls onSelect with the trace id, and explains an empty list', () => {
    const onSelect = vi.fn();
    const container = render(<TraceHistory traces={TRACES} selectedId={LIVE_ENTRY} liveActive={false} onSelect={onSelect} />);
    act(() => (container.querySelectorAll('[role=option]')[1] as HTMLElement).click());
    expect(onSelect).toHaveBeenCalledWith('trace-old');
    act(() => root?.unmount());
    const empty = render(<TraceHistory traces={[]} selectedId={LIVE_ENTRY} liveActive={false} onSelect={onSelect} />);
    expect(empty.textContent).toContain('No saved traces yet');
  });
});

describe('TracePanel with trace history (M5b)', () => {
  beforeEach(() => {
    mocks.listTraces.mockResolvedValue(TRACES);
    mocks.readTrace.mockResolvedValue(PAST_SPANS);
    mocks.appState.agentId = 'weather';
    mocks.appState.spans = [];
    mocks.appState.runStatus = statusOf('stopped');
    mocks.appState.highlightedNodeId = undefined;
    mocks.appState.setHighlightedNodeId = vi.fn();
    mocks.appState.setDrawerTab = vi.fn();
    mocks.appState.graph = { nodes: [], edges: [] };
  });

  it('lists the agent traces and shows the selected one in the waterfall with kind and error status', async () => {
    const container = render(<TracePanel />);
    await flush();
    expect(mocks.listTraces).toHaveBeenCalledWith('weather');
    expect(container.querySelectorAll('[role=option]')).toHaveLength(2);

    act(() => (container.querySelectorAll('[role=option]')[0] as HTMLElement).click());
    await flush();
    expect(mocks.readTrace).toHaveBeenCalledWith('weather', 'trace-new');
    const rows = [...container.querySelectorAll('.trace-row')];
    expect(rows.map((row) => row.querySelector('.trace-name')?.textContent)).toEqual([
      'invoke_agent weather',
      'chat gpt-4o-mini',
      'execute_tool get_weather',
    ]);
    expect(rows[1].querySelector('.trace-kind')?.textContent).toBe('client');
    expect(rows[2].classList.contains('trace-row-error')).toBe(true);
    expect(rows[2].querySelector('.trace-bar')?.classList.contains('error')).toBe(true);
    expect(rows[1].classList.contains('trace-row-error')).toBe(false);
  });

  it('shows the live spans under a Live entry while a run is active', async () => {
    mocks.appState.runStatus = statusOf('running');
    mocks.appState.spans = LIVE_SPANS;
    const container = render(<TracePanel />);
    await flush();
    const options = [...container.querySelectorAll('[role=option]')];
    expect(options[0].textContent).toContain('Live');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.trace-name')?.textContent).toBe('invoke_agent live-run');
    expect(mocks.listTraces).not.toHaveBeenCalled();
  });

  it('reloads the list when a run ends', async () => {
    mocks.appState.runStatus = statusOf('running');
    const container = render(<TracePanel />);
    await flush();
    expect(mocks.listTraces).not.toHaveBeenCalled();

    mocks.appState.runStatus = statusOf('stopped');
    act(() => root?.render(<TracePanel />));
    await flush();
    expect(mocks.listTraces).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[role=option]')).toHaveLength(2);
  });

  it('says why the list is empty when the server cannot be read', async () => {
    mocks.listTraces.mockRejectedValue(new Error('No saved agent'));
    const container = render(<TracePanel />);
    await flush();
    expect(container.textContent).toContain('No saved agent');
  });
});
