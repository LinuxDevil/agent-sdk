import { describe, expect, it } from 'vitest';
import type { NodeKind } from '../../graph/v2/types';
import { KIND_VIEWS, viewFor } from '../kinds';

describe('viewFor', () => {
  it('falls back to the generic view for a kind with no registered view', () => {
    // Every NodeKind has a KindView since C15; the fallback only serves a
    // kind the registry does not know (a spec kind added later).
    const kind = 'mystery' as NodeKind;
    const view = viewFor(kind);
    expect(KIND_VIEWS[kind]).toBeUndefined();
    expect(view.label).toBe('mystery');
    expect(view.tone).toBe('neutral');
    expect(view.ports).toEqual({ in: true, out: true });
    expect(view.palette).toEqual([]);
    expect(view.title({ id: 'flow' } as never)).toBe('flow');
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

  it('returns the registered flow view with one palette entry per step type', () => {
    const view = viewFor('flow');
    expect(view.label).toBe('Flow step');
    expect(view.palette.map((entry) => entry.id)).toEqual([
      'flow-sequence',
      'flow-parallel',
      'flow-router',
      'flow-loop',
      'flow-evaluate',
      'flow-llm',
      'flow-agent',
      'flow-approval',
      'flow-tool',
      'flow-set',
      'flow-end',
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
