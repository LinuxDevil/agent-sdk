/**
 * Ops pipeline: fixer agent core (LOU-J6) - repo/log context in, unified
 * diff out.
 *
 * runFixer() diagnoses a FixRequest (built from an ErrorSignal, see
 * monitor.ts) via the REAL static AgentExecutor.execute() and extracts a
 * unified diff from the response text. It is wired as the target of a
 * LOU-D1 real createDelegateTool() call so the monitor agent can delegate a
 * fix request to it by ordinary tool-calling (see createFixerDelegateTool()
 * below).
 *
 * See guardedPr.ts (LOU-J7) for what happens to the extracted patch next
 * (guardrail-gated PR creation) - kept in a sibling file since it composes
 * this module's output with the LOU-E guardrails and LOU-J5 Slack tool
 * rather than being fixer-core itself.
 */
import { tool } from 'ai';
import {
  AgentExecutor,
  ExecuteOptions,
  ExecutionResult,
} from '../../src/execution/AgentExecutor';
import { AgentConfig, AgentType, ToolDescriptor } from '../../src/types';
import { LLMProvider } from '../../src/providers';
import {
  createDelegateTool,
  DelegateAgentOptions,
} from '../../src/execution/DelegationTool';

/**
 * A request to diagnose-and-fix an error, built from an ErrorSignal
 * (monitor.ts) or from a delegate-tool task.
 */
export interface FixRequest {
  errorSignature: string;
  logs: string;
  files: string[];
}

export const FIXER_SYSTEM_PROMPT =
  'You are a fixer agent. Given error logs and the repository files involved, diagnose the root ' +
  'cause and produce a MINIMAL unified diff that fixes it. Always respond with the diff in a ' +
  "fenced ```diff code block. Never invent files you were not shown.";

/**
 * Builds the fixer AgentConfig used by runFixer()/createFixerDelegateTool().
 */
export function buildFixerAgent(name = 'fixer'): AgentConfig {
  return {
    name,
    agentType: AgentType.SmartAssistant,
    prompt: FIXER_SYSTEM_PROMPT,
  };
}

/**
 * Builds the user-message input for a FixRequest.
 */
export function buildFixerInput(request: FixRequest): string {
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
 * Creates a ToolDescriptor that wraps the REAL LOU-D1 createDelegateTool()
 * targeting the fixer agent, post-processing its response text into an
 * extracted `patch` field (via extractDiffBlock()) so a parent (monitor)
 * agent's delegation to the fixer agent yields a usable patch the same way
 * runFixer() does directly. Throws EmptyPatchError if the delegated fixer
 * agent's response has no extractable diff.
 */
export function createFixerDelegateTool(opts: DelegateAgentOptions): ToolDescriptor {
  const base = createDelegateTool(opts);
  const baseTool = base.tool;

  return {
    ...base,
    tool: tool({
      description: baseTool.description,
      parameters: baseTool.parameters,
      execute: async (args: any, context: any) => {
        const result = await baseTool.execute!(args, context);
        const patch = extractDiffBlock((result as { text: string }).text);
        if (!patch.trim()) {
          throw new EmptyPatchError();
        }
        return { ...(result as object), patch };
      },
    }) as typeof baseTool,
  };
}
