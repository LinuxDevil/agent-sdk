// (c) Durable job: checkpoint, crash, resume, continue. CRASH_AT=3 kills `start` mid-run;
// `resume` finishes the turn from its last checkpoint (`continue` resumes first, too).
//   npx tsx durable-job.ts start job-1 | resume job-1 | continue job-1 "Now write a summary"
import { z } from 'zod';
import { createAgent, defineTool } from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

const [command = 'start', id = 'job-1', input = command === 'start' ? 'Run the import.' : 'Summarize the run.'] = process.argv.slice(2);
const store = new SqliteStore('./.loushy/jobs.db'); // transcript, per-step checkpoints, approvals
const processBatch = defineTool({
  name: 'process_batch',
  description: 'Process one batch of the import (0-9). Slow.',
  input: z.object({ batch: z.number().int().min(0).max(9) }),
  async execute({ batch }) {
    if (Number(process.env.CRASH_AT) === batch) process.exit(1); // simulated crash
    await new Promise((r) => setTimeout(r, 1_000));
    return { batch, rows: 1_000 };
  },
});
const agent = createAgent({
  model: 'openai/gpt-4o-mini', tools: [processBatch], maxSteps: 40, store,
  instructions: 'Process batches 0 to 9 one at a time with process_batch, then report the total rows.',
});
const result = command === 'resume' ? await agent.resume(id) : await agent.session({ id }).send(input);
console.log(result?.finishReason, result?.text);
store.close();
