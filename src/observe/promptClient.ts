/**
 * The agent-side client of the prompt registry (spec 0001-prompts-context-hub).
 *
 * `createAgent({ prompt: 'name@version' })` and `LOUSHO_PROMPT=name@version`
 * opt a run into registry-owned instructions: the SDK resolves the ref
 * against the daemon `LOUSHO_OBSERVE` points at (`GET
 * /api/v1/prompts/:name/:version`, where `latest` is resolved daemon side),
 * the fetched text replaces `instructions`, and `instructions` stays the
 * embedded fallback for when the daemon cannot be reached. The publish/list/
 * history calls back `lousho prompt push|list|get`.
 *
 * `registryPrompt()` is the createAgent wiring: it starts the fetch when the
 * agent is BUILT (the spec's "fetch at build"), memoizes it for the agent's
 * lifetime, and hands the reporter a `prompt_use` ref once the fetch landed.
 */

import { observeRequest } from './httpClient';
import { observeUrlFromEnv, type PromptUseProvider } from './reporter';

/** A `name@version` reference; `version` is an integer or the daemon-side movable `latest`. */
export interface PromptRef {
  name: string;
  version: number | 'latest';
}

/** `name@version`: a name without whitespace/`/`/`@`, then `@` and an integer or `latest`. */
const REF_PATTERN = /^([^\s@/]{1,200})@(\d+|latest)$/;

/**
 * Parse `'name@3'`, `'name@latest'` into a {@link PromptRef}; `undefined`
 * when the value is not a registry reference. A bare `'mira'` (no `@`) is
 * deliberately NOT a ref: `prompt` is also the deprecated `instructions`
 * alias, and only the unambiguous `name@version` shape opts into the registry.
 */
export function parsePromptRef(value: string | undefined): PromptRef | undefined {
  if (value === undefined) return undefined;
  const match = REF_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return { name: match[1], version: match[2] === 'latest' ? 'latest' : Number(match[2]) };
}

/** The daemon's `prompt` row as served (labels/variables decoded). */
export interface ResolvedPrompt {
  prompt_id: string;
  name: string;
  version: number;
  text: string | null;
  labels: unknown;
  variables: unknown;
  hash: string | null;
  created_at: number;
}

export interface PromptClientOptions {
  /** Bearer token for a `--require-token` daemon (`LOUSHO_OBSERVE_TOKEN`). */
  token?: string;
  /** Request timeout (default 2500ms); the prompt fetch must not stall a run for long. */
  timeoutMs?: number;
  /** Injectable transport (tests); default the global `fetch`. */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 2500;

/** Error body shape the daemon answers; the message is surfaced verbatim. */
function request<T>(baseUrl: string, path: string, init: RequestInit, options: PromptClientOptions): Promise<T> {
  return observeRequest<T>(baseUrl, path, init, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options);
}

/** `GET /api/v1/prompts/:name/:version`. Throws `LOUSHO_REMOTE_REQUEST_FAILED` on a non-200 (404 included). */
export async function fetchPrompt(baseUrl: string, ref: PromptRef, options: PromptClientOptions = {}): Promise<ResolvedPrompt> {
  const body = await request<{ prompt: ResolvedPrompt }>(
    baseUrl,
    `/api/v1/prompts/${encodeURIComponent(ref.name)}/${ref.version}`,
    { method: 'GET' },
    options
  );
  return body.prompt;
}

/** `POST /api/v1/prompts` - `lousho prompt push`. `created` is false on an identical republish (hash dedupe). */
export async function publishPrompt(
  baseUrl: string,
  input: { name: string; text: string; labels?: string[] | Record<string, string>; variables?: string[] },
  options: PromptClientOptions = {}
): Promise<{ prompt: ResolvedPrompt; created: boolean }> {
  return request(baseUrl, '/api/v1/prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, options);
}

export interface PromptSummary extends ResolvedPrompt {
  versions: number;
  uses: number;
}

/** `GET /api/v1/prompts` - one row per name (latest version + counts). */
export async function listPrompts(baseUrl: string, filter: { name?: string; limit?: number } = {}, options: PromptClientOptions = {}): Promise<PromptSummary[]> {
  const params = new URLSearchParams();
  if (filter.name !== undefined) params.set('name', filter.name);
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  const qs = params.toString();
  const body = await request<{ prompts: PromptSummary[] }>(baseUrl, `/api/v1/prompts${qs ? `?${qs}` : ''}`, { method: 'GET' }, options);
  return body.prompts;
}

/**
 * The resolved-or-fallback prompt a `prompt` ref produces for one agent. The
 * fetch starts at construction (agent build) and is memoized for the agent's
 * lifetime; a failure warns once and every run then uses the embedded
 * instructions.
 */
export interface RegistryPrompt {
  /** The fetched text, or `fallback()` when the fetch failed. */
  text(fallback: () => Promise<string | undefined>): Promise<string | undefined>;
  /** The `prompt_use` ref the reporter emits on the run's root span; `undefined` until the fetch landed. */
  use: PromptUseProvider;
  /** The ref being resolved (for messages). */
  ref: PromptRef;
}

/**
 * Resolve `ref` (`'name@version'`) against the daemon `env`'s
 * `LOUSHO_OBSERVE` points at. Returns `undefined` - the opt-in does not
 * apply - when the env names no daemon (`hasFallback: false` - no embedded
 * instructions - only changes the warning's wording); `LOUSHO_OBSERVE_TOKEN` is sent when set.
 */
export function registryPrompt(
  ref: string,
  options: { env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch; timeoutMs?: number; hasFallback?: boolean } = {}
): RegistryPrompt | undefined {
  const parsed = parsePromptRef(ref);
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const url = observeUrlFromEnv(env);
  if (parsed === undefined || url === undefined) return undefined;
  const fetchOptions: PromptClientOptions = {
    ...(env?.LOUSHO_OBSERVE_TOKEN ? { token: env.LOUSHO_OBSERVE_TOKEN } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
  let warned = false;
  let resolved: ResolvedPrompt | undefined;
  const pending = (async () => {
    try {
      const prompt = await fetchPrompt(url, parsed, fetchOptions);
      resolved = prompt;
      return prompt;
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn(
          `[lousho] prompt: could not resolve '${ref}' at ${url} (${error instanceof Error ? error.message : String(error)}); ` +
            (options.hasFallback === false
              ? 'there are no embedded instructions, so runs fail with LOUSHO_PROMPT_UNRESOLVED.'
              : 'the embedded instructions are used instead.')
        );
      }
      return undefined;
    }
  })();
  return {
    ref: parsed,
    text: async (fallback) => (await pending)?.text ?? (await fallback()),
    use: () => (resolved !== undefined ? { prompt_id: resolved.prompt_id, version: resolved.version } : undefined),
  };
}
