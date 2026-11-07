import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockModel, type MockModel } from 'lousho/testing';
import type { AgentSpecV2 } from 'lousho';
import { DRAFT_REVIEW_DIMENSIONS, isDraftReviewFailure, type AuthorToolFailure } from '../../../../shared/authorWire';
import { SettingsStore } from '../../../settingsStore';
import { SecretsStore } from '../../../secretsStore';
import type { AuthorTurn } from '../../turnRunner';
import type { ReviewInput, ReviewVerdict } from '../../proposal/review';
import { proposalTurnState } from '../../proposal/turnState';
import { createReviewDraft, REVIEW_TIMEOUT_MS, reviewVerdictSchema } from '../reviewDraft';
import type { ReviewState } from '../state';

/**
 * The draft-review pass (AA12): a small review model answers five yes/no
 * questions about each proposal before its card is shown. Any "no"
 * bounces the call back to the Author as a hidden DRAFT_REVIEW failure;
 * the third round lets the card through anyway; and every review problem
 * (disabled, no key, error, timeout, no step budget left) fails open.
 * The review model rides the `providerFor` seam on `mockModel`.
 */

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Mail triage',
  model: 'mock/mock-1',
  instructions: 'You triage mail.',
};

const ALL_PASS = {
  runs: { pass: true, reason: 'Everything resolves.' },
  fulfillsIntent: { pass: true, reason: 'Matches the ask.' },
  toolsComplete: { pass: true, reason: 'Every step has a tool.' },
  guardrailsFit: { pass: true, reason: 'Low risk.' },
  triggersFit: { pass: true, reason: 'Chat trigger fits.' },
};

const TOOLS_GAP = {
  ...ALL_PASS,
  toolsComplete: { pass: false, reason: 'No tool can read mail.' },
};

function verdictJson(verdict: object): string {
  return JSON.stringify(verdict);
}

function turn(over: Partial<AuthorTurn> = {}): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-t',
    focus: { mode: 'create' },
    storedTranscript: [],
    userMessage: { id: 'm-1', role: 'user', text: 'Make me an agent that reads my mail.', at: '2026-01-01T00:00:00.000Z' },
    signal: new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
    ...over,
  };
}

function input(over: Partial<ReviewInput> = {}, t: AuthorTurn = turn()): ReviewInput {
  return {
    turn: t,
    identity: { kind: 'create' },
    toolName: 'proposeAgent',
    spec: SPEC,
    changes: [],
    requirements: [],
    ...over,
  };
}

describe('createReviewDraft', () => {
  let dir: string;
  let settings: SettingsStore;
  let secrets: SecretsStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aa12-'));
    settings = new SettingsStore(dir);
    secrets = new SecretsStore(dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function review(model: MockModel, over: { log?: (line: string) => void } = {}) {
    return createReviewDraft({ settings, secrets, providerFor: () => model, ...over });
  }

  it('asks exactly the five rubric questions', () => {
    expect(Object.keys(reviewVerdictSchema.shape)).toEqual([...DRAFT_REVIEW_DIMENSIONS]);
  });

  it('lets an all-pass draft through after exactly one review request carrying a ReviewState', async () => {
    const model = mockModel([verdictJson(ALL_PASS)]);
    const verdict = await review(model)(input());

    expect(verdict).toEqual({ pass: true });
    expect(model.calls).toHaveLength(1);
    const last = model.calls[0].messages.at(-1)!;
    expect(last.role).toBe('user');
    const state = JSON.parse(last.content as string) as ReviewState;
    expect(state.conversation).toContain('Make me an agent that reads my mail.');
    expect(state.draft.kind).toBe('A new agent the user asked for');
    expect(state.draft.spec.name).toBe('Mail triage');
    expect(state.facts.requirements).toEqual([]);
    expect(state.facts.builtinTools.length).toBeGreaterThan(0);
    expect(state.facts.triggerTypes).toContain('chat');
    model.assertExhausted();
  });

  it('bounces a draft with one "no" on round 1 as a hidden DRAFT_REVIEW failure', async () => {
    const model = mockModel([verdictJson(TOOLS_GAP)]);
    const t = turn();
    const verdict = (await review(model)(input({}, t))) as { pass: false; failure: AuthorToolFailure };

    expect(verdict.pass).toBe(false);
    const failure = verdict.failure;
    expect(isDraftReviewFailure(failure)).toBe(true);
    expect(failure.code).toBe('DRAFT_REVIEW');
    // The format's trailing period lands after the judge's own sentence end.
    expect(failure.error).toBe(
      'Draft review found gaps (round 1 of 3): toolsComplete: No tool can read mail..'
    );
    expect(failure.userMessage).toBe('The Author is refining the draft.');
    expect(failure.next).toContain('call proposeAgent again');
    expect(failure.next).toContain('never mention it to the user');
    expect(failure.gaps).toEqual(['toolsComplete: No tool can read mail.']);
    expect(failure.draftReview).toEqual({ round: 1, maxRounds: 3, dimensions: ['toolsComplete'] });
    // A bounced call records nothing in the turn's proposal map.
    expect(proposalTurnState(t).proposed.size).toBe(0);
    expect(proposalTurnState(t).reviewRounds.get('create')).toBe(1);
  });

  it('bounces rounds 1 and 2 for one identity, then shows the card on round 3', async () => {
    const model = mockModel([verdictJson(TOOLS_GAP), verdictJson(TOOLS_GAP), verdictJson(TOOLS_GAP)]);
    const t = turn();
    const run = review(model);

    const first = (await run(input({}, t))) as { pass: false; failure: AuthorToolFailure };
    const second = (await run(input({}, t))) as { pass: false; failure: AuthorToolFailure };
    const third = await run(input({}, t));

    expect(first.failure.error).toContain('round 1 of 3');
    expect(second.failure.error).toContain('round 2 of 3');
    expect(third).toEqual({ pass: true });
    // The cap reset: the next bounce for this key would be round 1 again.
    expect(proposalTurnState(t).reviewRounds.has('create')).toBe(false);
    expect(model.calls).toHaveLength(3);
  });

  it('counts rounds per identity key: a create bounce does not count against an update', async () => {
    const model = mockModel([verdictJson(TOOLS_GAP), verdictJson(TOOLS_GAP), verdictJson(TOOLS_GAP)]);
    const t = turn();
    const run = review(model);

    const createBounce = (await run(input({}, t))) as { pass: false; failure: AuthorToolFailure };
    const updateBounce = (await run(
      input({ identity: { kind: 'update', agentId: 'a-1' }, toolName: 'proposeAgentUpdate' }, t)
    )) as { pass: false; failure: AuthorToolFailure };
    const secondCreateBounce = (await run(input({}, t))) as { pass: false; failure: AuthorToolFailure };

    expect(createBounce.failure.error).toContain('round 1 of 3');
    expect(updateBounce.failure.error).toContain('round 1 of 3');
    expect(updateBounce.failure.next).toContain('proposeAgentUpdate');
    expect(updateBounce.failure.next).toContain('Resend the complete change from this call');
    expect(secondCreateBounce.failure.error).toContain('round 2 of 3');
  });

  it('passes without a review call when the review is disabled', async () => {
    settings.setAuthor({ reviewEnabled: false });
    const model = mockModel([verdictJson(TOOLS_GAP)]);
    expect(await review(model)(input())).toEqual({ pass: true });
    expect(model.calls).toHaveLength(0);
  });

  it('passes without a review call when the turn has no step left to redraft in', async () => {
    const model = mockModel([verdictJson(TOOLS_GAP)]);
    expect(await review(model)(input({}, turn({ stepsRemaining: () => 1 })))).toEqual({ pass: true });
    expect(model.calls).toHaveLength(0);
  });

  it('passes when no review-model key is configured (no providerFor, no stored or env key)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const run = createReviewDraft({ settings, secrets });
    expect(await run(input())).toEqual({ pass: true });
  });

  it('passes and logs when the review model errors', async () => {
    const model = mockModel([{ error: new Error('review exploded') }]);
    const lines: string[] = [];
    const run = review(model, { log: (line) => lines.push(line) });
    expect(await run(input())).toEqual({ pass: true });
    expect(lines).toEqual(['author review skipped: review exploded']);
  });

  it('passes when the review does not answer inside the timeout', async () => {
    vi.useFakeTimers();
    // A reply far slower than REVIEW_TIMEOUT_MS: the deadline aborts it.
    const model = mockModel([{ text: verdictJson(ALL_PASS), delayMs: REVIEW_TIMEOUT_MS * 10 }]);
    const lines: string[] = [];
    const run = review(model, { log: (line) => lines.push(line) });
    const pending: Promise<ReviewVerdict> = run(input());
    await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ pass: true });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('author review skipped:');
  });

  it('validates the judge output against reviewVerdictSchema (a malformed verdict fails open)', async () => {
    const model = mockModel(['{"runs":{"pass":"maybe"}}']);
    expect(await review(model)(input())).toEqual({ pass: true });
  });
});
