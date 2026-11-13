import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { isValidAgentId } from '../../../../shared/agentId';
import type { AuthorDraft, AuthorPatch } from '../schema';
import { applyAuthorPatch, deriveAgentId, draftInvalidFailure, draftToSpec } from '../toSpec';

/**
 * The draft → spec build rules: `{ version: 2, ...draft }` plus the
 * chat-trigger backstop for creates; the keep / replace / clear / reset
 * patch semantics for edits; the DRAFT_INVALID failure copy; and the
 * name → agent-id derivation.
 */

const DRAFT: AuthorDraft = {
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You triage support mail and pick the queue.',
};

const BASE: AgentSpecV2 = {
  version: 2,
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You triage support mail and pick the queue.',
  tools: [{ builtin: 'web_fetch' }],
  reasoning: 'low',
  triggers: [{ id: 't1', type: 'chat' }],
};

describe('draftToSpec', () => {
  it('builds a v2 spec and appends a chat trigger', () => {
    const result = draftToSpec(DRAFT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.version).toBe(2);
      expect(result.spec.name).toBe('Support triage');
      expect(result.spec.triggers).toEqual([{ id: 't1', type: 'chat' }]);
    }
  });

  it('keeps a chat trigger the draft already has, exactly once', () => {
    const result = draftToSpec({ ...DRAFT, triggers: [{ id: 't1', type: 'chat' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.triggers).toEqual([{ id: 't1', type: 'chat' }]);
  });

  it('appends the chat trigger with the first unused t<N> id', () => {
    const result = draftToSpec({
      ...DRAFT,
      triggers: [{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Weekly sweep.' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.triggers).toEqual([
        { id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Weekly sweep.' },
        { id: 't2', type: 'chat' },
      ]);
    }
  });

  it("does not mutate the draft's triggers list when appending the chat trigger", () => {
    const triggers: AuthorDraft['triggers'] = [{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Weekly sweep.' }];
    const draft: AuthorDraft = { ...DRAFT, triggers };
    const result = draftToSpec(draft);
    expect(result.ok).toBe(true);
    expect(draft.triggers).toBe(triggers);
    expect(draft.triggers).toEqual([{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Weekly sweep.' }]);
  });

  it('reports issues as path: message with [n] array indexes', () => {
    const result = draftToSpec({
      ...DRAFT,
      guardrails: [{ id: 'g1', name: 'not-a-guardrail' as never, on: 'output' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'guardrails[0].name')).toBe(true);
    }
  });
});

describe('applyAuthorPatch', () => {
  const apply = (patch: AuthorPatch) => applyAuthorPatch(BASE, patch);

  it('{} keeps the base unchanged (the chat trigger stays)', () => {
    const result = apply({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec).toEqual(BASE);
  });

  it('a provided list replaces the list wholesale', () => {
    const result = apply({ tools: [{ builtin: 'todo' }, { builtin: 'day_name' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.tools).toEqual([{ builtin: 'todo' }, { builtin: 'day_name' }]);
  });

  it('[] clears a list', () => {
    const result = apply({ tools: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.tools).toEqual([]);
  });

  it('null resets an optional field to default (the key is gone)', () => {
    const result = apply({ reasoning: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect('reasoning' in result.spec).toBe(false);
  });

  it('a provided object replaces the object', () => {
    const result = apply({ modelSettings: { temperature: 0.5 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.modelSettings).toEqual({ temperature: 0.5 });
  });

  it('null on triggers deletes the list; the chat-trigger backstop re-adds it', () => {
    const result = apply({ triggers: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.triggers).toEqual([{ id: 't1', type: 'chat' }]);
  });

  it('adds a chat trigger when the base somehow has none', () => {
    const result = applyAuthorPatch({ ...BASE, triggers: undefined }, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.triggers).toEqual([{ id: 't1', type: 'chat' }]);
  });

  it('uses the first unused t<N> when other trigger ids exist', () => {
    const result = applyAuthorPatch({ ...BASE, triggers: [{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Sweep.' }] }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.triggers?.[result.spec.triggers.length - 1]).toEqual({ id: 't2', type: 'chat' });
    }
  });

  it("does not mutate the base's triggers list when appending the chat trigger", () => {
    const triggers: AgentSpecV2['triggers'] = [{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Sweep.' }];
    const base: AgentSpecV2 = { ...BASE, triggers };
    const result = applyAuthorPatch(base, {});
    expect(result.ok).toBe(true);
    expect(base.triggers).toBe(triggers);
    expect(base.triggers).toEqual([{ id: 't1', type: 'cron', cron: '0 9 * * 1', prompt: 'Sweep.' }]);
  });

  it('reports spec issues with [n] paths', () => {
    const result = apply({ guardrails: [{ id: 'g1', name: 'not-a-guardrail' as never }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'guardrails[0].name')).toBe(true);
    }
  });
});

describe('draftInvalidFailure', () => {
  it('returns the DRAFT_INVALID failure with the contract copy', () => {
    const failure = draftInvalidFailure('proposeAgent', [
      { path: 'model', message: 'is required' },
      { path: 'guardrails[0].name', message: "unknown guardrail 'x'" },
    ]);
    expect(failure).toEqual({
      ok: false,
      code: 'DRAFT_INVALID',
      error: "The draft does not match AgentSpec v2: model: is required; guardrails[0].name: unknown guardrail 'x'.",
      userMessage: 'The draft had a few invalid settings. The Author is fixing them.',
      next: 'Fix the fields listed and call proposeAgent again. Use listTools, listGuardrails and listTriggerTypes for valid values.',
    });
  });

  it('lists at most ten issues', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, message: 'bad' }));
    const failure = draftInvalidFailure('proposeAgentUpdate', issues);
    expect(failure.error).toContain('f9: bad');
    expect(failure.error).not.toContain('f10');
    expect(failure.next).toContain('call proposeAgentUpdate again');
  });
});

describe('deriveAgentId', () => {
  const cases: Array<[string, ReadonlySet<string>, string]> = [
    ['Support Triage!', new Set(), 'support-triage'],
    ['Support Triage!', new Set(['support-triage']), 'support-triage-2'],
    ['Support Triage!', new Set(['support-triage', 'support-triage-2']), 'support-triage-3'],
    ['', new Set(), 'agent'],
    ['!!!', new Set(), 'agent'],
    ['', new Set(['agent']), 'agent-2'],
    ['Ünïcödé Ægent', new Set(), 'n-c-d-gent'],
    ['x'.repeat(60), new Set(), 'x'.repeat(48)],
    ['--lead and trail--', new Set(), 'lead-and-trail'],
    ['123 Numbers', new Set(), '123-numbers'],
  ];

  it.each(cases)('deriveAgentId(%j) -> %s', (name, taken, expected) => {
    expect(deriveAgentId(name, taken)).toBe(expected);
  });

  it('every derived id passes isValidAgentId', () => {
    for (const [name, taken] of cases) {
      const id = deriveAgentId(name, taken as ReadonlySet<string>);
      expect(isValidAgentId(id)).toBe(true);
      expect(isValidAgentId(deriveAgentId(name, new Set([...(taken as ReadonlySet<string>), id])))).toBe(true);
    }
  });
});
