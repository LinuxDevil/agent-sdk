import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusPill, statusTone, type StatusTone } from '../StatusPill';
import { EmptyState } from '../EmptyState';
import { ToastProvider, useToast } from '../Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.useRealTimers();
});

const TONE_CLASSES = ['pill-ok', 'pill-error', 'pill-warning', 'pill-running', 'pill-neutral'];
const pill = () => container.querySelector('.status-pill') as HTMLElement;
const toneClasses = (el: HTMLElement) => [...el.classList].filter((c) => TONE_CLASSES.includes(c));

describe('statusTone', () => {
  const vocabulary: [string, StatusTone][] = [
    // run
    ['ok', 'ok'],
    ['error', 'error'],
    ['running', 'running'],
    ['interrupted', 'warning'],
    // agent
    ['healthy', 'ok'],
    ['stale', 'warning'],
    ['down', 'error'],
    ['stopped', 'neutral'],
    // score
    ['pass', 'ok'],
    ['fail', 'error'],
    // builder run states
    ['idle', 'neutral'],
    ['done', 'ok'],
    ['paused', 'warning'],
  ];
  for (const [status, tone] of vocabulary) {
    it(`maps ${status} to ${tone}`, () => expect(statusTone(status)).toBe(tone));
  }

  it('maps unknown and missing statuses to neutral', () => {
    expect(statusTone('weird')).toBe('neutral');
    expect(statusTone('constructor')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
    expect(statusTone(undefined)).toBe('neutral');
  });
});

describe('StatusPill', () => {
  for (const status of ['ok', 'error', 'running', 'interrupted', 'healthy', 'stale', 'down', 'stopped', 'pass', 'fail', 'idle', 'done', 'paused']) {
    it(`renders ${status} with exactly one tone class`, () => {
      render(<StatusPill status={status} />);
      expect(toneClasses(pill())).toEqual([`pill-${statusTone(status)}`]);
      expect(pill().querySelector('.dot')?.getAttribute('aria-hidden')).toBe('true');
    });
  }

  it('labels paused as "awaiting approval"', () => {
    render(<StatusPill status="paused" />);
    expect(pill().textContent).toBe('awaiting approval');
  });

  it('renders an unknown status as its literal text in a neutral pill', () => {
    render(<StatusPill status="queued-weird" />);
    expect(pill().textContent).toBe('queued-weird');
    expect(toneClasses(pill())).toEqual(['pill-neutral']);
  });

  it('renders a missing status as "none", never "unknown"', () => {
    render(<StatusPill status={null} />);
    expect(pill().textContent).toBe('none');
    expect(pill().textContent?.toLowerCase()).not.toContain('unknown');
    expect(toneClasses(pill())).toEqual(['pill-neutral']);
  });

  it('is a polite status region with a hidden prefix when live', () => {
    render(<StatusPill status="running" live />);
    expect(pill().getAttribute('role')).toBe('status');
    expect(pill().getAttribute('aria-live')).toBe('polite');
    expect(pill().querySelector('.visually-hidden')?.textContent).toBe('Run status: ');
    expect(pill().textContent).toBe('Run status: running');
  });

  it('is plain text when not live', () => {
    render(<StatusPill status="running" />);
    expect(pill().getAttribute('role')).toBeNull();
    expect(pill().getAttribute('aria-live')).toBeNull();
    expect(pill().querySelector('.visually-hidden')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('renders the title, hint, action and a decorative icon', () => {
    render(<EmptyState title="No traces yet" hint="Run an agent." action={<button type="button">Run</button>} icon={<svg />} />);
    const root = container.querySelector('.empty-state') as HTMLElement;
    expect(root.querySelector('.empty-state-title')?.textContent).toBe('No traces yet');
    expect(root.querySelector('.empty-state-hint')?.textContent).toBe('Run an agent.');
    expect(root.querySelector('.empty-state-action button')?.textContent).toBe('Run');
    expect(root.querySelector('.empty-state-icon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts a hint without an action, and an action without a hint', () => {
    render(
      <>
        <EmptyState title="A" hint="hint only" />
        <EmptyState title="B" action={<a href="#/agents">Go</a>} />
      </>,
    );
    const [a, b] = [...container.querySelectorAll('.empty-state')];
    expect(a.querySelector('.empty-state-action')).toBeNull();
    expect(b.querySelector('.empty-state-hint')).toBeNull();
  });

  it('requires a hint or an action at compile time', () => {
    // @ts-expect-error - a title alone is not enough: say what to do next.
    const bare = <EmptyState title="Nothing" />;
    expect(bare).toBeTruthy();
  });
});

describe('Toast', () => {
  let api: ReturnType<typeof useToast>;
  function Grab() {
    api = useToast();
    return null;
  }
  const renderToasts = () =>
    render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    );
  const toasts = () => [...container.querySelectorAll('.toast')] as HTMLElement[];
  const politeRegion = () => container.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;

  it('shows a toast in the one polite live region and auto-dismisses it after 5 s', () => {
    vi.useFakeTimers();
    renderToasts();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    act(() => void api.show({ message: 'Saved', tone: 'success' }));
    expect(politeRegion().textContent).toContain('Saved');
    expect(toasts()[0].classList.contains('toast-success')).toBe(true);
    act(() => void vi.advanceTimersByTime(4999));
    expect(toasts()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(toasts()).toHaveLength(0);
  });

  it('keeps error toasts as alerts until dismissed', () => {
    vi.useFakeTimers();
    renderToasts();
    act(() => void api.show({ message: 'Save failed', tone: 'error' }));
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Save failed');
    expect(politeRegion().textContent).not.toContain('Save failed');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(toasts()).toHaveLength(1);
    const close = alert.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement;
    act(() => close.click());
    expect(toasts()).toHaveLength(0);
  });

  it('dismisses by id and runs an action, which also dismisses', () => {
    vi.useFakeTimers();
    renderToasts();
    const onClick = vi.fn();
    let first = '';
    act(() => {
      first = api.show({ message: 'one' });
      api.show({ message: 'two', action: { label: 'Undo', onClick } });
    });
    expect(toasts()).toHaveLength(2);
    expect(toasts()[0].classList.contains('toast-info')).toBe(true);
    act(() => api.dismiss(first));
    expect(toasts().map((t) => t.querySelector('.toast-message')?.textContent)).toEqual(['two']);
    const undo = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Undo') as HTMLButtonElement;
    act(() => undo.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(toasts()).toHaveLength(0);
  });

  it('throws a clear error when useToast is used outside a ToastProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Grab />)).toThrow(/useToast must be used inside a <ToastProvider>/);
    spy.mockRestore();
  });
});
