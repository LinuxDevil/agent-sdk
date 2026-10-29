import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimeSeriesChart, type TimeSeries } from '../TimeSeriesChart';
import { render, rerender } from './render';

const MIN = 60_000;
/** 10:00 local time on an arbitrary day, so HH:MM labels are predictable. */
const FROM = new Date(2026, 9, 25, 10, 0, 0, 0).getTime();
const TO = FROM + 60 * MIN;
const BUCKET = 5 * MIN; // 12 buckets

const fmt = (v: number) => `${v} req`;

const SERIES: TimeSeries[] = [
  {
    id: 'ok',
    label: 'Requests',
    color: 'accent',
    points: [
      { t: FROM, v: 4 },
      { t: FROM + BUCKET + 10, v: 7 },
      { t: FROM + 2 * BUCKET, v: 23 },
    ],
  },
  { id: 'err', label: 'Errors', color: 'danger', points: [{ t: FROM + BUCKET, v: 2 }] },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const svgOf = (c: HTMLElement) => c.querySelector('svg.tsc-svg') as SVGSVGElement;
const plotOf = (c: HTMLElement) => c.querySelector('.tsc-plot') as SVGRectElement;
const statusOf = (c: HTMLElement) => c.querySelector('[role="status"]') as HTMLElement;

/** Make the svg report a 600 px wide box at the viewport origin (jsdom has no layout). */
function stubRect(c: HTMLElement) {
  vi.spyOn(svgOf(c), 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 600, bottom: 200, width: 600, height: 200, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
}
const pointer = (target: EventTarget, type: string, clientX: number) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
  });
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

/** Bucket centre x in the default 600 px layout (plot from x=48 to x=588). */
const centreX = (k: number, n = 12) => 48 + ((k + 0.5) * 540) / n;

describe('TimeSeriesChart', () => {
  it('renders x ticks only at bucket boundaries, labelled HH:MM for a sub-day span', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const ticks = [...c.querySelectorAll('.tsc-xtick')];
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(8);
    for (const t of ticks) {
      const at = Number(t.getAttribute('data-t'));
      expect((at - FROM) % BUCKET).toBe(0);
      expect(at).toBeGreaterThanOrEqual(FROM);
      expect(at).toBeLessThanOrEqual(TO);
    }
    expect(ticks[0]!.textContent).toBe('10:00');
  });

  it('labels a multi-day span by date and caps labels for many buckets', () => {
    const day = 24 * 60 * MIN;
    const c = render(
      <TimeSeriesChart series={[]} from={FROM} to={FROM + 30 * day} bucketMs={day} yFormat={fmt} />,
    );
    const ticks = [...c.querySelectorAll('.tsc-xtick')];
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks[0]!.textContent).toBe('Oct 25');
    for (const t of ticks) expect((Number(t.getAttribute('data-t')) - FROM) % day).toBe(0);
  });

  it('labels hour buckets HH:MM even when the window spans more than a day, and never repeats a label', () => {
    const hour = 60 * MIN;
    // 25 hour buckets (a 24h window aligned to whole hours): boundary 0 and 24 are both 10:00.
    const c = render(<TimeSeriesChart series={[]} from={FROM} to={FROM + 25 * hour} bucketMs={hour} yFormat={fmt} />);
    const labels = [...c.querySelectorAll('.tsc-xtick')].map((t) => t.textContent);
    expect(labels.length).toBeGreaterThan(1);
    for (const l of labels) expect(l).toMatch(/^\d\d:\d\d$/);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('renders at least three nice y ticks inside the domain, formatted with yFormat', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const ticks = [...c.querySelectorAll('.tsc-ytick')];
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    const values = ticks.map((t) => Number(t.getAttribute('data-v')));
    expect(values[0]).toBe(0);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(23);
    expect(ticks.map((t) => t.textContent)).toEqual(values.map(fmt));
  });

  it('renders a sane 0..1 axis for empty or all-zero data', () => {
    const c = render(
      <TimeSeriesChart
        series={[{ id: 'z', label: 'Zero', color: 'info', points: [{ t: FROM, v: 0 }] }]}
        from={FROM}
        to={TO}
        bucketMs={BUCKET}
        yFormat={String}
      />,
    );
    const values = [...c.querySelectorAll('.tsc-ytick')].map((t) => Number(t.getAttribute('data-v')));
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
  });

  it('renders a single bucket as one point, not a bar or an invisible line', () => {
    const c = render(
      <TimeSeriesChart
        series={[{ id: 'a', label: 'A', color: 'success', points: [{ t: FROM, v: 3 }] }]}
        from={FROM}
        to={FROM + BUCKET}
        bucketMs={BUCKET}
        yFormat={fmt}
      />,
    );
    expect(c.querySelectorAll('polyline')).toHaveLength(0);
    expect(c.querySelectorAll('rect.tsc-bar')).toHaveLength(0);
    const dots = c.querySelectorAll('circle.tsc-point');
    expect(dots).toHaveLength(1);
    expect(Number(dots[0]!.getAttribute('cx'))).toBeCloseTo(centreX(0, 1));
  });

  it('draws each series as a polyline through bucket centres, isolated buckets as points', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const line = c.querySelector('polyline[data-series="ok"]')!;
    const xs = line.getAttribute('points')!.split(' ').map((p) => Number(p.split(',')[0]));
    expect(xs).toHaveLength(3);
    xs.forEach((x, k) => expect(x).toBeCloseTo(centreX(k)));
    expect(c.querySelectorAll('circle.tsc-point[data-series="err"]')).toHaveLength(1);
  });

  it('colours series with token CSS variables', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    expect(c.querySelector('polyline[data-series="ok"]')!.getAttribute('stroke')).toBe('var(--accent)');
    expect(c.querySelector('circle[data-series="err"]')!.getAttribute('fill')).toBe('var(--danger)');
    const swatches = [...c.querySelectorAll('.tsc-swatch')] as HTMLElement[];
    expect(swatches.map((s) => s.style.background)).toEqual(['var(--accent)', 'var(--danger)']);
  });

  it('shows a legend only for more than one series', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    expect(c.querySelector('.tsc-legend')!.textContent).toContain('Requests');
    const one = render(
      <TimeSeriesChart series={SERIES.slice(0, 1)} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />,
    );
    expect(one.querySelector('.tsc-legend')).toBeNull();
  });

  it('is an accessible image with a summary label and a default height of 200', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const svg = svgOf(c);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toMatch(/Requests, Errors.*12 buckets.*10:00.*11:00/);
    expect(svg.getAttribute('height')).toBe('200');
    expect(statusOf(c).getAttribute('aria-live')).toBe('polite');
  });

  it('hover snaps to a bucket and shows a crosshair tooltip with every series value', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    stubRect(c);
    pointer(plotOf(c), 'pointermove', centreX(1) + 5);
    const cross = c.querySelector('.tsc-crosshair')!;
    expect(Number(cross.getAttribute('x1'))).toBeCloseTo(centreX(1));
    const tip = statusOf(c).textContent!;
    expect(tip).toContain('10:05');
    expect(tip).toContain('10:10');
    expect(tip).toContain('Requests');
    expect(tip).toContain('7 req');
    expect(tip).toContain('Errors');
    expect(tip).toContain('2 req');

    pointer(plotOf(c), 'pointermove', centreX(5));
    expect(statusOf(c).textContent).toContain('Errors—');

    // React derives onPointerLeave from pointerout towards an element outside the plot.
    act(() => {
      plotOf(c).dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(c.querySelector('.tsc-crosshair')).toBeNull();
    expect(statusOf(c).textContent).toBe('');
  });

  it('clicking a bucket calls onBucketClick with its bounds, with a pointer cursor', () => {
    const onBucketClick = vi.fn();
    const c = render(
      <TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} onBucketClick={onBucketClick} />,
    );
    stubRect(c);
    expect(plotOf(c).classList.contains('tsc-clickable')).toBe(true);
    pointer(plotOf(c), 'click', centreX(2));
    expect(onBucketClick).toHaveBeenCalledWith(FROM + 2 * BUCKET, FROM + 3 * BUCKET);
  });

  it('has no pointer cursor and ignores clicks without onBucketClick', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    stubRect(c);
    expect(plotOf(c).classList.contains('tsc-clickable')).toBe(false);
    pointer(plotOf(c), 'click', centreX(2));
  });

  it('keyboard: arrows move the hovered bucket, Enter clicks it, Escape clears', () => {
    const onBucketClick = vi.fn();
    const c = render(
      <TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} onBucketClick={onBucketClick} />,
    );
    const svg = svgOf(c);
    expect(svg.getAttribute('tabindex')).toBe('0');
    key(svg, 'ArrowRight');
    expect(statusOf(c).textContent).toContain('10:00');
    key(svg, 'ArrowRight');
    key(svg, 'ArrowRight');
    key(svg, 'ArrowLeft');
    key(svg, 'Enter');
    expect(onBucketClick).toHaveBeenCalledWith(FROM + BUCKET, FROM + 2 * BUCKET);
    key(svg, 'ArrowLeft');
    key(svg, 'ArrowLeft');
    key(svg, 'Enter');
    expect(onBucketClick).toHaveBeenLastCalledWith(FROM, FROM + BUCKET);
    key(svg, 'Escape');
    expect(statusOf(c).textContent).toBe('');
    key(svg, 'ArrowLeft');
    expect(statusOf(c).textContent).toContain('10:55');
  });

  it('follows its container width when ResizeObserver is available', () => {
    let fire: (w: number) => void = () => {};
    class FakeRO {
      constructor(cb: ResizeObserverCallback) {
        fire = (width) => cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} height={120} />);
    act(() => fire(900));
    expect(svgOf(c).getAttribute('width')).toBe('900');
    expect(svgOf(c).getAttribute('height')).toBe('120');
  });

  it('legend chips toggle a series (aria-pressed); the last visible series cannot be hidden', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const chip = (name: string) =>
      [...c.querySelectorAll<HTMLButtonElement>('.tsc-legend button')].find((b) => b.textContent === name)!;
    expect(chip('Requests').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Errors').getAttribute('aria-pressed')).toBe('true');

    act(() => chip('Errors').click());
    expect(chip('Errors').getAttribute('aria-pressed')).toBe('false');
    expect(c.querySelector('[data-series="err"]')).toBeNull();
    expect(c.querySelector('polyline[data-series="ok"]')).not.toBeNull();
    // The hidden series leaves the tooltip too.
    stubRect(c);
    pointer(plotOf(c), 'pointermove', centreX(1));
    expect(statusOf(c).textContent).toContain('Requests');
    expect(statusOf(c).textContent).not.toContain('Errors');

    // The only visible series stays on: its chip is pressed and disabled.
    expect(chip('Requests').disabled).toBe(true);
    act(() => chip('Requests').click());
    expect(c.querySelector('polyline[data-series="ok"]')).not.toBeNull();

    act(() => chip('Errors').click());
    expect(chip('Errors').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Requests').disabled).toBe(false);
    expect(c.querySelector('circle[data-series="err"]')).not.toBeNull();
  });

  it('legend chips follow the plot when the series prop drops every visible series', () => {
    const three: TimeSeries[] = [
      { id: 'a', label: 'A', color: 'chart-1', points: [{ t: FROM, v: 1 }, { t: FROM + BUCKET, v: 2 }] },
      { id: 'b', label: 'B', color: 'chart-2', points: [{ t: FROM, v: 3 }, { t: FROM + BUCKET, v: 4 }] },
      { id: 'c', label: 'C', color: 'chart-3', points: [{ t: FROM, v: 5 }, { t: FROM + BUCKET, v: 6 }] },
    ];
    const chart = (s: TimeSeries[]) => <TimeSeriesChart series={s} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />;
    const c = render(chart(three));
    const chip = (name: string) =>
      [...c.querySelectorAll<HTMLButtonElement>('.tsc-legend button')].find((b) => b.textContent === name)!;
    act(() => chip('B').click());
    act(() => chip('C').click());
    expect(c.querySelectorAll('polyline.tsc-line')).toHaveLength(1);
    // A goes away: B and C are both drawn again, so both chips must read as on.
    rerender(chart(three.slice(1)));
    expect(c.querySelectorAll('polyline.tsc-line')).toHaveLength(2);
    expect(chip('B').getAttribute('aria-pressed')).toBe('true');
    expect(chip('C').getAttribute('aria-pressed')).toBe('true');
    expect(chip('B').disabled).toBe(false);
    // And one of them can be hidden again.
    act(() => chip('B').click());
    expect(chip('B').getAttribute('aria-pressed')).toBe('false');
    expect(c.querySelector('[data-series="b"]')).toBeNull();
    expect(chip('C').disabled).toBe(true);
  });

  it('legend prop: forced on for one series, off for many', () => {
    const one = render(
      <TimeSeriesChart series={SERIES.slice(0, 1)} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} legend />,
    );
    expect(one.querySelector('.tsc-legend button')?.textContent).toBe('Requests');
    const many = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} legend={false} />);
    expect(many.querySelector('.tsc-legend')).toBeNull();
  });

  it('fills a token gradient area under each line by default, none with area={false}', () => {
    const c = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} />);
    const area = c.querySelector('path.tsc-area[data-series="ok"]')!;
    expect(area).not.toBeNull();
    const id = /^url\(#(.+)\)$/.exec(area.getAttribute('fill')!)![1]!;
    const stops = [...c.querySelectorAll<SVGStopElement>(`linearGradient[id="${id}"] stop`)];
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.style.stopColor)).toEqual(['var(--accent)', 'var(--accent)']);
    expect(stops.map((s) => Number(s.style.stopOpacity))).toEqual([0.18, 0]);
    // A single isolated bucket is a point, with no area.
    expect(c.querySelector('path.tsc-area[data-series="err"]')).toBeNull();

    const flat = render(<TimeSeriesChart series={SERIES} from={FROM} to={TO} bucketMs={BUCKET} yFormat={fmt} area={false} />);
    expect(flat.querySelector('path.tsc-area')).toBeNull();
    expect(flat.querySelector('polyline[data-series="ok"]')).not.toBeNull();
  });

  it('draws the chart-1..chart-6 palette colours from their tokens', () => {
    const c = render(
      <TimeSeriesChart
        series={[
          { ...SERIES[0]!, color: 'chart-2' },
          { ...SERIES[1]!, color: 'chart-6' },
        ]}
        from={FROM}
        to={TO}
        bucketMs={BUCKET}
        yFormat={fmt}
      />,
    );
    expect(c.querySelector('polyline[data-series="ok"]')!.getAttribute('stroke')).toBe('var(--chart-2)');
    expect(c.querySelector('circle[data-series="err"]')!.getAttribute('fill')).toBe('var(--chart-6)');
  });

  it('styles axis and grid with theme tokens only', () => {
    const css = readFileSync(resolve(__dirname, '../timeSeriesChart.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).toContain('var(--border)');
    expect(css).toContain('var(--text-muted)');
  });
});
