// testing.md:79
import { it, expect } from 'vitest';
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

it('surfaces a provider failure', async () => {
  const model = mockModel([{ error: new Error('upstream 503') }]);
  const agent = createAgent({ prompt: 'x', provider: model });

  await expect(agent.send('hi')).rejects.toThrow();
  expect(model.calls).toHaveLength(1); // the failed request is still recorded
});
export {};
