import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../../__tests__/render';

import type { ObserveObservationRow, ObserveScoreRow } from '../../../observe/types';
import { RunInspector } from '../RunInspector';
import { RunTree } from '../RunTree';
import { TraceViewer } from '../TraceViewer';
import { Waterfall } from '../Waterfall';

const T0 = 1_700_000_000_000;

function obs(over: Partial<ObserveObservationRow> & { obs_id: string }): ObserveObservationRow {
  return {
    trace_id: 'tr1',
    session_id: null,
    agent_id: null,
    parent_obs_id: null,
    kind: 'span',
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

function score(over: Partial<ObserveScoreRow> & { score_id: string }): ObserveScoreRow {
  return { trace_id: 'tr1', obs_id: null, name: 'quality', value: 1, source: 'human', comment: null, agent_id: null, created_at: T0, ...over };
}

const LONG_NAME = 'a-really-long-step-name-that-must-never-be-clipped-by-the-tree-row-'.repeat(3);

const TRACE: ObserveObservationRow[] = [
  obs({ obs_id: 'root', kind: 'span', name: 'agent run', start: T0, end: T0 + 2000 }),
  obs({
    obs_id: 'gen/1',
    parent_obs_id: 'root',
    kind: 'generation',
    name: LONG_NAME,
    start: T0 + 100,
    end: T0 + 900,
    model: 'gpt-4o-mini',
    usage_input_tokens: 1200,
    usage_output_tokens: 34,
  }),
  obs({ obs_id: 'tool1', parent_obs_id: 'gen/1', kind: 'tool', name: 'get_weather', start: T0 + 950, end: T0 + 1500 }),
  obs({ obs_id: 'ev1', parent_obs_id: 'root', kind: 'event', name: 'checkpoint', start: T0 + 1600, end: T0 + 1600 }),
  obs({ obs_id: 'odd', parent_obs_id: 'root', kind: 'mystery', name: 'custom', start: T0 + 1700, end: T0 + 1800 }),
];

const row = (c: HTMLElement, id: string) => c.querySelector(`[data-obs-id="${id}"]`) as HTMLElement;

describe('RunTree', () => {
  it('indents rows by depth in depth-first order', () => {
    const c = render(<RunTree observations={TRACE} onSelect={() => {}} now={T0 + 5000} />);
    const rows = [...c.querySelectorAll<HTMLElement>('.run-tree-row')];
    expect(rows.map((r) => r.dataset.obsId)).toEqual(['root', 'gen/1', 'tool1', 'ev1', 'odd']);
    expect(rows.map((r) => r.dataset.depth)).toEqual(['0', '1', '2', '1', '1']);
    const pad = (id: string) => parseInt((row(c, id).querySelector('.run-row-main') as HTMLElement).style.paddingLeft, 10);
    expect(pad('gen/1')).toBeGreaterThan(pad('root'));
    expect(pad('tool1')).toBeGreaterThan(pad('gen/1'));
  });

  it('shows the full name with a title tooltip, kind icon, duration, tokens and model chip', () => {
    const c = render(<RunTree observations={TRACE} onSelect={() => {}} />);
    const gen = row(c, 'gen/1');
    const name = gen.querySelector('.run-name') as HTMLElement;
    expect(name.textContent).toBe(LONG_NAME);
    expect(name.title).toBe(LONG_NAME);
    expect(gen.querySelector('.run-kind-generation svg')).not.toBeNull();
    expect(gen.querySelector('.run-dur')?.textContent).toBe('800ms');
    expect(gen.querySelector('.run-tokens')?.textContent).toBe('1,234 tok');
    expect(gen.querySelector('.run-model-chip')?.textContent).toBe('gpt-4o-mini');
    expect(row(c, 'tool1').querySelector('.run-kind-tool')).not.toBeNull();
    expect(row(c, 'ev1').querySelector('.run-kind-event')).not.toBeNull();
    expect(row(c, 'odd').querySelector('.run-kind-other svg')).not.toBeNull();
    expect(row(c, 'root').querySelector('.run-tokens')).toBeNull();
    expect(row(c, 'root').querySelector('.run-model-chip')).toBeNull();
  });

  it('links generations (only) to the Playground', () => {
    const c = render(<RunTree observations={TRACE} onSelect={() => {}} />);
    const links = [...c.querySelectorAll<HTMLAnchorElement>('.run-tree .run-playground-link')];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('#/playground?fromObs=gen%2F1');
    expect(links[0]!.textContent).toBe('Open in Playground');
  });

  it('marks an error node red and an open node as running', () => {
    const rows = [
      obs({ obs_id: 'root', end: null, status: null }),
      obs({ obs_id: 'bad', parent_obs_id: 'root', status: 'error', start: T0 + 10, end: T0 + 20 }),
    ];
    const c = render(<RunTree observations={rows} onSelect={() => {}} now={T0 + 1500} />);
    expect(row(c, 'bad').classList.contains('run-row-error')).toBe(true);
    expect(row(c, 'bad').querySelector('.status-pill.pill-error')).not.toBeNull();
    expect(row(c, 'root').classList.contains('run-row-error')).toBe(false);
    expect(row(c, 'root').querySelector('.run-dur-live')?.textContent).toBe('1.5s running');
    expect(row(c, 'root').querySelector('.status-pill.pill-running')).not.toBeNull();
  });

  it('calls onSelect on click and keyboard activation via buttons', () => {
    const onSelect = vi.fn();
    const c = render(<RunTree observations={TRACE} selectedObsId="tool1" onSelect={onSelect} />);
    const main = row(c, 'gen/1').querySelector('button.run-row-main') as HTMLButtonElement;
    act(() => main.click());
    expect(onSelect).toHaveBeenCalledWith('gen/1');
    expect(row(c, 'tool1').classList.contains('selected')).toBe(true);
    expect(row(c, 'tool1').querySelector('[aria-current="true"]')).not.toBeNull();
  });

  it('virtualises above 500 observations and renders plain rows at 500', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => obs({ obs_id: `o${i}`, start: T0 + i, end: T0 + i + 1 }));
    let c = render(<RunTree observations={many(500)} onSelect={() => {}} />);
    expect(c.querySelector('.run-virtual')).toBeNull();
    expect(c.querySelectorAll('.run-tree-row')).toHaveLength(500);
    c = render(<RunTree observations={many(501)} onSelect={() => {}} />);
    expect(c.querySelector('.run-virtual')).not.toBeNull();
    const rendered = c.querySelectorAll('.run-tree-row').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    // Virtualised rows keep the full name in a tooltip.
    expect((c.querySelector('.run-row-virtual .run-name') as HTMLElement).title).toBe('o0');
  });
});

describe('Waterfall', () => {
  it('draws a time axis relative to the trace start', () => {
    const c = render(<Waterfall observations={TRACE} onSelect={() => {}} />);
    const ticks = [...c.querySelectorAll('.run-axis-tick')].map((t) => t.textContent);
    expect(ticks[0]).toBe('0ms');
    expect(ticks).toContain('500ms');
    expect(ticks).toContain('1s');
    expect(ticks.at(-1)).toBe('2s');
  });

  it('offsets and sizes one bar per row by start/end', () => {
    const c = render(<Waterfall observations={TRACE} onSelect={() => {}} />);
    expect(c.querySelectorAll('.run-wf-bar')).toHaveLength(TRACE.length);
    const bar = row(c, 'gen/1').querySelector('.run-wf-bar') as HTMLElement;
    expect(bar.style.left).toBe('5%');
    expect(bar.style.width).toBe('40%');
    expect(bar.classList.contains('run-wf-bar-generation')).toBe(true);
    expect((row(c, 'gen/1').querySelector('.run-name') as HTMLElement).title).toBe(LONG_NAME);
  });

  it('extends an open bar to now and paints an error bar red', () => {
    const rows = [
      obs({ obs_id: 'root', start: T0, end: null, status: null }),
      obs({ obs_id: 'bad', parent_obs_id: 'root', status: 'error', start: T0, end: T0 + 500 }),
    ];
    const c = render(<Waterfall observations={rows} onSelect={() => {}} now={T0 + 1000} />);
    const open = row(c, 'root').querySelector('.run-wf-bar') as HTMLElement;
    expect(open.style.width).toBe('100%');
    expect(open.classList.contains('running')).toBe(true);
    expect(row(c, 'bad').querySelector('.run-wf-bar.error')).not.toBeNull();
    expect(row(c, 'bad').classList.contains('run-row-error')).toBe(true);
  });

  it('selects a row on click', () => {
    const onSelect = vi.fn();
    const c = render(<Waterfall observations={TRACE} onSelect={onSelect} />);
    act(() => row(c, 'tool1').click());
    expect(onSelect).toHaveBeenCalledWith('tool1');
    expect(row(c, 'tool1').tagName).toBe('BUTTON');
  });

  it('virtualises above 500 observations', () => {
    const rows = Array.from({ length: 600 }, (_, i) => obs({ obs_id: `o${i}`, start: T0 + i, end: T0 + i + 1 }));
    const c = render(<Waterfall observations={rows} onSelect={() => {}} />);
    expect(c.querySelector('.run-virtual')).not.toBeNull();
    expect(c.querySelectorAll('.run-wf-row').length).toBeLessThan(100);
  });
});

describe('RunInspector', () => {
  const sectionOrder = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-section]')].map((s) => s.dataset.section);

  it('renders sections in the design-brief order, Error first for a failed step', () => {
    const failed = obs({ obs_id: 'bad', status: 'error', input: 'hi', output: 'oops', attrs: { error: 'Rate limited' } });
    const c = render(<RunInspector observation={failed} scores={[]} />);
    expect(sectionOrder(c)).toEqual(['error', 'input', 'output', 'feedback', 'usage', 'attributes']);
    const alert = c.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Rate limited');
  });

  it('omits Error for an ok step and Attributes when attrs is null', () => {
    const c = render(<RunInspector observation={obs({ obs_id: 'fine' })} scores={[]} />);
    expect(sectionOrder(c)).toEqual(['input', 'output', 'feedback', 'usage']);
    expect(c.querySelector('[role="alert"]')).toBeNull();
    expect(c.textContent).toContain('No feedback on this step yet.');
  });

  it('shows the error pill, not "running", for an open observation that failed (error wins)', () => {
    const c = render(
      <RunInspector observation={obs({ obs_id: 'open-bad', status: 'error', end: null })} scores={[]} now={T0 + 500} />,
    );
    const pill = c.querySelector('.run-inspector-head .status-pill') as HTMLElement;
    expect(pill.classList.contains('pill-error')).toBe(true);
    expect(pill.classList.contains('pill-running')).toBe(false);
  });

  it('renders the feedback slot inside the Feedback section', () => {
    const c = render(
      <RunInspector observation={obs({ obs_id: 'fine' })} scores={[]} renderFeedback={(r) => <form data-for={r.obs_id} />} />,
    );
    expect(c.querySelector('[data-section="feedback"] form[data-for="fine"]')).not.toBeNull();
  });

  it('reads attrs.error.message, falling back to a generic line', () => {
    let c = render(<RunInspector observation={obs({ obs_id: 'a', status: 'error', attrs: { error: { message: 'boom' } } })} scores={[]} />);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('boom');
    c = render(<RunInspector observation={obs({ obs_id: 'b', status: 'error', attrs: { error: 42 } })} scores={[]} />);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('This step failed.');
  });

  it('shows this observation’s scores, plus trace-level scores for a root', () => {
    const scores = [
      score({ score_id: 's1', obs_id: 'child', name: 'helpful', value: 0.8, source: 'llm-judge', comment: 'solid' }),
      score({ score_id: 's2', obs_id: null, name: 'thumbs', value: 1, source: 'human' }),
      score({ score_id: 's3', obs_id: 'other', name: 'nope' }),
    ];
    let c = render(<RunInspector observation={obs({ obs_id: 'child', parent_obs_id: 'root' })} scores={scores} />);
    let names = [...c.querySelectorAll('.run-score-name')].map((n) => n.textContent);
    expect(names).toEqual(['helpful']);
    expect(c.querySelector('.run-score')?.textContent).toContain('0.8');
    expect(c.querySelector('.run-score')?.textContent).toContain('llm-judge');
    expect(c.querySelector('.run-score')?.textContent).toContain('solid');
    c = render(<RunInspector observation={obs({ obs_id: 'root' })} scores={scores} />);
    names = [...c.querySelectorAll('.run-score-name')].map((n) => n.textContent);
    expect(names).toEqual(['thumbs']);
  });

  it('shows tokens, cost markers, model and the truncated note', () => {
    const gen = obs({
      obs_id: 'g',
      kind: 'generation',
      model: 'gpt-4o',
      usage_input_tokens: 10,
      usage_output_tokens: 20,
      usage_cached_tokens: 5,
      usage_reasoning_tokens: 7,
      cost_usd: 0.0021,
      cost_partial: true,
      usage_estimated: true,
      truncated: true,
    });
    const c = render(<RunInspector observation={gen} scores={[]} />);
    const usage = c.querySelector('[data-section="usage"]')!.textContent!;
    expect(usage).toContain('Input tokens10');
    expect(usage).toContain('Reasoning tokens7');
    expect(usage).toContain('$0.0021 (partial, estimated)');
    expect(usage).toContain('gpt-4o');
    expect(c.querySelector('.run-truncated-note')).not.toBeNull();
    expect(c.querySelector('.run-inspector .run-playground-link')?.getAttribute('href')).toBe('#/playground?fromObs=g');
  });
});

describe('TraceViewer', () => {
  const inspected = (c: HTMLElement) => (c.querySelector('.run-inspector') as HTMLElement).dataset.obsId;

  it('opens a failed trace on the earliest error', () => {
    const rows = [
      obs({ obs_id: 'root', status: 'error', start: T0, attrs: { error: 'root failed' } }),
      obs({ obs_id: 'late', parent_obs_id: 'root', status: 'error', start: T0 + 50 }),
    ];
    // Root is earliest here, so it is the first error.
    let c = render(<TraceViewer observations={rows} scores={[]} onSelect={() => {}} mode="tree" />);
    expect(inspected(c)).toBe('root');
    const child = [obs({ obs_id: 'root' }), obs({ obs_id: 'e2', parent_obs_id: 'root', status: 'error', start: T0 + 60 }), obs({ obs_id: 'e1', parent_obs_id: 'root', status: 'error', start: T0 + 30 })];
    c = render(<TraceViewer observations={child} scores={[]} selectedObsId="missing" onSelect={() => {}} mode="tree" />);
    expect(inspected(c)).toBe('e1');
    expect(c.querySelector('.run-inspector [role="alert"]')).not.toBeNull();
    expect(row(c, 'e1').classList.contains('selected')).toBe(true);
  });

  it('falls back to the first root, and honours a valid selection', () => {
    let c = render(<TraceViewer observations={TRACE} scores={[]} onSelect={() => {}} mode="tree" />);
    expect(inspected(c)).toBe('root');
    c = render(<TraceViewer observations={TRACE} scores={[]} selectedObsId="tool1" onSelect={() => {}} mode="tree" />);
    expect(inspected(c)).toBe('tool1');
  });

  it('renders the mode the caller asks for, with a toggle only when onModeChange is given', () => {
    let c = render(<TraceViewer observations={TRACE} scores={[]} onSelect={() => {}} mode="waterfall" />);
    expect(c.querySelector('.run-waterfall')).not.toBeNull();
    expect(c.querySelector('.run-tree')).toBeNull();
    expect(c.querySelector('.run-mode-toggle')).toBeNull();
    const onModeChange = vi.fn();
    c = render(<TraceViewer observations={TRACE} scores={[]} onSelect={() => {}} mode="tree" onModeChange={onModeChange} />);
    expect(c.querySelector('.run-tree')).not.toBeNull();
    const buttons = [...c.querySelectorAll<HTMLButtonElement>('.run-mode-toggle button')];
    expect(buttons.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Tree', 'true'],
      ['Waterfall', 'false'],
    ]);
    act(() => buttons[1]!.click());
    expect(onModeChange).toHaveBeenCalledWith('waterfall');
  });

  it('forwards row clicks to onSelect', () => {
    const onSelect = vi.fn();
    const c = render(<TraceViewer observations={TRACE} scores={[]} onSelect={onSelect} mode="waterfall" />);
    act(() => row(c, 'ev1').click());
    expect(onSelect).toHaveBeenCalledWith('ev1');
  });

  it('shows an empty state for a trace with no observations', () => {
    const c = render(<TraceViewer observations={[]} scores={[]} onSelect={() => {}} mode="tree" />);
    expect(c.querySelector('.empty-state-title')?.textContent).toBe('No steps recorded');
  });
});
