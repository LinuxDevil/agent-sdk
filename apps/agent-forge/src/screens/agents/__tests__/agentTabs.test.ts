import { describe, expect, it } from 'vitest';
import { agentListPath, agentRedirect, agentTabItems, agentTabPath, isAgentTab } from '../agentTabs';

describe('agentTabPath / agentListPath / isAgentTab', () => {
  it('builds /agents/<encoded id>/<tab> while no workspace is known', () => {
    // No '#/w/…' hash and no launch id in this file: the legacy shape comes out.
    expect(agentTabPath('a b', 'runs')).toBe('/agents/a%20b/runs');
    expect(agentTabPath('support-bot', 'canvas')).toBe('/agents/support-bot/canvas');
    expect(isAgentTab('runs')).toBe(true);
    expect(isAgentTab('nope')).toBe(false);
  });

  it('scopes the path to an explicit or URL workspace', () => {
    expect(agentTabPath('a b', 'runs', 'app-1a2b3c')).toBe('/w/app-1a2b3c/agents/a%20b/runs');
    window.location.hash = '#/w/proj-def456/agents';
    try {
      expect(agentTabPath('x', 'overview')).toBe('/w/proj-def456/agents/x/overview');
      expect(agentListPath()).toBe('/agents'); // agentListPath takes the workspace explicitly
      expect(agentListPath('proj-def456')).toBe('/w/proj-def456/agents');
    } finally {
      window.location.hash = '';
    }
  });

  it('agentListPath is the all-workspaces list without a workspace', () => {
    expect(agentListPath()).toBe('/agents');
    expect(agentListPath(undefined)).toBe('/agents');
  });
});

describe('agentRedirect', () => {
  const LAUNCH = 'launch-abc123';

  it('sends legacy /agents/:id… URLs into the launch workspace', () => {
    expect(agentRedirect('#/agents/x', LAUNCH)).toBe('/w/launch-abc123/agents/x/canvas');
    expect(agentRedirect('#/agents/x?y=1', LAUNCH)).toBe('/w/launch-abc123/agents/x/canvas?y=1');
    expect(agentRedirect('#/agents/x/bogus', LAUNCH)).toBe('/w/launch-abc123/agents/x/canvas');
    expect(agentRedirect('#/agents/x/overview', LAUNCH)).toBe('/w/launch-abc123/agents/x/overview');
    expect(agentRedirect('#/agents/x/canvas', LAUNCH)).toBe('/w/launch-abc123/agents/x/canvas');
  });

  it('waits (null) on legacy URLs while the launch id is unknown', () => {
    expect(agentRedirect('#/agents/x', undefined)).toBeNull();
    expect(agentRedirect('#/agents/x/overview', undefined)).toBeNull();
  });

  it('settles workspace-scoped URLs inside their own workspace', () => {
    expect(agentRedirect('#/w/app-1a2b3c/agents/x', LAUNCH)).toBe('/w/app-1a2b3c/agents/x/canvas');
    expect(agentRedirect('#/w/app-1a2b3c/agents/x?y=1', LAUNCH)).toBe('/w/app-1a2b3c/agents/x/canvas?y=1');
    expect(agentRedirect('#/w/app-1a2b3c/agents/x/bogus', LAUNCH)).toBe('/w/app-1a2b3c/agents/x/canvas');
    // Built tabs and the bare list stay put.
    expect(agentRedirect('#/w/app-1a2b3c/agents/x/canvas', LAUNCH)).toBeNull();
    expect(agentRedirect('#/w/app-1a2b3c/agents/x/overview', LAUNCH)).toBeNull();
    expect(agentRedirect('#/w/app-1a2b3c/agents', LAUNCH)).toBeNull();
  });

  it('sends an invalid workspace id back to the all-workspaces list', () => {
    expect(agentRedirect('#/w/NOT!/agents', LAUNCH)).toBe('/agents');
    expect(agentRedirect('#/w/NOT!/agents/x/canvas', LAUNCH)).toBe('/agents');
    expect(agentRedirect('#/w/app-1a2b3c-extra/agents', LAUNCH)).toBe('/agents');
  });

  it('leaves non-agents routes alone', () => {
    expect(agentRedirect('#/traces', LAUNCH)).toBeNull();
    expect(agentRedirect('#/agents', LAUNCH)).toBeNull();
    expect(agentRedirect('', LAUNCH)).toBeNull();
  });
});

describe('agentTabItems counts', () => {
  it('puts the count pill on the named tab only, and hides a zero count', () => {
    const items = agentTabItems('x', { suggestions: 1 });
    expect(items.find((i) => i.id === 'suggestions')?.count).toBe(1);
    expect(items.find((i) => i.id === 'versions')?.count).toBeUndefined();
    expect(agentTabItems('x', { suggestions: 0 }).find((i) => i.id === 'suggestions')?.count).toBeUndefined();
    expect(agentTabItems('x').find((i) => i.id === 'suggestions')?.count).toBeUndefined();
  });
});
