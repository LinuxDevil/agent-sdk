import { describe, expect, it } from 'vitest';

import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveObservationRow } from '../../../observe/types';
import { TraceHeader } from '../TraceHeader';

const T0 = 1_700_000_000_000;

function obs(over: Partial<ObserveObservationRow> & { obs_id: string }): ObserveObservationRow {
  return {
    trace_id: 't1',
    session_id: null,
    agent_id: null,
    parent_obs_id: null,
    kind: 'agent',
    name: over.obs_id,
    start: T0,
    end: T0 + 100,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...over,
  };
}

const chips = (c: HTMLElement) => [...c.querySelectorAll('.header-card-fact')].map((el) => el.getAttribute('title'));

const mount = (rows: ObserveObservationRow[]) =>
  render(
    <ToastProvider>
      <TraceHeader root={rows[0]!} observations={rows} agentName={undefined} now={T0 + 1_000} />
    </ToastProvider>,
  );

describe('TraceHeader', () => {
  it('leaves out the tokens, cost and model chips when the trace has none (no "-" chips)', () => {
    const c = mount([obs({ obs_id: 'root' }), obs({ obs_id: 'tool', parent_obs_id: 'root', kind: 'tool' })]);
    expect(chips(c)).toEqual(['Duration', 'Start']);
    expect(c.querySelector('.header-card-facts')!.textContent).not.toMatch(/(^|\s)-(\s|$)/);
  });

  it('shows them once a step reports usage, cost and a model', () => {
    const c = mount([
      obs({ obs_id: 'root' }),
      obs({ obs_id: 'gen', parent_obs_id: 'root', kind: 'generation', model: 'gpt-4o', usage_input_tokens: 10, usage_output_tokens: 2, cost_usd: 0.001 }),
    ]);
    expect(chips(c)).toEqual(['Duration', 'Tokens', 'Cost', 'Model', 'Start']);
  });
});
