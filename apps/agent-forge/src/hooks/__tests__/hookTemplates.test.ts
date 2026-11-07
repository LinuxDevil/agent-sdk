import { describe, expect, it } from 'vitest';

import { HOOK_TEMPLATES, templatePoint, type HookTemplate } from '../hookTemplates';

const template = (point: HookTemplate['point'], phase: HookTemplate['phase']): HookTemplate => ({
  id: 'x',
  name: 'x',
  point,
  phase,
  when: '',
  code: '',
});

describe('templatePoint', () => {
  it.each([
    ['toolCall', 'pre', 'preToolCall'],
    ['toolCall', 'post', 'postToolCall'],
    ['generate', 'pre', 'preGenerate'],
    ['generate', 'post', 'postGenerate'],
  ] as const)('maps %s %s to %s', (point, phase, expected) => {
    expect(templatePoint(template(point, phase))).toBe(expected);
  });

  it('maps every shipped template to a spec hook point', () => {
    for (const t of HOOK_TEMPLATES) {
      expect(templatePoint(t)).toMatch(/^(pre|post)(ToolCall|Generate)$/);
    }
  });
});
