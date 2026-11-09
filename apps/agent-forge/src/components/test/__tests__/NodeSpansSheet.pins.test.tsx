import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import type { AgentRunStatusPayload, ChatMessage, SpanEvent, ToolPin } from '../../../../shared/wireTypes';
import type { TraceViewerProps } from '../../../ui/run/TraceViewer';
import type { ObserveObservationRow } from '../../../observe/types';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';

const state = vi.hoisted(() => ({
  spansNodeId: undefined as string | undefined,
  spans: [] as SpanEvent[],
  runStatus: undefined as AgentRunStatusPayload | undefined,
  chatMessages: [] as ChatMessage[],
  pins: [] as ToolPin[],
  closeNodeSpans: vi.fn(),
  togglePin: vi.fn(),
  clearPins: vi.fn(),
  isPinned: vi.fn((_pin: ToolPin) => false),
  runFromHere: vi.fn(),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
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
    chat: { sessionId: 'sess', messages: state.chatMessages },
    pins: state.pins,
    togglePin: state.togglePin,
    clearPins: state.clearPins,
    isPinned: state.isPinned,
    runFromHere: state.runFromHere,
  }),
}));

const viewer = vi.hoisted(() => ({ props: undefined as TraceViewerProps | undefined }));
vi.mock('../../../ui/run/TraceViewer', () => ({
  TraceViewer: (props: TraceViewerProps) => {
    viewer.props = props;
    return <div className="trace-viewer-mock" />;
  },
}));

import { NodeSpansSheet } from '../NodeSpansSheet';

function toolSpan(id: string, withResult = true): SpanEvent {
  return {
    id,
    name: `execute_tool http`,
    startTime: 1,
    attributes: {
      'lousho.node.id': 'tool:http',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'http',
      'gen_ai.tool.call.arguments': '{"url":"https://x"}',
      ...(withResult ? { 'gen_ai.tool.call.result': '{"ok":true}' } : {}),
    },
  };
}

const userMsg = (content: string): ChatMessage => ({
  id: `u-${content}`,
  role: 'user',
  content,
  timestamp: '2024-01-01T00:00:00Z',
});

function toolRow(obsId: string): ObserveObservationRow {
  return { obs_id: obsId, kind: 'tool' } as ObserveObservationRow;
}

/** Render the sheet for the tool node, then re-mount just the row action it produced. */
function renderRowAction(span: SpanEvent = toolSpan('s1'), row: ObserveObservationRow = toolRow('s1')): HTMLDivElement {
  state.spansNodeId = 'tool:http';
  state.spans = [span];
  state.chatMessages = [userMsg('hi')];
  render(<NodeSpansSheet />);
  const action = viewer.props!.rowAction!(row);
  return render(<>{action}</>);
}

const footerButton = (text: string) =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('.node-spans-footer button')).find(
    (b) => b.textContent?.trim() === text
  );

describe('NodeSpansSheet pins (T04)', () => {
  beforeEach(() => {
    state.spansNodeId = undefined;
    state.spans = [];
    state.runStatus = undefined;
    state.chatMessages = [];
    state.pins = [];
    state.closeNodeSpans = vi.fn();
    state.togglePin = vi.fn();
    state.clearPins = vi.fn();
    state.isPinned = vi.fn((_pin: ToolPin) => false);
    state.runFromHere = vi.fn();
    viewer.props = undefined;
  });

  it('offers a "Pin this result" toggle on tool rows and calls togglePin with the span’s pin', () => {
    const host = renderRowAction();
    const button = host.querySelector<HTMLButtonElement>('.node-pin-toggle')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toContain('Pin this result');
    act(() => button.click());
    expect(state.togglePin).toHaveBeenCalledWith({
      nodeId: 'tool:http',
      toolName: 'http',
      args: { url: 'https://x' },
      result: { ok: true },
    });
  });

  it('disables the toggle with an explanatory title when the span recorded no result', () => {
    const host = renderRowAction(toolSpan('s1', false));
    const button = host.querySelector<HTMLButtonElement>('.node-pin-toggle')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/did not record/);
    act(() => button.click());
    expect(state.togglePin).not.toHaveBeenCalled();
  });

  it('shows "Unpin" with aria-pressed for an already pinned call', () => {
    state.isPinned = vi.fn((_pin: ToolPin) => true);
    const host = renderRowAction();
    const button = host.querySelector<HTMLButtonElement>('.node-pin-toggle')!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toContain('Unpin');
  });

  it('footer shows the pinned count, clears pins, and runs from here', () => {
    state.pins = [{ nodeId: 'tool:http', toolName: 'http', result: { ok: true } }];
    state.spansNodeId = 'tool:http';
    state.spans = [toolSpan('s1')];
    state.chatMessages = [userMsg('hi')];
    render(<NodeSpansSheet />);
    expect(document.body.querySelector('.node-pins-chip')?.textContent).toBe('1 pinned');
    const clear = footerButton('Clear')!;
    act(() => clear.click());
    expect(state.clearPins).toHaveBeenCalledTimes(1);
    const run = footerButton('Run from here')!;
    expect(run.disabled).toBe(false);
    act(() => run.click());
    expect(state.runFromHere).toHaveBeenCalledTimes(1);
  });

  it('disables "Run from here" without a user message', () => {
    state.spansNodeId = 'tool:http';
    state.spans = [toolSpan('s1')];
    state.chatMessages = [];
    render(<NodeSpansSheet />);
    const run = footerButton('Run from here')!;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe('Send a message first');
    act(() => run.click());
    expect(state.runFromHere).not.toHaveBeenCalled();
  });

  it('disables "Run from here" while a run is live', () => {
    state.spansNodeId = 'tool:http';
    state.spans = [toolSpan('s1')];
    state.chatMessages = [userMsg('hi')];
    state.runStatus = { agentId: 'a', status: 'running', updatedAt: '' } as AgentRunStatusPayload;
    render(<NodeSpansSheet />);
    const run = footerButton('Run from here')!;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe('Wait for the current run to finish');
  });

  it('hides pin controls on non-tool nodes', () => {
    state.spansNodeId = 'model';
    state.spans = [toolSpan('s1')];
    state.chatMessages = [userMsg('hi')];
    render(<NodeSpansSheet />);
    expect(document.body.querySelector('.node-pins-chip')).toBeNull();
    expect(footerButton('Run from here')).toBeUndefined();
  });
});
