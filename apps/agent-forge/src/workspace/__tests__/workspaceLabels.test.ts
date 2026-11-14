import { describe, expect, it } from 'vitest';

import type { WorkspaceListItem } from '../../../shared/wireTypes';
import { switcherSelection, workspaceLabel } from '../workspaceLabels';

const ws = (id: string, name: string): WorkspaceListItem => ({
  id,
  name,
  root: `/code/${name}`,
  addedAt: '2025-01-01T00:00:00Z',
  lastOpenedAt: '2025-01-01T00:00:00Z',
  isLaunch: false,
  available: true,
  agentCount: 0,
  observeProject: 'default',
});

const LIST = [ws('app-1a2b3c', 'support-bot'), ws('proj-def456', 'billing')];

describe('workspaceLabel', () => {
  it('is "All workspaces" with no id, the item name when known, the id otherwise', () => {
    expect(workspaceLabel(undefined, LIST)).toBe('All workspaces');
    expect(workspaceLabel('app-1a2b3c', LIST)).toBe('support-bot');
    expect(workspaceLabel('gone-000000', LIST)).toBe('gone-000000');
    expect(workspaceLabel('app-1a2b3c', undefined)).toBe('app-1a2b3c');
  });
});

describe('switcherSelection', () => {
  it('is the /w/<ws>/ URL workspace, undefined everywhere else', () => {
    expect(switcherSelection('#/w/app-1a2b3c/agents/x/runs')).toBe('app-1a2b3c');
    expect(switcherSelection('#/agents')).toBeUndefined();
    expect(switcherSelection('#/traces')).toBeUndefined();
    expect(switcherSelection('#/w/not%20valid/agents')).toBeUndefined();
    expect(switcherSelection('')).toBeUndefined();
  });
});
