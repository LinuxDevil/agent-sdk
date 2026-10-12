// testing.md:38
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

describe('weather agent', () => {
  it('calls get_weather and reports the result', async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21 }));
    const getWeather = defineTool({
      name: 'get_weather',
      description: 'Get the weather for a city',
      input: z.object({ city: z.string() }),
      execute,
    });
    const model = mockModel([
      { toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, // turn 1
      { text: 'It is 21°C in Paris.' },                                  // turn 2
    ]);
    const agent = createAgent({
      prompt: 'You report the weather.',
      provider: model,
      tools: [getWeather],
    });

    const result = await agent.send('Weather in Paris?');

    expect(result.text).toBe('It is 21°C in Paris.');
    expect(execute).toHaveBeenCalledWith({ city: 'Paris' }, expect.anything());
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
    model.assertExhausted(); // fails if scripted turns were never used
  });
});
export {};
