import { describe, it, expect } from 'vitest';
import { generateClaudeCodeSkill } from './claude-code';
import { exampleAgentSpec } from './__fixtures__/exampleSpec';

describe('generateClaudeCodeSkill', () => {
  it('produces a SKILL.md path under .claude/skills/', () => {
    const file = generateClaudeCodeSkill(exampleAgentSpec);
    expect(file.path).toBe('.claude/skills/ops-fixer/SKILL.md');
  });

  it('includes valid YAML frontmatter with name and description', () => {
    const file = generateClaudeCodeSkill(exampleAgentSpec);
    expect(file.content.startsWith('---\n')).toBe(true);
    expect(file.content).toMatch(/name: "ops-fixer"/);
    expect(file.content).toMatch(/description: "/);
  });

  it('contains the agent name', () => {
    const file = generateClaudeCodeSkill(exampleAgentSpec);
    expect(file.content).toContain(exampleAgentSpec.name);
  });

  it('contains the FULL prompt verbatim', () => {
    const file = generateClaudeCodeSkill(exampleAgentSpec);
    expect(file.content).toContain(exampleAgentSpec.prompt);
  });

  it('contains every tool', () => {
    const file = generateClaudeCodeSkill(exampleAgentSpec);
    for (const t of exampleAgentSpec.tools ?? []) {
      expect(file.content).toContain(t);
    }
  });

  it('handles a spec with no tools', () => {
    const file = generateClaudeCodeSkill({ ...exampleAgentSpec, tools: undefined });
    expect(file.content).toContain('(none)');
  });

  it('lists guardrails given as { name, ...options } objects by name (LOU-X5)', () => {
    const { content } = generateClaudeCodeSkill({
      ...exampleAgentSpec,
      policy: { requiresApproval: ['http'], guardrails: ['secret-scan', { name: 'deny-topics', topics: ['x'] }] },
    });
    expect(content).toContain('- Guardrails: secret-scan, deny-topics');
  });
});
