import { describe, expect, it } from 'vitest';

import { parseWorkspacesQuery, workspacePath, workspacesHref } from '../workspacesUrl';

describe('workspacesUrl', () => {
  it('round-trips q and drops an empty one', () => {
    expect(parseWorkspacesQuery(new URLSearchParams('q=market'))).toEqual({ q: 'market' });
    expect(workspacesHref({})).toBe('/workspaces');
    expect(workspacesHref({ q: 'a b' })).toBe('/workspaces?q=a+b');
  });

  it('builds section paths and encodes ids', () => {
    expect(workspacePath('marketing', 'pages')).toBe('/workspaces/marketing/pages');
    expect(workspacePath('my workspace')).toBe('/workspaces/my%20workspace');
  });
});
