import { describe, it, expect } from 'vitest';
import type { SpecChange } from '../../../shared/wireTypes';
import { classifyChange, classifyDraft, draftFingerprint } from '../draftFields';

/** A minimal `SpecChange` for the class table; label/section are display-only here. */
function change(field: string, op: SpecChange['op'] = 'edit', before?: unknown, after?: unknown): SpecChange {
  return {
    field,
    label: field,
    section: 'Tools',
    op,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

describe('classifyChange', () => {
  it.each(['instructions', 'instructionsByFamily', 'description', 'labels', 'skills'])(
    'plain key %s is routine',
    (field) => {
      expect(classifyChange(change(field))).toBe('routine');
    }
  );

  it('memory edits that only touch recall are routine', () => {
    const before = { name: 'facts', provider: 'kv', recall: { limit: 5, window: 'recent' } };
    const after = { name: 'facts', provider: 'kv', recall: { limit: 10, window: 'recent' } };
    expect(classifyChange(change('memory[facts]', 'edit', before, after))).toBe('routine');
  });

  it('memory edits touching anything but recall are gated', () => {
    const before = { name: 'facts', provider: 'kv', recall: { limit: 5 } };
    const providerChanged = { name: 'facts', provider: 'pinecone', recall: { limit: 5 } };
    expect(classifyChange(change('memory[facts]', 'edit', before, providerChanged))).toBe('gated');
    const scopeChanged = { name: 'facts', provider: 'kv', scope: 'user', recall: { limit: 5 } };
    expect(classifyChange(change('memory[facts]', 'edit', before, scopeChanged))).toBe('gated');
  });

  it('memory adds and removes are gated (the whole item changed, not only recall)', () => {
    expect(classifyChange(change('memory[facts]', 'add', undefined, { name: 'facts' }))).toBe('gated');
    expect(classifyChange(change('memory[facts]', 'remove', { name: 'facts' }, undefined))).toBe('gated');
  });

  it('tool removes are routine; tool adds and edits are gated', () => {
    expect(classifyChange(change('tools[web-fetch]', 'remove', { builtin: 'web_fetch' }))).toBe('routine');
    expect(classifyChange(change('tools[web-fetch]', 'add', undefined, { builtin: 'web_fetch' }))).toBe('gated');
    expect(
      classifyChange(change('tools[web-fetch]', 'edit', { builtin: 'web_fetch' }, { builtin: 'web_fetch', x: 1 }))
    ).toBe('gated');
  });

  it('guardrail adds are routine; removes and edits are gated', () => {
    expect(classifyChange(change('guardrails[g1]', 'add', undefined, { id: 'g1' }))).toBe('routine');
    expect(classifyChange(change('guardrails[g1]', 'remove', { id: 'g1' }))).toBe('gated');
    expect(classifyChange(change('guardrails[g1]', 'edit', { id: 'g1' }, { id: 'g1', x: 1 }))).toBe('gated');
  });

  it.each([
    'model',
    'fallbackModels',
    'mcpServers',
    'mcpServers[github]',
    'permissions',
    'permissions[p1]',
    'permissionMode',
    'triggers',
    'triggers[t1]',
    'abortListeners',
    'hooks',
    'hooks[h1]',
    'subagents',
    'subagents[research]',
    'handoffs',
    'handoffs[ops]',
  ])('gated key %s is gated', (field) => {
    expect(classifyChange(change(field))).toBe('gated');
  });

  it.each(['name', 'limits', 'output', 'flow', 'promptRef', 'modelSettings', 'evals', 'someFutureKey'])(
    'unlisted key %s fails closed to gated',
    (field) => {
      expect(classifyChange(change(field))).toBe('gated');
    }
  );
});

describe('classifyDraft', () => {
  it('splits changed field paths into routine and gated, deduped per class', () => {
    const classes = classifyDraft([
      change('instructions'),
      change('description'),
      change('tools[web-fetch]', 'remove', { builtin: 'web_fetch' }),
      change('tools[http]', 'add', undefined, { builtin: 'http' }),
      change('model'),
      change('model'), // same field twice still lists once
      change('guardrails[g1]', 'add', undefined, { id: 'g1' }),
    ]);
    expect(classes.routine.sort()).toEqual(['description', 'guardrails[g1]', 'instructions', 'tools[web-fetch]'].sort());
    expect(classes.gated.sort()).toEqual(['model', 'tools[http]'].sort());
  });

  it('an instructions-only draft has no gated fields', () => {
    const classes = classifyDraft([change('instructions', 'edit', 'a', 'b')]);
    expect(classes).toEqual({ routine: ['instructions'], gated: [] });
  });
});

describe('draftFingerprint', () => {
  const draft = {
    patch: { description: 'x', model: 'mock/mock-1' },
    reason: 'because',
    baseVersion: 3,
  };

  it('is a sha256 hex of the stable-JSON { patch, reason, baseVersion }', () => {
    const fp = draftFingerprint(draft);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(draftFingerprint({ ...draft })).toBe(fp);
  });

  it('is stable under patch key order', () => {
    const reordered = {
      patch: { model: 'mock/mock-1', description: 'x' },
      reason: 'because',
      baseVersion: 3,
    };
    expect(draftFingerprint(reordered)).toBe(draftFingerprint(draft));
  });

  it('changes when patch, reason or baseVersion changes', () => {
    const fp = draftFingerprint(draft);
    expect(draftFingerprint({ ...draft, reason: 'other' })).not.toBe(fp);
    expect(draftFingerprint({ ...draft, baseVersion: 4 })).not.toBe(fp);
    expect(draftFingerprint({ ...draft, patch: { description: 'x' } })).not.toBe(fp);
  });
});
