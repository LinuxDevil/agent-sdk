import { describe, expect, it } from 'vitest';

import type { WorkspaceListItem } from '../../../../shared/wireTypes';
import { projectWorkspaceNames, workspaceProjects } from '../workspaceProjects';

const ws = (id: string, name: string, observeProject: string): WorkspaceListItem => ({
  id,
  name,
  root: `/${id}`,
  addedAt: '',
  lastOpenedAt: '',
  isLaunch: false,
  available: true,
  agentCount: 0,
  observeProject,
});

describe('workspaceProjects / projectWorkspaceNames (W09b)', () => {
  it('lists workspaces with their observe projects', () => {
    const list = [ws('a-1a2b3c', 'Alpha', 'shop'), ws('b-2b3c4d', 'Beta', 'ci')];
    expect(workspaceProjects(list)).toEqual([
      { workspaceId: 'a-1a2b3c', workspaceName: 'Alpha', project: 'shop' },
      { workspaceId: 'b-2b3c4d', workspaceName: 'Beta', project: 'ci' },
    ]);
  });

  it('maps project → workspace name, first wins on a shared project', () => {
    const list = [ws('a-1a2b3c', 'Alpha', 'shop'), ws('b-2b3c4d', 'Beta', 'shop'), ws('c-3c4d5e', 'Gamma', 'ci')];
    const names = projectWorkspaceNames(list);
    expect(names.get('shop')).toBe('Alpha');
    expect(names.get('ci')).toBe('Gamma');
  });

  it('handles an undefined or empty list', () => {
    expect(workspaceProjects(undefined)).toEqual([]);
    expect(projectWorkspaceNames(undefined).size).toBe(0);
  });
});
