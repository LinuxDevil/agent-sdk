import { describe, expect, it } from 'vitest';

import { render as mount } from './render';

import { STATUS_CONFIG, statusKey, statusToneClass, type StatusKey } from '../status';
import { StatusBadge, StatusDot } from '../StatusBadge';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

describe('statusKey', () => {
  const vocabulary: [string | null | undefined, StatusKey][] = [
    ['queued', 'queued'],
    ['running', 'running'],
    ['paused', 'waiting'],
    ['awaiting_approval', 'waiting'],
    ['waiting', 'waiting'],
    ['blocked', 'waiting'],
    ['done', 'done'],
    ['ok', 'done'],
    ['completed', 'done'],
    ['pass', 'done'],
    ['success', 'done'],
    ['error', 'error'],
    ['failed', 'error'],
    ['fail', 'error'],
    ['stopped', 'stopped'],
    ['aborted', 'stopped'],
    ['cancelled', 'stopped'],
    ['interrupted', 'stopped'],
    ['timed_out', 'timed_out'],
    ['timeout', 'timed_out'],
    ['expired', 'timed_out'],
    ['enabled', 'enabled'],
    ['disabled', 'disabled'],
    ['draft', 'draft'],
    ['published', 'published'],
    ['idle', 'unknown'],
    ['constructor', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [raw, key] of vocabulary) {
    it(`maps ${String(raw)} to ${key}`, () => expect(statusKey(raw)).toBe(key));
  }
});

describe('STATUS_CONFIG', () => {
  it('has 12 entries, each with a non-empty label, a tone and an icon', () => {
    const entries = Object.values(STATUS_CONFIG);
    expect(entries).toHaveLength(12);
    for (const config of entries) {
      expect(config.label.length).toBeGreaterThan(0);
      expect(config.tone.length).toBeGreaterThan(0);
      expect(config.icon).toBeTruthy();
    }
  });

  it('gives a badge and a dot for the same key the same tone class', () => {
    for (const key of Object.keys(STATUS_CONFIG) as StatusKey[]) {
      render(
        <>
          <StatusBadge status={key} />
          <StatusDot status={key} />
        </>,
      );
      const tone = statusToneClass(key);
      expect(container.querySelector('.status-badge')?.classList.contains(tone)).toBe(true);
      expect(container.querySelector('.status-dot')?.classList.contains(tone)).toBe(true);
    }
  });
});

describe('StatusBadge', () => {
  it('renders a failed badge with its icon', () => {
    render(<StatusBadge status="error" />);
    const badge = container.querySelector('.status-badge') as HTMLElement;
    expect(badge.classList.contains('status-tone-danger')).toBe(true);
    expect(badge.textContent).toBe('Failed');
    const svgs = badge.querySelectorAll('svg[aria-hidden="true"]');
    expect(svgs).toHaveLength(1);
  });

  it('supports a label override, the sm size and no icon', () => {
    render(<StatusBadge status="published" label="Published v3" size="sm" icon={false} />);
    const badge = container.querySelector('.status-badge') as HTMLElement;
    expect(badge.textContent).toBe('Published v3');
    expect(badge.classList.contains('status-badge-sm')).toBe(true);
    expect(badge.querySelector('svg')).toBeNull();
  });

  it('spins the running icon', () => {
    render(<StatusBadge status="running" />);
    const svg = container.querySelector('.status-badge svg') as SVGElement;
    expect(svg.classList.contains('status-badge-spin')).toBe(true);
  });
});

describe('StatusDot', () => {
  it('renders an enabled halo dot hidden from assistive tech', () => {
    render(<StatusDot status="enabled" halo />);
    const dot = container.querySelector('.status-dot') as HTMLElement;
    expect(dot.classList.contains('status-tone-success')).toBe(true);
    expect(dot.classList.contains('status-dot-halo')).toBe(true);
    expect(dot.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders a titled running dot as a named pulsing image', () => {
    render(<StatusDot status="running" title="Running now" />);
    const dot = container.querySelector('.status-dot') as HTMLElement;
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('Running now');
    expect(dot.classList.contains('status-dot-pulse')).toBe(true);
    expect(dot.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('statusToneClass', () => {
  it('returns the tone class for a key', () => {
    expect(statusToneClass('waiting')).toBe('status-tone-warning');
  });
});
