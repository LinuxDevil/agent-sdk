import { describe, expect, it } from 'vitest';
import { isEdgeTypeAllowed } from '../connectionRules';

describe('isEdgeTypeAllowed', () => {
  it('allows the canonical pipeline edges', () => {
    expect(isEdgeTypeAllowed('trigger', 'llm')).toBe(true);
    expect(isEdgeTypeAllowed('llm', 'tool')).toBe(true);
    expect(isEdgeTypeAllowed('llm', 'approval')).toBe(true);
    expect(isEdgeTypeAllowed('llm', 'output')).toBe(true);
    expect(isEdgeTypeAllowed('tool', 'tool')).toBe(true);
    expect(isEdgeTypeAllowed('tool', 'approval')).toBe(true);
    expect(isEdgeTypeAllowed('tool', 'output')).toBe(true);
    expect(isEdgeTypeAllowed('approval', 'output')).toBe(true);
  });

  it('rejects trigger -> trigger', () => {
    expect(isEdgeTypeAllowed('trigger', 'trigger')).toBe(false);
  });

  it('rejects anything into a trigger', () => {
    expect(isEdgeTypeAllowed('llm', 'trigger')).toBe(false);
    expect(isEdgeTypeAllowed('output', 'trigger')).toBe(false);
  });

  it('rejects anything out of output', () => {
    expect(isEdgeTypeAllowed('output', 'llm')).toBe(false);
  });

  it('rejects backward pipeline edges', () => {
    expect(isEdgeTypeAllowed('tool', 'llm')).toBe(false);
    expect(isEdgeTypeAllowed('approval', 'llm')).toBe(false);
    expect(isEdgeTypeAllowed('output', 'approval')).toBe(false);
  });
});
