import { describe, it, expect } from 'vitest';
import { generateCodexConfig, CodexAgentConfig } from './codex';
import { exampleAgentSpec } from './__fixtures__/exampleSpec';

describe('generateCodexConfig', () => {
  it('produces a config path under .codex/agents/', () => {
    const file = generateCodexConfig(exampleAgentSpec);
    expect(file.path).toBe('.codex/agents/ops-fixer.json');
  });

  it('produces valid, parseable JSON', () => {
    const file = generateCodexConfig(exampleAgentSpec);
    expect(() => JSON.parse(file.content)).not.toThrow();
  });

  it("parsed output's fields match the fixture", () => {
    const file = generateCodexConfig(exampleAgentSpec);
    const parsed = JSON.parse(file.content) as CodexAgentConfig;

    expect(parsed.name).toBe(exampleAgentSpec.name);
    expect(parsed.instructions).toBe(exampleAgentSpec.prompt);
    expect(parsed.model).toEqual({
      provider: exampleAgentSpec.provider.type,
      name: exampleAgentSpec.provider.model,
    });
    expect(parsed.tools).toEqual(exampleAgentSpec.tools);
    expect(parsed.policy).toEqual(exampleAgentSpec.policy);
    expect(parsed.triggers).toEqual(exampleAgentSpec.triggers);
  });

  it('omits tools/policy/triggers gracefully when absent from the spec', () => {
    const file = generateCodexConfig({
      name: 'bare',
      prompt: 'bare prompt',
      provider: { type: 'mock', model: 'mock-model-1' },
    });
    const parsed = JSON.parse(file.content) as CodexAgentConfig;
    expect(parsed.tools).toEqual([]);
    expect(parsed.policy).toBeUndefined();
    expect(parsed.triggers).toBeUndefined();
  });
});
