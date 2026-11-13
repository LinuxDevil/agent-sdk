import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PortabilityAnalysis, PortabilityFinding } from '../../../../../shared/wireTypes';
import { render } from '../../../../ui/__tests__/render';
import { RuntimeApiError } from '../../../../runtime/runtimeClient';
import { PortabilityPanel } from '../PortabilityPanel';

function finding(over: Partial<PortabilityFinding> = {}): PortabilityFinding {
  return {
    location: 'instructions',
    kind: 'email_address',
    quote: 'email me at ops@acme.com',
    explanation: 'A personal email address is baked into the instructions.',
    suggestion: 'Replace with [YOUR EMAIL].',
    ...over,
  };
}

function analysis(over: Partial<PortabilityAnalysis> = {}): PortabilityAnalysis {
  return {
    kind: 'portability',
    id: 'portability-abc123',
    agentId: 'support-bot',
    specHash: 'sha256:abc123',
    summary: '1 hard-coded detail found.',
    findings: [finding()],
    adaptedInstructions: null,
    model: 'test-model',
    createdAt: '2026-10-29T12:00:00Z',
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const panel = () => document.querySelector<HTMLElement>('.portability')!;
const button = (label: string) =>
  [...panel().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

describe('PortabilityPanel', () => {
  it('goes idle → loading → findings and reports the analysis', async () => {
    const pending = deferred<PortabilityAnalysis>();
    const run = vi.fn(() => pending.promise);
    const onAnalysis = vi.fn();
    render(<PortabilityPanel run={run} onAnalysis={onAnalysis} />);

    expect(panel().getAttribute('aria-live')).toBe('polite');
    expect(document.getElementById('portability-title')?.textContent).toBe('Hard-coded details');
    expect(onAnalysis).not.toHaveBeenCalled();

    await click(button('Check for hard-coded details'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(panel().textContent).toContain('Checking…');
    expect(onAnalysis).toHaveBeenLastCalledWith(undefined);

    const result = analysis({ adaptedInstructions: 'email me at [YOUR EMAIL]' });
    await act(async () => {
      pending.resolve(result);
      await Promise.resolve();
    });

    expect(panel().textContent).toContain('1 hard-coded detail found.');
    expect(panel().textContent).toContain('ops@acme.com');
    expect(panel().textContent).toContain('A personal email address is baked into the instructions.');
    expect(panel().textContent).toContain('Replace with [YOUR EMAIL].');
    expect(button('Check again')).toBeTruthy();
    expect(onAnalysis).toHaveBeenLastCalledWith(result);
  });

  it('shows the empty state when nothing is hard-coded', async () => {
    const run = vi.fn(async () => analysis({ findings: [], summary: 'Nothing to adapt.' }));
    render(<PortabilityPanel run={run} />);
    await click(button('Check for hard-coded details'));
    expect(panel().querySelector('.portability-none')?.textContent).toBe(
      'Nothing hard-coded found. Nothing to adapt.'
    );
    expect(panel().querySelector('.portability-findings')).toBeNull();
  });

  it('labels every location and kind, and marks secrets danger', async () => {
    const findings: PortabilityFinding[] = [
      finding({ location: 'instructions', kind: 'repository' }),
      finding({ location: 'triggers', kind: 'channel' }),
      finding({ location: 'tools', kind: 'path' }),
      finding({ location: 'mcpServers', kind: 'host' }),
      finding({ location: 'hooks', kind: 'person' }),
      finding({ location: 'other', kind: 'url' }),
      finding({ location: 'instructions', kind: 'secret' }),
      finding({ location: 'other', kind: 'other' }),
    ];
    const run = vi.fn(async () => analysis({ findings }));
    render(<PortabilityPanel run={run} />);
    await click(button('Check for hard-coded details'));

    const cards = [...panel().querySelectorAll('.portability-finding')];
    expect(cards).toHaveLength(8);
    const labels = (card: Element) =>
      [...card.querySelectorAll('.portability-finding-tags .chip')].map((c) => c.textContent);
    expect(labels(cards[0])).toEqual(['Instructions', 'Repository']);
    expect(labels(cards[1])).toEqual(['Triggers', 'Channel']);
    expect(labels(cards[2])).toEqual(['Tools', 'Path']);
    expect(labels(cards[3])).toEqual(['MCP servers', 'Host']);
    expect(labels(cards[4])).toEqual(['Hooks', 'Person']);
    expect(labels(cards[5])).toEqual(['Other', 'URL']);
    expect(labels(cards[7])).toEqual(['Other', 'Other']);
    const secretChips = cards[6].querySelectorAll('.chip[data-tone="danger"]');
    expect(secretChips).toHaveLength(1);
    expect(secretChips[0].textContent).toBe('Secret');
    expect(cards[0].querySelector('.chip[data-tone="danger"]')).toBeNull();
  });

  it.each([
    ['LOUSHO_PASS_UNAVAILABLE', 'The portability pass is not available.'],
    ['LOUSHO_PASS_REFUSED', 'The model refused the check.'],
    ['LOUSHO_SCHEMA', 'bad output'],
  ])('shows the %s error without a retry button', async (code, message) => {
    const run = vi.fn(async () => {
      throw new RuntimeApiError(message, 400, code);
    });
    const onAnalysis = vi.fn();
    render(<PortabilityPanel run={run} onAnalysis={onAnalysis} />);
    await click(button('Check for hard-coded details'));

    expect(panel().querySelector('.portability-error')?.textContent).toContain(message);
    expect(panel().querySelector('.portability-error')?.getAttribute('role')).toBe('alert');
    expect([...panel().querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Try again');
    expect(onAnalysis).toHaveBeenLastCalledWith(undefined);
  });

  it('offers Try again only for LOUSHO_PASS_FAILED and re-runs on click', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeApiError('model timed out', 502, 'LOUSHO_PASS_FAILED'))
      .mockResolvedValueOnce(analysis());
    render(<PortabilityPanel run={run} />);
    await click(button('Check for hard-coded details'));

    expect(panel().querySelector('.portability-error')?.textContent).toContain('model timed out');
    await click(button('Try again'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(panel().textContent).toContain('1 hard-coded detail found.');
  });
});
