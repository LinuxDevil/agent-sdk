import { describe, expect, it } from 'vitest';
import { KIND_VIEWS, viewFor } from '../kinds';

describe('viewFor', () => {
  it('falls back to the generic view while KIND_VIEWS.tool is unset', () => {
    const view = viewFor('tool');
    expect(KIND_VIEWS.tool).toBeUndefined();
    expect(view.label).toBe('tool');
    expect(view.tone).toBe('neutral');
    expect(view.ports).toEqual({ in: true, out: true });
    expect(view.palette).toEqual([]);
    expect(view.title({ id: 'tool:http' } as never)).toBe('http');
    expect(view.title({ id: 'agent' } as never)).toBe('agent');
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
