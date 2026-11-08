import { createAgent, defineSkill, type AgentHook } from 'lousho';
import { renderTranscript, type Harness, type ProbeRun } from 'lousho/improve';
import { mockModel } from 'lousho/testing';
import { AGENTS, type BenchmarkAgent } from './agents';

export type FailureNames = 'real' | 'none' | 'shuffled';

export const SHUFFLED_FAILURES: Readonly<Record<string, string>> = { 'add-months': 'other callers keep their behaviour', 'invoice-rounding': 'follows project conventions' };

const FAILURE_NAMES: readonly FailureNames[] = ['real', 'none', 'shuffled'];

export function parseFailureNames(value: string): FailureNames {
  const mode = FAILURE_NAMES.find((candidate) => candidate === value);
  if (!mode) throw new Error(`--failure-names must be real, none or shuffled, not '${value}'.`);
  return mode;
}

function shuffledFor(caseId: string): string {
  const swapped = SHUFFLED_FAILURES[caseId];
  if (swapped === undefined) throw new Error(`--failure-names shuffled is defined only for add-months and invoice-rounding, not '${caseId}'.`);
  return swapped;
}

export function failureFor(mode: FailureNames, caseId: string, real: string | undefined): string | undefined {
  if (mode === 'real') return real;
  if (mode === 'none' || real === undefined) return undefined;
  return shuffledFor(caseId);
}

export function checkFailureNames(mode: FailureNames, caseIds: readonly string[]): void {
  if (mode === 'shuffled') caseIds.forEach(shuffledFor);
}

export interface ProbeSettings {
  agent: string;
  model: string;
  live: boolean;
  gapMs: number;
  failureNames?: FailureNames;
}

export function throttleHook(gapMs: number): AgentHook {
  return { name: 'throttle', preGenerate: () => new Promise((resolve) => setTimeout(resolve, gapMs)) };
}

export function buildAgent(name: string): BenchmarkAgent {
  const build = AGENTS.find((candidate) => candidate().name === name);
  if (!build) throw new Error(`Unknown agent '${name}'.`);
  return build();
}

function failedCheck(task: BenchmarkAgent['tasks'][number]): { failure?: string } {
  const failure = task.failure?.();
  return failure ? { failure } : {};
}

function withFailureNames(run: ProbeRun, mode: FailureNames, caseId: string): ProbeRun {
  const { failure: real, ...rest } = run;
  const failure = failureFor(mode, caseId, real);
  return failure ? { ...rest, failure } : rest;
}

export function benchmarkProbe(settings: ProbeSettings): (harness: Harness, caseId: string, repeat?: number) => Promise<ProbeRun> {
  const { live, model, failureNames = 'real' } = settings;
  const throttle = throttleHook(settings.gapMs);
  return async (harness, caseId) => {
    const spec = buildAgent(settings.agent);
    const task = spec.tasks.find((candidate) => candidate.id === caseId);
    if (!task) throw new Error(`Unknown case '${caseId}'.`);
    const agent = createAgent({
      name: spec.name,
      ...(live ? { model: `openrouter/${model}` } : { provider: mockModel(['I cannot access that document.']) }),
      instructions: harness.instructions,
      tools: spec.tools,
      skills: Object.entries(harness.skills).map(([name, skill]) => defineSkill({ name, ...skill })),
      maxSteps: 15,
      hooks: live ? [throttle] : [],
    });
    let run: ProbeRun;
    try {
      const result = await agent.send(task.input);
      run = { passed: task.check(result.text ?? ''), transcript: renderTranscript(result.messages), tokens: result.usage?.totalTokens ?? 0, ended: result.finishReason, ...failedCheck(task) };
    } catch (error) {
      const { code, usage } = error as { code?: string; usage?: { totalTokens?: number } };
      return { passed: null, transcript: String(error), tokens: usage?.totalTokens ?? 0, ended: code ?? 'error' };
    }
    return withFailureNames(run, failureNames, caseId);
  };
}
