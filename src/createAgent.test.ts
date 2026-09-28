/**
 * LOU-H1 test: only imports createAgent() and a mock provider - zero other
 * Loushy imports - to prove the one-liner surface is self-contained.
 */
import { describe, it, expect } from 'vitest';
import { createAgent } from './createAgent';
import { createMockProvider } from './providers/mock';

describe('createAgent', () => {
  it('sends a message and gets a non-empty response', async () => {
    const agent = createAgent({
      prompt: 'You are a helpful assistant.',
      provider: createMockProvider({ responses: ['Hello there!'] }),
    });

    const result = await agent.send('hi');

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('throws a guiding error when provider is missing', () => {
    expect(() =>
      createAgent({ prompt: 'x', provider: undefined as any })
    ).toThrow(/provider/i);
  });
});
