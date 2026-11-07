import type { AgentHook } from './hooks';

/** Checks by tool name: each gets a call's arguments and result, and returns what is wrong with the output, or nothing. */
export type OutputChecks = Readonly<Record<string, (args: Record<string, unknown>, result: unknown) => string | undefined | Promise<string | undefined>>>;

/** A hook that runs a check after a tool succeeds and tells the model what the check found, so it can fix the output. */
export function createOutputCheck(checks: OutputChecks): AgentHook {
  return {
    name: 'output-check',
    async postToolCall(ctx, outcome) {
      const check = Object.hasOwn(checks, ctx.toolName) ? checks[ctx.toolName] : undefined;
      if (!check || outcome.error || outcome.requiresApproval) return undefined;
      const problem = await Promise.resolve()
        .then(() => check(ctx.args, outcome.result))
        .catch((error: unknown) => `The check could not run: ${error instanceof Error ? error.message : String(error)}`);
      if (!problem) return undefined;
      const base = typeof outcome.result === 'object' && outcome.result !== null ? outcome.result : { result: outcome.result };
      return { result: { ...base, outputCheckFailed: problem } };
    },
  };
}
