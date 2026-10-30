import { describe, it, expect } from 'vitest';
import { SPEC_GUARDRAIL_NAMES, type SpecGuardrailName } from '../spec/guardrailOptions';
import { REWRITABLE_GUARDRAILS } from '../spec/v2/guardrails';
import { listGuardrails } from './guardrailCatalog';

const DESCRIPTIONS: Record<SpecGuardrailName, string> = {
  'max-length': 'Blocks text longer than a set number of characters.',
  'secret-scan': 'Finds API keys and tokens in the text; blocks or masks them.',
  regex: 'Blocks or rewrites text that matches a regular expression you give.',
  'deny-topics': 'Blocks text that mentions any of the topics you list.',
  'llm-judge': 'Asks a model whether the text is acceptable, using your instruction.',
  pii: 'Finds personal data (emails, phone numbers, card numbers, ...); blocks or masks it.',
  secrets: 'Finds secrets with the built-in patterns plus yours; masks them by default.',
  'prompt-injection': "Flags attempts to override the agent's instructions (heuristics, then a model if set).",
  moderation: 'Asks a model to flag hateful, violent, sexual or other harmful content.',
};

describe('listGuardrails', () => {
  it('lists the starter set in SPEC_GUARDRAIL_NAMES order, with descriptions', () => {
    const entries = listGuardrails();
    expect(entries.map((entry) => entry.name)).toEqual([...SPEC_GUARDRAIL_NAMES]);
    for (const entry of entries) {
      expect(entry.description).toBe(DESCRIPTIONS[entry.name]);
      expect(entry.on).toEqual(['input', 'output', 'tools']);
      expect(entry.canRunInParallel).toBe(true);
    }
  });

  it("exposes each guardrail's options as JSON Schema without the 'on' field", () => {
    const regex = listGuardrails().find((entry) => entry.name === 'regex');
    const properties = regex?.optionsJsonSchema.properties as Record<string, unknown>;
    expect(properties.pattern).toBeDefined();
    expect(properties.on).toBeUndefined();
    expect(regex?.optionsJsonSchema.required).toContain('pattern');
    expect(regex?.optionsJsonSchema.required).not.toContain('on');
  });

  it('marks exactly the rewritable guardrails', () => {
    for (const entry of listGuardrails()) {
      expect(entry.canRewrite).toBe(REWRITABLE_GUARDRAILS.includes(entry.name));
    }
  });

  it('returns fresh objects on every call', () => {
    const first = listGuardrails().find((entry) => entry.name === 'regex');
    (first?.optionsJsonSchema.properties as Record<string, unknown>).pattern = 'mutated';
    first!.optionsJsonSchema.required = [];
    const second = listGuardrails().find((entry) => entry.name === 'regex');
    expect((second?.optionsJsonSchema.properties as Record<string, unknown>).pattern).not.toBe('mutated');
    expect(second?.optionsJsonSchema.required).toContain('pattern');
  });
});
