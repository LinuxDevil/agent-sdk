import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../../../../shared/wireTypes';
import type { AgentSpecV2 } from '@linuxdevil/lousho/spec';
import { parseHash } from '../../../../router/router';
import { render } from '../../../../ui/__tests__/render';
import { ToastProvider } from '../../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  specToCode: vi.fn(() => 'line1\nline2'),
  specToAgentDir: vi.fn(() => ({
    files: [
      { path: 'agent.yaml', content: 'name: x' },
      { path: 'prompts/system.md', content: 'Hi' },
    ],
    dropped: [],
  })),
}));

// The Code tab calls the real SDK generators in the browser; here they are
// stubbed so the assertions are about the tab, not the generators.
vi.mock('@linuxdevil/lousho/spec', () => ({
  specToCode: () => mocks.specToCode(),
  specToAgentDir: () => mocks.specToAgentDir(),
}));

import { AgentDetailContext } from '../../AgentDetailContext';
import { CodeTab } from '../CodeTab';

function record(): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
    } as AgentSpecV2,
    meta: {
      schemaVersion: 1,
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      publishedVersion: null,
      createdAt: '2026-10-29T09:00:00Z',
      updatedAt: '2026-10-29T09:00:00Z',
    },
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
    requirements: [],
  };
}

/** Mounts the tab at `#/agents/support-bot/code` inside the context and toast provider the route provides. */
function renderTab(hash = '/#/agents/support-bot/code') {
  window.history.replaceState(null, '', hash);
  return render(
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: record(), refresh: () => {}, setRecord: () => {} }}>
        <CodeTab />
      </AgentDetailContext.Provider>
    </ToastProvider>,
  );
}

/** Flushes the hashchange-triggered re-render: jsdom delivers `hashchange` on a macrotask, so promises alone do not reach `useRoute`. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Clicks the `.seg-btn` whose text is `label` and flushes the hashchange update. */
async function clickView(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.seg-btn')].find((b) => b.textContent === label)!;
  act(() => button.click());
  await flush();
}

/** The treeitem button of the row named `name`. */
function treeItem(host: HTMLElement, name: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('.code-tree-item')].find((b) => b.textContent === name)!;
}

function keydown(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  mocks.specToCode.mockReset().mockReturnValue('line1\nline2');
  mocks.specToAgentDir.mockReset().mockReturnValue({
    files: [
      { path: 'agent.yaml', content: 'name: x' },
      { path: 'prompts/system.md', content: 'Hi' },
    ],
    dropped: [],
  });
});

describe('CodeTab', () => {
  it('defaults to the TypeScript view: pressed seg button, numbered lines, read-only note', async () => {
    const host = renderTab();
    await flush();

    const pressed = host.querySelector<HTMLButtonElement>('button.seg-btn[aria-pressed="true"]');
    expect(pressed?.textContent).toBe('TypeScript');
    const lines = [...host.querySelectorAll('.code-view .code-line')].map((s) => s.textContent);
    expect(lines).toEqual(['line1', 'line2']);
    expect(host.querySelector<HTMLPreElement>('pre.code-view')?.getAttribute('aria-label')).toBe(
      'TypeScript for Support bot',
    );
    expect(host.querySelector('.code-note')?.textContent).toBe(
      'Generated from the spec. Read-only — edit on the canvas or in Configure.',
    );
  });

  it('switches to YAML via the segmented control and writes ?view=yaml', async () => {
    const host = renderTab();
    await flush();

    await clickView(host, 'YAML');

    expect(parseHash(window.location.hash).query.get('view')).toBe('yaml');
    expect(host.querySelector('button.seg-btn[aria-pressed="true"]')?.textContent).toBe('YAML');
    // The real yaml.stringify runs on record.spec.
    expect(host.querySelector('pre.code-view')?.textContent).toContain('name: Support bot');
  });

  it('keeps the view across a reload: ?view=dir opens the directory', async () => {
    const host = renderTab('/#/agents/support-bot/code?view=dir');
    await flush();

    expect(host.querySelector('button.seg-btn[aria-pressed="true"]')?.textContent).toBe('Agent directory');
    expect(host.querySelector('ul.code-tree[role="tree"]')).not.toBeNull();
  });

  it('Copy writes exactly the generated text and toasts "Copied"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = renderTab();
    await flush();

    const copyButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Copy'),
    )!;
    act(() => copyButton.click());
    await flush();

    expect(writeText).toHaveBeenCalledWith('line1\nline2');
    expect(host.querySelector('.toast-message')?.textContent).toBe('Copied');
  });

  it('toasts "Could not copy" when the clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = renderTab();
    await flush();

    const copyButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Copy'),
    )!;
    act(() => copyButton.click());
    await flush();

    expect(host.querySelector('.toast-message')?.textContent).toBe('Could not copy');
  });

  it('directory view: tree, default agent.yaml selection, disabled Download', async () => {
    const host = renderTab();
    await flush();
    await clickView(host, 'Agent directory');

    expect(host.querySelector('ul.code-tree[role="tree"]')?.getAttribute('aria-label')).toBe('Files');
    const agentYaml = treeItem(host, 'agent.yaml').closest('li')!;
    expect(agentYaml.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('pre.code-view-file')?.textContent).toBe('name: x');

    const download = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Download'),
    )!;
    expect(download.disabled).toBe(true);
    expect(download.title).toBe('Copy files one at a time from the tree');
  });

  it('directory view: ArrowDown moves focus, Enter selects the file into ?file=', async () => {
    const host = renderTab();
    await flush();
    await clickView(host, 'Agent directory');

    // The first tree item (the 'prompts' directory, folders sort first) is the roving-tabindex stop.
    const first = host.querySelector<HTMLButtonElement>('.code-tree-item')!;
    expect(first.textContent).toBe('prompts');
    expect(first.tabIndex).toBe(0);

    keydown(first, 'ArrowDown');
    const systemMd = treeItem(host, 'system.md');
    expect(host.ownerDocument.activeElement).toBe(systemMd);
    expect(systemMd.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    keydown(systemMd, 'Enter');
    await flush();

    expect(parseHash(window.location.hash).query.get('file')).toBe('prompts/system.md');
    expect(host.querySelector('pre.code-view-file')?.textContent).toBe('Hi');
    expect(systemMd.closest('li')?.getAttribute('aria-selected')).toBe('true');
  });

  it('deep-links a file: ?file=prompts/system.md previews it', async () => {
    const host = renderTab('/#/agents/support-bot/code?view=dir&file=prompts%2Fsystem.md');
    await flush();

    expect(host.querySelector('pre.code-view-file')?.textContent).toBe('Hi');
    expect(treeItem(host, 'system.md').closest('li')?.getAttribute('aria-selected')).toBe('true');
  });

  it('a generator error shows "Could not generate code" and only breaks that view', async () => {
    mocks.specToCode.mockImplementation(() => {
      throw new Error('Unsupported field: flow');
    });
    const host = renderTab();
    await flush();

    expect(host.querySelector('.empty-state-title')?.textContent).toBe('Could not generate code');
    expect(host.querySelector('.empty-state-hint')?.textContent).toBe('Unsupported field: flow');
    // The read-only note is still visible.
    expect(host.querySelector('.code-note')?.textContent).toContain('Read-only');

    await clickView(host, 'YAML');
    expect(host.querySelector('pre.code-view')?.textContent).toContain('name: Support bot');
    expect(host.querySelector('.empty-state-title')).toBeNull();
  });
});
