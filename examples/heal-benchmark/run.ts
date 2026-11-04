import { createHash } from 'node:crypto';
import { createAgent, type AgentHook, type LLMProvider } from 'lousho';
import type { BenchmarkAgent, BenchmarkTask } from './agents';

export type RunOutcome = 'passed' | 'failed' | 'unknown';

export interface BenchmarkRun {
  harness: string;
  agent: string;
  task: string;
  taskInput: string;
  model: string;
  repeat: number;
  outcome: RunOutcome;
  ended: string;
  toolRuns: number;
  tokens: number;
  text?: string;
}

export interface BenchmarkOptions {
  agents: readonly (() => BenchmarkAgent)[];
  models: readonly string[];
  repeats: number;
  only?: string;
  hooks?: readonly AgentHook[];
  instructionSuffix?: string;
  provider?: (model: string) => LLMProvider;
  retry?: false;
  maxSteps?: number;
  onRun?: (run: BenchmarkRun) => void;
}

export function harnessVersion(agent: Pick<BenchmarkAgent, 'instructions' | 'tools'>, hookNames: readonly string[] = []): string {
  const tools = agent.tools.map((tool) => tool.name).sort();
  const source = JSON.stringify({ instructions: agent.instructions, tools, hooks: [...hookNames].sort() });
  return createHash('sha256').update(source).digest('hex').slice(0, 12);
}

const AGENT_ERRORS = new Set(['LOUSHO_RUN_NO_PROGRESS']);

async function attempt(agent: BenchmarkAgent, task: BenchmarkTask, options: BenchmarkOptions, model: string, repeat: number): Promise<BenchmarkRun> {
  const hooks = options.hooks ?? [];
  const instructions = agent.instructions + (options.instructionSuffix ?? '');
  const row: BenchmarkRun = {
    harness: harnessVersion({ instructions, tools: agent.tools }, hooks.map((hook) => hook.name)),
    agent: agent.name,
    task: task.id,
    taskInput: task.input,
    model,
    repeat,
    outcome: 'failed',
    ended: 'unknown',
    toolRuns: 0,
    tokens: 0,
  };
  const counter: AgentHook = {
    name: 'benchmark-counter',
    postToolCall: () => {
      row.toolRuns += 1;
    },
  };
  const built = createAgent({
    name: agent.name,
    ...(options.provider ? { provider: options.provider(model) } : { model: `openrouter/${model}` }),
    instructions,
    tools: agent.tools,
    maxSteps: options.maxSteps ?? 15,
    ...(options.retry === false && { retry: false as const }),
    hooks: [counter, ...hooks],
  });
  try {
    const result = await built.send(task.input);
    row.ended = result.finishReason;
    row.text = result.text;
    row.tokens = result.usage?.totalTokens ?? 0;
    row.outcome = task.check(result.text ?? '') ? 'passed' : 'failed';
  } catch (error) {
    const { code, usage } = error as { code?: string; usage?: { totalTokens?: number } };
    row.ended = code ?? (error instanceof Error ? error.name : 'error');
    row.tokens = usage?.totalTokens ?? 0;
    row.outcome = code !== undefined && AGENT_ERRORS.has(code) ? 'failed' : 'unknown';
  }
  await built.close?.();
  return row;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkRun[]> {
  const rows: BenchmarkRun[] = [];
  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    for (const model of options.models) {
      for (const build of options.agents) {
        for (const { id } of build().tasks) {
          if (options.only !== undefined && options.only !== id) continue;
          const agent = build();
          const task = agent.tasks.find((candidate) => candidate.id === id) as BenchmarkTask;
          const row = await attempt(agent, task, options, model, repeat);
          rows.push(row);
          options.onRun?.(row);
        }
      }
    }
  }
  return rows;
}
