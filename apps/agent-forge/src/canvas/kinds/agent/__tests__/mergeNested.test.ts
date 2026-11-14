import { describe, expect, it } from 'vitest';

import { mergeNested } from '../mergeNested';

describe('mergeNested', () => {
  it('adds a sub-key to an existing object', () => {
    expect(mergeNested({ limits: { maxTokens: 5 } }, 'limits', { maxCostUsd: 1.5 })).toEqual({
      limits: { maxTokens: 5, maxCostUsd: 1.5 },
    });
  });

  it('creates the object when the key is absent', () => {
    expect(mergeNested({}, 'rateLimit', { requestsPerMinute: 60 })).toEqual({
      rateLimit: { requestsPerMinute: 60 },
    });
  });

  it('overwrites an existing sub-key', () => {
    expect(mergeNested({ limits: { maxCostUsd: 1 } }, 'limits', { maxCostUsd: 2 })).toEqual({
      limits: { maxCostUsd: 2 },
    });
  });

  it('deletes a sub-key on undefined and keeps the object while keys remain', () => {
    expect(
      mergeNested({ limits: { maxTokens: 5, maxCostUsd: 2 } }, 'limits', { maxCostUsd: undefined }),
    ).toEqual({ limits: { maxTokens: 5 } });
  });

  it('returns undefined for the key when the merge empties the object', () => {
    expect(mergeNested({ limits: { maxCostUsd: 2 } }, 'limits', { maxCostUsd: undefined })).toEqual({
      limits: undefined,
    });
  });

  it('starts from {} when the current value is not an object (retry: false)', () => {
    expect(mergeNested({ retry: false }, 'retry', { maxRetries: 3 })).toEqual({
      retry: { maxRetries: 3 },
    });
  });
});
