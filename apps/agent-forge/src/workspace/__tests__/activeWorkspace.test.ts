import { describe, it, expect, beforeEach } from 'vitest';
import { activeWorkspace, setLaunchWorkspace, workspaceFromHash } from '../activeWorkspace';

describe('workspaceFromHash', () => {
  it.each([
    ['#/w/app-1a2b3c/agents', 'app-1a2b3c'],
    ['#/w/app-1a2b3c', 'app-1a2b3c'],
    ['#/w/app-1a2b3c/agents/x/canvas', 'app-1a2b3c'],
    // A percent-encoded '-' still decodes to a valid id.
    ['#/w/app%2D1a2b3c/x', 'app-1a2b3c'],
  ])('%s → %s', (hash, id) => {
    expect(workspaceFromHash(hash)).toBe(id);
  });

  it.each([
    '#/agents',
    '#/w/app-1a2b3c-extra/agents', // does not end in -<6 hex>
    '#/w/BAD/agents',
    '#/w//agents',
    '#/w',
    '',
    '#/x/w/app-1a2b3c',
  ])('%s → undefined', (hash) => {
    expect(workspaceFromHash(hash)).toBeUndefined();
  });
});

describe('activeWorkspace', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('is undefined before the launch id is known and the hash names no workspace', () => {
    // Runs first in the file: no setLaunchWorkspace call has happened yet.
    window.location.hash = '#/agents';
    expect(activeWorkspace()).toBeUndefined();
  });

  it('is the launch id on a workspace-less hash once GET /workspaces answered', () => {
    setLaunchWorkspace('launch-abc123');
    window.location.hash = '#/agents';
    expect(activeWorkspace()).toBe('launch-abc123');
  });

  it('prefers the URL workspace over the launch id', () => {
    window.location.hash = '#/w/proj-abc123/agents';
    expect(activeWorkspace()).toBe('proj-abc123');
  });

  it('falls back to the launch id on a malformed #/w/ hash', () => {
    window.location.hash = '#/w/BAD/agents';
    expect(activeWorkspace()).toBe('launch-abc123');
  });
});
