/** Eve CORE-F14: a finish reason a provider reports outside the known set is reported as 'other'. */
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import type { GenerateResult, LLMProvider } from '../providers';
import type { AgentEvent } from './agentEvents';

/** A provider whose one reply ends with `finishReason` (any string, as a backend might send). */
function endingWith(finishReason: string): LLMProvider {
  return {
    name: 'raw',
    defaultModel: 'raw',
    async generate(): Promise<GenerateResult> {
      return { text: 'hi', finishReason: finishReason as GenerateResult['finishReason'], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  } as unknown as LLMProvider;
}

describe('finishReason normalization (Eve CORE-F14)', () => {
  it("maps an unknown provider reason to 'other' on the result and the step.done / run.done events", async () => {
    const events: AgentEvent[] = [];
    const result = await createAgent({ provider: endingWith('end_turn'), onEvent: (event) => events.push(event) }).send('x');

    expect(result.finishReason).toBe('other');
    const done = events.find((event) => event.type === 'run.done');
    const step = events.find((event) => event.type === 'step.done');
    expect(done?.type === 'run.done' && done.finishReason).toBe('other');
    expect(step?.type === 'step.done' && step.finishReason).toBe('other');
  });

  it.each(['stop', 'length', 'content_filter', 'other'])("keeps the known reason '%s'", async (reason) => {
    const result = await createAgent({ provider: endingWith(reason) }).send('x');

    expect(result.finishReason).toBe(reason);
  });
});
