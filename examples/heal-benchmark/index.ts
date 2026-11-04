import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createProgressGuard, type AgentHook } from 'lousho';
import { mockModel } from 'lousho/testing';
import { AGENTS } from './agents';
import { runBenchmark } from './run';
import { formatSummary, summarize } from './score';

const FREE_MODELS = ['nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'];

const { values } = parseArgs({
  options: {
    repeats: { type: 'string', default: '2' },
    model: { type: 'string', multiple: true },
    only: { type: 'string' },
    guard: { type: 'boolean', default: false },
    instructions: { type: 'string' },
    out: { type: 'string' },
    'gap-ms': { type: 'string', default: '3500' },
  },
});

const live = process.env.OPENROUTER_API_KEY !== undefined;
const gapMs = Number(values['gap-ms']);
const throttle: AgentHook = { name: 'throttle', preGenerate: () => new Promise((resolve) => setTimeout(resolve, gapMs)) };

async function main(): Promise<void> {
  const rows = await runBenchmark({
    agents: AGENTS,
    models: live ? (values.model ?? FREE_MODELS) : ['mock'],
    repeats: Number(values.repeats),
    ...(values.only !== undefined && { only: values.only }),
    ...(values.instructions !== undefined && { instructionSuffix: ` ${values.instructions}` }),
    ...(live ? {} : { provider: () => mockModel(['I cannot answer that.']) }),
    hooks: [...(live ? [throttle] : []), ...(values.guard ? [createProgressGuard()] : [])],
    onRun: (row) => {
      if (values.out !== undefined) appendFileSync(values.out, `${JSON.stringify(row)}\n`);
    },
  });

  console.log(formatSummary(summarize(rows)));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
