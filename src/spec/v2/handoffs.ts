/**
 * The `spec.handoffs` section of AgentSpec v2: each entry names a target
 * agent the run can hand the whole conversation to, plus the transfer
 * tool's `toolName`/`description` and an `inputFilter` naming one of the
 * SDK's ready-made filters. `inputJsonSchema` parses but is rejected as
 * "not supported yet" until the JSON Schema → Standard Schema adapter
 * (S15) is wired into handoffFromSpec (S16). Browser-safe: no `node:*`
 * imports.
 */
import { z } from 'zod';
import { anyError } from '../../utils/zodCompat';
import { specIdSchema } from './common';
import { addUnsupportedIssue } from './unsupported';

/** One `spec.handoffs` entry (PLAN §3.1). */
export interface HandoffSpec {
  /** Target: an agent id (Studio: `.lousho/agents/<id>`) or the name of one of this spec's subagents. */
  agent: string;
  /** The transfer tool's name (default `transfer_to_<target name>`). */
  toolName?: string;
  /** The transfer tool's description (default: the target's own). */
  description?: string;
  /** What the target sees: one of the SDK's named filters. */
  inputFilter?: 'removeToolCalls' | 'lastUserMessage';
  /** JSON Schema of the handoff arguments. Not supported yet (needs S15's adapter wired in). */
  inputJsonSchema?: Record<string, unknown>;
}

/** The transfer tool's name rule: the same one defineTool() enforces. */
const HANDOFF_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** One `spec.handoffs` entry (zod). */
// fallow-ignore-next-line unused-export -- composed by handoffListSchema; exported for section schemas that embed it
export const handoffSpecSchema = z
  .object({
    agent: specIdSchema,
    toolName: z
      .string()
      .regex(HANDOFF_TOOL_NAME_PATTERN, 'must be 1-64 letters, digits, dashes or underscores')
      .optional(),
    description: z.string().min(1).max(1024).optional(),
    inputFilter: z.enum(['removeToolCalls', 'lastUserMessage'], anyError("must be 'removeToolCalls' or 'lastUserMessage'")).optional(),
    inputJsonSchema: z
      .any()
      .superRefine((value, ctx) => {
        if (value !== undefined) {
          addUnsupportedIssue(ctx, "'inputJsonSchema' on a handoff (handoffs take the default { reason } input for now)");
        }
      })
      .optional(),
  })
  .strict();

/** The list rules: targets unique, explicit toolNames unique; each repeat is flagged at its own key. */
function refineHandoffList(list: readonly HandoffSpec[], ctx: z.RefinementCtx): void {
  const targets = new Set<string>();
  const toolNames = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (targets.has(entry.agent)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate handoff to '${entry.agent}'`, path: [index, 'agent'] });
    } else {
      targets.add(entry.agent);
    }
    if (entry.toolName === undefined) continue;
    if (toolNames.has(entry.toolName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate toolName '${entry.toolName}'`, path: [index, 'toolName'] });
    } else {
      toolNames.add(entry.toolName);
    }
  }
}

/** The `spec.handoffs` list (zod): targets unique, explicit toolNames unique. */
export const handoffListSchema = z.array(handoffSpecSchema).superRefine(refineHandoffList);
