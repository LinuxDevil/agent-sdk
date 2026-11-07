/**
 * Starter hook templates for the hook node's Inspector (`redact-pii`,
 * `rate-limit`, `inject-context`, `audit-log`). Each is an editable starting
 * point — the Inspector's CodeMirror editor lets a user change `code`
 * freely after applying one.
 *
 * `code` is the BODY of an async function invoked as `hook(ctx)` inside the
 * sandboxed subprocess (see server/hookSandbox.ts) — `ctx` shape depends on
 * `point`:
 *   - `toolCall`: `{ toolName, args, result?, error? }` — mutate `ctx.args`
 *     (pre) or `ctx.result`/`ctx.error` (post) and return `ctx`.
 *   - `generate`: `{ messages, model }` — mutate/push onto `ctx.messages`
 *     and return `ctx`.
 */
import type { HookSpec } from '../graph/v2/specTypes';

/** The `inline` member of `HookSpec`. */
type InlineHookSpec = Extract<HookSpec, { inline: unknown }>['inline'];

/**
 * A starter hook: `point`/`phase` are the v1 dimensions (`templatePoint`
 * maps them onto the spec's four hook points).
 */
export interface HookTemplate {
  id: string;
  name: string;
  /** Which call the hook wraps. */
  point: 'toolCall' | 'generate';
  /** Before or after that call. */
  phase: 'pre' | 'post';
  /** Shown in the template row, e.g. "before tool.call". */
  when: string;
  code: string;
}

/** The spec hook point a template lands at: `toolCall`+`pre` → `preToolCall`, `generate`+`post` → `postGenerate`, … */
export function templatePoint(t: HookTemplate): InlineHookSpec['point'] {
  return `${t.phase}${t.point === 'toolCall' ? 'ToolCall' : 'Generate'}` as InlineHookSpec['point'];
}

export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: 'redact-pii',
    name: 'redact-pii',
    phase: 'pre',
    point: 'toolCall',
    when: 'before tool.call',
    code: `const PII = /[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/gi;
for (const key of Object.keys(ctx.args || {})) {
  if (typeof ctx.args[key] === 'string') {
    ctx.args[key] = ctx.args[key].replace(PII, '[REDACTED]');
  }
}
return ctx;`,
  },
  {
    id: 'rate-limit',
    name: 'rate-limit',
    phase: 'pre',
    point: 'toolCall',
    when: 'before tool.call',
    code: `// Simple fixed-window limiter, keyed by tool name. Throwing here aborts
// the step - see HookRegistry's doc comment: a thrown hook error is never
// silently swallowed.
globalThis.__rateLimitCounts = globalThis.__rateLimitCounts || {};
const key = ctx.toolName;
const count = (globalThis.__rateLimitCounts[key] || 0) + 1;
globalThis.__rateLimitCounts[key] = count;
const MAX_CALLS = 5;
if (count > MAX_CALLS) {
  throw new Error('rate limit exceeded for tool "' + key + '"');
}
return ctx;`,
  },
  {
    id: 'audit-log',
    name: 'audit-log',
    phase: 'post',
    point: 'toolCall',
    when: 'after tool.call',
    code: `console.log(JSON.stringify({
  event: 'tool.call',
  toolName: ctx.toolName,
  args: ctx.args,
  result: ctx.result,
  error: ctx.error,
  at: new Date().toISOString(),
}));
return ctx;`,
  },
  {
    id: 'inject-context',
    name: 'inject-context',
    phase: 'pre',
    point: 'generate',
    when: 'before llm.generate',
    code: `ctx.messages = ctx.messages || [];
ctx.messages.push({ role: 'system', content: 'Current date: ' + new Date().toISOString().slice(0, 10) });
return ctx;`,
  },
];
