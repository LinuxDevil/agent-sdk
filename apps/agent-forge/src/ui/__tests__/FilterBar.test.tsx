import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render as mount, rerender } from './render';

import { FilterBar, type FacetDef } from '../FilterBar';
import { formatTimeRange, parseTimeRange, toWindow, type TimeRange } from '../TimeRangePicker';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

afterEach(() => {
  vi.useRealTimers();
});

/** Fire a React-visible value change on an input. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (el: Element) => act(() => (el as HTMLElement).click());
const byText = (sel: string, text: string) =>
  [...container.querySelectorAll(sel)].find((e) => e.textContent?.includes(text)) as HTMLElement;

describe('toWindow / parse / format', () => {
  const T = 1_700_000_000_000;
  it('resolves presets against now', () => {
    expect(toWindow({ preset: '24h' }, T)).toEqual({ from: T - 86_400_000, to: T });
    expect(toWindow({ preset: '15m' }, T).from).toBe(T - 900_000);
    expect(toWindow({ preset: '30d' }, T).from).toBe(T - 30 * 86_400_000);
  });
  it('returns an absolute range unchanged', () => {
    expect(toWindow({ from: 1, to: 2 }, T)).toEqual({ from: 1, to: 2 });
  });
  it('round-trips and rejects garbage', () => {
    const ranges: TimeRange[] = [{ preset: '7d' }, { from: 1000, to: 2000 }];
    for (const r of ranges) expect(parseTimeRange(formatTimeRange(r))).toEqual(r);
    expect(formatTimeRange({ preset: '24h' })).toBe('24h');
    expect(formatTimeRange({ from: 5, to: 9 })).toBe('5-9');
    for (const bad of [null, '', 'abc', '2h', '9-5', '1-', '-1', '1-2-3']) expect(parseTimeRange(bad)).toBeNull();
  });
});

describe('FilterBar search', () => {
  it('debounces 250 ms, emits the last value, and resets on external change', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const ui = (value: string) => <FilterBar facets={[]} search={{ value, onChange, placeholder: 'Find' }} />;
    render(ui(''));
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    type(input, 'a');
    type(input, 'ab');
    expect(input.value).toBe('ab');
    act(() => void vi.advanceTimersByTime(249));
    expect(onChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('ab');
    rerender(ui('zzz'));
    expect(input.value).toBe('zzz');
  });

  it('keeps what the user typed when the parent echoes a trimmed value, but follows real external changes', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const ui = (value: string) => <FilterBar facets={[]} search={{ value, onChange }} />;
    render(ui(''));
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    type(input, 'tool ');
    act(() => void vi.advanceTimersByTime(250));
    expect(onChange).toHaveBeenCalledWith('tool ');
    rerender(ui('tool'));
    expect(input.value).toBe('tool ');
    type(input, 'tool timed out');
    act(() => void vi.advanceTimersByTime(250));
    rerender(ui('tool timed out'));
    expect(input.value).toBe('tool timed out');
    rerender(ui(''));
    expect(input.value).toBe('');
    rerender(ui('tool timed out'));
    expect(input.value).toBe('tool timed out');
  });

  it('calls the latest onChange when the callback identity changes mid-debounce', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    render(<FilterBar facets={[]} search={{ value: '', onChange: first }} />);
    type(container.querySelector('input') as HTMLInputElement, 'q');
    rerender(<FilterBar facets={[]} search={{ value: '', onChange: second }} />);
    act(() => void vi.advanceTimersByTime(250));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('q');
  });

  it('cancels the pending timer on unmount', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<FilterBar facets={[]} search={{ value: '', onChange }} />);
    type(container.querySelector('input') as HTMLInputElement, 'x');
    cleanup();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('FilterBar facets', () => {
  const facet = (value: string[], onChange = vi.fn()): FacetDef => ({
    key: 'status',
    label: 'Status',
    value,
    onChange,
    options: [
      { value: 'ok', label: 'OK', count: 7 },
      { value: 'error', label: 'Error' },
    ],
  });

  it('shows the selected count, toggles options, and clear emits []', () => {
    const onChange = vi.fn();
    render(<FilterBar facets={[facet(['ok'], onChange)]} />);
    const btn = byText('button.facet-btn', 'Status');
    expect(btn.textContent).toContain('1');
    click(btn);
    expect(container.textContent).toContain('7');
    click(container.querySelectorAll('.facet-pop input')[1]);
    expect(onChange).toHaveBeenLastCalledWith(['ok', 'error']);
    click(container.querySelectorAll('.facet-pop input')[0]);
    expect(onChange).toHaveBeenLastCalledWith([]);
    click(byText('button', 'Clear'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('Esc closes and refocuses the button; outside click closes', () => {
    render(<FilterBar facets={[facet([])]} />);
    const btn = byText('button.facet-btn', 'Status');
    click(btn);
    expect(container.querySelector('.facet-pop')).not.toBeNull();
    const cb = container.querySelector('.facet-pop input') as HTMLElement;
    cb.focus();
    act(() => void cb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('.facet-pop')).toBeNull();
    expect(document.activeElement).toBe(btn);
    click(btn);
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container.querySelector('.facet-pop')).toBeNull();
  });
});

describe('TimeRangePicker via FilterBar', () => {
  it('selects presets and marks the active one', () => {
    const onChange = vi.fn();
    render(<FilterBar facets={[]} range={{ value: { preset: '1h' }, onChange }} />);
    expect(byText('.time-range button', '1h').getAttribute('aria-pressed')).toBe('true');
    click(byText('.time-range button', '7d'));
    expect(onChange).toHaveBeenCalledWith({ preset: '7d' });
  });

  it('custom range: Apply is disabled when from >= to', () => {
    const onChange = vi.fn();
    render(<FilterBar facets={[]} range={{ value: { preset: '1h' }, onChange }} />);
    click(byText('.time-range button', 'Custom'));
    const [from, to] = [...container.querySelectorAll('input[type="datetime-local"]')] as HTMLInputElement[];
    const apply = byText('.time-range button', 'Apply') as HTMLButtonElement;
    type(from, '2026-01-02T10:00');
    type(to, '2026-01-02T10:00');
    expect(apply.disabled).toBe(true);
    type(to, '2026-01-02T11:00');
    expect(apply.disabled).toBe(false);
    click(apply);
    expect(onChange).toHaveBeenCalledWith({
      from: new Date('2026-01-02T10:00').getTime(),
      to: new Date('2026-01-02T11:00').getTime(),
    });
  });
});

describe('FilterBar look', () => {
  it('presets and Custom sit in one segmented control; the group keeps its name', () => {
    render(<FilterBar facets={[]} range={{ value: { preset: '24h' }, onChange: vi.fn() }} />);
    const group = container.querySelector('.time-range[role="group"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('Time range');
    const seg = group.querySelector('.segmented') as HTMLElement;
    expect([...seg.querySelectorAll('button.seg-btn')].map((b) => b.textContent)).toEqual(['15m', '1h', '24h', '7d', '30d', 'Custom']);
  });

  it('the search box carries a decorative search icon; facet buttons a chevron', () => {
    const facet: FacetDef = { key: 's', label: 'Status', options: [], value: [], onChange: vi.fn() };
    render(<FilterBar search={{ value: '', onChange: vi.fn(), placeholder: 'Search' }} facets={[facet]} />);
    expect(container.querySelector('.filter-search-wrap svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('input.filter-search')?.getAttribute('aria-label')).toBe('Search');
    const btn = container.querySelector('button.facet-btn') as HTMLElement;
    expect(btn.textContent).toBe('Status');
    expect(btn.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('TimeRangePicker Custom open state', () => {
  it('Custom reads as open (aria-expanded) while its inputs show, and the CSS styles that state', () => {
    render(<FilterBar facets={[]} range={{ value: { preset: '24h' }, onChange: vi.fn() }} />);
    const custom = byText('.time-range button', 'Custom');
    expect(custom.getAttribute('aria-expanded')).toBe('false');
    click(custom);
    expect(custom.getAttribute('aria-expanded')).toBe('true');
    expect(byText('.time-range button', '24h').getAttribute('aria-pressed')).toBe('true');
    const css = readFileSync(resolve(__dirname, '../filterBar.css'), 'utf8');
    expect(css).toMatch(/\.seg-btn\[aria-expanded='true'\]:not\(\[aria-pressed='true'\]\)\s*\{[^}]*background:\s*var\(--accent-soft\)/);
  });
});

describe('TimeRangePicker re-seeding', () => {
  const inputs = () => [...container.querySelectorAll('input[type="datetime-local"]')] as HTMLInputElement[];
  const ui = (value: TimeRange) => <FilterBar facets={[]} range={{ value, onChange: vi.fn() }} />;

  it('follows external value changes: absolute opens Custom with new dates, preset closes it', () => {
    const a = { from: new Date('2026-03-01T08:00').getTime(), to: new Date('2026-03-01T09:00').getTime() };
    const b = { from: new Date('2026-04-05T10:30').getTime(), to: new Date('2026-04-06T11:45').getTime() };
    render(ui({ preset: '1h' }));
    expect(inputs()).toHaveLength(0);
    rerender(ui(a));
    expect(inputs().map((i) => i.value)).toEqual(['2026-03-01T08:00', '2026-03-01T09:00']);
    rerender(ui(b));
    expect(inputs().map((i) => i.value)).toEqual(['2026-04-05T10:30', '2026-04-06T11:45']);
    rerender(ui({ preset: '24h' }));
    expect(inputs()).toHaveLength(0);
  });
});
