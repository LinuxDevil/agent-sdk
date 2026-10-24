/**
 * Live smoke test for the observability platform: prompt registry fetch +
 * prompt_use, tool-call observation, hub publish/query, all reported to the
 * daemon via LOUSHO_OBSERVE=1. Run: npx tsx .smoke/agent.ts
 */
import { createAgent, defineTool, hub } from '../src/index';
import { z } from 'zod';

const getTime = defineTool({
  name: 'get_time',
  description: 'Get the current date and time in ISO format.',
  input: z.object({}),
  execute: async () => new Date().toISOString(),
});

async function main() {
  const h = hub();
  if (!h) throw new Error('hub() is undefined - LOUSHO_OBSERVE not set?');
  await h.publish({ namespace: 'smoke', key: 'last-run', value: new Date().toISOString(), scope: 'fleet' });
  const entries = await h.query({ namespace: 'smoke', scope: 'fleet' });
  console.log('[hub] fleet entries in smoke namespace:', entries.length);

  const agent = createAgent({
    name: 'smoke-agent',
    model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    prompt: 'observe-test@latest',
    tools: { get_time: getTime },
  });

  const first = await agent.send('Hey! What time is it right now?');
  console.log('[agent 1]', first.text);
  const second = await agent.send('And what day of the week is that?');
  console.log('[agent 2]', second.text);

  // Give the reporter's interval flush a moment, then close for the exit flush.
  const reporter = (agent as unknown as { __observeReporter?: { close(): Promise<void> } }).__observeReporter;
  await reporter?.close();
  await new Promise((r) => setTimeout(r, 3000));
  console.log('[smoke] done');
}

main().catch((e) => {
  console.error('[smoke] failed:', e);
  process.exit(1);
});
