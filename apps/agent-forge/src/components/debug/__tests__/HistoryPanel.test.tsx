import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { HistoryList, TrajectoryCompare } from '../HistoryPanel';
import type { RunComparisonPayload, RunHistoryStep } from '../../../../shared/wireTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What `GET /runs/:id/history` returns for a run that called a tool, then answered.
const STEPS: RunHistoryStep[] = [
  {
    step: 1,
    status: 'in-progress',
    savedAt: '2026-10-01T10:00:00.000Z',
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}', result: '{"tempF":68}' }],
    tokens: 42,
    costUsd: 0.00021,
  },
  { step: 2, status: 'finished', savedAt: '2026-10-01T10:00:01.000Z', finishReason: 'stop', toolCalls: [], tokens: 30 },
];

// What `GET /runs/compare` returns for that run and a fork whose tool result was edited.
const COMPARISON: RunComparisonPayload = {
  a: [
    { text: '', tools: [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}', result: '{"tempF":68}' }] },
    { text: 'It is 68F in Paris.', tools: [] },
  ],
  b: [
    { text: '', tools: [{ id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}', result: '{"tempC":20}' }] },
    { text: 'It is 20C in Paris.', tools: [] },
    { text: 'Anything else?', tools: [] },
  ],
  divergedAt: 1,
  drift: [{ field: 'steps', committed: '2', current: '3' }],
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe('HistoryList (LOU-D45)', () => {
  it('renders a row per step with status, finish reason, tool calls, tokens and cost', () => {
    const container = render(<HistoryList steps={STEPS} onReplay={() => undefined} />);
    const rows = [...container.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].slice(0, 6).map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ['1', 'in-progress', 'tool_calls', 'get_weather', '42', '$0.0002'],
      ['2', 'finished', 'stop', '-', '30', '-'],
    ]);
  });

  it('"Edit and replay from here" hands its step to onReplay', () => {
    const onReplay = vi.fn();
    const container = render(<HistoryList steps={STEPS} onReplay={onReplay} />);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Edit and replay from here', 'Edit and replay from here']);
    act(() => buttons[1].click());
    expect(onReplay).toHaveBeenCalledWith(STEPS[1]);
  });
});

describe('TrajectoryCompare (LOU-D45)', () => {
  it('shows both runs side by side, highlights the turn they diverged at and lists the drift', () => {
    const container = render(<TrajectoryCompare comparison={COMPARISON} a="weather" b="weather.fork-1" />);
    expect([...container.querySelectorAll('.traj-head b')].map((b) => b.textContent)).toEqual(['weather', 'weather.fork-1']);

    const rows = [...container.querySelectorAll('.traj-row:not(.traj-head)')];
    expect(rows).toHaveLength(3);
    expect(rows[0].classList.contains('diverged')).toBe(true);
    expect(rows[0].textContent).toContain('1 diverged');
    expect(rows[0].textContent).toContain('{"tempF":68}');
    expect(rows[0].textContent).toContain('{"tempC":20}');
    expect(rows[1].classList.contains('diverged')).toBe(false);
    expect(rows[2].querySelector('.traj-missing')?.textContent).toBe('-'); // the original has no third turn

    expect(container.querySelector('.traj-drift')?.textContent).toBe('steps: 2 -> 3');
  });

  it('says so when the runs did not drift', () => {
    const same: RunComparisonPayload = { a: COMPARISON.a, b: COMPARISON.a, drift: [] };
    const container = render(<TrajectoryCompare comparison={same} a="a" b="b" />);
    expect(container.querySelector('.diverged')).toBeNull();
    expect(container.querySelector('.traj-drift')?.textContent).toBe('No drift');
  });
});
