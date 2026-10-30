import { describe, it, expect } from 'vitest';
import type { GuardrailSpec } from '../guardrails';
import { guardrailsFromSpec } from './guardrails';

const entries: GuardrailSpec[] = [
  { id: 'g1', name: 'pii', options: { types: ['email'] } },
  { id: 'g2', name: 'regex', on: ['input', 'tools'], options: { pattern: 'secret' } },
  { id: 'g3', name: 'prompt-injection', on: 'input', runInParallel: true },
];

describe('guardrailsFromSpec', () => {
  it('puts each guardrail on the sides `on` names, named by its id', () => {
    const guardrails = guardrailsFromSpec(entries);
    expect(guardrails?.input?.map((g) => g.name)).toEqual(['g1', 'g2', 'g3']);
    expect(guardrails?.output?.map((g) => g.name)).toEqual(['g1']);
    expect(guardrails?.tools?.map((g) => g.name)).toEqual(['g2']);
    expect(guardrails?.input?.[2].runInParallel).toBe(true);
    expect(guardrails?.input?.[0].runInParallel).toBeUndefined();
  });

  it("applies onTripped 'rewrite' as the built guardrail's action", async () => {
    const guardrails = guardrailsFromSpec([{ id: 'mask', name: 'pii', onTripped: 'rewrite' }]);
    const result = await guardrails?.input?.[0].check({ kind: 'input', text: 'mail a@b.co', messages: [] });
    expect(result).toMatchObject({ ok: false, action: 'rewrite' });
  });

  it('passes the options to the built-in and names it by id', async () => {
    const guardrails = guardrailsFromSpec([{ id: 'len', name: 'max-length', options: { maxChars: 3 } }]);
    const guardrail = guardrails?.input?.[0];
    expect(guardrail?.name).toBe('len');
    expect(await guardrail?.check({ kind: 'input', text: 'abcd', messages: [] })).toMatchObject({ ok: false });
  });

  it('returns undefined for an empty list', () => {
    expect(guardrailsFromSpec([])).toBeUndefined();
  });
});
