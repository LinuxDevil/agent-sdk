import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createAgent, defineSkill, type AgentHook } from 'lousho';
import { improveAgent, renderTranscript, type Harness, type ProbeRun } from 'lousho/improve';
import { mockModel } from 'lousho/testing';
import { AGENTS, type BenchmarkAgent } from './agents';

const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'doc-qa' },
    case: { type: 'string', multiple: true, default: ['forbidden-doc'] },
    holdout: { type: 'string', multiple: true, default: [] },
    model: { type: 'string', default: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
    editor: { type: 'string', default: 'nvidia/nemotron-3.5-super-vl:free' },
    attempts: { type: 'string', default: '1' },
    repeats: { type: 'string', default: '3' },
    confirm: { type: 'string', default: '0' },
    'max-tokens': { type: 'string', default: '400000' },
    'max-cost-increase': { type: 'string' },
    'always-propose': { type: 'boolean', default: false },
    'gap-ms': { type: 'string', default: '3000' },
    out: { type: 'string' },
  },
});

const live = process.env.OPENROUTER_API_KEY !== undefined;
const gapMs = Number(values['gap-ms']);
const costLimit = values['max-cost-increase'] === undefined ? {} : { maxCostIncrease: Number(values['max-cost-increase']) };
const throttle: AgentHook = { name: 'throttle', preGenerate: () => new Promise((resolve) => setTimeout(resolve, gapMs)) };

function buildAgent(): BenchmarkAgent {
  const build = AGENTS.find((candidate) => candidate().name === values.agent);
  if (!build) throw new Error(`Unknown agent '${values.agent}'.`);
  return build();
}

async function probe(harness: Harness, caseId: string): Promise<ProbeRun> {
  const spec = buildAgent();
  const task = spec.tasks.find((candidate) => candidate.id === caseId);
  if (!task) throw new Error(`Unknown case '${caseId}'.`);
  const agent = createAgent({
    name: spec.name,
    ...(live ? { model: `openrouter/${values.model}` } : { provider: mockModel(['I cannot access that document.']) }),
    instructions: harness.instructions,
    tools: spec.tools,
    skills: Object.entries(harness.skills).map(([name, skill]) => defineSkill({ name, ...skill })),
    maxSteps: 15,
    hooks: live ? [throttle] : [],
  });
  try {
    const result = await agent.send(task.input);
    const failure = task.failure?.();
    return { passed: task.check(result.text ?? ''), transcript: renderTranscript(result.messages), tokens: result.usage?.totalTokens ?? 0, ended: result.finishReason, ...(failure && { failure }) };
  } catch (error) {
    const { code, usage } = error as { code?: string; usage?: { totalTokens?: number } };
    return { passed: null, transcript: String(error), tokens: usage?.totalTokens ?? 0, ended: code ?? 'error' };
  }
}

async function confirmRate(harness: Harness, caseIds: readonly string[], runs: number): Promise<{ passed: number; scored: number }> {
  const results: ProbeRun[] = [];
  for (let i = 0; i < runs; i += 1) for (const caseId of caseIds) results.push(await probe(harness, caseId));
  const scored = results.filter((run) => run.passed !== null);
  return { passed: scored.filter((run) => run.passed).length, scored: scored.length };
}

async function main(): Promise<void> {
  const base: Harness = { instructions: buildAgent().instructions, skills: {} };
  const scripted = mockModel(["<notes>KEEP_BASE. The runs don't argue for a change.</notes>"], { onExhausted: 'repeat-last' });
  for (let attempt = 0; attempt < Number(values.attempts); attempt += 1) {
    const result = await improveAgent({
      harness: base,
      cases: values.case,
      holdout: values.holdout,
      probe,
      editor: live ? { model: `openrouter/${values.editor}` } : { provider: scripted },
      repeats: Number(values.repeats),
      maxTokens: Number(values['max-tokens']),
      ...costLimit,
      alwaysPropose: values['always-propose'],
      editorHooks: live ? [throttle] : [],
    });
    const confirmed = result.harness && Number(values.confirm) > 0 ? await confirmRate(result.harness, values.case, Number(values.confirm)) : undefined;
    const row = { attempt, ...result, confirmed };
    if (values.out !== undefined) appendFileSync(values.out, `${JSON.stringify(row)}\n`);
    console.log(`attempt ${attempt}: ${result.outcome}. ${result.reason} ${result.spend.tokens} tokens.`);
    if (result.diff) console.log(result.diff);
    if (confirmed) console.log(`confirmed on fresh runs: ${confirmed.passed}/${confirmed.scored}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
