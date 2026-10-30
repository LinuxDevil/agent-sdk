/**
 * The AgentSpec v2 zod schema: strict at the top level (unknown keys get a
 * did-you-mean suggestion in parseAgentSpecV2) and placeholder fields for
 * every section that has not landed yet, which reject any value with a
 * "not supported yet" issue. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { anyError, typeErrors } from '../../utils/zodCompat';
import type { SpecObjectSchema } from '../schema';
import { modelIdSchema, relativePathSchema } from './common';
import { guardrailListSchema } from './guardrails';
import { permissionListSchema } from './permissions';
import { runtimeShape } from './runtime';
import { toolRefListSchema } from './tools';
import { pendingField } from './unsupported';
import type { AgentSpecV2 } from './types';

/** Agent `name`: 1-64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (subagent names)
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** The v2 shape (zod), for schema composition inside src/spec/v2 (S08 inline subagents, S17 JSON Schema). */
export const agentSpecV2Shape = {
  version: z.literal(2, anyError('must be 2 (convert a v1 spec with upgradeSpec())')),
  name: z
    .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
    .regex(AGENT_NAME_PATTERN, 'must be 1-64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit'),
  description: z
    .string(typeErrors({ invalid: 'must be a string' }))
    .min(1, 'must not be empty')
    .max(1024, 'must be at most 1024 characters')
    .optional(),
  model: modelIdSchema,
  fallbackModels: z.array(modelIdSchema).optional(),
  instructions: z.union([z.string(), z.object({ file: relativePathSchema }).strict()], anyError("must be a string or { file: 'instructions.md' }")),
  instructionsByFamily: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'keys must be lowercase model families such as openai'), z.string())
    .optional(),
  promptRef: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+$/, "must be 'name@version' or 'name@label', e.g. 'support@prod'")
    .optional(),
  ...runtimeShape,
  tools: toolRefListSchema.optional(),
  skills: pendingField('skills'),
  memory: pendingField('memory'),
  subagents: pendingField('subagents'),
  handoffs: pendingField('handoffs'),
  guardrails: guardrailListSchema.optional(),
  permissions: permissionListSchema.optional(),
  hooks: pendingField('hooks'),
  output: pendingField('output'),
  triggers: pendingField('triggers'),
  abortListeners: pendingField('abortListeners'),
  flow: pendingField('flow'),
  evals: pendingField('evals'),
};

const schema = z.object(agentSpecV2Shape).strict();

/** The v2 schema as published: structural, so declarations do not depend on the installed zod major. */
export const agentSpecV2Schema = schema as unknown as SpecObjectSchema<AgentSpecV2>;
