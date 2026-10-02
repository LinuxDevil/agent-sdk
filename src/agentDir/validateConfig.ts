/**
 * Validation of an agent directory's config object (LOU-Y5). Node-free: used by
 * `readConfig()` on a config read from disk and by the Cloudflare Worker
 * runtime (src/deploy/workerAgentDir.ts) on a config bundled at build time.
 */
import type { LLMProvider } from '../providers/llm';
import { assertToolConcurrency, type ToolConcurrency } from '../execution/toolBatch';
import { closest } from './closest';
import { SDKError } from '../execution/errors';

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

function assertValues(file: string, c: Record<string, unknown>): void {
  for (const key of ['name', 'description', 'model', 'instructions']) assertString(file, key, c[key]);
  assertMaxSteps(file, c.maxSteps);
  assertProvider(file, c.provider);
  assertProjectInstructions(file, c.projectInstructions);
  try {
    assertToolConcurrency(c.toolConcurrency, 'config');
  } catch (error) {
    fail(file, (error as Error).message.replace(/^config: /, ''));
  }
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
