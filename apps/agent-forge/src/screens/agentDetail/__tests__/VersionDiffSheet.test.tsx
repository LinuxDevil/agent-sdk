import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpecChange, VersionListItem, VersionRecord } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';

const mocks = vi.hoisted(() => ({
  diffVersion: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { diffVersion: mocks.diffVersion, getVersion: mocks.getVersion },
}));

import { VersionDiffSheet } from '../VersionDiffSheet';

function item(over: Partial<VersionListItem> = {}): VersionListItem {
  return {
    version: 1,
    kind: 'update',
    source: 'editor',
    changedFields: [],
    restoredFromVersion: null,
    summary: 'Saved.',
    requestText: null,
    authorSessionId: null,
    specHash: 'abc',
    createdAt: '2026-10-29T10:00:00Z',
    ...over,
  };
}

/** Versions v1..v`n` newest first, as `GET /agents/:id/versions` returns them. */
function listThrough(n: number): VersionListItem[] {
  return Array.from({ length: n }, (_, i) => item({ version: n - i }));
}

function change(over: Partial<SpecChange> = {}): SpecChange {
  return {
    field: 'model',
    label: 'Model',
    section: 'Model',
    op: 'edit',
    before: 'anthropic/a',
    after: 'anthropic/b',
    ...over,
  };
}

function record(over: Partial<VersionRecord> = {}): VersionRecord {
  return {
    ...item({ version: 1, kind: 'create', source: 'template' }),
    snapshot: { spec: { version: 2, name: 'Support bot', model: 'anthropic/claude-sonnet-5-5' } as VersionRecord['snapshot']['spec'], labels: [] },
    ...over,
  };
}

const noop = () => {};

function renderSheet(props: Partial<Parameters<typeof VersionDiffSheet>[0]> = {}) {
  return render(
    <VersionDiffSheet
      agentId="support-bot"
      version={7}
      versions={listThrough(7)}
      open
      onClose={noop}
      {...props}
    />,
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const sheet = () => document.querySelector('.sheet') as HTMLElement;

beforeEach(() => {
  mocks.diffVersion.mockReset();
  mocks.getVersion.mockReset();
  mocks.diffVersion.mockResolvedValue([change()]);
  mocks.getVersion.mockResolvedValue(record());
});

describe('VersionDiffSheet', () => {
  it('opens titled "v7 changes", described "Compared with v6", fetching diff?against=6', async () => {
    renderSheet();
    await flush();

    expect(mocks.diffVersion).toHaveBeenCalledWith('support-bot', 7, 6);
    expect(document.querySelector('.sheet-title')?.textContent).toBe('v7 changes');
    expect(document.querySelector('.sheet-description')?.textContent).toBe('Compared with v6');
    // The default "Compare with" option is the highest version below v7.
    const select = document.querySelector<HTMLSelectElement>('.version-diff-compare select')!;
    expect(select.value).toBe('6');
    expect([...select.options].map((o) => o.label)).toEqual([
      'v6 (previous)',
      'v5',
      'v4',
      'v3',
      'v2',
      'v1',
    ]);
  });

  it('refetches when "Compare with" changes and updates the description', async () => {
    renderSheet();
    await flush();

    const select = document.querySelector<HTMLSelectElement>('.version-diff-compare select')!;
    act(() => {
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(mocks.diffVersion).toHaveBeenLastCalledWith('support-bot', 7, 4);
    expect(document.querySelector('.sheet-description')?.textContent).toBe('Compared with v4');
  });

  it('groups changes under the fixed section headings, each with its count', async () => {
    mocks.diffVersion.mockResolvedValue([
      change({ field: 'tools[web_fetch]', label: 'Tool: web_fetch', section: 'Tools', op: 'add', after: {} }),
      change({ field: 'name', label: 'Name', section: 'Identity' }),
      change({ field: 'tools[calculator]', label: 'Tool: calculator', section: 'Tools', op: 'remove', before: {} }),
      change({ field: 'someFutureField', label: 'Future field' }),
    ]);
    renderSheet();
    await flush();

    const sections = [...document.querySelectorAll<HTMLElement>('.version-diff-section')];
    expect(sections.map((s) => s.getAttribute('aria-labelledby'))).toEqual(['vd-Identity', 'vd-Tools', 'vd-Other']);
    const heading = (s: HTMLElement) => s.querySelector('.version-diff-section-title')!;
    expect(heading(sections[0]).textContent).toContain('Identity');
    expect(sections[0].querySelector('.version-diff-count')?.textContent).toBe('1');
    expect(sections[1].querySelector('.version-diff-count')?.textContent).toBe('2');
    expect(sections[1].querySelectorAll('.change-row').length).toBe(2);
    expect(sections[2].querySelector('.version-diff-count')?.textContent).toBe('1');
  });

  it('shows "No differences recorded for this version." on an empty diff', async () => {
    mocks.diffVersion.mockResolvedValue([]);
    renderSheet();
    await flush();

    expect(document.querySelector('.empty-state-title')?.textContent).toBe(
      'No differences recorded for this version.',
    );
    expect(document.querySelector('.empty-state-hint')?.textContent).toBe(
      'It has the same configuration as the version it is compared with.',
    );
    expect(document.querySelector('.empty-state-icon')).toBeNull();
  });

  it('shows the first-version text and the YAML snapshot for v1, with no compare select', async () => {
    renderSheet({ version: 1, versions: listThrough(1) });
    await flush();

    expect(mocks.diffVersion).not.toHaveBeenCalled();
    expect(mocks.getVersion).toHaveBeenCalledWith('support-bot', 1);
    expect(document.querySelector('.version-diff-compare')).toBeNull();
    expect(document.querySelector('.version-diff-first')?.textContent).toBe(
      'This is the first version, so there is nothing to compare it with.',
    );
    expect(document.querySelector('.version-diff-yaml')?.textContent).toContain('name: Support bot');
    expect(document.querySelector('.version-diff-yaml')?.textContent).toContain('claude-sonnet-5-5');
  });

  it('treats a version with no earlier entries as the first version', async () => {
    renderSheet({ version: 7, versions: [item({ version: 7 })] });
    await flush();

    expect(mocks.getVersion).toHaveBeenCalledWith('support-bot', 7);
    expect(mocks.diffVersion).not.toHaveBeenCalled();
    expect(document.querySelector('.version-diff-first')).not.toBeNull();
  });

  it('shows the skeleton while fetching', async () => {
    mocks.diffVersion.mockReturnValue(new Promise(() => {}));
    renderSheet();
    await flush();

    expect(document.querySelector('.skeleton-rows')).not.toBeNull();
  });

  it('shows the error state and retries', async () => {
    mocks.diffVersion.mockRejectedValueOnce(new Error('boom'));
    renderSheet();
    await flush();

    expect(document.querySelector('.empty-state-title')?.textContent).toBe("Couldn't load the changes");
    expect(document.querySelector('.empty-state-hint')?.textContent).toBe('boom');

    const retry = [...document.querySelectorAll<HTMLButtonElement>('.empty-state button')].find((b) =>
      b.textContent?.includes('Retry'),
    )!;
    act(() => retry.click());
    await flush();

    expect(mocks.diffVersion).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.version-diff-section')).not.toBeNull();
  });

  it('ignores a stale diff response after "Compare with" changed', async () => {
    let slow: ((changes: SpecChange[]) => void) | undefined;
    mocks.diffVersion.mockImplementation((_id: string, _n: number, against?: number) =>
      against === 6
        ? new Promise<SpecChange[]>((resolve) => {
            slow = resolve;
          })
        : Promise.resolve([change({ field: 'name', section: 'Identity' })]),
    );
    renderSheet();
    await flush();

    const select = document.querySelector<HTMLSelectElement>('.version-diff-compare select')!;
    act(() => {
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(document.querySelector('.version-diff-section')).not.toBeNull();

    // The in-flight against=6 answer lands late and must not overwrite the v4 result.
    await act(async () => slow?.([change({ field: 'model' })]));
    expect(document.querySelector('.version-diff-section-title')?.textContent).toContain('Identity');
    expect(document.querySelector('.version-diff-section-title')?.textContent).not.toContain('Model');
  });

  it('Escape and the close button call onClose', async () => {
    const onClose = vi.fn();
    renderSheet({ onClose });
    await flush();

    act(() => {
      sheet().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => (document.querySelector('.sheet-close') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
