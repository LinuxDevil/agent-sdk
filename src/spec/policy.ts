/**
 * `AgentSpec.policy` compiled into `createAgent()` options (LOU-X5).
 */
import type { z } from 'zod';
import type { CreateAgentConfig } from '../createAgent';
import { ValidationError } from '../execution/errors';
import { ask } from '../execution/permissions';
import {
  denyTopicsGuardrail,
  llmJudgeGuardrail,
  maxLengthGuardrail,
  regexGuardrail,
  type AgentGuardrails,
  type IoGuardrail,
} from '../execution/ioGuardrails';
import { GUARDRAIL_OPTIONS, guardrailParts, isSpecGuardrailName, unknownGuardrailMessage, type SpecGuardrailName } from './guardrailOptions';
import { agentSpecPolicySchema, type AgentSpecPolicy } from './schema';

/** The `createAgent()` options a policy compiles to. */
export type CompiledPolicy = Pick<CreateAgentConfig, 'permissions' | 'guardrails' | 'limits' | 'askQuestion' | 'compaction'>;

type GuardrailOptions<N extends SpecGuardrailName> = z.infer<(typeof GUARDRAIL_OPTIONS)[N]>;

const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_JUDGE_INSTRUCTION = 'Reject anything unsafe, abusive or outside what this agent is meant to do.';

/** How each built-in guardrail name builds its guardrail from its options. */
const BUILDERS: { [N in SpecGuardrailName]: (options: GuardrailOptions<N>) => IoGuardrail } = {
  'max-length': ({ maxChars = DEFAULT_MAX_CHARS }) => maxLengthGuardrail({ maxChars }),
  'secret-scan': (options) => regexGuardrail({ name: 'secret-scan', ...options }),
  regex: ({ pattern, flags, ...options }) => regexGuardrail({ name: 'regex', pattern: new RegExp(pattern, flags), ...options }),
  'deny-topics': ({ topics }) => denyTopicsGuardrail({ topics }),
  'llm-judge': ({ model, instruction = DEFAULT_JUDGE_INSTRUCTION }) => llmJudgeGuardrail({ model, instruction }),
};

type GuardrailTarget = 'input' | 'output' | 'tools';

function compileGuardrails(entries: NonNullable<AgentSpecPolicy['guardrails']>): AgentGuardrails | undefined {
  const lists: Record<GuardrailTarget, IoGuardrail[]> = { input: [], output: [], tools: [] };
  for (const entry of entries) {
    const { name, options } = guardrailParts(entry);
    if (!isSpecGuardrailName(name)) throw new ValidationError(`specToAgent: ${unknownGuardrailMessage(name)}`, undefined, 'LOUSHO_SPEC_INVALID');
    const { on = ['input', 'output'], ...rest } = GUARDRAIL_OPTIONS[name].parse(options) as { on?: GuardrailTarget | GuardrailTarget[] };
    const guardrail = (BUILDERS[name] as (options: unknown) => IoGuardrail)(rest);
    for (const target of typeof on === 'string' ? [on] : on) lists[target].push(guardrail);
  }
  const compiled = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0));
  return Object.keys(compiled).length > 0 ? compiled : undefined;
}

/**
 * Compiles `spec.policy` into `createAgent()` options: `requiresApproval` into
 * `permissions` (`true`: `ask('*')`; a list: `ask` for those tools),
 * `guardrails` into input and output guardrails (`on` per entry can add
 * `tools`), and `limits`, `askQuestion` and `compaction` as they are. Throws a
 * `ValidationError` for an invalid policy; fields it does not know are ignored.
 */
export function compilePolicy(policy: AgentSpecPolicy | undefined): CompiledPolicy {
  if (!policy) return {};
  const parsed = agentSpecPolicySchema.safeParse(policy);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `'policy.${(issue.path ?? []).join('.')}': ${issue.message}`);
    throw new ValidationError(`specToAgent: invalid policy - ${issues.join('; ')}`, undefined, 'LOUSHO_SPEC_INVALID');
  }
  const { requiresApproval, guardrails, limits, askQuestion, compaction } = parsed.data as AgentSpecPolicy;
  const approval = requiresApproval === true ? '*' : requiresApproval;
  return {
    ...(approval && approval.length > 0 && { permissions: [ask(approval)] }),
    ...(guardrails && { guardrails: compileGuardrails(guardrails) }),
    ...(limits && { limits }),
    ...(askQuestion !== undefined && { askQuestion }),
    ...(compaction !== undefined && { compaction }),
  };
}

/** One block of a policy for `lousho doctor`: what it compiles to, and guardrail names that do not exist. */
export interface PolicyLine {
  block: 'approval' | 'guardrails' | 'limits' | 'askQuestion' | 'compaction';
  text: string;
  unknownGuardrails: string[];
}

type Present<K extends keyof AgentSpecPolicy> = NonNullable<AgentSpecPolicy[K]>;

function line<T>(block: PolicyLine['block'], value: T | undefined, describe: (value: T) => string): PolicyLine[] {
  return value === undefined ? [] : [{ block, text: describe(value), unknownGuardrails: [] }];
}

function describeApproval(approval: Present<'requiresApproval'>): string {
  if (approval === true) return 'every tool call asks for approval';
  return Array.isArray(approval) && approval.length > 0 ? `asks for approval before: ${approval.join(', ')}` : 'no approval required';
}

function describeCompaction(compaction: Present<'compaction'>): string {
  if (!compaction) return 'off';
  const percent = typeof compaction === 'object' ? compaction.thresholdPercent : undefined;
  return percent === undefined ? 'on' : `on at ${Math.round(percent * 100)}% of the context window`;
}

function guardrailLine(guardrails: Present<'guardrails'>): PolicyLine {
  const names = guardrails.map((entry) => guardrailParts(entry).name);
  return { block: 'guardrails', text: names.join(', ') || 'none', unknownGuardrails: names.filter((name) => !isSpecGuardrailName(name)) };
}

/** One line per policy block that is set (does not validate; see {@link compilePolicy}). */
export function summarizePolicy(policy: AgentSpecPolicy | undefined): PolicyLine[] {
  if (!policy) return [];
  return [
    ...line('approval', policy.requiresApproval, describeApproval),
    ...(policy.guardrails === undefined ? [] : [guardrailLine(policy.guardrails)]),
    ...line('limits', policy.limits, (limits) => Object.entries(limits).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'none'),
    ...line('askQuestion', policy.askQuestion, (on) => (on ? 'the agent can ask the user questions' : 'off')),
    ...line('compaction', policy.compaction, describeCompaction),
  ];
}
