import type { SimpleAgent } from '../../../createAgent';
import type { ExecutionResult } from '../../../execution/AgentExecutor';
import type { AgentSession } from '../../../session/AgentSession';
import { outputFromSpec } from '../../../spec/v2/jsonSchemaAdapter';
import type { PageEngine, PageErrorKind, PageInput, PageResult, PageRunContext, PageRunStatus, PageUsage } from '../../contracts/execution';
import { attachmentAgent } from '../attachmentAgent';
import type { PageEngineFactory, PageEngineSetup } from './types';

const FAILED: Partial<Record<ExecutionResult['finishReason'], { status: PageRunStatus; kind?: PageErrorKind }>> = {
  aborted: { status: 'cancelled', kind: 'cancelled' },
  'awaiting-approval': { status: 'needs-approval' },
  'budget-exceeded': { status: 'failed', kind: 'budget' },
  'max-steps': { status: 'failed', kind: 'budget' },
  error: { status: 'failed', kind: 'engine' },
  content_filter: { status: 'failed', kind: 'engine' },
};

function outputSchemaOf(setup: PageEngineSetup): Record<string, unknown> | undefined {
  const schema = setup.harness.outputs?.schema;
  return typeof schema === 'object' ? schema : undefined;
}

function inputsBlock(inputs: unknown): string {
  return inputs === undefined ? '' : `\n\nInputs:\n${JSON.stringify(inputs, null, 2)}`;
}

function priorBlock(prior: PageResult | undefined): string {
  if (!prior) return '';
  const output = prior.output === undefined ? '' : `\nOutput:\n${JSON.stringify(prior.output, null, 2)}`;
  return `\n\nYour earlier result:\n${prior.summary}${output}`;
}

function promptOf(input: PageInput, setup: PageEngineSetup): string {
  const revise = input.revise ? `\n\nRevise it: ${input.revise.instruction}` : '';
  return `${input.task}${inputsBlock(input.inputs)}${priorBlock(setup.prior)}${revise}`;
}

function parsedText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function usageOf(result: ExecutionResult): PageUsage {
  const { usage } = result;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.costUsd !== undefined && { costUsd: usage.costUsd }),
    ...(usage.costPartial !== undefined && { costPartial: usage.costPartial }),
    modelCalls: usage.modelCalls,
  };
}

function pageResult(result: ExecutionResult, ctx: PageRunContext, structured: boolean): PageResult {
  const failed = FAILED[result.finishReason];
  const output = structured ? (result.object ?? parsedText(result.text)) : result.text;
  return {
    status: failed?.status ?? 'ok',
    ...(output !== undefined && { output }),
    artifacts: [],
    summary: result.text,
    usage: usageOf(result),
    runId: ctx.runId,
    ...(failed?.kind !== undefined && { error: { kind: failed.kind, message: result.abortReason?.message ?? `the run ended with '${result.finishReason}'` } }),
  };
}

/** The `single` engine: one attachment runs the page in its own session, with structured output when the harness has an output schema. A revise of the same run continues that session; any other input starts it. */
export const singleEngine: PageEngineFactory = (setup) => {
  const alias = setup.page.execution.single?.agent ?? '';
  const schema = outputSchemaOf(setup);
  const agent: SimpleAgent = attachmentAgent(setup, alias, {
    ...(schema !== undefined && { output: outputFromSpec({ jsonSchema: schema }) }),
    ...(setup.page.execution.limits !== undefined && { limits: setup.page.execution.limits }),
  });
  const sessions = new Map<string, AgentSession>();
  let stepIndex = 0;
  const engine: PageEngine = {
    type: 'single',
    async run(input, ctx) {
      const continues = input.revise?.runId === ctx.runId && sessions.has(ctx.runId);
      const session = sessions.get(ctx.runId) ?? agent.session({ id: ctx.runId });
      sessions.set(ctx.runId, session);
      const labels = { ...ctx.labels, attachment: alias, stepKind: 'single' as const, stepIndex: stepIndex++ };
      ctx.emit({ type: 'step', phase: 'start', ...labels });
      const result = await session.send(continues ? (input.revise?.instruction ?? '') : promptOf(input, setup), { signal: ctx.signal });
      ctx.emit({ type: 'step', phase: 'done', ...labels });
      return pageResult(result, ctx, schema !== undefined);
    },
  };
  return engine;
};
