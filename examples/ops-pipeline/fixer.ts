/**
 * Ops pipeline: fixer agent core (LOU-J6) - repo/log context in, unified
 * diff out.
 *
 * runFixer() diagnoses a FixRequest (built from an ErrorSignal, see
 * monitor.ts) via the REAL static AgentExecutor.execute() and extracts a
 * unified diff from the response text. It is wired as the target of a
 * defineTool() tool (see createFixerTool() below) so the monitor agent can
 * delegate a fix request to it by ordinary tool-calling.
 *
 * See guardedPr.ts (LOU-J7) for what happens to the extracted patch next
 * (guardrail-gated PR creation) - kept in a sibling file since it composes
 * this module's output with the LOU-E guardrails and LOU-J5 Slack tool
 * rather than being fixer-core itself.
 */
import { z } from 'zod';
import {
  AgentExecutor,
  ExecuteOptions,
  ExecutionResult,
} from '../../src/execution/AgentExecutor';
import { AgentConfig, ToolDescriptor } from '../../src/types';
import { defineTool } from '../../src/tools/defineTool';
import { LLMProvider } from '../../src/providers';

/**
 * A request to diagnose-and-fix an error, built from an ErrorSignal
 * (monitor.ts) or from a fixer tool task.
 */
export interface FixRequest {
  errorSignature: string;
  logs: string;
  files: string[];
}

const FIXER_SYSTEM_PROMPT =
  'You are a fixer agent. Given error logs and the repository files involved, diagnose the root ' +
  'cause and produce a MINIMAL unified diff that fixes it. Always respond with the diff in a ' +
  "fenced ```diff code block. Never invent files you were not shown.";

/**
 * Builds the fixer AgentConfig used by runFixer()/createFixerTool().
 */
export function buildFixerAgent(name = 'fixer'): AgentConfig {
  return {
    name,
    prompt: FIXER_SYSTEM_PROMPT,
  };
}

/**
 * Builds the user-message input for a FixRequest.
 */
function buildFixerInput(request: FixRequest): string {
  return [
    `Error signature: ${request.errorSignature}`,
    '',
    'Logs:',
    request.logs,
    '',
    'Files involved:',
    request.files.length > 0 ? request.files.join('\n') : '(none provided)',
  ].join('\n');
}

/** Thrown by runFixer()/extractDiffBlock() when no non-empty diff could be extracted. */
export class EmptyPatchError extends Error {
  constructor(message = 'Fixer produced an empty or unparseable patch') {
    super(message);
    this.name = 'EmptyPatchError';
  }
}

/**
 * Extracts a unified diff from a fixer agent's free-text response.
 *
 * Strategy, in order:
 *  1. A fenced ```diff ... ``` code block (or a plain ``` ... ``` block
 *     whose content looks like a diff) - the common case for an LLM
 *     response.
 *  2. Falling back to scanning for unified-diff markers (`--- `, `+++ `,
 *     `@@`) directly in the text and taking from the first such marker to
 *     the end, for a response that didn't fence the diff.
 *  3. Otherwise returns an empty string (callers treat this as "no patch",
 *     see EmptyPatchError).
 */
export function extractDiffBlock(text: string): string {
  const fencedDiffMatch = text.match(/```diff\r?\n([\s\S]*?)```/);
  if (fencedDiffMatch) {
    return fencedDiffMatch[1].trim();
  }

  // A plain fenced block whose content itself looks like a diff.
  const fencedMatches = [...text.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)];
  for (const match of fencedMatches) {
    const content = match[1];
    if (looksLikeDiff(content)) {
      return content.trim();
    }
  }

  const lines = text.split('\n');
  const startIndex = lines.findIndex(
    (line) => line.startsWith('--- ') || line.startsWith('diff --git') || /^@@ /.test(line)
  );
  if (startIndex !== -1) {
    return lines.slice(startIndex).join('\n').trim();
  }

  return '';
}

function looksLikeDiff(content: string): boolean {
  return /^(diff --git|--- |\+\+\+ |@@ )/m.test(content);
}

/**
 * Runs the fixer agent against `request` via the REAL static
 * AgentExecutor.execute() and extracts a unified diff from its response.
 * Throws EmptyPatchError if no non-empty patch could be extracted.
 *
 * SAFETY: this function only produces a patch candidate. It does NOT run
 * guardrails and does NOT gate on human approval. In the shipped pipeline
 * (index.ts) it is only ever reached from inside the fixer tool that
 * AgentExecutor pauses on `needsApproval: true` before invoking. Do not
 * call runFixer() directly from a new entry point without first routing
 * through that same approval gate and through handleFixerPatch()'s
 * guardrail check (guardedPr.ts) before any GitHub write action.
 */
export async function runFixer(
  request: FixRequest,
  provider: LLMProvider,
  options: Partial<Omit<ExecuteOptions, 'agent' | 'input' | 'provider'>> = {}
): Promise<{ patch: string; result: ExecutionResult }> {
  const agent = buildFixerAgent();
  const result = await AgentExecutor.execute({
    ...options,
    agent,
    input: buildFixerInput(request),
    provider,
  });

  const patch = extractDiffBlock(result.text);
  if (!patch.trim()) {
    throw new EmptyPatchError();
  }

  return { patch, result };
}

/**
 * Creates a `defineTool()` tool that runs the fixer agent for one task and
 * post-processes its response text into an extracted `patch` field (via
 * extractDiffBlock()), so a parent (monitor) agent's delegation to the
 * fixer agent yields a usable patch the same way runFixer() does directly.
 * Throws EmptyPatchError if the fixer agent's response has no extractable
 * diff.
 */
export function createFixerTool(opts: { agent: AgentConfig; provider: LLMProvider }): ToolDescriptor {
  return defineTool({
    name: 'delegate_to_fixer',
    description: 'Delegate a fix request to the fixer agent and get back a unified diff patch.',
    input: z.object({ task: z.string() }),
    execute: async ({ task }, context) => {
      const result = await AgentExecutor.execute({
        agent: opts.agent,
        input: task,
        provider: opts.provider,
        signal: context.abortSignal,
      });
      const patch = extractDiffBlock(result.text);
      if (!patch.trim()) {
        throw new EmptyPatchError();
      }
      return { text: result.text, patch };
    },
  });
}
