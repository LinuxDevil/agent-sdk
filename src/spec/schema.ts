/**
 * Declarative agent spec file format (LOU-H9).
 *
 * A plain-data description of an agent - name, prompt, provider, tool
 * names - that can be authored as YAML or JSON and turned into a live
 * agent via specToAgent(). The TS interface and the zod schema below are
 * kept in lockstep by hand (zod is already a project dependency; no
 * schema-to-type codegen is set up in this repo).
 */
import { z } from 'zod';
import { anyError, typeErrors, type SafeParser } from '../utils/zodCompat';
import type { McpApproval } from '../tools/mcp/McpToolLoader';
import type { RunLimits } from '../execution/budget';
import { guardrailEntrySchema, type AgentSpecGuardrail } from './guardrailOptions';

export interface AgentSpecProvider {
  type: string;
  model: string;
}

/** `policy.compaction` as an object: when to compact, as a fraction of the context window. */
export interface AgentSpecCompaction {
  thresholdPercent?: number;
}

export { SPEC_GUARDRAIL_NAMES, type AgentSpecGuardrail, type SpecGuardrailName } from './guardrailOptions';

/**
 * Optional cross-harness execution policy (LOU-J1+). The known fields below
 * are validated and compiled by specToAgent() (LOU-X5) into `createAgent()`
 * permissions, guardrails, limits, `askQuestion` and compaction. Other
 * fields stay an open record (`.passthrough()` on the zod side): different
 * target harnesses (Claude Code, Codex, Pi, ...) each honor a different
 * subset, and the generators read the raw policy.
 */
export interface AgentSpecPolicy {
  /** `true`: every tool call asks for approval. A list: only those tools do. */
  requiresApproval?: boolean | string[];
  /** Built-in guardrails (see {@link AgentSpecGuardrail}'s names, `SPEC_GUARDRAIL_NAMES`) on the agent's input and output. */
  guardrails?: AgentSpecGuardrail[];
  /** Budgets of each run (`createAgent({ limits })`). */
  limits?: RunLimits;
  /** Adds the built-in `ask_question` tool. */
  askQuestion?: boolean;
  /** `true` for the defaults, or `{ thresholdPercent }`. */
  compaction?: boolean | AgentSpecCompaction;
  /** Additional, harness-specific policy fields. */
  [key: string]: unknown;
}

/**
 * Optional trigger describing when/how this agent is invoked outside of a
 * direct call (e.g. a monitoring webhook, a cron schedule). Open record for
 * the same reason as AgentSpecPolicy above.
 */
export interface AgentSpecTrigger {
  type: string;
  [key: string]: unknown;
}

/** An MCP server launched as a child process and spoken to over stdio. */
export interface McpStdioServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Which of this server's tools ask for approval (LOU-Z5). Default `'annotations'`. */
  approval?: McpApproval;
}

/** An MCP server reached over HTTP. */
export interface McpHttpServerSpec {
  url: string;
  headers?: Record<string, string>;
  /** Which of this server's tools ask for approval (LOU-Z5). Default `'annotations'`. */
  approval?: McpApproval;
}

/**
 * One entry of `AgentSpec.mcpServers` (LOU-D20): stdio (`command`, optional
 * `args`/`env`) or HTTP (`url`, optional `headers`). Exactly one of
 * `command` / `url` is set.
 */
export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

export interface AgentSpec {
  name: string;
  prompt: string;
  provider: AgentSpecProvider;
  tools?: string[];
  /**
   * Optional (LOU-J1+, backward-compatible with LOU-H9's original
   * {name, prompt, provider, tools} shape - existing specs that omit this
   * still validate and load unchanged).
   */
  policy?: AgentSpecPolicy;
  /** Optional (LOU-J1+), same backward-compatibility note as `policy`. */
  triggers?: AgentSpecTrigger[];
  /**
   * Optional (LOU-D20), same backward-compatibility note as `policy`: MCP
   * servers this agent uses, keyed by a name that namespaces their tools.
   */
  mcpServers?: Record<string, McpServerSpec>;
}

const providerSchema = z.object({
  type: z.string(typeErrors({ required: "AgentSpec validation failed: missing required field 'provider.type'" })),
  model: z.string(typeErrors({ required: "AgentSpec validation failed: missing required field 'provider.model'" })),
});

const POLICY = 'AgentSpec validation failed:';

const posInt = z.number().int().positive();

const runLimitsSchema = z
  .object({
    maxTokens: posInt.optional(),
    maxInputTokens: posInt.optional(),
    maxOutputTokens: posInt.optional(),
    maxCostUsd: z.number().positive().optional(),
    maxDurationMs: posInt.optional(),
    maxSteps: posInt.optional(),
    onExceeded: z.enum(['stop', 'throw']).optional(),
  })
  .strict();

const policySchema = z
  .object({
    requiresApproval: z
      .union([z.boolean(), z.array(z.string().min(1))], anyError(`${POLICY} 'requiresApproval' must be true, false or a list of tool names`))
      .optional(),
    guardrails: z.array(guardrailEntrySchema).optional(),
    limits: runLimitsSchema.optional(),
    askQuestion: z.boolean().optional(),
    compaction: z
      .union(
        [z.boolean(), z.object({ thresholdPercent: z.number().gt(0).lte(1).optional() }).strict()],
        anyError(`${POLICY} 'compaction' must be a boolean or { thresholdPercent: 0-1 }`)
      )
      .optional(),
  })
  .passthrough();

const triggerSchema = z
  .object({
    type: z.string(typeErrors({ required: "AgentSpec validation failed: missing required field 'triggers[].type'" })),
  })
  .passthrough();

const MCP_PREFIX = 'AgentSpec validation failed:';

const mcpStringMap = (field: string) =>
  z.record(z.string(), z.string(), typeErrors({ invalid: `${MCP_PREFIX} '${field}' must be a map of string to string` }));

/** `approval`: a mode, or (in code, not YAML/JSON) a predicate over a tool's name and annotations. */
const mcpApprovalSchema = z.union(
  [z.enum(['annotations', 'always', 'never']), z.custom<McpApproval>((value) => typeof value === 'function')],
  anyError(`${MCP_PREFIX} 'approval' must be 'annotations', 'always' or 'never'`)
);

/** What is wrong with a loosely-parsed `mcpServers` entry, if anything. */
function mcpServerProblem(server: Record<string, unknown>): string | undefined {
  const stdio = server.command !== undefined;
  if (stdio === (server.url !== undefined)) {
    return stdio
      ? "set either 'command' (stdio) or 'url' (HTTP), not both"
      : "missing 'command' (stdio server) or 'url' (HTTP server)";
  }
  const stray = (stdio ? ['headers'] : ['args', 'env']).find((key) => server[key] !== undefined);
  return stray && `'${stray}' does not apply to ${stdio ? "a stdio ('command')" : "an HTTP ('url')"} server`;
}

/**
 * One `mcpServers` entry. A plain z.discriminatedUnion cannot word the
 * mix-ups well (neither/both of command and url, stdio-only fields on an HTTP
 * server and vice versa), so this validates a loose object and then narrows it
 * to McpServerSpec. Issue paths include the entry name (`mcpServers.fs.env`).
 */
const mcpServerSchema = z
  .object(
    {
      command: z
        .string(typeErrors({ invalid: `${MCP_PREFIX} 'command' must be a string` }))
        .min(1)
        .optional(),
      args: z
        .array(z.string(), typeErrors({ invalid: `${MCP_PREFIX} 'args' must be a list of strings` }))
        .optional(),
      env: mcpStringMap('env').optional(),
      url: z
        .string(typeErrors({ invalid: `${MCP_PREFIX} 'url' must be a string` }))
        .url(`${MCP_PREFIX} 'url' must be a valid URL`)
        .optional(),
      headers: mcpStringMap('headers').optional(),
      approval: mcpApprovalSchema.optional(),
    },
    typeErrors({ invalid: `${MCP_PREFIX} each mcpServers entry must be an object with 'command' or 'url'` })
  )
  .superRefine((server, ctx) => {
    const problem = mcpServerProblem(server);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${MCP_PREFIX} ${problem}` });
    }
  })
  // superRefine has verified exactly one of command/url and no cross-shape fields.
  .transform((server): McpServerSpec => server as McpServerSpec);

/** Also accepts the pre-LOU-D20 list form `[{ name, command | url }]` that `lousho doctor` read. */
const mcpServersSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? Object.fromEntries(
          value.map((entry: unknown, index) => {
            const { name, ...rest } = (entry ?? {}) as Record<string, unknown>;
            return [typeof name === 'string' ? name : `#${index + 1}`, rest];
          })
        )
      : value,
  z.record(z.string(), mcpServerSchema, typeErrors({ invalid: `${MCP_PREFIX} 'mcpServers' must be a map of server name to config` }))
);

const specSchema = z.object({
  name: z.string(typeErrors({ required: "AgentSpec validation failed: missing required field 'name'" })),
  prompt: z.string(typeErrors({ required: "AgentSpec validation failed: missing required field 'prompt'" })),
  provider: providerSchema,
  tools: z.array(z.string()).optional(),
  policy: policySchema.optional(),
  triggers: z.array(triggerSchema).optional(),
  mcpServers: mcpServersSchema.optional(),
});

/**
 * The spec schemas as published: structural types, not zod's, so their
 * declarations do not depend on the installed zod major (LOU-V4.2). `safeParse`
 * and `parse` work as on a zod schema.
 */
export interface SpecSchema<T> extends SafeParser<T> {
  parse(value: unknown): T;
}

/** {@link SpecSchema} of an object schema, with its `shape` (the spec's field names). */
export interface SpecObjectSchema<T> extends SpecSchema<T> {
  readonly shape: Readonly<Record<string, unknown>>;
}

export const agentSpecProviderSchema = providerSchema as unknown as SpecSchema<AgentSpecProvider>;
export const agentSpecPolicySchema = policySchema as unknown as SpecSchema<AgentSpecPolicy>;
export const agentSpecTriggerSchema = triggerSchema as unknown as SpecSchema<AgentSpecTrigger>;
export const mcpServerSpecSchema = mcpServerSchema as unknown as SpecSchema<McpServerSpec>;
export const agentSpecSchema = specSchema as unknown as SpecObjectSchema<AgentSpec>;
