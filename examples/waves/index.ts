/**
 * waves - WAVE engineering (Workers / Aggregate / Verify / Extend), the
 * bounded-parallel pattern behind the community "waves" workflows: instead
 * of asking one agent to do everything serially, a wave of worker agents
 * each handles one slice in a clean context; their outputs are aggregated
 * deterministically; a verifier judges the aggregate; and ONLY if the
 * verdict fails does a follow-up wave run against the verifier's gaps.
 *
 * Mapping to Lousho:
 *   Workers   - `task` sub-agent calls fanned out in one turn, or plain
 *               `agent.send()` calls under Promise.all (used here: the
 *               wave shape is owned by the harness, not the model)
 *   Aggregate - deterministic merge in code (not an LLM call)
 *   Verify    - a structured-decision call: `output` schema
 *               { verdict, gaps[] } - the Jev-style "typed decision" idiom
 *   Extend    - the verifier's `gaps` seed the next wave's worker prompts
 *
 * Offline (default) workers and the verifier are scripted mocks. With
 * OPENROUTER_API_KEY set they run live on openrouter/openai/gpt-4o-mini.
 *
 * Run with: npx tsx examples/waves/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent, resolveProvider, type LLMProvider, type SimpleAgent } from '../../src';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

/** The verifier's typed verdict - wave engineering's "Verify" step. */
export const VERDICT = z.object({
  /** 'pass' ships the aggregate; 'extend' launches another wave on `gaps`. */
  verdict: z.enum(['pass', 'extend']),
  /** What a follow-up wave must still cover. Empty when verdict is 'pass'. */
  gaps: z.array(z.string()),
});
export type WaveVerdict = z.infer<typeof VERDICT>;

export interface WaveOptions {
  /**
   * Factory for one worker agent per unit of work. A factory (not a pool)
   * because each worker must run in a clean context - sharing one agent
   * session across slices leaks one worker's transcript into the next.
   */
  worker: () => SimpleAgent;
  /** The verifier: a provider + model for the structured verdict call. */
  verifier: { provider: LLMProvider; model: string };
  /** The work items of the FIRST wave. */
  tasks: readonly string[];
  /**
   * Aggregates one wave's outputs into the artifact the verifier judges.
   * Deterministic by design - an LLM merge can silently drop a worker's
   * contribution and the verifier has no way to see the loss.
   */
  aggregate: (task: string, output: string) => string;
  /** The question the verifier answers about the aggregate. */
  verifyPrompt: (aggregate: string, wave: number) => string;
  /** Turns a verifier gap into the next wave's worker task. */
  gapToTask: (gap: string) => string;
  /** Hard bound on waves; a still-failing aggregate returns as-is. */
  maxWaves: number;
  /** Hard bound on parallel workers inside one wave. */
  concurrency: number;
}

export interface WaveResult {
  aggregate: string;
  waves: number;
  /** Worker outputs per wave, for callers that want provenance. */
  outputs: string[][];
  /** The last verdict; 'extend' on a maxWaves cut-off is expected. */
  verdict: WaveVerdict;
}

/**
 * Runs the WAVES loop. Each wave: workers run `tasks` in `concurrency`-sized
 * chunks (a slice that fails throws - a partial aggregate would validate
 * against a corpus the verifier can't see); outputs merge via `aggregate`;
 * the verifier returns a typed verdict; 'extend' turns its gaps into the
 * next wave's tasks.
 */
export async function runWaves(options: WaveOptions): Promise<WaveResult> {
  if (options.maxWaves < 1) throw new Error('runWaves: maxWaves must be >= 1');
  if (options.concurrency < 1) throw new Error('runWaves: concurrency must be >= 1');

  let tasks = [...options.tasks];
  const outputs: string[][] = [];
  const sections: string[] = [];
  let aggregate = '';
  let verdict: WaveVerdict = { verdict: 'pass', gaps: [] };

  for (let wave = 1; wave <= options.maxWaves; wave++) {
    const waveOutputs: string[] = [];
    for (let i = 0; i < tasks.length; i += options.concurrency) {
      const slice = tasks.slice(i, i + options.concurrency);
      waveOutputs.push(...(await Promise.all(slice.map((t) => options.worker().send(t).then((r) => r.text)))));
    }
    outputs.push(waveOutputs);
    // Extend waves ADD coverage: the aggregate accumulates sections across
    // waves, so the verifier judges the whole artifact, not just the patch.
    sections.push(...tasks.map((t, i) => options.aggregate(t, waveOutputs[i])));
    aggregate = sections.join('\n');

    const verify = createAgent({
      name: `wave-verifier-${wave}`,
      instructions: 'You are a coverage verifier. Judge the aggregate, list concrete gaps.',
      provider: options.verifier.provider,
      model: options.verifier.model,
      output: VERDICT,
    });
    const verified = await verify.send(options.verifyPrompt(aggregate, wave));
    verdict = verified.object ?? { verdict: 'extend', gaps: [`wave ${wave} verifier returned no parseable verdict`] };

    if (verdict.verdict === 'pass') {
      return { aggregate, waves: wave, outputs, verdict };
    }
    if (verdict.gaps.length === 0) {
      // 'extend' with no gaps cannot seed a wave - treat as pass rather
      // than loop on an empty task list.
      verdict = { verdict: 'pass', gaps: [] };
      return { aggregate, waves: wave, outputs, verdict };
    }
    tasks = verdict.gaps.map(options.gapToTask);
  }

  return { aggregate, waves: options.maxWaves, outputs, verdict };
}

// ---------------------------------------------------------------------------
// Offline scripts + demo
// ---------------------------------------------------------------------------

const CHAPTERS = [
  'Summarize chapter 1 (setup) of the field report.',
  'Summarize chapter 2 (incident) of the field report.',
  'Summarize chapter 3 (resolution) of the field report.',
];

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const provider: LLMProvider = live ? resolveProvider(LIVE_MODEL) : (undefined as never);

  // Offline: three worker drafts, then a verifier that finds a missing
  // risks section, then a second-wave worker covering it, then a pass.
  const workerScripts: string[][] = live
    ? []
    : [
        ['Ch1: the survey team deployed to the valley site on Monday.'],
        ['Ch2: a flash flood severed the access road on day three.'],
        ['Ch3: supply drops resumed via helicopter by Friday.'],
        ['Residual risk: the road remains single-lane until the culvert rebuild.'],
      ];
  const workerCalls = { i: 0 };
  const makeWorker = () =>
    createAgent({
      name: 'wave-worker',
      instructions: 'You are a terse summarizer. Reply with one sentence.',
      ...(live ? { model: LIVE_MODEL } : { provider: mockModel(workerScripts[workerCalls.i++ % workerScripts.length].map((t) => ({ text: t }))) }),
    });

  const verifierProvider = live
    ? provider
    : mockModel([
        { text: JSON.stringify({ verdict: 'extend', gaps: ['residual risks'] }) },
        { text: JSON.stringify({ verdict: 'pass', gaps: [] }) },
      ]);

  console.log(live ? `Live run on ${LIVE_MODEL}` : 'Offline run with scripted models');
  const result = await runWaves({
    worker: makeWorker,
    verifier: { provider: verifierProvider, model: live ? LIVE_MODEL.split('/').slice(1).join('/') : 'mock-verifier' },
    tasks: CHAPTERS,
    aggregate: (task, out) => `### ${task}\n${out}`,
    verifyPrompt: (agg, wave) => `Wave ${wave} produced:\n${agg}\n\nDoes this cover every chapter AND the residual risks?`,
    gapToTask: (gap) => `Summarize the field report section covering: ${gap}.`,
    maxWaves: 3,
    concurrency: 3,
  });

  result.outputs.forEach((outs, i) => {
    console.log(`\n--- wave ${i + 1} (${outs.length} workers) ---`);
    outs.forEach((o) => console.log(`  ${o}`));
  });
  console.log(`\nverdict after ${result.waves} wave(s): ${result.verdict.verdict}`);
  console.log('\n=== aggregate ===\n' + result.aggregate);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
