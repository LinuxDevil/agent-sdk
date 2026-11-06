import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import type { ProposalOutput } from '../../../shared/authorWire';
import { ProposalCard, SPEC_FIELD_LABELS } from '../ProposalCard';
import { render } from '../../ui/__tests__/render';

const probe = vi.hoisted(() => vi.fn());
vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: { probeMcp: probe },
  RuntimeApiError: class RuntimeApiError extends Error {},
}));

function output(over: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    ok: true,
    proposalId: 'prop-1',
    kind: 'create',
    spec: {
      version: 2,
      name: 'Triage bot',
      description: 'Labels new issues.',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Line one.\nLine two.\nLine three.',
      tools: [{ builtin: 'web_fetch' }],
      mcpServers: { github: { command: 'gh-mcp' } },
      triggers: [{ id: 't1', type: 'chat' }],
    },
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: false,
    ...over,
  };
}

const card = (c: HTMLElement) => c.querySelector<HTMLElement>('.proposal-card')!;

afterEach(() => {
  probe.mockReset();
});

describe('ProposalCard chrome', () => {
  it('renders name, kind tag, enabled badge and description', () => {
    const c = render(<ProposalCard output={output()} state="actionable" />);
    expect(card(c).getAttribute('data-proposal-id')).toBe('prop-1');
    expect(card(c).getAttribute('data-state')).toBe('actionable');
    expect(card(c).getAttribute('aria-labelledby')).toBe('proposal-prop-1-title');
    expect(c.querySelector('.proposal-kind')?.textContent).toBe('New agent');
    expect(c.querySelector('#proposal-prop-1-title')?.textContent).toBe('Triage bot');
    expect(c.querySelector('.status-badge')?.textContent).toContain('Disabled');
    expect(c.querySelector('.proposal-desc')?.textContent).toBe('Labels new issues.');
  });

  it('shows Enabled for an enabled spec and "Change" for an update', () => {
    const c = render(<ProposalCard output={output({ kind: 'update', enabled: true })} state="actionable" />);
    expect(c.querySelector('.proposal-kind')?.textContent).toBe('Change');
    expect(c.querySelector('.status-badge')?.textContent).toContain('Enabled');
  });

  it('non-actionable states show their status line and no Apply button', () => {
    for (const [state, copy] of [
      ['superseded', 'Replaced by a newer proposal'],
      ['discarded', 'Discarded'],
      ['saved', 'Saved'],
    ] as const) {
      const c = render(<ProposalCard output={output()} state={state} />);
      expect(c.querySelector('.proposal-status')?.textContent).toBe(copy);
      expect(c.querySelector('.proposal-apply')).toBeNull();
      expect(c.querySelector('.proposal-foot')).toBeNull();
    }
  });
});

describe('ProposalCard changes and carried-over', () => {
  it('an update card lists the changes section with the field count', () => {
    const c = render(
      <ProposalCard
        output={output({
          kind: 'update',
          changes: [
            { field: 'model', label: 'Model', section: 'Model', op: 'edit', before: 'a/1', after: 'b/2' },
            { field: 'description', label: 'Description', section: 'Identity', op: 'edit', before: 'x', after: 'y' },
          ],
        })}
        state="actionable"
      />
    );
    expect(c.querySelector('.proposal-section-title')?.textContent).toContain('What changes · 2 fields');
    expect(c.querySelectorAll('.change-row').length).toBe(2);
    expect(c.querySelector('.proposal-nochange')).toBeNull();
  });

  it('an empty changes list shows the no-change note', () => {
    const c = render(<ProposalCard output={output({ kind: 'update', changes: [] })} state="actionable" />);
    expect(c.querySelector('.proposal-section-title')?.textContent).toContain('What changes · 0 fields');
    expect(c.querySelector('.proposal-nochange')?.textContent).toBe(
      'This proposal matches the saved agent. Applying it would change nothing.'
    );
  });

  it('a create card has no changes section', () => {
    const c = render(<ProposalCard output={output()} state="actionable" />);
    expect(c.querySelector('.proposal-changes')).toBeNull();
  });

  it('the carried-over note maps fields through SPEC_FIELD_LABELS', () => {
    const c = render(
      <ProposalCard
        output={output({ kind: 'update', carriedOver: true, carriedFields: ['instructions', 'triggers', 'oddball'] })}
        state="actionable"
      />
    );
    const note = c.querySelector('.proposal-carried');
    expect(note?.textContent).toContain('Your earlier change was never saved');
    expect(note?.querySelector('strong')?.textContent).toBe('Instructions, Triggers, oddball');
  });
});

describe('ProposalCard requirements', () => {
  it('lists non-ok requirements with their fix buttons', () => {
    const c = render(
      <ProposalCard
        output={output({
          requirements: [
            { id: 'ok1', kind: 'model', status: 'ok', label: 'fine' },
            {
              id: 's1',
              kind: 'secret',
              status: 'missing',
              label: 'JIRA_TOKEN',
              fix: { action: 'add_secret', target: 'JIRA_TOKEN' },
            },
            {
              id: 'm1',
              kind: 'mcp',
              status: 'unknown',
              label: 'github MCP',
              fix: { action: 'probe', target: 'github' },
            },
          ],
        })}
        state="actionable"
      />
    );
    const rows = [...c.querySelectorAll<HTMLElement>('.proposal-req')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute('data-status')).toBe('missing');
    expect(rows[0]!.textContent).toContain('JIRA_TOKEN');
    expect(rows[0]!.querySelector('button')?.textContent).toBe('Add secret');
    expect(rows[1]!.getAttribute('data-status')).toBe('unknown');
    expect(rows[1]!.querySelector('button')?.textContent).toBe('Check');
  });

  it('Add secret navigates to settings', () => {
    const c = render(
      <ProposalCard
        output={output({
          requirements: [
            { id: 's1', kind: 'secret', status: 'missing', label: 'KEY', fix: { action: 'add_secret', target: 'KEY' } },
          ],
        })}
        state="actionable"
      />
    );
    act(() => c.querySelector<HTMLButtonElement>('.proposal-req button')!.click());
    expect(window.location.hash).toBe('#/settings');
  });

  it('Open Settings navigates to the fix target', () => {
    const c = render(
      <ProposalCard
        output={output({
          requirements: [
            {
              id: 'p1',
              kind: 'provider_key',
              status: 'missing',
              label: 'Anthropic key',
              fix: { action: 'open_settings', target: '/settings' },
            },
          ],
        })}
        state="actionable"
      />
    );
    act(() => c.querySelector<HTMLButtonElement>('.proposal-req button')!.click());
    expect(window.location.hash).toBe('#/settings');
  });

  it('Check probes the MCP server and rewrites the row label', async () => {
    probe.mockResolvedValue({ ok: true, tools: [{ name: 'a' }, { name: 'b' }] });
    const c = render(
      <ProposalCard
        output={output({
          requirements: [
            { id: 'm1', kind: 'mcp', status: 'unknown', label: 'github MCP', fix: { action: 'probe', target: 'github' } },
          ],
        })}
        state="actionable"
      />
    );
    await act(async () => c.querySelector<HTMLButtonElement>('.proposal-req button')!.click());
    expect(probe).toHaveBeenCalledWith({ command: 'gh-mcp' });
    expect(c.querySelector('.proposal-req span')?.textContent).toBe('Reachable · 2 tools');

    probe.mockResolvedValue({ ok: false, error: 'connection refused' });
    const c2 = render(
      <ProposalCard
        output={output({
          requirements: [
            { id: 'm1', kind: 'mcp', status: 'unknown', label: 'github MCP', fix: { action: 'probe', target: 'github' } },
          ],
        })}
        state="actionable"
      />
    );
    await act(async () => c2.querySelector<HTMLButtonElement>('.proposal-req button')!.click());
    expect(c2.querySelector('.proposal-req span')?.textContent).toBe('Unreachable: connection refused');
  });
});

describe('ProposalCard full configuration', () => {
  it('creates start expanded, updates collapsed; the toggle flips aria-expanded', () => {
    const create = render(<ProposalCard output={output()} state="actionable" />);
    const toggle = create.querySelector<HTMLButtonElement>('.proposal-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide full configuration');
    expect(create.querySelector('#proposal-prop-1-config')).not.toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show full configuration');
    expect(create.querySelector('#proposal-prop-1-config')).toBeNull();

    const update = render(<ProposalCard output={output({ kind: 'update' })} state="actionable" />);
    const uToggle = update.querySelector<HTMLButtonElement>('.proposal-toggle')!;
    expect(uToggle.getAttribute('aria-expanded')).toBe('false');
    expect(update.querySelector('#proposal-prop-1-config')).toBeNull();
  });

  it('renders one row per non-empty field in SPEC_FIELD_LABELS order', () => {
    const c = render(<ProposalCard output={output()} state="actionable" />);
    const rows = [...c.querySelectorAll<HTMLElement>('.proposal-row')];
    const labels = rows.map((r) => r.querySelector('dt')?.textContent);
    expect(labels).toEqual(['Name', 'Description', 'Model', 'Instructions', 'Tools', 'MCP servers', 'Triggers']);
    const byLabel = (label: string) => rows.find((r) => r.querySelector('dt')?.textContent === label);
    expect(byLabel('Model')?.querySelector('dd')?.textContent).toBe('anthropic/claude-sonnet-5-5');
    expect(byLabel('Tools')?.querySelector('dd')?.textContent).toBe('web_fetch');
    expect(byLabel('MCP servers')?.querySelector('dd')?.textContent).toBe('github');
    expect(byLabel('Triggers')?.querySelector('dd')?.textContent).toBe('Chat');
  });

  it('instructions collapse behind a line-count summary', () => {
    const c = render(<ProposalCard output={output()} state="actionable" />);
    const summary = c.querySelector('.proposal-config summary');
    expect(summary?.textContent).toBe('Instructions · 3 lines');
    expect(c.querySelector('.proposal-instructions')?.textContent).toBe('Line one.\nLine two.\nLine three.');
  });

  it('SPEC_FIELD_LABELS covers the spec fields and falls back to the raw key', () => {
    expect(SPEC_FIELD_LABELS['name']).toBe('Name');
    expect(SPEC_FIELD_LABELS['mcpServers']).toBe('MCP servers');
    expect(SPEC_FIELD_LABELS['permissionMode']).toBe('Permission mode');
    expect(SPEC_FIELD_LABELS['maxSteps']).toBe('Max steps');
  });
});

describe('ProposalCard apply footer', () => {
  it('Save agent on a create, Apply changes on an update, Saving… while saving', () => {
    const create = render(
      <ProposalCard output={output()} state="actionable" apply={{ onApply: vi.fn(), saving: false, disabledReason: null }} />
    );
    expect(create.querySelector('.proposal-apply')?.textContent).toBe('Save agent');

    const update = render(
      <ProposalCard
        output={output({ kind: 'update' })}
        state="actionable"
        apply={{ onApply: vi.fn(), saving: false, disabledReason: null }}
      />
    );
    expect(update.querySelector('.proposal-apply')?.textContent).toBe('Apply changes');

    const saving = render(
      <ProposalCard output={output()} state="actionable" apply={{ onApply: vi.fn(), saving: true, disabledReason: null }} />
    );
    expect(saving.querySelector('.proposal-apply')?.textContent).toBe('Saving…');
    expect(saving.querySelector<HTMLButtonElement>('.proposal-apply')?.disabled).toBe(true);
  });

  it('clicking Apply calls onApply; a disabledReason disables with the reason as title', () => {
    const onApply = vi.fn();
    const c = render(
      <ProposalCard output={output()} state="actionable" apply={{ onApply, saving: false, disabledReason: null }} />
    );
    act(() => c.querySelector<HTMLButtonElement>('.proposal-apply')!.click());
    expect(onApply).toHaveBeenCalledTimes(1);

    const disabled = render(
      <ProposalCard
        output={output()}
        state="actionable"
        apply={{ onApply, saving: false, disabledReason: 'Wait for the Author to finish replying' }}
      />
    );
    const btn = disabled.querySelector<HTMLButtonElement>('.proposal-apply')!;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe('Wait for the Author to finish replying');
  });

  it('a missing-requirements warning shows only when a row is missing', () => {
    const c = render(
      <ProposalCard
        output={output({
          requirements: [{ id: 's1', kind: 'secret', status: 'missing', label: 'KEY' }],
        })}
        state="actionable"
        apply={{ onApply: vi.fn(), saving: false, disabledReason: null }}
      />
    );
    expect(c.querySelector('.proposal-warn')?.textContent).toBe(
      'Some requirements are missing. The agent still saves, and stays off until you add them.'
    );

    const c2 = render(
      <ProposalCard output={output()} state="actionable" apply={{ onApply: vi.fn(), saving: false, disabledReason: null }} />
    );
    expect(c2.querySelector('.proposal-warn')).toBeNull();
  });

  it('a save error alerts; latestProposalId adds a "Show the newer proposal" button', () => {
    const onShowNewer = vi.fn();
    const c = render(
      <ProposalCard
        output={output()}
        state="actionable"
        onShowNewer={onShowNewer}
        apply={{
          onApply: vi.fn(),
          saving: false,
          disabledReason: null,
          error: { message: 'A newer proposal exists.', latestProposalId: 'prop-9' },
        }}
      />
    );
    const error = c.querySelector('.proposal-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('A newer proposal exists.');
    const btn = [...error!.querySelectorAll('button')].find((b) => b.textContent === 'Show the newer proposal')!;
    act(() => btn.click());
    expect(onShowNewer).toHaveBeenCalledWith('prop-9');
  });
});
