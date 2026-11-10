import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import type {
  AgentRunStatusPayload,
  RunComparisonPayload,
  RunHistoryStep,
  SpanEvent,
  StreamMessage,
} from '../../../../shared/wireTypes';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';

const state = vi.hoisted(() => ({
  spansNodeId: undefined as string | undefined,
  spans: [] as SpanEvent[],
  runStatus: undefined as AgentRunStatusPayload | undefined,
  closeNodeSpans: vi.fn(),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    agentId: 'agent1',
    spansNodeId: state.spansNodeId,
    closeNodeSpans: state.closeNodeSpans,
    displayGraph: specToGraph({
      version: 2,
      name: 'a',
      model: 'mock/mock-1',
      instructions: 'x',
      tools: [{ builtin: 'http' }],
    } as unknown as AgentSpecV2),
    spans: state.spans,
    runStatus: state.runStatus,
  }),
}));

const api = vi.hoisted(() => ({
  runHistory: vi.fn(),
  forkRun: vi.fn(),
  compareRuns: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

import { NodeSpansSheet } from '../NodeSpansSheet';

// The checkpoint history `GET /runs/agent1/history` returns: `call_1` came from step 1.
const STEPS: RunHistoryStep[] = [
  {
    step: 1,
    status: 'in-progress',
    savedAt: '2026-10-01T10:00:00.000Z',
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}', result: '{"tempF":68}' }],
  },
  { step: 2, status: 'finished', savedAt: '2026-10-01T10:00:01.000Z', finishReason: 'stop', toolCalls: [] },
];

const COMPARISON: RunComparisonPayload = {
  a: [{ text: '', tools: [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}', result: '{"tempF":68}' }] }],
  b: [{ text: '', tools: [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}', result: 'slow' }] }],
  divergedAt: 1,
  drift: [],
};

function toolSpan(id: string, callId: string | undefined): SpanEvent {
  return {
    id,
    name: 'execute_tool get_weather',
    startTime: 1,
    endTime: 2,
    attributes: {
      'lousho.node.id': 'tool:get_weather',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get_weather',
      ...(callId === undefined ? {} : { 'gen_ai.tool.call.id': callId }),
    },
  };
}

const sheet = () => document.body.querySelector<HTMLElement>('.sheet');
const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
const forkButton = () => button('Fork from here');
const flush = () => act(async () => {});

function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('NodeSpansSheet fork from checkpoint', () => {
  beforeEach(() => {
    state.spansNodeId = undefined;
    state.spans = [];
    state.runStatus = undefined;
    api.runHistory.mockReset().mockResolvedValue({ runId: 'agent1', steps: [] });
    api.forkRun.mockReset();
    api.compareRuns.mockReset();
    api.subscribe.mockReset().mockReturnValue(vi.fn());
  });

  it('enables "Fork from here", POSTs the fork with the edited result and shows the comparison once the fork finishes', async () => {
    api.runHistory.mockResolvedValue({ runId: 'agent1', steps: STEPS });
    api.forkRun.mockResolvedValue({
      runId: 'agent1.fork-1',
      fromStep: 1,
      status: { agentId: 'agent1.fork-1', status: 'running', updatedAt: '' } satisfies AgentRunStatusPayload,
    });
    api.compareRuns.mockResolvedValue(COMPARISON);
    state.spansNodeId = 'tool:get_weather';
    state.spans = [toolSpan('s1', 'call_1')];
    render(<NodeSpansSheet />);
    await flush();

    const fork = forkButton()!;
    expect(fork.disabled).toBe(false);
    act(() => fork.click());

    // The ReplayEditor opens with this span's call preselected and its recorded result loaded.
    const editor = sheet()!.querySelector<HTMLElement>('.replay-editor')!;
    expect(editor.textContent).toContain('Replay from step 1');
    const select = editor.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('call_1');
    const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.value).toBe('{"tempF":68}');

    act(() => typeInto(textarea, 'slow'));
    act(() => button('Fork and replay')!.click());
    await flush();

    expect(api.forkRun).toHaveBeenCalledWith('agent1', {
      fromStep: 1,
      patch: { toolResult: { toolCallId: 'call_1', result: 'slow' } },
    });
    // While the fork runs, the sheet shows the "replaying" placeholder and subscribes to the fork's stream.
    expect(sheet()!.textContent).toContain('Replaying as agent1.fork-1');
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    const [subscribedId, onMessage] = api.subscribe.mock.calls[0] as unknown as [string, (m: StreamMessage) => void];
    expect(subscribedId).toBe('agent1.fork-1');

    // The fork leaving 'running' pulls the comparison into view.
    act(() => {
      onMessage({ type: 'status', payload: { agentId: 'agent1.fork-1', status: 'done', updatedAt: '' } });
    });
    await flush();
    expect(api.compareRuns).toHaveBeenCalledWith('agent1', 'agent1.fork-1');
    expect(sheet()!.querySelector('.traj-compare')).not.toBeNull();

    // "Back to spans" restores the trace viewer.
    act(() => button('Back to spans')!.click());
    expect(sheet()!.querySelector('.run-viewer')).not.toBeNull();
  });

  it('shows the fork error inline and keeps the editor open when the fork request fails', async () => {
    api.runHistory.mockResolvedValue({ runId: 'agent1', steps: STEPS });
    api.forkRun.mockRejectedValue(new Error('no checkpoint at step 1'));
    state.spansNodeId = 'tool:get_weather';
    state.spans = [toolSpan('s1', 'call_1')];
    render(<NodeSpansSheet />);
    await flush();

    act(() => forkButton()!.click());
    act(() => button('Fork and replay')!.click());
    await flush();

    const alert = sheet()!.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain('no checkpoint at step 1');
    expect(sheet()!.querySelector('.replay-editor')).not.toBeNull();
  });

  it('disables the button with its reason when the call id matches no checkpointed step', async () => {
    api.runHistory.mockResolvedValue({ runId: 'agent1', steps: STEPS });
    state.spansNodeId = 'tool:get_weather';
    state.spans = [toolSpan('s1', 'call_9')];
    render(<NodeSpansSheet />);
    await flush();

    const fork = forkButton()!;
    expect(fork.disabled).toBe(true);
    expect(fork.title).toBe('This call has no checkpoint. Forking needs a checkpointed run of the agent.');
  });

  it('disables the button for every tool span of a run with no checkpoints (flows)', async () => {
    api.runHistory.mockResolvedValue({ runId: 'agent1', steps: [] });
    state.spansNodeId = 'tool:get_weather';
    state.spans = [toolSpan('s1', 'call_1'), toolSpan('s2', 'call_2')];
    render(<NodeSpansSheet />);
    await flush();

    // The first root span is inspected by default; select the second row to inspect it too.
    for (const obsId of ['s1', 's2']) {
      if (obsId === 's2') {
        act(() => sheet()!.querySelector<HTMLButtonElement>(`[data-obs-id="s2"] .run-row-main`)!.click());
      }
      const fork = forkButton()!;
      expect(fork.disabled).toBe(true);
      expect(fork.title).toBe('This call has no checkpoint. Forking needs a checkpointed run of the agent.');
    }
  });
});
