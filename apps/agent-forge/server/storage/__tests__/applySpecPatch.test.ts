import { describe, it, expect } from 'vitest';
import { applySpecPatch } from '../draftStore';
import type { SpecSnapshot } from '../../../shared/wireTypes';

const BASE: SpecSnapshot = {
  spec: {
    version: 2,
    name: 'ops',
    description: 'Runs the ops checks.',
    model: 'mock/mock-1',
    instructions: 'Check the queues.',
    maxSteps: 8,
    fallbackModels: ['mock/mock-2', 'mock/mock-3'],
  },
  labels: ['ops', 'nightly'],
};

describe('applySpecPatch', () => {
  it('keeps every key the patch omits', () => {
    const next = applySpecPatch(BASE, { description: 'Shorter.' });
    expect(next.spec).toEqual({ ...BASE.spec, description: 'Shorter.' });
    expect(next.labels).toEqual(BASE.labels);
  });

  it('removes a key patched to null and replaces keys patched to a value', () => {
    const next = applySpecPatch(BASE, { description: null, maxSteps: 12 });
    expect(next.spec.description).toBeUndefined();
    expect('description' in next.spec).toBe(false);
    expect(next.spec.maxSteps).toBe(12);
    expect(next.spec.name).toBe('ops');
  });

  it('replaces lists wholesale and clears them with []', () => {
    const replaced = applySpecPatch(BASE, { fallbackModels: ['mock/mock-9'] });
    expect(replaced.spec.fallbackModels).toEqual(['mock/mock-9']);
    const cleared = applySpecPatch(BASE, { fallbackModels: [] });
    expect(cleared.spec.fallbackModels).toEqual([]);
  });

  it('sets labels from the patch, clears them on [] and on null, keeps them when absent', () => {
    expect(applySpecPatch(BASE, { labels: ['a'] }).labels).toEqual(['a']);
    expect(applySpecPatch(BASE, { labels: [] }).labels).toEqual([]);
    expect(applySpecPatch(BASE, { labels: null }).labels).toEqual([]);
    expect(applySpecPatch(BASE, { description: 'x' }).labels).toEqual(BASE.labels);
  });

  it('ignores a version key when one is present', () => {
    const next = applySpecPatch(BASE, { version: 7, description: 'x' } as never);
    expect(next.spec.version).toBe(2);
    expect(next.spec.description).toBe('x');
  });

  it('never mutates its input', () => {
    const before = structuredClone(BASE);
    const next = applySpecPatch(BASE, {
      name: 'renamed',
      description: null,
      fallbackModels: [],
      labels: ['new'],
    });
    expect(BASE).toEqual(before);
    expect(next.spec.name).toBe('renamed');
    expect(next.labels).toEqual(['new']);
  });

  it('returns a spec detached from the base (edits to the result do not touch the base)', () => {
    const next = applySpecPatch(BASE, {});
    expect(next.spec).not.toBe(BASE.spec);
    next.spec.name = 'mutated';
    next.labels.push('mutated');
    expect(BASE.spec.name).toBe('ops');
    expect(BASE.labels).toEqual(['ops', 'nightly']);
  });
});
