/**
 * ImportSheet (L08b): preview rendering, mode hints and disabled reasons,
 * the replace picker, success navigation/toast, in-sheet errors, close-reset
 * and the FileReader staleness guard.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  previewImport: vi.fn(),
  importAgent: vi.fn(),
  listAgents: vi.fn(),
}));
vi.mock('../../../../runtime/runtimeClient', () => ({
  runtimeClient: api,
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string
    ) {
      super(message);
    }
  },
}));

import type { AgentListItem, AgentRecord, ImportPreview } from '../../../../../shared/wireTypes';
import { render, rerender } from '../../../../ui/__tests__/render';
import { ToastProvider } from '../../../../ui/Toast';
import { ImportSheet } from '../ImportSheet';

const SPEC_TEXT = 'name: Support triage\nmodel: anthropic/claude-sonnet-5-5\ninstructions: Help.';

function preview(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    format: 'yaml',
    spec: {
      version: 2,
      name: 'Support triage',
      model: 'anthropic/claude-sonnet-5-5',
      tools: [{ kind: 'builtin', name: 'web_search' }],
      triggers: [{}],
    } as unknown as ImportPreview['spec'],
    labels: [],
    suggestedId: 'support-triage',
    clash: null,
    resolvedId: 'support-triage',
    requirements: [
      { id: 'secret:GITHUB_TOKEN', kind: 'secret', status: 'missing', label: 'Secret GITHUB_TOKEN' },
      { id: 'provider:anthropic', kind: 'provider_key', status: 'ok', label: 'Anthropic API key' },
    ],
    prompts: [],
    warnings: ['Upgraded from spec v1.'],
    ...over,
  };
}

const AGENTS: AgentListItem[] = [
  {
    id: 'support-bot',
    name: 'Support bot',
    description: '',
    model: 'anthropic/claude-sonnet-5-5',
    enabled: true,
    labels: [],
    updatedAt: '2026-10-29T11:00:00Z',
    publishedVersion: 3,
    counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  },
];

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'support-triage',
    spec: { version: 2, name: 'Support triage', model: 'anthropic/claude-sonnet-5-5' } as unknown as AgentRecord['spec'],
    meta: {},
    layout: {},
    updatedAt: '2026-10-29T12:00:00Z',
    latestVersion: 1,
    ...over,
  } as unknown as AgentRecord;
}

const sheet = () => document.querySelector<HTMLElement>('.sheet')!;
const textarea = () => sheet().querySelector<HTMLTextAreaElement>('.import-text')!;
const importButton = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('.sheet-footer button')].find((b) =>
    b.textContent?.includes('Import')
  )!;

function typeInto(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function settleDebounce() {
  await act(async () => vi.advanceTimersByTime(400));
  await flush();
}

function mount(props: Partial<Parameters<typeof ImportSheet>[0]> = {}) {
  return render(
    <ToastProvider>
      <ImportSheet open onClose={vi.fn()} {...props} />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.listAgents.mockResolvedValue(AGENTS);
  api.previewImport.mockResolvedValue(preview());
  api.importAgent.mockResolvedValue(record());
  window.history.replaceState(null, '', '/#/agents');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImportSheet preview', () => {
  it('renders title, description and the disabled Import with its reason on empty text', async () => {
    mount();
    await flush();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Import an agent');
    expect(document.querySelector('.sheet-description')?.textContent).toBe(
      'Paste a spec or a bundle exported from Studio, or pick a file.'
    );
    expect(document.activeElement).toBe(textarea());
    expect(importButton().disabled).toBe(true);
    expect(importButton().title).toBe('Paste a spec first');
    expect(api.previewImport).not.toHaveBeenCalled();
  });

  it('shows the preview card, meta line, requirements, warnings and clash after the debounce', async () => {
    api.previewImport.mockResolvedValue(
      preview({ clash: { id: 'support-triage', name: 'Support triage' }, resolvedId: 'support-triage-2' })
    );
    mount();
    await flush();
    typeInto(textarea(), SPEC_TEXT);
    await settleDebounce();

    expect(api.previewImport).toHaveBeenCalledWith({ text: SPEC_TEXT, mode: 'new', targetId: undefined });
    expect(document.querySelector('.import-preview-name')?.textContent).toBe('Support triage');
    expect(document.querySelector('.import-preview-meta')?.textContent).toBe(
      'anthropic/claude-sonnet-5-5 · 1 tool · 1 trigger · YAML'
    );
    expect(document.querySelector('.import-requirements')?.textContent).toContain('Secret GITHUB_TOKEN');
    expect(document.querySelector('.import-warnings')?.textContent).toContain('Upgraded from spec v1.');
    expect(document.querySelector('.import-clash')?.textContent).toContain('support-triage');
    // The selected mode's hint carries the resolved id.
    const hints = [...sheet().querySelectorAll('.import-mode-option .hint')].map((el) => el.textContent);
    expect(hints[0]).toContain('support-triage-2');
    expect(hints[1]).toBe('Saved under a new id');
  });

  it('shows the server schema error and disables Import until the spec is fixed', async () => {
    const { RuntimeApiError } = await import('../../../../runtime/runtimeClient');
    api.previewImport.mockRejectedValue(
      new RuntimeApiError("tools[0].builtin: Unknown tool 'web_serch'.", 400, 'LOUSHO_SCHEMA')
    );
    mount();
    await flush();
    typeInto(textarea(), 'name: X');
    await settleDebounce();

    expect(document.querySelector('.import-error')?.textContent).toContain("tools[0].builtin: Unknown tool 'web_serch'.");
    expect(importButton().disabled).toBe(true);
    expect(importButton().title).toBe('Fix the spec first');
  });
});

describe('ImportSheet modes', () => {
  async function withText() {
    mount();
    await flush();
    typeInto(textarea(), SPEC_TEXT);
    await settleDebounce();
  }

  it('keeps replace targetless disabled until an agent is picked', async () => {
    await withText();
    const replace = [...sheet().querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (r) => r.value === 'replace'
    )!;
    await act(async () => {
      replace.click();
    });
    await settleDebounce();

    expect(document.querySelector('.import-mode .select')).not.toBeNull();
    expect(importButton().disabled).toBe(true);
    expect(importButton().title).toBe('Pick the agent to replace');

    const select = document.querySelector<HTMLSelectElement>('.import-mode .select')!;
    await act(async () => {
      select.value = 'support-bot';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleDebounce();
    expect(api.previewImport).toHaveBeenLastCalledWith({
      text: SPEC_TEXT,
      mode: 'replace',
      targetId: 'support-bot',
    });
    expect(importButton().disabled).toBe(false);
  });

  it('opens on replace with initialTargetId preselected', async () => {
    mount({ initialTargetId: 'support-bot' });
    await flush();
    const replace = [...sheet().querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (r) => r.value === 'replace'
    )!;
    expect(replace.checked).toBe(true);
    expect(document.querySelector<HTMLSelectElement>('.import-mode .select')?.value).toBe('support-bot');
  });
});

describe('ImportSheet import', () => {
  async function readyToImport(onClose?: () => void) {
    mount(onClose === undefined ? {} : { onClose });
    await flush();
    typeInto(textarea(), SPEC_TEXT);
    await settleDebounce();
  }

  it('imports as new, toasts, navigates to the Overview and asks the parent to close', async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await flush();
    typeInto(textarea(), SPEC_TEXT);
    await settleDebounce();
    await act(async () => importButton().click());
    await flush();

    expect(api.importAgent).toHaveBeenCalledWith({ text: SPEC_TEXT, mode: 'new', targetId: undefined });
    expect(window.location.hash).toBe('#/agents/support-triage/overview');
    expect(document.querySelector('.toast-message')?.textContent).toContain(
      'Imported Support triage. It is off until you turn it on.'
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('replace mode sends the target and toasts the version', async () => {
    mount({ initialTargetId: 'support-bot' });
    await flush();
    typeInto(textarea(), SPEC_TEXT);
    await settleDebounce();
    await act(async () => importButton().click());
    await flush();

    expect(api.importAgent).toHaveBeenCalledWith({ text: SPEC_TEXT, mode: 'replace', targetId: 'support-bot' });
    expect(document.querySelector('.toast-message')?.textContent).toContain(
      'Replaced Support triage with the imported spec (v1).'
    );
    expect(window.location.hash).toBe('#/agents/support-triage/overview');
  });

  it('keeps the sheet open with the server message when the import fails', async () => {
    api.importAgent.mockRejectedValue(new Error('Disk full'));
    await readyToImport();
    await act(async () => importButton().click());
    await flush();

    expect(document.querySelector('.import-error')?.textContent).toBe('Disk full');
    expect(document.querySelector('.sheet')).not.toBeNull();
    expect(window.location.hash).toBe('#/agents');
  });
});

describe('ImportSheet file picking and reset', () => {
  class FakeFileReader {
    static instances: FakeFileReader[] = [];
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeFileReader.instances.push(this);
    }
    readAsText() {}
    fire(text: string) {
      this.result = text;
      this.onload?.();
    }
  }

  function pickFile(name: string, size: number, content = '') {
    const input = sheet().querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([content], name, { type: 'text/yaml' });
    Object.defineProperty(file, 'size', { value: size });
    act(() => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('reads a picked file into the textarea and shows its name', async () => {
    vi.stubGlobal('FileReader', FakeFileReader);
    FakeFileReader.instances = [];
    mount();
    await flush();
    pickFile('support-triage.yaml', 100, 'ignored');
    await act(async () => FakeFileReader.instances[0].fire(SPEC_TEXT));
    await flush();

    expect(textarea().value).toBe(SPEC_TEXT);
    expect(document.querySelector('.import-file-name')?.textContent).toBe('support-triage.yaml');
    vi.unstubAllGlobals();
  });

  it('refuses files over 1 MB without touching the textarea', async () => {
    vi.stubGlobal('FileReader', FakeFileReader);
    FakeFileReader.instances = [];
    mount();
    await flush();
    pickFile('huge.yaml', 1024 * 1024 + 1);
    await flush();

    expect(document.querySelector('.import-error')?.textContent).toBe('That file is larger than 1 MB.');
    expect(FakeFileReader.instances).toHaveLength(0);
    expect(textarea().value).toBe('');
    vi.unstubAllGlobals();
  });

  it('drops a stale file read when a newer pick lands first', async () => {
    vi.stubGlobal('FileReader', FakeFileReader);
    FakeFileReader.instances = [];
    mount();
    await flush();
    pickFile('first.yaml', 10);
    pickFile('second.yaml', 10);
    // The second read resolves first, then the first (stale) resolves.
    await act(async () => FakeFileReader.instances[1].fire('name: Second'));
    await act(async () => FakeFileReader.instances[0].fire('name: First'));
    await flush();

    expect(textarea().value).toBe('name: Second');
    expect(document.querySelector('.import-file-name')?.textContent).toBe('second.yaml');
    vi.unstubAllGlobals();
  });

  it('resets text, mode and preview when the sheet closes and reopens', async () => {
    const onClose = vi.fn();
    mount({ onClose });
    await flush();
    typeInto(textarea(), SPEC_TEXT);
    await settleDebounce();
    expect(document.querySelector('.import-preview-name')).not.toBeNull();

    await act(async () => document.querySelector<HTMLButtonElement>('.sheet-close')!.click());
    expect(onClose).toHaveBeenCalled();
    // Simulate the parent closing the sheet.
    rerender(
      <ToastProvider>
        <ImportSheet open={false} onClose={onClose} />
      </ToastProvider>
    );
    rerender(
      <ToastProvider>
        <ImportSheet open onClose={onClose} />
      </ToastProvider>
    );
    await flush();

    expect(textarea().value).toBe('');
    expect(document.querySelector('.import-preview-name')).toBeNull();
    expect(api.previewImport).toHaveBeenCalledTimes(1);
  });
});
