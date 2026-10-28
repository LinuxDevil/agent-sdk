import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunStatusPayload, SpanEvent } from '../../../shared/wireTypes';

const appState = vi.hoisted(() => ({
  runStatus: undefined as AgentRunStatusPayload | undefined,
  spans: [] as SpanEvent[],
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { render } from '../../ui/__tests__/render';
import { RunStatus } from '../RunStatus';

const status = (s: AgentRunStatusPayload['status'], over: Partial<AgentRunStatusPayload> = {}): AgentRunStatusPayload => ({
  agentId: 'bot',
  status: s,
  updatedAt: '',
  ...over,
});
const link = (container: HTMLElement) => container.querySelector('a') as HTMLAnchorElement | null;

beforeEach(() => {
  appState.runStatus = undefined;
  appState.spans = [];
});

describe('RunStatus', () => {
  it('is an idle pill with no trace link before any run', () => {
    const container = render(<RunStatus />);
    expect(container.querySelector('.status-pill')?.textContent).toContain('idle');
    expect(link(container)).toBeNull();
  });

  it("shows the last run's status and links to its trace", () => {
    appState.runStatus = status('done', { traceId: 'trace-42' });
    const container = render(<RunStatus />);
    expect(container.querySelector('.status-pill')?.textContent).toContain('done');
    expect(link(container)?.getAttribute('href')).toBe('#/traces/trace-42');
    expect(link(container)?.textContent).toBe('Open trace');
  });

  it('falls back to the live root span while the status has no trace id yet', () => {
    appState.runStatus = status('running');
    appState.spans = [
      { id: 'child', name: 'chat', parentId: 'root-1', startTime: 2, attributes: {} },
      { id: 'root-1', name: 'invoke_agent', startTime: 1, attributes: {} },
    ];
    const container = render(<RunStatus />);
    expect(link(container)?.getAttribute('href')).toBe('#/traces/root-1');
  });

  it('labels a paused run as awaiting approval', () => {
    appState.runStatus = status('paused', { traceId: 't' });
    const container = render(<RunStatus />);
    expect(container.querySelector('.status-pill')?.textContent).toContain('awaiting approval');
  });
});
