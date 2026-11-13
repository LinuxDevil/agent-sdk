import { describe, expect, it } from 'vitest';

import type { CodeAgentItem } from '../../../../shared/wireTypes';
import { CodeAgentCard } from '../CodeAgentCard';
import { render } from '../../../ui/__tests__/render';

const agent = (over: Partial<CodeAgentItem> = {}): CodeAgentItem => ({
  kind: 'code',
  id: 'agents/support',
  name: 'support',
  workspaceId: 'alpha-1a2b3c',
  configFile: 'agent.ts',
  configKind: 'code',
  ...over,
});

function mount(item: CodeAgentItem, workspaceName?: string) {
  return render(<CodeAgentCard agent={item} workspaceName={workspaceName} />);
}

describe('CodeAgentCard', () => {
  it('renders the name, "In code" chip, path, config file and read-only footer', () => {
    const host = mount(agent());
    const card = host.querySelector('article.agent-card--code')!;
    expect(card.textContent).toContain('support');
    expect(card.textContent).toContain('In code');
    expect(card.querySelector('code')?.textContent).toBe('agents/support');
    expect(card.textContent).toContain('agent.ts');
    expect(card.textContent).toContain('Read-only. Edit the files to change it.');
    expect(card.querySelector('[role="switch"]')).toBeNull();
  });

  it('links the whole card to the workspace-scoped code canvas with a "defined in code" aria-label', () => {
    const host = mount(agent());
    const link = host.querySelector<HTMLAnchorElement>('.agent-card-link')!;
    // The '/' in the path is encodeURIComponent'd into ONE segment.
    expect(link.getAttribute('href')).toBe('#/w/alpha-1a2b3c/code-agents/agents%2Fsupport');
    expect(link.getAttribute('aria-label')).toBe('support, defined in code');
  });

  it('renders the workspace chip only when a workspace name is given', () => {
    const named = mount(agent(), 'Alpha');
    expect(named.querySelector('.agent-card-workspace')?.textContent).toContain('Alpha');
    const bare = mount(agent());
    expect(bare.querySelector('.agent-card-workspace')).toBeNull();
  });
});
