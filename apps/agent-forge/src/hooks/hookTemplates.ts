import type { AgentNodeHookPhase, AgentNodeHookPoint } from '../graph/types';

/**
 * Starter hook templates (LOU-Q2), matching `.design-ref/agent-forge-mockup.html`'s
 * Inspector "Hooks" section examples (`redact-pii`, `rate-limit`,
 * `inject-context`, `audit-log`). Each is an editable starting point - the
 * Inspector's CodeMirror editor lets a user change `code` freely after
 * dragging/adding one onto a node; `templateId` is kept on the resulting
 * `AgentNodeHookInstance` only as provenance (what it started from), not as
 * a live link back to this list.
 *
 * `code` is the BODY of an async function invoked as `hook(ctx)` inside the
 * sandboxed subprocess (see server/hookSandbox.ts) - `ctx` shape depends on
 * `point`:
 *   - `toolCall`: `{ toolName, args, result?, error? }` - mutate `ctx.args`
 *     (pre) or `ctx.result`/`ctx.error` (post) and return `ctx`.
 *   - `generate`: `{ messages, model }` - mutate/push onto `ctx.messages`
 *     and return `ctx`.
 */
export interface HookTemplate {
  id: string;
  name: string;
  phase: AgentNodeHookPhase;
  point: AgentNodeHookPoint;
  /** Shown in the Inspector's hook-chip, e.g. "before llm.generate". */
  when: string;
  code: string;
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
