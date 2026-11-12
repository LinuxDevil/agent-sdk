import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSummary } from 'lousho/workspaces/client';

import { WorkspacesScreen } from '../WorkspacesScreen';
import type { ScreenHeaderProps } from '../../../shell/ScreenHeader';
import { WorkspaceApiError } from 'lousho/workspaces/client';
import { buttonByName, click, flush, renderWithClient, spyClient } from './workspaceTestKit';

vi.mock('../../../shell/ScreenHeader', () => ({
  ScreenHeader: ({ title, description, actions }: ScreenHeaderProps) => (
    <header className="test-screen-header">
      <h1>{title}</h1>
      <p>{description}</p>
      {actions}
    </header>
  ),
}));

const ROW_A: WorkspaceSummary = { id: 'alpha', name: 'Alpha', revision: 'rev-a', pageCount: 1, hasMainAgent: false };
const ROW_B: WorkspaceSummary = { id: 'beta', name: 'Beta', domain: 'beta-domain', revision: 'rev-b', pageCount: 2, hasMainAgent: true };

beforeEach(() => {
  window.location.hash = '#/workspaces';
});

describe('WorkspacesScreen', () => {
  it('lists the fixture workspace with its page count and status', async () => {
    const client = spyClient();
    const container = renderWithClient(<WorkspacesScreen />, client);
    await flush();
    expect(container.textContent).toContain('Marketing');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('Valid');
    expect(container.textContent).toContain('rev-7d6e6f2ce202');
  });

  it('j/k moves between rows', async () => {
    const client = spyClient({ listWorkspaces: () => [ROW_A, ROW_B] });
    const container = renderWithClient(<WorkspacesScreen />, client);
    await flush();
    const rows = [...container.querySelectorAll('tbody tr[data-row-index]')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    act(() => rows[0].focus());
    act(() => {
      rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);
  });

  it('the q filter hides rows that do not match', async () => {
    window.location.hash = '#/workspaces?q=zzz';
    const client = spyClient();
    const container = renderWithClient(<WorkspacesScreen />, client);
    await flush();
    expect(container.textContent).toContain('No workspaces yet');
  });

  it('a load failure offers Retry', async () => {
    const client = spyClient({ listWorkspaces: () => { throw new WorkspaceApiError('down', 503); } });
    const container = renderWithClient(<WorkspacesScreen />, client);
    await flush();
    expect(container.textContent).toContain('Could not load workspaces');
    click(buttonByName(container, 'Retry'));
    await flush();
    expect(client.callsTo('listWorkspaces')).toHaveLength(2);
  });
});
