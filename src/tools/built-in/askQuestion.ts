/**
 * Built-in `ask_question` tool (LOU-X9).
 *
 * Lets the agent ask the user a question and wait for the answer. The call
 * pauses the run through the approval mechanism (`needsApproval: true`), so
 * the wait is durable like any approval: the pending record has
 * `kind: 'question'`, and `agent.approvals.answer({ id, answer })` (or
 * `resolve({ id, approved: true, note: answer })`) continues the run with
 * `{ answer, option? }` as the tool result.
 */
import { z } from 'zod';
import { defineTool, type DefinedTool } from '../defineTool';
import { ASK_QUESTION_TOOL_NAME } from '../../execution/ApprovalGate';
import type { ToolDescriptor } from '../../types';
import { toolFailure } from './toolFailure';
import { allowInPlanMode } from '../../execution/permissions';

const askQuestionInput = z.object({
  question: z.string().trim().min(1).describe('The question to ask, in one or two sentences.'),
  options: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe('Choices to offer when the answer is one of a few.'),
  allowFreeText: z
    .boolean()
    .optional()
    .describe('With options: whether the user may answer something else. Defaults to true.'),
});

/** The arguments of an `ask_question` call. */
export type AskQuestionInput = z.output<typeof askQuestionInput>;

/** What `ask_question` returns to the model once the user answered. */
export interface AskQuestionResult {
  answer: string;
  /** Index into `options` when the answer is one of them (case-insensitive). */
  option?: number;
}

/**
 * The built-in `ask_question` tool: the run pauses until a human answers.
 * Register it with `createAgent({ askQuestion: true })`, or pass it in
 * `tools`. Answer with `agent.approvals.answer({ id, answer })`; an `approve`
 * callback may answer by returning a string.
 *
 * @example
 * ```ts
 * const agent = createAgent({ prompt: 'Plan the trip.', provider, tools: [askQuestionTool()] });
 * ```
 */
export function askQuestionTool(): DefinedTool<typeof askQuestionInput, AskQuestionResult> {
  // N4: asking changes nothing, so plan mode lets it through (it still pauses for the answer).
  return allowInPlanMode(defineTool({
    name: ASK_QUESTION_TOOL_NAME,
    description:
      'Ask the user a question and wait for the answer. Use it only for information or a decision that only the user ' +
      'can give; offer `options` when the answer is one of a few choices.',
    input: askQuestionInput,
    needsApproval: true,
    execute({ options, allowFreeText }, ctx): AskQuestionResult {
      const answer = ctx.approval?.note?.trim();
      if (!answer) {
        throw toolFailure('No answer: ask_question returns only after a person answers it (agent.approvals.answer()).');
      }
      const option = options?.findIndex((choice) => choice.toLowerCase() === answer.toLowerCase()) ?? -1;
      if (option >= 0) return { answer, option };
      if (options && allowFreeText === false) {
        throw toolFailure(`The answer must be one of: ${options.join(', ')}`);
      }
      return { answer };
    },
  }));
}

type AgentTools = readonly DefinedTool[] | Record<string, ToolDescriptor>;

/** `tools` plus `ask_question` when `enabled` (`createAgent({ askQuestion: true })`). */
export function withAskQuestion(tools: AgentTools | undefined, enabled: boolean | undefined): AgentTools | undefined {
  if (!enabled) return tools;
  if (tools === undefined || Array.isArray(tools)) return [...((tools as readonly DefinedTool[]) ?? []), askQuestionTool()];
  return { ...tools, [ASK_QUESTION_TOOL_NAME]: askQuestionTool() };
}
