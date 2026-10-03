/** N13b: the generator tool, prompt and event collection shared by toolPartial.live.test.ts and its replay test. */
import { z } from 'zod';
import { defineTool } from '../../tools/defineTool';
import type { AgentEvent, AgentEventOf } from '../agentEvents';
import type { ExecutionResult } from '../AgentExecutor';

export const PROMPT = 'Use count_to with n=3, then say done.';

/** `count_to({ n })`: yields `{ at: i }` for each step before `n`, then `{ done: true, n }`. */
export function countToTool() {
  return defineTool({
    name: 'count_to',
    description: 'Counts from 1 to n, reporting each step.',
    input: z.object({ n: z.number().int().min(1).max(10) }),
    async *execute({ n }) {
      for (let i = 1; i < n; i++) yield { at: i };
      yield { done: true, n };
    },
  });
}

/** The run's `tool.partial` events, its `tool.done` and its result. */
export async function runCounting(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const partials: AgentEventOf<'tool.partial'>[] = [];
  let done: AgentEventOf<'tool.done'> | undefined;
  for await (const event of run) {
    if (event.type === 'tool.partial') partials.push(event);
    if (event.type === 'tool.done') done = event;
  }
  return { partials, done, result: await run.result };
}
