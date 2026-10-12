/* Eve multiagent repro 10: record/replay of parallel sub-agents.
 * `lousho eval --record/--replay` wraps each provider with recordReplay() in the DEFAULT
 * 'sequence' mode (src/evals/cassettes.ts:148). Two parallel `task` calls to one sub-agent share
 * its provider, so the recorded call order is whatever the real model's latency was. Replay
 * answers instantly, the interleaving changes, and the case fails with CassetteMismatchError.
 * Run: npx tsx eve/multiagent/r10-cassette-parallel.ts */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel, recordReplay } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const cassette = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-cas-')), 'worker.json');
const noop = defineTool({ name: 'lookup', description: 'lookup', input: z.object({ q: z.string() }), execute: async ({ q }) => `data for ${q}` });

// The "real" worker model: job A's first call is slow (like a real provider having a slow moment).
const realWorker = () =>
  mockModel(
    [
      (req) => {
        const last: any = req.messages.at(-1);
        const prompt = String(req.messages.find((m: any) => m.role === 'user')?.content);
        if (last.role === 'user') return { toolCalls: [{ name: 'lookup', args: { q: prompt } }], delayMs: prompt.includes('A') ? 300 : 10 };
        return { text: `answer for ${prompt}` };
      },
    ],
    { onExhausted: 'repeat-last' }
  );

async function run(mode: 'record' | 'replay') {
  const lead = mockModel([
    { toolCalls: [
      { name: 'task', args: { agent: 'worker', prompt: 'job A', description: 'a' } },
      { name: 'task', args: { agent: 'worker', prompt: 'job B', description: 'b' } },
    ] },
    'both done',
  ]);
  const worker = createAgent({ provider: recordReplay(mode === 'record' ? realWorker() : undefined, { cassette, mode }), instructions: 'w', description: 'Worker', tools: [noop] });
  const agent = createAgent({ provider: lead, instructions: 'lead', subagents: { worker } });
  const r = await agent.send('go');
  const errs = r.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content).slice(0, 120));
  console.log(`${mode}: finish=${r.finishReason}; task results: ${JSON.stringify(errs)}`);
}
await run('record');
await run('replay');
