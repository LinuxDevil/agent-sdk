/**
 * Validation of an agent directory's config object (LOU-Y5). Node-free: used by
 * `readConfig()` on a config read from disk and by the Cloudflare Worker
 * runtime (src/deploy/workerAgentDir.ts) on a config bundled at build time.
 */
import type { LLMProvider } from '../providers/llm';
import { assertToolConcurrency, type ToolConcurrency } from '../execution/toolBatch';
import { closest } from './closest';
import { SDKError } from '../execution/errors';
import type { AgentHook } from '../execution/hooks';
import type { AgentCompaction } from '../context/agentCompaction';
import type { RunLimits } from '../execution/budget';
import type { ApproveToolCall } from '../createAgentApprovals';
import type { PermissionAction, PermissionMode, PermissionRule } from '../execution/permissions';

/**
 * A permission rule as an agent directory's config file may write it
 * (LOU-Y5 follow-up: the serializable half of `createAgent`'s
 * `permissions`). `tool` is a name, a list of names (`'*'` covers every
 * tool) or - in a code config file - a `RegExp`. `when` narrows the rule:
 * in JSON / YAML it is a record mapping an argument name to a regular
 * expression tested against `String(args[name])` (all must match); a code
 * config may give the predicate itself. See {@link permissionRulesOf}.
 *
 * @example
 * ```json
 * { "tool": "shell", "when": { "command": "\\brm\\b" }, "action": "deny", "reason": "No deletes" }
 * ```
 */
export interface AgentDirPermissionRule {
  tool: string | readonly string[] | RegExp;
  when?: Record<string, string> | PermissionRule['when'];
  action: PermissionAction;
  reason?: string;
}

/**
 * The options an agent directory's config file (`agent.ts` / `.js` / `.json`
 * / `.yaml`) may set. Everything here is optional; `instructions` may live in
 * `instructions.md` instead. `provider` can only be given from a code file.
 *
 * @example
 * ```ts
 * // agent.ts
 * export default { model: 'openai/gpt-4o-mini', description: 'Triages bugs', maxSteps: 8 };
 * ```
 */
export interface AgentDirConfig {
  /** Agent name; defaults to the directory name. */
  name?: string;
  /** What this agent does. Required for agents in `subagents/` (the parent's model reads it). */
  description?: string;
  /** `provider/model` string, or a bare model id when `provider` is also given. */
  model?: string;
  /** An LLM provider instance (code config files only). */
  provider?: LLMProvider;
  /** System prompt. Mutually exclusive with `instructions.md`. */
  instructions?: string;
  /** Maximum model/tool round trips per `send()`. */
  maxSteps?: number;
  /** How many tool calls from one turn may run at once. */
  toolConcurrency?: ToolConcurrency;
  /** Append the nearest AGENTS.md / CLAUDE.md, see `createAgent`'s `projectInstructions`. */
  projectInstructions?: boolean | { cwd?: string; files?: readonly string[] };
  /** `createAgent`'s `permissionMode` ('default', 'plan', 'acceptEdits' or 'dontAsk'; a function only in a code config). */
  permissionMode?: PermissionMode | (() => PermissionMode);
  /** `createAgent`'s `permissions`, in the serializable {@link AgentDirPermissionRule} form. */
  permissions?: readonly AgentDirPermissionRule[];
  /** `createAgent`'s `compaction` (an options object, or `true` for the defaults). */
  compaction?: AgentCompaction;
  /** The agent's hooks: a path (relative to the directory) of a file default-exporting a hook or a list, or - in a code config - the hook(s) inline. */
  hooks?: string | AgentHook | readonly AgentHook[];
  /** The approver of `ask`ed tool calls: a path (relative to the directory) of a file default-exporting the function, or - in a code config - the function inline. */
  approve?: string | ApproveToolCall;
  /** `createAgent`'s `limits` (e.g. `{ "maxCostUsd": 0.05 }`). */
  limits?: RunLimits;
  /**
   * The sub-agent engine. Only valid in a `subagents/<name>/` directory:
   * `'pi'` turns it into a {@link piAgent} coding sub-agent instead of a
   * nested `createAgent()` one, so it lands in the parent's `subagents` map
   * (the `task` tool) rather than becoming a `delegate_to_<name>` tool.
   */
  engine?: 'pi';
}

const CONFIG_KEYS = [
  'name',
  'description',
  'model',
  'provider',
  'instructions',
  'maxSteps',
  'toolConcurrency',
  'projectInstructions',
  'permissionMode',
  'permissions',
  'compaction',
  'hooks',
  'approve',
  'limits',
  'engine',
] as const;

/** Throws LOUSHO_AGENT_DIR_INVALID for the config file `file`. */
export function fail(file: string, message: string): never {
  throw new SDKError(`loadAgentDir: ${file}: ${message}`, 'LOUSHO_AGENT_DIR_INVALID');
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value)}`;
}

function assertKnownKeys(file: string, config: Record<string, unknown>): void {
  const problems: string[] = [];
  for (const key of Object.keys(config)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    const suggestion = closest(key, CONFIG_KEYS);
    problems.push(`'${key}'${suggestion ? ` (did you mean '${suggestion}'?)` : ''}`);
  }
  if (problems.length > 0) {
    fail(file, `unknown config key ${problems.join(', ')}. Allowed keys: ${CONFIG_KEYS.join(', ')}.`);
  }
}

function assertString(file: string, key: string, value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    fail(file, `'${key}' must be a non-empty string, got ${describeValue(value)}.`);
  }
}

function assertMaxSteps(file: string, value: unknown): void {
  if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value >= 1)) {
    fail(file, `'maxSteps' must be a positive integer, got ${describeValue(value)}.`);
  }
}

function assertProvider(file: string, value: unknown): void {
  if (value === undefined) return;
  const generate = (value as { generate?: unknown } | null)?.generate;
  if (typeof generate !== 'function') {
    fail(
      file,
      `'provider' must be an LLM provider instance (an object with generate()), got ${describeValue(value)}. ` +
        "Config files in JSON/YAML can only set 'model' as a 'provider/model' string."
    );
  }
}

function assertProjectInstructions(file: string, value: unknown): void {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (value !== undefined && typeof value !== 'boolean' && !isObject) {
    fail(file, `'projectInstructions' must be a boolean or { cwd?, files? }, got ${describeValue(value)}.`);
  }
}

const PERMISSION_MODE_NAMES: ReadonlySet<string> = new Set<PermissionMode>(['default', 'plan', 'acceptEdits', 'dontAsk']);
const PERMISSION_ACTIONS: ReadonlySet<string> = new Set<PermissionAction>(['allow', 'deny', 'ask']);
const RULE_KEYS = new Set(['tool', 'when', 'action', 'reason']);
const LIMIT_KEYS: ReadonlySet<string> = new Set<keyof RunLimits>([
  'maxTokens',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCostUsd',
  'maxDurationMs',
  'maxSteps',
  'onExceeded',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof RegExp);
}

function assertPermissionMode(file: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === 'function') return;
  if (typeof value === 'string' && PERMISSION_MODE_NAMES.has(value)) return;
  fail(file, `'permissionMode' must be 'default', 'plan', 'acceptEdits' or 'dontAsk' (a code config may set a function), got ${describeValue(value)}.`);
}

/** The `tool` matcher of a config permission rule: a name, a list of names, or (code config) a RegExp. */
function isToolMatcher(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  if (value instanceof RegExp) return true;
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string' && name !== '');
}

/** The `when` of a config permission rule: a predicate (code config) or { argName: regex string }. */
function isWhen(value: unknown): boolean {
  if (typeof value === 'function') return true;
  return isPlainObject(value) && Object.keys(value).length > 0 && Object.values(value).every((pattern) => typeof pattern === 'string');
}

function assertPermissionRule(file: string, index: number, rule: unknown): void {
  const where = `'permissions[${index}]'`;
  if (!isPlainObject(rule)) fail(file, `${where} must be an object like { "tool": "shell", "action": "deny" }, got ${describeValue(rule)}.`);
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length > 0) fail(file, `${where}: unknown key(s) ${unknown.join(', ')}. Allowed keys: tool, when, action, reason.`);
  if (!isToolMatcher(rule.tool)) fail(file, `${where}.tool must be a tool name, a list of names or (a code config) a RegExp, got ${describeValue(rule.tool)}.`);
  if (typeof rule.action !== 'string' || !PERMISSION_ACTIONS.has(rule.action)) {
    fail(file, `${where}.action must be 'allow', 'deny' or 'ask', got ${describeValue(rule.action)}.`);
  }
  if (rule.reason !== undefined && typeof rule.reason !== 'string') fail(file, `${where}.reason must be a string, got ${describeValue(rule.reason)}.`);
  if (rule.when !== undefined && !isWhen(rule.when)) {
    fail(file, `${where}.when must be a predicate (a code config) or a record of argument names to regular expressions, got ${describeValue(rule.when)}.`);
  }
  if (isPlainObject(rule.when)) {
    for (const [arg, pattern] of Object.entries(rule.when)) {
      try {
        new RegExp(pattern as string);
      } catch (error) {
        fail(file, `${where}.when.${arg} is not a valid regular expression: ${(error as Error).message}`);
      }
    }
  }
}

function assertPermissions(file: string, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    fail(file, `'permissions' must be a list of rules, e.g. [{ "tool": "shell", "action": "deny" }], got ${describeValue(value)}.`);
  }
  value.forEach((rule, index) => assertPermissionRule(file, index, rule));
}

function assertCompaction(file: string, value: unknown): void {
  if (value === undefined || typeof value === 'boolean') return;
  if (!isPlainObject(value)) fail(file, `'compaction' must be true or an options object like { "thresholdPercent": 0.8 }, got ${describeValue(value)}.`);
}

function assertHooks(file: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === 'string' && value.trim() !== '') return;
  const hooks = Array.isArray(value) ? value : [value];
  if (hooks.length === 0 || !hooks.every((hook) => isPlainObject(hook) && typeof hook.name === 'string')) {
    fail(file, `'hooks' must be a path to a hooks file (e.g. "hooks.ts") or - in a code config - a hook or a list of them, got ${describeValue(value)}.`);
  }
}

function assertApprove(file: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === 'function' || (typeof value === 'string' && value.trim() !== '')) return;
  fail(file, `'approve' must be a path to an approver file (e.g. "approve.ts") or - in a code config - a function, got ${describeValue(value)}.`);
}

function assertLimits(file: string, value: unknown): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) fail(file, `'limits' must be an object like { "maxCostUsd": 0.05 }, got ${describeValue(value)}.`);
  for (const [key, entry] of Object.entries(value)) {
    if (!LIMIT_KEYS.has(key)) fail(file, `'limits.${key}' is not a known limit. Allowed keys: ${[...LIMIT_KEYS].join(', ')}.`);
    if (key === 'onExceeded') {
      if (entry !== 'stop' && entry !== 'throw') fail(file, `'limits.onExceeded' must be 'stop' or 'throw', got ${describeValue(entry)}.`);
    } else if (!(typeof entry === 'number' && Number.isFinite(entry) && entry > 0)) {
      fail(file, `'limits.${key}' must be a positive number, got ${describeValue(entry)}.`);
    }
  }
}

function assertEngine(file: string, value: unknown): void {
  if (value !== undefined && value !== 'pi') {
    fail(file, `'engine' must be 'pi' (a Pi coding sub-agent), got ${describeValue(value)}.`);
  }
}

function assertValues(file: string, c: Record<string, unknown>): void {
  for (const key of ['name', 'description', 'model', 'instructions']) assertString(file, key, c[key]);
  assertMaxSteps(file, c.maxSteps);
  assertProvider(file, c.provider);
  assertProjectInstructions(file, c.projectInstructions);
  assertPermissionMode(file, c.permissionMode);
  assertPermissions(file, c.permissions);
  assertCompaction(file, c.compaction);
  assertHooks(file, c.hooks);
  assertApprove(file, c.approve);
  assertLimits(file, c.limits);
  assertEngine(file, c.engine);
  try {
    assertToolConcurrency(c.toolConcurrency, 'config');
  } catch (error) {
    fail(file, (error as Error).message.replace(/^config: /, ''));
  }
}

/**
 * Turns the config's {@link AgentDirPermissionRule}s into `createAgent()`'s
 * `PermissionRule`s: a `when` record becomes a predicate that requires every
 * argument's regex to match `String(args[name])`. `file` only names errors.
 * Node-free: the Cloudflare Worker runtime converts the same way.
 */
export function permissionRulesOf(file: string, rules: readonly AgentDirPermissionRule[] | undefined): PermissionRule[] | undefined {
  if (rules === undefined) return undefined;
  return rules.map((rule, index) => {
    let when: PermissionRule['when'];
    if (typeof rule.when === 'function') {
      when = rule.when;
    } else if (rule.when !== undefined) {
      const tests = Object.entries(rule.when).map(([arg, pattern]) => {
        try {
          return { arg, regex: new RegExp(pattern) };
        } catch (error) {
          fail(file, `'permissions[${index}].when.${arg}' is not a valid regular expression: ${(error as Error).message}`);
        }
      });
      when = (args) => tests.every(({ arg, regex }) => regex.test(String(args[arg] ?? '')));
    }
    return { tool: rule.tool, ...(when !== undefined && { when }), action: rule.action, ...(rule.reason !== undefined && { reason: rule.reason }) };
  });
}

/**
 * Validates `value`, the contents of the config file `file`: an object with
 * only known keys and well-typed values (`null`/`undefined` is an empty
 * config). Throws LOUSHO_AGENT_DIR_INVALID naming the file.
 */
export function validateConfig(file: string, value: unknown): AgentDirConfig {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(file, `the config must be an object (export default { model: '...' }), got ${describeValue(value)}.`);
  }
  const config = value as Record<string, unknown>;
  assertKnownKeys(file, config);
  assertValues(file, config);
  return config as AgentDirConfig;
}
