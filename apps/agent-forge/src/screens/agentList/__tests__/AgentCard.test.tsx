import { describe, expect, it, vi } from 'vitest';

import { AgentCard, lastRunLabel, type AgentCardAgent } from '../AgentCard';
import { render } from '../../../ui/__tests__/render';

const NOW = Date.parse('2026-10-29T12:00:00Z');

const agent: AgentCardAgent = {
  id: 'support-bot',
  name: 'Support bot',
  description: 'Answers billing questions.',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: ['billing', 'tier-1', 'eu', 'vip', 'beta'],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: 3,
  lastRun: { status: 'error', at: '2026-10-29T11:57:00Z', traceId: 't1' },
  counts: { tools: 3, mcpServers: 1, subagents: 0 },
};

function setup(overrides: Partial<AgentCardAgent> = {}, props: { toggling?: boolean } = {}) {
  const onOpen = vi.fn();
  const onToggleEnabled = vi.fn();
  const host = render(
    <AgentCard
      agent={{ ...agent, ...overrides }}
      onOpen={onOpen}
      onToggleEnabled={onToggleEnabled}
      now={NOW}
      toggling={props.toggling}
    />
  );
  return { host, onOpen, onToggleEnabled };
}

describe('AgentCard', () => {
  it('labels the article by the agent name and links the name to the overview tab', () => {
    const { host } = setup();
    const article = host.querySelector('article.agent-card')!;
    const name = document.getElementById(article.getAttribute('aria-labelledby')!)!;
    expect(name.textContent).toBe('Support bot');
    const link = host.querySelector<HTMLAnchorElement>('a.agent-card-link')!;
    expect(link.getAttribute('href')).toBe('#/agents/support-bot/overview');
  });

  it('shows the model chip and the published version badge', () => {
    const { host } = setup();
    const model = host.querySelector('.agent-card-model')!;
    expect(model.textContent).toBe('anthropic/claude-sonnet-5-5');
    expect(model.getAttribute('title')).toBe('anthropic/claude-sonnet-5-5');
    expect(host.querySelector('.status-badge-label')!.textContent).toBe('v3');
  });

  it('renders the On switch and toggles without opening the agent', () => {
    const { host, onOpen, onToggleEnabled } = setup();
    const sw = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-label')).toBe('Support bot enabled');
    expect(host.querySelector('.agent-card-state')!.textContent).toBe('On');
    sw.click();
    expect(onToggleEnabled).toHaveBeenCalledWith('support-bot', false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens the agent from the name link and prevents the default hash navigation', () => {
    const { host, onOpen } = setup();
    const link = host.querySelector<HTMLAnchorElement>('a.agent-card-link')!;
    link.click();
    expect(onOpen).toHaveBeenCalledWith('support-bot');
    expect(window.location.hash).not.toBe('#/agents/support-bot/overview');
  });

  it('shows three labels plus a +N chip naming the hidden ones', () => {
    const { host } = setup();
    const labels = [...host.querySelectorAll('.agent-card-label')];
    expect(labels).toHaveLength(3);
    const more = host.querySelector('.agent-card-label-more')!;
    expect(more.textContent).toBe('+2');
    expect(more.getAttribute('title')).toBe('vip, beta');
  });

  it('renders only the non-zero capability chips', () => {
    const { host } = setup();
    const caps = [...host.querySelectorAll('.agent-card-cap')].map((c) => c.textContent);
    expect(caps).toEqual(['3 tools', '1 MCP server']);
    expect(host.querySelector('.agent-card-cap-violet')).toBeNull();
  });

  it('renders the violet subagent chip with the right plural', () => {
    const { host } = setup({ counts: { tools: 1, mcpServers: 2, subagents: 2 } });
    const caps = [...host.querySelectorAll('.agent-card-cap')];
    expect(caps.map((c) => c.textContent)).toEqual(['1 tool', '2 MCP servers', '2 subagents']);
    expect(caps[2].classList.contains('agent-card-cap-violet')).toBe(true);
  });

  it('shows the last run status, age and updated age in the footer', () => {
    const { host } = setup();
    const foot = host.querySelector('.agent-card-foot')!;
    expect(foot.textContent).toContain('Last run failed');
    expect(foot.querySelector('.status-dot.status-tone-danger')).not.toBeNull();
    const times = [...foot.querySelectorAll('time')];
    expect(times[0].textContent).toBe('3m ago');
    expect(times[0].getAttribute('dateTime')).toBe('2026-10-29T11:57:00Z');
    expect(host.querySelector('.agent-card-updated time')!.textContent).toBe('1h ago');
    expect(host.querySelector('.agent-card-updated')!.textContent).toContain('Updated');
  });

  it('greys only the tile and keeps full contrast when the agent is off', () => {
    const { host } = setup({ enabled: false });
    const article = host.querySelector('article.agent-card')!;
    expect(article.classList.contains('agent-card-off')).toBe(true);
    expect(host.querySelector('.agent-tile')!.classList.contains('agent-tile-muted')).toBe(true);
    expect(host.querySelector('.agent-card-state')!.textContent).toBe('Off');
    for (const el of host.querySelectorAll<HTMLElement>('[style]')) {
      expect(el.style.opacity).not.toBe('0.6');
    }
  });

  it('shows Never run, no caps and no description paragraph when those are absent', () => {
    const { host } = setup({ lastRun: undefined, counts: undefined, description: '' });
    expect(host.querySelector('.agent-card-never')!.textContent).toBe('Never run');
    expect(host.querySelector('.agent-card-caps')).toBeNull();
    expect(host.querySelector('p.agent-card-description')).toBeNull();
  });

  it('disables the switch while a toggle is in flight', () => {
    const { host } = setup({}, { toggling: true });
    const sw = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.disabled).toBe(true);
  });

  it('omits the time element when a timestamp does not parse', () => {
    const { host } = setup({ lastRun: { status: 'done', at: 'not-a-date' } });
    const foot = host.querySelector('.agent-card-foot')!;
    expect(foot.textContent).toContain('Last run succeeded');
    // The unparseable run time is omitted; only the valid "Updated" time remains.
    expect(foot.querySelector('time[dateTime="not-a-date"]')).toBeNull();
    expect(foot.querySelectorAll('time')).toHaveLength(1);
  });
});

describe('lastRunLabel', () => {
  it.each([
    ['done', 'Last run succeeded'],
    ['ok', 'Last run succeeded'],
    ['error', 'Last run failed'],
    ['running', 'Running now'],
    ['paused', 'Waiting on you'],
    ['idle', 'Last run'],
  ])('maps %s to "%s"', (status, label) => {
    expect(lastRunLabel(status)).toBe(label);
  });
});
