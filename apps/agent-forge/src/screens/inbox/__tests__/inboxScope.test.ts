import { describe, expect, it } from 'vitest';

import { inboxPath, inboxScopeFromHash } from '../inboxScope';

describe('inboxScopeFromHash', () => {
  it('reads #/inbox as the all-workspaces scope', () => {
    expect(inboxScopeFromHash('#/inbox')).toEqual({ kind: 'all' });
    expect(inboxScopeFromHash('#/inbox?x=1')).toEqual({ kind: 'all' });
    expect(inboxScopeFromHash('')).toEqual({ kind: 'all' });
  });

  it('reads #/w/<ws>/inbox as that workspace’s scope', () => {
    expect(inboxScopeFromHash('#/w/app-1a2b3c/inbox')).toEqual({ kind: 'workspace', workspaceId: 'app-1a2b3c' });
    expect(inboxScopeFromHash('#/w/app-1a2b3c/inbox?foo=bar')).toEqual({ kind: 'workspace', workspaceId: 'app-1a2b3c' });
  });

  it('falls back to all for other routes and malformed workspace ids', () => {
    expect(inboxScopeFromHash('#/w/app-1a2b3c/agents')).toEqual({ kind: 'all' });
    expect(inboxScopeFromHash('#/w/not-an-id/inbox')).toEqual({ kind: 'all' });
    expect(inboxScopeFromHash('#/w/app-1a2b3c/inbox/extra')).toEqual({ kind: 'all' });
    expect(inboxScopeFromHash('#/traces')).toEqual({ kind: 'all' });
  });
});

describe('inboxPath', () => {
  it('builds the scoped and aggregate paths', () => {
    expect(inboxPath()).toBe('/inbox');
    expect(inboxPath('app-1a2b3c')).toBe('/w/app-1a2b3c/inbox');
  });
});
