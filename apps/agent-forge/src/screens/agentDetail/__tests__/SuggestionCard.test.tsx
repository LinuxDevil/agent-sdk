import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptSuggestion, VersionListItem } from '../../../../shared/wireTypes';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import { RuntimeApiError } from '../../../runtime/runtimeClient';

const mocks = vi.hoisted(() => ({
  applySuggestion: vi.fn(),
  dismissSuggestion: vi.fn(),
  suggestFromTrace: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../runtime/runtimeClient')>()),
  runtimeClient: {
    applySuggestion: mocks.applySuggestion,
    dismissSuggestion: mocks.dismissSuggestion,
    suggestFromTrace: mocks.suggestFromTrace,
  },
}));

import { SuggestionCard } from '../SuggestionCard';

function suggestion(over: Partial<PromptSuggestion> = {}): PromptSuggestion {
  return {
    kind: 'prompt_edit',
    id: 'sg-1',
    agentId: 'support-bot',
    sourceTraceId: 'trace-abc12345-6789',
    expectedPromptHash: 'hash-before',
    proposedPromptHash: 'hash-after',
    oldText: 'Be helpful.',
    newText: 'Be helpful and concise.',
    confidence: 'high',
    optimizationClass: 'Ambiguous instruction',
    evidence: 'The run asked the same clarifying question twice.',
    expectedSaving: 'About 2s per run.',
    risk: 'Low - one sentence added.',
    validationPlan: ['Run the agent once', 'Check the reply stays on task'],
    status: 'open',
    createdAt: new Date(Date.now() - 180_000).toISOString(),
    updatedAt: new Date(Date.now() - 180_000).toISOString(),
    resolvedAt: null,
    appliedVersion: null,
    ...over,
  };
}

function version(n: number): VersionListItem {
  return {
    version: n,
    kind: 'update',
    source: 'suggestion',
    changedFields: ['instructions'],
    restoredFromVersion: null,
    summary: null,
    requestText: null,
    authorSessionId: null,
    specHash: 'sha256:x',
  } as VersionListItem;
}

function renderCard(s: PromptSuggestion = suggestion(), promptRef?: string, onChanged = vi.fn()) {
  const host = render(
    <ToastProvider>
      <SuggestionCard agentId="support-bot" suggestion={s} promptRef={promptRef} onChanged={onChanged} />
    </ToastProvider>
  );
  return { host, onChanged };
}

/** Flushes the promise chain and applies state updates inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label));
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = findButton(host, label);
  expect(found, `button "${label}"`).toBeDefined();
  return found!;
}

beforeEach(() => {
  mocks.applySuggestion.mockReset();
  mocks.dismissSuggestion.mockReset();
  mocks.suggestFromTrace.mockReset();
});

describe('SuggestionCard', () => {
  it('renders an open suggestion: class title, confidence, source, diff and the four facts', async () => {
    const { host } = renderCard();
    await flush();

    const card = host.querySelector('.suggestion-card')!;
    expect(card.getAttribute('data-status')).toBe('open');
    expect(card.getAttribute('aria-labelledby')).toBe('sg-sg-1-title');
    expect(host.querySelector('#sg-sg-1-title')?.textContent).toBe('Ambiguous instruction');
    expect(host.querySelector('.status-pill')?.textContent).toBe('High confidence');
    expect(host.querySelector('.suggestion-card-source')?.getAttribute('href')).toBe('#/traces/trace-abc12345-6789');
    expect(host.textContent).toContain('From run trace-ab');

    // The instructions diff goes through ChangeList's text view.
    expect(host.querySelector('.change-list')).not.toBeNull();
    expect(host.querySelector('[data-field="instructions"]')).not.toBeNull();

    const facts = host.querySelector('.suggestion-card-facts')!;
    expect(facts.textContent).toContain('Evidence');
    expect(facts.textContent).toContain('The run asked the same clarifying question twice.');
    expect(facts.textContent).toContain('Expected saving');
    expect(facts.textContent).toContain('Risk');
    expect(facts.textContent).toContain('How to check it');
    expect(facts.querySelectorAll('ol li')).toHaveLength(2);

    expect(button(host, 'Apply')).toBeDefined();
    expect(button(host, 'Dismiss')).toBeDefined();
  });

  it('shows the promptRef fallback note under the header', async () => {
    const { host } = renderCard(suggestion(), 'triage@v2');
    await flush();

    expect(host.querySelector('.suggestion-card-note')?.textContent).toContain('prompt registry (triage@v2)');
    expect(host.querySelector('.suggestion-card-note')?.textContent).toContain('fallback text only');
  });

  it('marks low confidence with the neutral pill', async () => {
    const { host } = renderCard(suggestion({ confidence: 'low' }));
    await flush();

    expect(host.querySelector('.status-pill')?.textContent).toBe('Low confidence');
    expect(host.querySelector('.status-pill')?.className).toContain('pill-neutral');
  });

  it('applies: calls applySuggestion, toasts the version and collapses to "Applied as v4"', async () => {
    mocks.applySuggestion.mockResolvedValue(version(4));
    const { host, onChanged } = renderCard();
    await flush();

    button(host, 'Apply').click();
    await flush();

    expect(mocks.applySuggestion).toHaveBeenCalledWith('support-bot', 'sg-1');
    expect(onChanged).toHaveBeenCalled();
    expect(host.querySelector('.suggestion-card')?.getAttribute('data-status')).toBe('applied');
    expect(host.querySelector('.suggestion-card-applied a')?.getAttribute('href')).toBe(
      '#/agents/support-bot/versions'
    );
    expect(host.textContent).toContain('Applied as v4');
    expect(host.querySelector('.suggestion-card-actions')).toBeNull();
    expect(host.textContent).toContain('Instructions updated (v4)');
  });

  it('a 409 conflict flips the card to the conflict state with "Suggest again" and hides Apply', async () => {
    mocks.applySuggestion.mockRejectedValue(
      new RuntimeApiError('The instructions changed since this was suggested.', 409, 'LOUSHO_SUGGESTION_CONFLICT')
    );
    const { host, onChanged } = renderCard();
    await flush();

    button(host, 'Apply').click();
    await flush();

    expect(onChanged).toHaveBeenCalled();
    expect(host.querySelector('.suggestion-card')?.getAttribute('data-status')).toBe('conflict');
    expect(host.querySelector('.suggestion-card-conflict')?.textContent).toContain(
      'The instructions changed since this was suggested.'
    );
    expect(findButton(host, 'Apply')).toBeUndefined();
    expect(button(host, 'Suggest again')).toBeDefined();
  });

  it('dismisses: calls dismissSuggestion, toasts and asks the parent to refresh', async () => {
    mocks.dismissSuggestion.mockResolvedValue(undefined);
    const { host, onChanged } = renderCard();
    await flush();

    button(host, 'Dismiss').click();
    await flush();

    expect(mocks.dismissSuggestion).toHaveBeenCalledWith('support-bot', 'sg-1');
    expect(onChanged).toHaveBeenCalled();
    expect(host.textContent).toContain('Suggestion dismissed');
  });

  it('renders an already-applied suggestion collapsed to its version link', async () => {
    const { host } = renderCard(suggestion({ status: 'applied', appliedVersion: 7 }));
    await flush();

    expect(host.querySelector('.suggestion-card')?.getAttribute('data-status')).toBe('applied');
    expect(host.textContent).toContain('Applied as v7');
    expect(host.querySelector('.suggestion-card-actions')).toBeNull();
    expect(host.querySelector('.change-list')).toBeNull();
  });

  it('renders a conflict suggestion with the banner and no Apply button', async () => {
    const { host } = renderCard(suggestion({ status: 'conflict' }));
    await flush();

    expect(host.querySelector('.suggestion-card')?.getAttribute('data-status')).toBe('conflict');
    expect(host.querySelector('.suggestion-card-conflict')).not.toBeNull();
    expect(findButton(host, 'Apply')).toBeUndefined();
    expect(button(host, 'Suggest again')).toBeDefined();
  });

  it('renders nothing for a dismissed suggestion', async () => {
    const { host } = renderCard(suggestion({ status: 'dismissed' }));
    await flush();

    expect(host.querySelector('.suggestion-card')).toBeNull();
  });

  it('"Suggest again" starts a fresh pass on the source trace', async () => {
    mocks.suggestFromTrace.mockResolvedValue({ suggestionId: 'sg-2' });
    const { host } = renderCard(suggestion({ status: 'conflict' }));
    await flush();

    button(host, 'Suggest again').click();
    await flush();

    expect(mocks.suggestFromTrace).toHaveBeenCalledWith('support-bot', 'trace-abc12345-6789');
  });
});
