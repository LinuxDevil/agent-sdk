import type { AgentHook, ExecutionResult, LLMProvider } from 'lousho';
import { buildArm, type ArmName, type Built } from './arms';

export interface PilotRow {
  arm: ArmName;
  case: string;
  repeat: number;
  passed: boolean | null;
  failure?: string;
  tokens: number;
  costUsd: number | null;
  modelCalls: number;
  toolRuns: number;
  ended: string;
  model: string;
  date: string;
}

export interface PlanItem {
  arm: ArmName;
  caseId: string;
  repeat: number;
}

export interface PilotOptions {
  arms: readonly ArmName[];
  cases: readonly string[];
  repeats: number;
  model: string;
  gapMs: number;
  maxTokens: number;
  provider?: () => LLMProvider;
  done?: ReadonlySet<string>;
  onRow?: (row: PilotRow) => void;
  now?: () => Date;
}

const AGENT_ERRORS = new Set(['LOUSHO_RUN_NO_PROGRESS']);

export const rowKey = (row: { model: string; arm: string; case: string; repeat: number }): string => `${row.model}|${row.arm}|${row.case}|${row.repeat}`;

export function planRuns(arms: readonly ArmName[], cases: readonly string[], repeats: number): PlanItem[] {
  return Array.from({ length: repeats }, (_, repeat) => repeat).flatMap((repeat) =>
    cases.flatMap((caseId, index) => {
      const shift = (repeat + index) % arms.length;
      return [...arms.slice(shift), ...arms.slice(0, shift)].map((arm) => ({ arm, caseId, repeat }));
    })
  );
}

export function parseRows(text: string): PilotRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PilotRow);
}

export function doneKeys(rows: readonly PilotRow[]): Set<string> {
  return new Set(rows.filter((row) => row.passed !== null).map(rowKey));
}

function throttle(gapMs: number): AgentHook {
  return { name: 'throttle', preGenerate: () => new Promise((resolve) => setTimeout(resolve, gapMs)) };
}

function emptyRow(item: PlanItem, model: string, date: Date): PilotRow {
  return { arm: item.arm, case: item.caseId, repeat: item.repeat, passed: null, tokens: 0, costUsd: null, modelCalls: 0, toolRuns: 0, ended: 'unknown', model, date: date.toISOString() };
}

function recordError(row: PilotRow, error: unknown): void {
  const { code, usage } = error as { code?: string; usage?: { totalTokens?: number } };
  row.ended = code ?? (error instanceof Error ? error.name : 'error');
  row.tokens = usage?.totalTokens ?? 0;
  row.passed = code !== undefined && AGENT_ERRORS.has(code) ? false : null;
}

function counter(row: PilotRow, crashes: string[]): AgentHook {
  return {
    name: 'pilot-counter',
    postToolCall: (ctx, outcome) => {
      row.toolRuns += 1;
      if (ctx.toolName === 'task' && !ctx.subagent && outcome.error?.startsWith("Sub-agent '")) crashes.push(outcome.error);
    },
  };
}

function recordResult(row: PilotRow, result: ExecutionResult, built: Built, crashes: readonly string[]): void {
  const usage = result.usage;
  row.ended = crashes.length > 0 ? 'page-error' : result.finishReason;
  row.tokens = usage?.totalTokens ?? 0;
  row.costUsd = usage?.costUsd ?? null;
  row.modelCalls = usage?.modelCalls ?? 0;
  if (crashes.length > 0) {
    row.failure = crashes[0].slice(0, 300);
    return;
  }
  row.passed = built.check();
  const failure = built.failure();
  if (failure) row.failure = failure;
}

async function runOne(item: PlanItem, options: PilotOptions): Promise<PilotRow> {
  const row = emptyRow(item, options.model, (options.now ?? (() => new Date()))());
  const crashes: string[] = [];
  const hooks = [counter(row, crashes), ...(options.provider ? [] : [throttle(options.gapMs)])];
  const built = await buildArm(item.arm, item.caseId, { model: options.model, maxTokens: options.maxTokens, hooks, ...(options.provider && { provider: options.provider }) });
  try {
    recordResult(row, await built.agent.send(built.input), built, crashes);
  } catch (error) {
    recordError(row, error);
  }
  await built.agent.close?.();
  return row;
}

export async function runPilot(options: PilotOptions): Promise<PilotRow[]> {
  const rows: PilotRow[] = [];
  for (const item of planRuns(options.arms, options.cases, options.repeats)) {
    if (options.done?.has(rowKey({ model: options.model, arm: item.arm, case: item.caseId, repeat: item.repeat }))) continue;
    const row = await runOne(item, options);
    rows.push(row);
    options.onRow?.(row);
  }
  return rows;
}
