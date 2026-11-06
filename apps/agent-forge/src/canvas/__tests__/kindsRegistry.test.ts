import { describe, expect, it } from 'vitest';
import { KIND_VIEWS, viewFor } from '../kinds';

describe('viewFor', () => {
  it('falls back to the generic view while KIND_VIEWS.memory is unset', () => {
    const view = viewFor('memory');
    expect(KIND_VIEWS.memory).toBeUndefined();
    expect(view.label).toBe('memory');
    expect(view.tone).toBe('neutral');
    expect(view.ports).toEqual({ in: true, out: true });
    expect(view.palette).toEqual([]);
    expect(view.title({ id: 'memory:mem' } as never)).toBe('mem');
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
