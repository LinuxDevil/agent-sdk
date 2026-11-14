import { describe, expect, it, vi } from 'vitest';

// The Workspace column maps observe projects through the registered
// workspaces: 'shop' -> Alpha, 'ci' -> Beta; anything else is "Elsewhere".
vi.mock('../../../workspace/WorkspacesProvider', () => ({
  useWorkspacesMaybe: () => ({
    list: [
      { id: 'alpha-a1b2c3', name: 'Alpha', root: '/a', addedAt: '', lastOpenedAt: '', isLaunch: true, available: true, agentCount: 1, observeProject: 'shop' },
      { id: 'beta-b2c3d4', name: 'Beta', root: '/b', addedAt: '', lastOpenedAt: '', isLaunch: false, available: true, agentCount: 1, observeProject: 'ci' },
    ],
    launchId: 'alpha-a1b2c3',
    activeId: 'alpha-a1b2c3',
    error: undefined,
    refresh: async () => {},
  }),
  useWorkspaces: () => {
    throw new Error('unused');
  },
}));

import type { ObserveAgentRow } from '../../../observe/types';
import { render } from '../../../ui/__tests__/render';
import { FleetTable } from '../FleetTable';

const NOW = Date.UTC(2026, 9, 25, 12, 30);

function agent(over: Partial<ObserveAgentRow> & { agent_id: string }): ObserveAgentRow {
  return {
    project: null,
    name: over.agent_id,
    version: null,
    first_seen: NOW - 3_600_000,
    last_heartbeat: NOW - 5_000,
    status: 'healthy',
    heartbeat_age_ms: 5_000,
    heartbeat_interval_ms: 30_000,
    hostname: null,
    pid: null,
    dropped: null,
    runs_today: 0,
    error_rate_today: 0,
    ...over,
  };
}

const AGENTS = [
  agent({ agent_id: 'a1', name: 'Shop bot', project: 'shop' }),
  agent({ agent_id: 'a2', name: 'CI bot', project: 'ci' }),
  agent({ agent_id: 'a3', name: 'Nightly', project: 'nightly' }),
  agent({ agent_id: 'a4', name: 'No project', project: null }),
];

/** The Workspace cell (second column) of the row whose agent cell names `label`. */
function workspaceCell(container: HTMLElement, label: string): string | null {
  const row = [...container.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(label));
  return row?.querySelectorAll('td')[1]?.textContent ?? null;
}

describe('FleetTable Workspace column (W09b)', () => {
  it('maps known projects to workspace names and everything else to Elsewhere', () => {
    const container = render(<FleetTable agents={AGENTS} insights={undefined} loading={false} />);
    expect(workspaceCell(container, 'Shop bot')).toBe('Alpha');
    expect(workspaceCell(container, 'CI bot')).toBe('Beta');
    expect(workspaceCell(container, 'Nightly')).toBe('Elsewhere');
    expect(workspaceCell(container, 'No project')).toBe('Elsewhere');
  });
});
