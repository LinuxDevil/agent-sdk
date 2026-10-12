// CORE: a throwing onEvent listener (e.g. a logging bug) - does it kill the agent run?
// Run: npx tsx eve/core/r12-onevent-throw.ts
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

let sent = 0;
const sendEmail = defineTool({ name: 'send_email', description: 's', input: z.object({}), execute: async () => { sent++; return 'sent'; } });
for (const failOn of ['run.start', 'tool.start', 'tool.done', 'run.done']) {
  sent = 0;
  const agent = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'send_email' }] }, 'done']),
    tools: [sendEmail],
    onEvent: (e) => {
      if (e.type === failOn) throw new Error(`telemetry bug on ${e.type}`);
    },
  });
  try {
    const r = await agent.send('go');
    console.log('throw on %s -> run ok finishReason=%s emailsSent=%d', failOn.padEnd(10), r.finishReason, sent);
  } catch (e: any) {
    console.log('throw on %s -> send() REJECTED: %s; emailsSent=%d', failOn.padEnd(10), e.message, sent);
  }
}
