import { describe, expect, it } from 'vitest';
import { agentRedirect, agentTabItems, agentTabPath, isAgentTab } from '../agentTabs';

describe('agentTabPath / isAgentTab', () => {
  it('builds /agents/<encoded id>/<tab> and knows the tab names', () => {
    expect(agentTabPath('a b', 'runs')).toBe('/agents/a%20b/runs');
    expect(agentTabPath('support-bot', 'canvas')).toBe('/agents/support-bot/canvas');
    expect(isAgentTab('runs')).toBe(true);
    expect(isAgentTab('nope')).toBe(false);
  });
});

describe('agentRedirect', () => {
  it('sends the legacy builder URL and unbuilt or unknown tabs to canvas', () => {
    expect(agentRedirect('#/agents/x')).toBe('/agents/x/canvas');
    expect(agentRedirect('#/agents/x?y=1')).toBe('/agents/x/canvas?y=1');
    expect(agentRedirect('#/agents/x/bogus')).toBe('/agents/x/canvas');
  });
  it('leaves the canvas tab and every non-agents route alone', () => {
    expect(agentRedirect('#/agents/x/canvas')).toBeNull();
    expect(agentRedirect('#/agents/x/canvas?y=1')).toBeNull();
    // 'runs' (A11) and 'suggestions' (L11b) are built; unknown tabs redirect.
    expect(agentRedirect('#/agents/x/runs')).toBeNull();
    expect(agentRedirect('#/agents/x/suggestions')).toBeNull();
    expect(agentRedirect('#/agents')).toBeNull();
    expect(agentRedirect('#/traces')).toBeNull();
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
