// (c) Long-running durable job: checkpoint, crash, resume, continue with new input.
//   npx tsx durable-job.ts start job-1            # CRASH_AT=3 kills the process mid-run
//   npx tsx durable-job.ts resume job-1           # rehydrates from the last checkpoint
//   npx tsx durable-job.ts continue job-1 "Now write a summary"
// Checkpoints are saved after each tool result (after each model turn once
// LOU-U9 lands); a finished run deletes its checkpoint, so "continue" re-sends
// the stored transcript. createAgent() takes no checkpointStore, hence AgentExecutor.
import { z } from 'zod';
import {
  AgentBuilder,
  AgentExecutor,
  AgentType,
  ToolRegistry,
  defineTool,
  resolveProvider,
  type ExecuteOptions,
  type Message,
} from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

const [command = 'start', sessionId = 'job-1', newInput] = process.argv.slice(2);
const store = new SqliteStore('./.loushy/jobs.db');

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
const toolRegistry = new ToolRegistry();
toolRegistry.register(processBatch);

const agent = AgentBuilder.create()
  .setType(AgentType.SmartAssistant)
  .setId('importer')
  .setName('importer')
  .setPrompt('Process batches 0 to 9 one at a time with process_batch, then report the total rows.')
  .addTool(processBatch)
  .build();

const base: Omit<ExecuteOptions, 'input'> = {
  agent,
  provider: resolveProvider('openai/gpt-4o-mini'),
  toolRegistry,
  sessionId,
  checkpointStore: store.checkpoints,
  maxSteps: 40,
};

let input: string | Message[] = 'Run the import.';
if (command === 'resume') input = 'continue'; // ignored while a checkpoint exists (LOU-U8 open)
if (command === 'continue') {
  const transcript = (await store.sessions.load(sessionId)) ?? [];
  input = [...transcript, { role: 'user', content: newInput ?? 'Summarize the run.' }];
}

const result = await AgentExecutor.execute({
  ...base,
  input,
  skipSystemPromptInjection: command === 'continue',
});
await store.sessions.save(sessionId, result.messages); // keep the thread for "continue"
console.log(result.finishReason, result.text);
store.close();
