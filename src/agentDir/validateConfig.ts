/**
 * Validation of an agent directory's config object (LOU-Y5). Node-free: used by
 * `readConfig()` on a config read from disk and by the Cloudflare Worker
 * runtime (src/deploy/workerAgentDir.ts) on a config bundled at build time.
 */
import type { LLMProvider, ModelSettings } from '../providers/llm';
import { MODEL_SETTING_KEYS, modelSettingProblem } from '../execution/modelSettings';
import { assertToolConcurrency, type ToolConcurrency } from '../execution/toolBatch';
import { closest } from './closest';
import { SDKError } from '../execution/errors';
import type { AgentHook } from '../execution/hooks';
import type { AgentCompaction } from '../context/agentCompaction';
import type { RunLimits } from '../execution/budget';
import type { ApproveToolCall } from '../createAgentApprovals';
import type { PermissionAction, PermissionMode, PermissionRule } from '../execution/permissions';
import type { AgentStore } from '../storage/agentStore';
import type { TokenKeyInput } from '../oauth/tokenCipher';

/**
 * The matcher a `when` entry may set on one argument. `eq` / `ne` compare
 * the argument to the operand with `===` / `!==`; `lt` / `lte` / `gt` /
 * `gte` compare `Number(arg)` to the operand (a non-numeric argument never
 * matches); `matches` is a regular expression tested against
 * `String(args[name])`. An object may set several operators, all of which
 * must hold.
 *
 * @example
 * ```json
 * { "replicas": { "gte": 1, "lte": 10 } }
 * ```
 */
export interface WhenArgMatcher {
  eq?: string | number | boolean | null;
  ne?: string | number | boolean | null;
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
  matches?: string;
}

/**
 * A permission rule as an agent directory's config file may write it
 * (LOU-Y5 follow-up: the serializable half of `createAgent`'s
 * `permissions`). `tool` is a name, a list of names (`'*'` covers every
 * tool) or - in a code config file - a `RegExp`. `when` narrows the rule:
 * in JSON / YAML it is a record mapping an argument name to a matcher - a
 * regular expression tested against `String(args[name])`, or a
 * {@link WhenArgMatcher} operator object - and every argument's matcher
 * must hold; a code config may give the predicate itself. See
 * {@link permissionRulesOf}.
 *
 * @example
 * ```json
 * { "tool": "shell", "when": { "command": "\\brm\\b" }, "action": "deny", "reason": "No deletes" }
 * ```
 */
export interface AgentDirPermissionRule {
  tool: string | readonly string[] | RegExp;
  when?: Record<string, string | WhenArgMatcher> | PermissionRule['when'];
  action: PermissionAction;
  reason?: string;
  /**
   * TTL: with `action: 'ask'`, how long the pause waits for a decision, in
   * milliseconds (`PermissionRule.ttlMs`): decided after it, the call is
   * denied ('approval expired'). Wins over the agent's `approvalTtlMs`;
   * rejected on `allow` / `deny` rules, where it would do nothing.
   */
  ttlMs?: number;
}

/**
 * The file-backed {@link AgentStore} a data config's `store` key declares -
 * `fileStore()`'s options plus the required `dir`, which is resolved against
 * the agent directory. Sessions, checkpoints and paused approvals under it
 * survive a restart (the "draft today, approve tomorrow" case).
 *
 * @example
 * ```json
 * { "store": { "dir": "./.lousho" } }
 * ```
 */
export interface AgentDirFileStore {
  /** Directory the file store writes under, relative to the agent directory (e.g. `"./.lousho"`). */
  dir: string;
  /** `fileStore()`'s `historyLimit`: checkpoints kept per session (default 50, `0` keeps none). */
  historyLimit?: number;
  /** `fileStore()`'s `tokenKey`: 32 random bytes as base64 (`generateTokenKey()`), or several, newest first. */
  tokenKey?: TokenKeyInput;
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
  /** `createAgent`'s `approvalTtlMs`: how long a pause for approval stays decidable, in milliseconds. An `ask` rule's `ttlMs` wins over it. */
  approvalTtlMs?: number;
  /** `createAgent`'s `limits` (e.g. `{ "maxCostUsd": 0.05 }`). */
  limits?: RunLimits;
  /** `createAgent`'s `modelSettings` (e.g. `{ "maxTokens": 1024, "temperature": 0.2 }`). */
  modelSettings?: ModelSettings;
  /**
   * `createAgent`'s `store`: `{ "dir": "./.lousho" }` (an
   * {@link AgentDirFileStore}, resolved against the agent directory) becomes
   * a `fileStore()`, so sessions, checkpoints and paused approvals survive a
   * restart; a code config may give an `AgentStore` instance instead. Node
   * only - the Cloudflare Worker target rejects it.
   */
  store?: AgentDirFileStore | AgentStore;
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
  'approvalTtlMs',
  'limits',
  'modelSettings',
  'store',
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
const RULE_KEYS = new Set(['tool', 'when', 'action', 'reason', 'ttlMs']);
/** The operand kind each `when` operator takes; {@link WHEN_OPERATORS} is derived from it. */
const OPERAND_KIND: Record<keyof WhenArgMatcher, 'scalar' | 'number' | 'regex'> = {
  eq: 'scalar',
  ne: 'scalar',
  lt: 'number',
  lte: 'number',
  gt: 'number',
  gte: 'number',
  matches: 'regex',
};
const WHEN_OPERATORS = new Set<keyof WhenArgMatcher>(Object.keys(OPERAND_KIND) as (keyof WhenArgMatcher)[]);
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

/** Throws unless `pattern` compiles as a regular expression; `where` names the config path. */
function assertRegex(file: string, where: string, pattern: string): void {
  try {
    new RegExp(pattern);
  } catch (error) {
    fail(file, `${where} is not a valid regular expression: ${(error as Error).message}`);
  }
}

/** The `when` entry of one argument: a regular expression string or a {@link WhenArgMatcher} operator object. */
function assertWhenMatcher(file: string, where: string, matcher: unknown): void {
  if (typeof matcher === 'string') {
    assertRegex(file, where, matcher);
    return;
  }
  if (!isPlainObject(matcher) || Object.keys(matcher).length === 0) {
    fail(file, `${where} must be a regular expression or an operator object like { "lt": 10 }, got ${describeValue(matcher)}.`);
  }
  for (const [op, operand] of Object.entries(matcher)) {
    assertWhenOperand(file, where, op, operand);
  }
}

/** One `when` operator/operand pair: known operator, operand of the kind that operator takes. */
function assertWhenOperand(file: string, where: string, op: string, operand: unknown): void {
  const kind = OPERAND_KIND[op as keyof WhenArgMatcher];
  if (!WHEN_OPERATORS.has(op as keyof WhenArgMatcher)) {
    fail(file, `${where}.${op} is not a known operator. Allowed operators: eq, ne, lt, lte, gt, gte, matches.`);
  }
  if (kind === 'scalar' && operand !== null && typeof operand !== 'string' && typeof operand !== 'number' && typeof operand !== 'boolean') {
    fail(file, `${where}.${op} must be a string, number, boolean or null, got ${describeValue(operand)}.`);
  }
  if (kind === 'regex') {
    if (typeof operand !== 'string') {
      fail(file, `${where}.matches must be a regular expression string, got ${describeValue(operand)}.`);
    }
    assertRegex(file, `${where}.matches`, operand);
  }
  if (kind === 'number' && (typeof operand !== 'number' || !Number.isFinite(operand))) {
    fail(file, `${where}.${op} must be a finite number, got ${describeValue(operand)}.`);
  }
}

/** A rule's `ttlMs`: an 'ask'-only positive pause deadline. */
function assertRuleTtl(file: string, where: string, rule: Record<string, unknown>): void {
  if (rule.ttlMs === undefined) return;
  if (rule.action !== 'ask') {
    fail(file, `${where}.ttlMs only applies to 'ask' rules (it is how long the pause waits for a decision), but the action is '${rule.action}'.`);
  }
  if (typeof rule.ttlMs !== 'number' || !Number.isFinite(rule.ttlMs) || rule.ttlMs <= 0) {
    fail(file, `${where}.ttlMs must be a positive number of milliseconds, got ${describeValue(rule.ttlMs)}.`);
  }
}

/** A rule's `when`: a predicate (code config) or a non-empty record of argument names to matchers. */
function assertRuleWhen(file: string, where: string, when: unknown): void {
  if (when === undefined || typeof when === 'function') return;
  if (!isPlainObject(when)) {
    fail(file, `${where}.when must be a predicate (a code config) or a record of argument names to matchers, got ${describeValue(when)}.`);
  }
  if (Object.keys(when).length === 0) fail(file, `${where}.when must name at least one argument.`);
  for (const [arg, matcher] of Object.entries(when)) {
    assertWhenMatcher(file, `${where}.when.${arg}`, matcher);
  }
}

function assertPermissionRule(file: string, index: number, rule: unknown): void {
  const where = `'permissions[${index}]'`;
  if (!isPlainObject(rule)) fail(file, `${where} must be an object like { "tool": "shell", "action": "deny" }, got ${describeValue(rule)}.`);
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length > 0) fail(file, `${where}: unknown key(s) ${unknown.join(', ')}. Allowed keys: tool, when, action, reason, ttlMs.`);
  if (!isToolMatcher(rule.tool)) fail(file, `${where}.tool must be a tool name, a list of names or (a code config) a RegExp, got ${describeValue(rule.tool)}.`);
  if (typeof rule.action !== 'string' || !PERMISSION_ACTIONS.has(rule.action)) {
    fail(file, `${where}.action must be 'allow', 'deny' or 'ask', got ${describeValue(rule.action)}.`);
  }
  assertRuleTtl(file, where, rule);
  if (rule.reason !== undefined && typeof rule.reason !== 'string') fail(file, `${where}.reason must be a string, got ${describeValue(rule.reason)}.`);
  assertRuleWhen(file, where, rule.when);
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

function assertApprovalTtlMs(file: string, value: unknown): void {
  if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    fail(file, `'approvalTtlMs' must be a positive number of milliseconds, got ${describeValue(value)}.`);
  }
}

/** The entries of the object-valued key `name` (none when it is undefined); fails unless it is a plain object. */
function objectEntries(file: string, name: string, example: string, value: unknown): [string, unknown][] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) fail(file, `'${name}' must be an object like ${example}, got ${describeValue(value)}.`);
  return Object.entries(value);
}

function assertLimits(file: string, value: unknown): void {
  for (const [key, entry] of objectEntries(file, 'limits', '{ "maxCostUsd": 0.05 }', value)) {
    if (!LIMIT_KEYS.has(key)) fail(file, `'limits.${key}' is not a known limit. Allowed keys: ${[...LIMIT_KEYS].join(', ')}.`);
    if (key === 'onExceeded') {
      if (entry !== 'stop' && entry !== 'throw') fail(file, `'limits.onExceeded' must be 'stop' or 'throw', got ${describeValue(entry)}.`);
    } else if (!(typeof entry === 'number' && Number.isFinite(entry) && entry > 0)) {
      fail(file, `'limits.${key}' must be a positive number, got ${describeValue(entry)}.`);
    }
  }
}

function assertModelSettings(file: string, value: unknown): void {
  for (const [key, entry] of objectEntries(file, 'modelSettings', '{ "maxTokens": 1024 }', value)) {
    if (!(MODEL_SETTING_KEYS as readonly string[]).includes(key)) {
      fail(file, `'modelSettings.${key}' is not a known setting. Allowed keys: ${MODEL_SETTING_KEYS.join(', ')}.`);
    }
    assertModelSetting(file, key, entry);
  }
}

/** Fails unless `entry` is a valid value for the (known) `modelSettings` key `key`. */
function assertModelSetting(file: string, key: string, entry: unknown): void {
  if (key === 'toolChoice') {
    assertToolChoice(file, entry);
  } else if (key === 'stop') {
    if (!(Array.isArray(entry) && entry.every((stop) => typeof stop === 'string'))) fail(file, `'modelSettings.stop' must be an array of strings, got ${describeValue(entry)}.`);
  } else if (!(typeof entry === 'number' && Number.isFinite(entry))) {
    fail(file, `'modelSettings.${key}' must be a number, got ${describeValue(entry)}.`);
  } else {
    // Eve CORE-F13: the same ranges createAgent checks (temperature 0..2, maxTokens >= 1, ...).
    const problem = modelSettingProblem(key, entry);
    if (problem) fail(file, `'modelSettings.${key}' ${problem}.`);
  }
}

/** Fails unless `entry` is a valid `modelSettings.toolChoice`. */
function assertToolChoice(file: string, entry: unknown): void {
  const named = isPlainObject(entry) && entry.type === 'function' && isPlainObject(entry.function) && typeof entry.function.name === 'string';
  if (!(entry === 'auto' || entry === 'required' || entry === 'none' || named)) {
    fail(file, `'modelSettings.toolChoice' must be "auto", "required", "none" or { "type": "function", "function": { "name": ... } }, got ${describeValue(entry)}.`);
  }
}

const FILE_STORE_KEYS = new Set<keyof AgentDirFileStore>(['dir', 'historyLimit', 'tokenKey']);
/**
 * The method that proves an `AgentStore` part is a real store and not JSON
 * data: a part without it would fail later, deeper, with a worse error.
 */
const STORE_PART_METHOD: Record<keyof AgentStore, string> = {
  sessions: 'load',
  checkpoints: 'save',
  approvals: 'resolve',
  tokens: 'get',
};

/**
 * `store` is `{ dir, historyLimit?, tokenKey? }` (a `fileStore()` rooted at
 * `dir`) or - in a code config - an `AgentStore` instance. A `dir` key picks
 * the file-store form; without one, at least one of the `AgentStore` parts
 * must be present and look like a store (extra keys are ignored: a class
 * instance like `SqliteStore` carries more than the store parts).
 */
const STORE_SHAPE = `a file-store options object like { "dir": "./.lousho" } or - in a code config - an AgentStore`;

/** The `{ dir, historyLimit?, tokenKey? }` form of `store` - keys beyond FILE_STORE_KEYS are rejected. */
function assertFileStore(file: string, keys: string[], store: Record<string, unknown>): void {
  const unknown = keys.filter((key) => !FILE_STORE_KEYS.has(key as keyof AgentDirFileStore));
  if (unknown.length > 0) {
    fail(file, `'store': unknown key(s) ${unknown.join(', ')}. The file-store form allows: dir, historyLimit, tokenKey.`);
  }
  if (typeof store.dir !== 'string' || store.dir.trim() === '') {
    fail(file, `'store.dir' must be a non-empty string (a path relative to the agent directory, e.g. "./.lousho"), got ${describeValue(store.dir)}.`);
  }
  const { historyLimit, tokenKey } = store;
  if (historyLimit !== undefined && !(typeof historyLimit === 'number' && Number.isInteger(historyLimit) && historyLimit >= 0)) {
    fail(file, `'store.historyLimit' must be a non-negative integer, got ${describeValue(historyLimit)}.`);
  }
  if (tokenKey !== undefined && !(typeof tokenKey === 'string' || (Array.isArray(tokenKey) && tokenKey.length > 0 && tokenKey.every((key) => typeof key === 'string')))) {
    fail(file, `'store.tokenKey' must be a base64 key string or a list of them (generateTokenKey() makes one), got ${describeValue(tokenKey)}.`);
  }
}

/** The `AgentStore` instance form: at least one store part, each shaped like a store. */
function assertStoreParts(file: string, value: unknown, keys: string[], store: Record<string, unknown>): void {
  const parts = keys.filter((key) => (STORE_PART_METHOD as Record<string, string>)[key] !== undefined);
  if (parts.length === 0) {
    fail(file, `'store' must be ${STORE_SHAPE}, got ${describeValue(value)}.`);
  }
  for (const part of parts) {
    const method = STORE_PART_METHOD[part as keyof AgentStore];
    const target = store[part];
    if (typeof target !== 'object' || target === null || typeof (target as Record<string, unknown>)[method] !== 'function') {
      fail(file, `'store.${part}' must be a store (an object with ${method}()), got ${describeValue(target)}.`);
    }
  }
}

function assertStore(file: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof RegExp) {
    fail(file, `'store' must be ${STORE_SHAPE}, got ${describeValue(value)}.`);
  }
  const store = value as Record<string, unknown>;
  const keys = Object.keys(store);
  if (keys.includes('dir')) {
    assertFileStore(file, keys, store);
  } else {
    assertStoreParts(file, value, keys, store);
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
  assertApprovalTtlMs(file, c.approvalTtlMs);
  assertLimits(file, c.limits);
  assertModelSettings(file, c.modelSettings);
  assertStore(file, c.store);
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
 * argument's matcher to hold. `file` only names errors. Node-free: the
 * Cloudflare Worker runtime converts the same way.
 */
export function permissionRulesOf(file: string, rules: readonly AgentDirPermissionRule[] | undefined): PermissionRule[] | undefined {
  if (rules === undefined) return undefined;
  return rules.map((rule, index) => permissionRuleOf(file, rule, index));
}

/** One config rule as a `PermissionRule`; a `when` record becomes an all-must-match predicate. */
function permissionRuleOf(file: string, rule: AgentDirPermissionRule, index: number): PermissionRule {
  let when: PermissionRule['when'];
  if (typeof rule.when === 'function') {
    when = rule.when;
  } else if (rule.when !== undefined) {
    const tests = Object.entries(rule.when).map(([arg, matcher]) => ({ arg, test: argMatcher(file, index, arg, matcher) }));
    when = (args) => tests.every(({ arg, test }) => test(args[arg]));
  }
  return {
    tool: rule.tool,
    ...(when !== undefined && { when }),
    action: rule.action,
    ...(rule.reason !== undefined && { reason: rule.reason }),
    ...(rule.ttlMs !== undefined && { ttlMs: rule.ttlMs }),
  };
}

const NUMERIC_COMPARISONS: Record<'lt' | 'lte' | 'gt' | 'gte', (n: number, limit: number) => boolean> = {
  lt: (n, limit) => n < limit,
  lte: (n, limit) => n <= limit,
  gt: (n, limit) => n > limit,
  gte: (n, limit) => n >= limit,
};

/** A number or non-empty numeric string; everything else fails closed (`Number(null)`/`Number('')` would coerce to 0). */
function numericValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

/**
 * The `lt`/`lte`/`gt`/`gte` argument test: the argument is compared as a
 * number and fails closed - only a number or a non-empty numeric string can
 * match (`Number(null)`/`Number('')`/`Number(false)` would coerce to 0).
 */
function numericComparison(op: 'lt' | 'lte' | 'gt' | 'gte', limit: number): (value: unknown) => boolean {
  return (value) => Number.isFinite(numericValue(value)) && NUMERIC_COMPARISONS[op](numericValue(value), limit);
}

/** Compiles a `when` regular expression; `file`/`index`/`arg` only name errors. */
function regexOf(file: string, index: number, arg: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    fail(file, `'permissions[${index}].when.${arg}' is not a valid regular expression: ${(error as Error).message}`);
  }
}

/**
 * One `when` argument's test: a bare string is a regular expression tested
 * against `String(value)`, an operator object holds when every operator does
 * (`eq`/`ne` compare with `===`/`!==`, `lt`/`lte`/`gt`/`gte` compare
 * `Number(value)` - a non-numeric argument never matches, `matches` is a
 * regular expression).
 */
function argMatcher(file: string, index: number, arg: string, matcher: string | WhenArgMatcher): (value: unknown) => boolean {
  if (typeof matcher === 'string') {
    const regex = regexOf(file, index, arg, matcher);
    return (value) => regex.test(String(value ?? ''));
  }
  const tests = Object.entries(matcher).map(([op, operand]): ((value: unknown) => boolean) => {
    switch (op) {
      case 'eq':
        return (value) => value === operand;
      case 'ne':
        return (value) => value !== operand;
      case 'matches': {
        const regex = regexOf(file, index, arg, String(operand));
        return (value) => regex.test(String(value ?? ''));
      }
      default:
        return numericComparison(op as 'lt' | 'lte' | 'gt' | 'gte', operand as number);
    }
  });
  return (value) => tests.every((test) => test(value));
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
