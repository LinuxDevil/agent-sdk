import { describe, expect, it } from 'vitest';
import { KIND_VIEWS, viewFor } from '../kinds';

describe('viewFor', () => {
  it('falls back to the generic view while KIND_VIEWS.guardrail is unset', () => {
    const view = viewFor('guardrail');
    expect(KIND_VIEWS.guardrail).toBeUndefined();
    expect(view.label).toBe('guardrail');
    expect(view.tone).toBe('neutral');
    expect(view.ports).toEqual({ in: true, out: true });
    expect(view.palette).toEqual([]);
    expect(view.title({ id: 'guard:g1' } as never)).toBe('g1');
    expect(view.title({ id: 'agent' } as never)).toBe('agent');
  });

  it('returns the registered tool view', () => {
    const view = viewFor('tool');
    expect(view.label).toBe('Tool');
    expect(view.tone).toBe('info');
    expect(view.ports).toEqual({ in: true, out: true });
    expect(view.palette.map((entry) => entry.id)).toEqual([
      'tool',
      'tool-openapi',
      'tool-integration',
    ]);
  });
});

describe('KIND_VIEWS palette entries', () => {
  it('every palette entry id across KIND_VIEWS is unique', () => {
    const ids = Object.values(KIND_VIEWS)
      .flatMap((view) => view?.palette ?? [])
      .map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
