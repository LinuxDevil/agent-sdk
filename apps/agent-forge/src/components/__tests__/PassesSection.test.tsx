import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import type { PassSettings, PassSpendSummary } from '../../../shared/wireTypes';

const api = vi.hoisted(() => ({
  settings: {
    model: 'anthropic/claude-haiku-5-5',
    autoApprovalModel: 'anthropic/claude-haiku-5-5',
    enabled: {
      version_summary: true,
      draft_review: true,
      portability_check: true,
      prompt_suggestion: true,
      auto_approval: true,
      eval_judge: true,
    },
  } as PassSettings,
  spend: {
    month: '2026-11',
    calls: 4,
    totalUsd: 0.0123,
    byKind: { version_summary: { calls: 4, costUsd: 0.0123 } },
  } as PassSpendSummary,
  settingsError: undefined as Error | undefined,
  spendError: undefined as Error | undefined,
  saveResult: null as null | ((patch: unknown) => Promise<PassSettings>),
  savedPatches: [] as unknown[],
}));

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {
    getPassSettings: async () => {
      if (api.settingsError) throw api.settingsError;
      return api.settings;
    },
    savePassSettings: (patch: unknown) => {
      api.savedPatches.push(patch);
      if (api.saveResult) return api.saveResult(patch);
      return Promise.resolve(api.settings);
    },
    getPassSpend: async () => {
      if (api.spendError) throw api.spendError;
      return api.spend;
    },
  },
}));

import { PassesSection } from '../PassesSection';

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  const host = render(<PassesSection />);
  await flush();
  return host;
}

beforeEach(() => {
  api.settings = {
    model: 'anthropic/claude-haiku-5-5',
    autoApprovalModel: 'anthropic/claude-haiku-5-5',
    enabled: {
      version_summary: true,
      draft_review: true,
      portability_check: true,
      prompt_suggestion: true,
      auto_approval: true,
      eval_judge: true,
    },
  };
  api.spend = {
    month: '2026-11',
    calls: 4,
    totalUsd: 0.0123,
    byKind: { version_summary: { calls: 4, costUsd: 0.0123 } },
  };
  api.settingsError = undefined;
  api.spendError = undefined;
  api.saveResult = null;
  api.savedPatches = [];
});

describe('PassesSection', () => {
  it('renders the two model inputs, the six kind switches and this month\'s spend', async () => {
    const host = await mount();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Pass model"]')?.value).toBe(
      'anthropic/claude-haiku-5-5'
    );
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="Auto-approval model"]')?.value
    ).toBe('anthropic/claude-haiku-5-5');
    const switches = [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    expect(switches).toHaveLength(6);
    expect(switches.every((el) => el.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(host.textContent).toContain('$0.0123');
    expect(host.textContent).toContain('across 4 calls');
  });

  it('saves a changed model on blur and flashes a Saved pill', async () => {
    const host = await mount();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Pass model"]')!;
    await act(async () => {
      input.value = 'openai/gpt-4o-mini';
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(api.savedPatches).toEqual([{ model: 'openai/gpt-4o-mini' }]);
    expect(host.textContent).toContain('Saved');
  });

  it('does not save an unchanged or blanked model on blur', async () => {
    const host = await mount();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Pass model"]')!;
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      input.value = '   ';
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(api.savedPatches).toEqual([]);
  });

  it('saves a kind switch as an enabled patch', async () => {
    const host = await mount();
    const switches = [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    // Order follows PASS_KINDS: index 4 is auto_approval.
    await act(async () => {
      switches[4].click();
      await Promise.resolve();
    });
    await flush();
    expect(api.savedPatches).toEqual([{ enabled: { auto_approval: false } }]);
  });

  it('lands a rejected save under its field', async () => {
    api.saveResult = () => Promise.reject(new Error('model must look like provider/model'));
    const host = await mount();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Pass model"]')!;
    await act(async () => {
      input.value = 'bad';
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(host.textContent).toContain('model must look like provider/model');
  });

  it('shows the spend failure state when the spend call fails', async () => {
    api.spendError = new Error('boom');
    const host = await mount();
    expect(host.textContent).toContain("Couldn't load spend");
  });
});
