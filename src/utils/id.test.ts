import { describe, it, expect } from 'vitest';
import { newId } from './id';

describe('newId', () => {
  it('returns a UUID', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('joins a prefix with an underscore', () => {
    expect(newId('run')).toMatch(/^run_[0-9a-f-]{36}$/);
  });

  it('does not repeat', () => {
    expect(new Set(Array.from({ length: 1000 }, () => newId())).size).toBe(1000);
  });
});
