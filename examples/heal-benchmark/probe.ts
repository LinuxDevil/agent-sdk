import { createAgent, defineSkill, type AgentHook } from 'lousho';
import { renderTranscript, type Harness, type ProbeRun } from 'lousho/improve';
import { mockModel } from 'lousho/testing';
import { AGENTS, type BenchmarkAgent } from './agents';

export interface ProbeSettings {
  agent: string;
  model: string;
  live: boolean;
  gapMs: number;
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

export function benchmarkProbe(settings: ProbeSettings): (harness: Harness, caseId: string, repeat?: number) => Promise<ProbeRun> {
  const { live, model } = settings;
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
    try {
      const result = await agent.send(task.input);
      return { passed: task.check(result.text ?? ''), transcript: renderTranscript(result.messages), tokens: result.usage?.totalTokens ?? 0, ended: result.finishReason, ...failedCheck(task) };
    } catch (error) {
      const { code, usage } = error as { code?: string; usage?: { totalTokens?: number } };
      return { passed: null, transcript: String(error), tokens: usage?.totalTokens ?? 0, ended: code ?? 'error' };
    }
  };
}
