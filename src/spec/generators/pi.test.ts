import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generatePiSkill, PiSkillDocument } from './pi';
import { exampleAgentSpec } from './__fixtures__/exampleSpec';

describe('generatePiSkill', () => {
  it('produces a YAML file path under .pi/skills/', () => {
    const file = generatePiSkill(exampleAgentSpec);
    expect(file.path).toBe('.pi/skills/ops-fixer.yaml');
  });

  it('produces valid, parseable YAML', () => {
    const file = generatePiSkill(exampleAgentSpec);
    expect(() => parseYaml(file.content)).not.toThrow();
  });

  it('contains name, full prompt, and every tool', () => {
    const file = generatePiSkill(exampleAgentSpec);
    const parsed = parseYaml(file.content) as PiSkillDocument;

    expect(parsed.name).toBe(exampleAgentSpec.name);
    expect(parsed.prompt).toBe(exampleAgentSpec.prompt);
    expect(file.content).toContain(exampleAgentSpec.name);
    expect(file.content).toContain(exampleAgentSpec.prompt.split('\n')[0].slice(0, 20));
    for (const t of exampleAgentSpec.tools ?? []) {
      expect(parsed.tools).toContain(t);
    }
  });

  it('round-trips provider/policy/triggers', () => {
    const file = generatePiSkill(exampleAgentSpec);
    const parsed = parseYaml(file.content) as PiSkillDocument;
    expect(parsed.provider).toEqual(exampleAgentSpec.provider);
    expect(parsed.policy).toEqual(exampleAgentSpec.policy);
    expect(parsed.triggers).toEqual(exampleAgentSpec.triggers);
  });
});
