import { describe, expect, it } from 'vitest';

import { MetricCard } from '../MetricCard';
import { render } from './render';

const delta = (c: HTMLElement) => c.querySelector('.metric-delta') as HTMLElement;
const spoken = (c: HTMLElement) => delta(c).querySelector('.visually-hidden')?.textContent;
const ms = (v: number) => `${v} ms`;

describe('MetricCard', () => {
  it('renders the label as an overline and the value as a tabular metric', () => {
    const c = render(<MetricCard label="Runs" value="1,204" hint="last 24 h" />);
    expect(c.querySelector('.metric-label')?.textContent).toBe('Runs');
    expect(c.querySelector('.metric-label')?.classList.contains('overline')).toBe(true);
    expect(c.querySelector('.metric-value')?.textContent).toBe('1,204');
    expect(c.querySelector('.metric-value')?.classList.contains('tabular-nums')).toBe(true);
    expect(c.querySelector('.metric-hint')?.textContent).toBe('last 24 h');
    expect(delta(c)).toBeNull();
    expect(c.querySelector('svg.metric-sparkline')).toBeNull();
  });

  it('an upward move is good by default: success tone, "up" phrase', () => {
    const c = render(<MetricCard label="Runs" value={10} delta={{ value: 12 }} />);
    expect(delta(c).dataset.tone).toBe('good');
    expect(delta(c).textContent).toContain('12%');
    expect(spoken(c)).toBe('up 12% vs previous window');
  });

  it('a downward move is bad by default', () => {
    const c = render(<MetricCard label="Runs" value={10} delta={{ value: -4.5 }} />);
    expect(delta(c).dataset.tone).toBe('bad');
    expect(spoken(c)).toBe('down 4.5% vs previous window');
  });

  it('goodWhen "down" flips the tones (errors, latency)', () => {
    const c = render(<MetricCard label="Errors" value={3} delta={{ value: -20, goodWhen: 'down' }} />);
    expect(delta(c).dataset.tone).toBe('good');
    const up = render(<MetricCard label="Errors" value={3} delta={{ value: 20, goodWhen: 'down' }} />);
    expect(delta(up).dataset.tone).toBe('bad');
  });

  it('zero is neutral, and format / label shape the text', () => {
    const c = render(<MetricCard label="p95" value="1.2s" delta={{ value: 0, format: ms, label: 'vs yesterday' }} />);
    expect(delta(c).dataset.tone).toBe('neutral');
    expect(spoken(c)).toBe('no change vs yesterday');
    const down = render(<MetricCard label="p95" value="1.2s" delta={{ value: -40, format: ms, label: 'vs yesterday' }} />);
    expect(spoken(down)).toBe('down 40 ms vs yesterday');
  });

  it('draws an aria-hidden sparkline polyline', () => {
    const c = render(<MetricCard label="Runs" value={10} sparkline={[1, 4, 2, 8]} />);
    const svg = c.querySelector('svg.metric-sparkline') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const points = svg.querySelector('polyline')?.getAttribute('points')?.trim().split(' ');
    expect(points).toHaveLength(4);
  });

  it('skips a sparkline with fewer than two points', () => {
    const c = render(<MetricCard label="Runs" value={10} sparkline={[3]} />);
    expect(c.querySelector('svg.metric-sparkline')).toBeNull();
  });

  it('loading shows skeletons instead of the value, delta and sparkline', () => {
    const c = render(<MetricCard label="Runs" value="1,204" sparkline={[1, 2, 3]} delta={{ value: 3 }} loading />);
    expect(c.querySelector('.metric-value')?.textContent).not.toContain('1,204');
    expect(c.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(2);
    expect(c.querySelector('svg.metric-sparkline')).toBeNull();
    expect(delta(c)).toBeNull();
    expect(c.querySelector('.metric-card')?.getAttribute('aria-busy')).toBe('true');
  });
});
