import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortabilityAnalysis } from '../../../../../shared/wireTypes';
import { render } from '../../../../ui/__tests__/render';
import { ToastProvider } from '../../../../ui/Toast';
import { ExportSheet } from '../ExportSheet';

const api = vi.hoisted(() => ({
  downloadExport: vi.fn(),
  checkPortability: vi.fn(),
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

import { RuntimeApiError } from '../../../../runtime/runtimeClient';

function analysis(over: Partial<PortabilityAnalysis> = {}): PortabilityAnalysis {
  return {
    kind: 'portability',
    id: 'portability-abc123',
    agentId: 'support-bot',
    specHash: 'sha256:abc123',
    summary: '1 hard-coded detail found.',
    findings: [],
    adaptedInstructions: 'Reply to [YOUR EMAIL].',
    model: 'test-model',
    createdAt: '2026-10-29T12:00:00Z',
    ...over,
  };
}

const sheet = () => document.querySelector<HTMLElement>('.sheet')!;
const footerButton = (label: string) =>
  [...sheet().querySelectorAll<HTMLButtonElement>('.sheet-footer button')].find((b) =>
    b.textContent?.includes(label)
  )!;
const radio = (value: string) =>
  sheet().querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
const adaptSwitch = () =>
  sheet().querySelector<HTMLElement>('[role="switch"][aria-label="Use adapted instructions in the export"]');
const checkButton = (label: string) =>
  [...sheet().querySelectorAll<HTMLButtonElement>('.portability button')].find(
    (b) => b.textContent === label
  )!;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

function toastTexts(): string {
  return [...document.querySelectorAll('.toast-message')].map((el) => el.textContent ?? '').join(' | ');
}

/** Records anchor downloads the way jsdom cannot. */
function captureDownloads(): { downloads: string[]; restore: () => void } {
  const downloads: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  };
  return {
    downloads,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

function mount() {
  return render(
    <ToastProvider>
      <ExportSheet agentId="support-bot" agentName="Support triage" open onClose={vi.fn()} />
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.downloadExport.mockResolvedValue({
    blob: new Blob(['{}']),
    filename: 'support-triage.yaml',
    warnings: [],
  });
  api.checkPortability.mockResolvedValue(analysis());
});

describe('ExportSheet', () => {
  it('shows the title, description, format fieldset with YAML default and the secrets note', async () => {
    mount();
    await flush();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Export Support triage');
    expect(document.querySelector('.sheet-description')?.textContent).toBe(
      'Download this agent to keep it, share it or import it into another workspace.'
    );
    expect(document.querySelector('.export-sheet')).toBeTruthy();
    expect(document.querySelector('.export-format legend')?.textContent).toBe('Format');
    expect(radio('yaml').checked).toBe(true);
    expect(radio('bundle').checked).toBe(false);
    expect(sheet().textContent).toContain('The spec only. Opens in any editor.');
    expect(sheet().textContent).toContain(
      'The spec, labels, its registry prompt and eval examples, as one JSON file.'
    );
    expect(sheet().textContent).toContain('Secret values are never exported, only their names.');
    expect(sheet().textContent).toContain('Check for hard-coded details');
    expect(footerButton('Download')).toBeTruthy();
    expect(footerButton('Cancel')).toBeTruthy();
    expect(adaptSwitch()).toBeNull();
  });

  it('switches the selected format', async () => {
    mount();
    await flush();
    await click(radio('bundle'));
    expect(radio('bundle').checked).toBe(true);
    expect(radio('yaml').checked).toBe(false);
  });

  it('hides the adapt switch when the analysis has no adaptation, shows it otherwise', async () => {
    api.checkPortability.mockResolvedValue(analysis({ adaptedInstructions: null }));
    mount();
    await flush();
    await click(checkButton('Check for hard-coded details'));
    await flush();
    expect(sheet().querySelector('.portability-none, .portability-summary')).toBeTruthy();
    expect(adaptSwitch()).toBeNull();

    api.checkPortability.mockResolvedValue(analysis());
    // A second mount gives a fresh sheet (render() tears the first down).
    mount();
    await flush();
    await click(checkButton('Check for hard-coded details'));
    await flush();
    expect(adaptSwitch()).toBeTruthy();
    expect(adaptSwitch()!.getAttribute('aria-checked')).toBe('false');
  });

  it('downloads yaml without adapt by default', async () => {
    const { downloads, restore } = captureDownloads();
    try {
      mount();
      await flush();
      await click(footerButton('Download'));
    } finally {
      restore();
    }
    expect(api.downloadExport).toHaveBeenCalledWith('support-bot', 'yaml', { adapt: false });
    expect(downloads).toEqual(['support-triage.yaml']);
    expect(toastTexts()).toContain('Exported support-triage.yaml');
  });

  it('downloads the bundle with adapt when the switch is on', async () => {
    const { downloads, restore } = captureDownloads();
    try {
      mount();
      await flush();
      await click(checkButton('Check for hard-coded details'));
      await flush();
      await click(adaptSwitch()!);
      await click(radio('bundle'));
      api.downloadExport.mockResolvedValue({
        blob: new Blob(['{}']),
        filename: 'support-triage.lousho-agent.json',
        warnings: [],
      });
      await click(footerButton('Download'));
    } finally {
      restore();
    }
    expect(api.downloadExport).toHaveBeenCalledWith('support-bot', 'bundle', { adapt: true });
    expect(downloads).toEqual(['support-triage.lousho-agent.json']);
  });

  it('shows each bundle warning as a warning toast instead of the success toast', async () => {
    api.downloadExport.mockResolvedValue({
      blob: new Blob(['{}']),
      filename: 'support-triage.lousho-agent.json',
      warnings: ["Prompt 'support@prod' could not be read."],
    });
    const { restore } = captureDownloads();
    try {
      mount();
      await flush();
      await click(footerButton('Download'));
    } finally {
      restore();
    }
    expect(toastTexts()).toContain("Prompt 'support@prod' could not be read.");
    expect(toastTexts()).not.toContain('Exported support-triage.yaml');
  });

  it('resets the panel and adapt switch on a 409 LOUSHO_PORTABILITY_MISSING', async () => {
    mount();
    await flush();
    await click(checkButton('Check for hard-coded details'));
    await flush();
    await click(adaptSwitch()!);
    expect(adaptSwitch()!.getAttribute('aria-checked')).toBe('true');

    api.downloadExport.mockRejectedValue(
      new RuntimeApiError('No portability analysis for this spec.', 409, 'LOUSHO_PORTABILITY_MISSING')
    );
    await click(footerButton('Download'));
    await flush();

    expect(sheet().textContent).toContain('The agent changed since the check. Run it again.');
    expect(sheet().querySelector('.export-error')?.getAttribute('role')).toBe('alert');
    expect(checkButton('Check for hard-coded details')).toBeTruthy();
    expect(sheet().textContent).not.toContain('1 hard-coded detail found.');
    expect(adaptSwitch()).toBeNull();
  });

  it('shows an error toast for other download failures', async () => {
    api.downloadExport.mockRejectedValue(new Error('disk full'));
    mount();
    await flush();
    await click(footerButton('Download'));
    await flush();
    expect(toastTexts()).toContain('Export failed: disk full');
  });
});
