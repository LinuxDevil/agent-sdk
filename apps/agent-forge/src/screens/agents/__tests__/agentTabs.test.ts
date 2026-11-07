import { describe, expect, it } from 'vitest';
import { agentRedirect, agentTabPath, isAgentTab } from '../agentTabs';

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
    // `suggestions` is the last tab to be built (R06), so this case survives A05-A11.
    expect(agentRedirect('#/agents/x/suggestions')).toBe('/agents/x/canvas');
    expect(agentRedirect('#/agents/x/bogus')).toBe('/agents/x/canvas');
  });
  it('leaves the canvas tab and every non-agents route alone', () => {
    expect(agentRedirect('#/agents/x/canvas')).toBeNull();
    expect(agentRedirect('#/agents/x/canvas?y=1')).toBeNull();
    expect(agentRedirect('#/agents')).toBeNull();
    expect(agentRedirect('#/traces')).toBeNull();
  });
});
