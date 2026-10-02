/**
 * Input and output guardrails (LOU-X4): checks on a run's new user input,
 * its assistant text and its tool arguments. A failed check either stops the
 * run (`finishReason: 'guardrail'`) or rewrites the text. Separate from the
 * diff/patch gates in guardrails.ts.
 */

import type { LLMProvider, Message } from '../providers';
import { textOf } from '../providers/content';
import { resolveProvider } from '../providers/resolveProvider';
import type { ExecuteOptions } from './AgentExecutor';
import { runEventsOf } from './agentRun';
import { SDKError } from './errors';
import { SECRET_PATTERNS } from './guardrails';

/** What a guardrail checks: the new user input, the assistant text, or a tool call's arguments. */
export type IoGuardrailKind = 'input' | 'output' | 'tool';

/** What {@link IoGuardrail.check} is given. */
export interface IoGuardrailContext {
  kind: IoGuardrailKind;
  /** The user message's text, the assistant text, or (for `tool`) the arguments as JSON. */
  text: string;
  messages: readonly Message[];
  toolName?: string;
  args?: Record<string, unknown>;
  /** The run's signal, for a check that calls a model or a service. */
  signal?: AbortSignal;
}

/** A passed check, or a failed one: `block` (default) stops the run, `rewrite` replaces the text with `replacement`. */
export type IoGuardrailResult =
  | { ok: true }
  | { ok: false; reason: string; action?: 'block' | 'rewrite'; replacement?: string };

/** One named input, output or tool guardrail. A check that throws fails the run. */
export interface IoGuardrail {
  name: string;
  check(ctx: IoGuardrailContext): IoGuardrailResult | Promise<IoGuardrailResult>;
}

/** `createAgent({ guardrails })` / `ExecuteOptions.guardrails`: each list runs in order. */
export interface AgentGuardrails {
  /** On each new user message, before the first model call. */
  input?: readonly IoGuardrail[];
  /** On the final assistant text (in a streamed run, on every step's text, before its `text.done`). */
  output?: readonly IoGuardrail[];
  /** On a tool call's arguments, after the permission rules (skipped on `deny`) and before `needsApproval`. */
  tools?: readonly IoGuardrail[];
  /** `'stop'` (default): `finishReason: 'guardrail'`. `'throw'`: reject with `GuardrailError`. */
  onTripped?: 'stop' | 'throw';
}

/** The guardrail that blocked (`result.guardrail`, `guardrail.tripped`) or rewrote (`guardrail.rewrote`). */
export interface GuardrailTrip {
  name: string;
  kind: IoGuardrailKind;
  reason: string;
  /** For a `tool` guardrail: the tool called. */
  toolName?: string;
}

/** Thrown when a guardrail blocks under `onTripped: 'throw'`; `guardrail` says which. */
export class GuardrailError extends SDKError {
  constructor(readonly guardrail: GuardrailTrip) {
    super(`Guardrail '${guardrail.name}' blocked the ${guardrail.kind}: ${guardrail.reason}`, 'LOUSHO_GUARDRAIL_TRIPPED');
    this.name = 'GuardrailError';
  }
}

/** The run options guardrails read (a sub-agent's tool call sees the inherited ones). */
type GuardrailRuntime = Pick<ExecuteOptions, 'guardrails' | 'signal'>;

/** Runs `guardrails` in order: the first block trips; a rewrite changes the text the next one sees. */
async function runChecks(
  options: GuardrailRuntime,
  guardrails: readonly IoGuardrail[],
  ctx: IoGuardrailContext
): Promise<{ text: string; rewritten: boolean } | { tripped: GuardrailTrip }> {
  let { text } = ctx;
  let rewritten = false;
  for (const guardrail of guardrails) {
    const result = await guardrail.check({ ...ctx, text, signal: options.signal });
    if (result.ok) continue;
    const trip = { name: guardrail.name, kind: ctx.kind, reason: result.reason, ...(ctx.toolName && { toolName: ctx.toolName }) };
    if (result.action !== 'rewrite') return { tripped: trip };
    text = result.replacement ?? '';
    rewritten = true;
    runEventsOf(options as ExecuteOptions)?.guardrail({ type: 'guardrail.rewrote', ...trip });
  }
  return { text, rewritten };
}

/** Input guardrails on the user messages that end the transcript (the new input); rewrites them in place. */
export async function checkInputGuardrails(options: GuardrailRuntime, lists: Message[][]): Promise<GuardrailTrip | undefined> {
  const guardrails = options.guardrails?.input;
  if (!guardrails?.length) return undefined;
  const all = lists.flatMap((list) => list.map((message, index) => ({ list, index, message })));
  const messages = all.map(({ message }) => message);
  let start = all.length;
  while (start > 0 && messages[start - 1].role === 'user') start--;
  for (const { list, index, message } of all.slice(start)) {
    const checked = await runChecks(options, guardrails, { kind: 'input', text: textOf(message), messages });
    if ('tripped' in checked) return checked.tripped;
    // A rewrite replaces the text; image and file parts stay.
    const parts = typeof message.content === 'string' ? [] : message.content.filter((part) => part.type !== 'text');
    if (checked.rewritten) list[index] = { ...message, content: parts.length ? [{ type: 'text', text: checked.text }, ...parts] : checked.text };
  }
  return undefined;
}

/** Output guardrails on an assistant text: the text to keep, or the trip. */
export async function checkOutputGuardrails(
  options: GuardrailRuntime,
  text: string,
  messages: readonly Message[]
): Promise<{ text: string } | { tripped: GuardrailTrip }> {
  const guardrails = options.guardrails?.output;
  return guardrails?.length ? runChecks(options, guardrails, { kind: 'output', text, messages }) : { text };
}

/** Tool guardrails on a call's arguments: the (rewritten) arguments; throws `GuardrailError` on a block. */
export async function checkToolGuardrails(
  options: GuardrailRuntime,
  call: { toolName: string; args: Record<string, unknown>; messages: readonly Message[] }
): Promise<Record<string, unknown>> {
  const guardrails = options.guardrails?.tools;
  if (!guardrails?.length) return call.args;
  const checked = await runChecks(options, guardrails, { kind: 'tool', text: JSON.stringify(call.args), ...call });
  if ('tripped' in checked) throw new GuardrailError(checked.tripped);
  return checked.rewritten ? (JSON.parse(checked.text) as Record<string, unknown>) : call.args;
}

/** A sub-agent's guardrails: the parent's first, then its own. */
export function inheritGuardrails(parent?: AgentGuardrails, own?: AgentGuardrails): AgentGuardrails | undefined {
  if (!parent || !own) return parent ?? own;
  const both = (kind: 'input' | 'output' | 'tools') => [...(parent[kind] ?? []), ...(own[kind] ?? [])];
  return { input: both('input'), output: both('output'), tools: both('tools'), onTripped: parent.onTripped ?? own.onTripped };
}

/** Fails texts longer than `maxChars`. */
export function maxLengthGuardrail({ maxChars }: { maxChars: number }): IoGuardrail {
  return {
    name: 'max-length',
    check: ({ text }) => (text.length <= maxChars ? { ok: true } : { ok: false, reason: `${text.length} characters, over the ${maxChars} limit` }),
  };
}

/**
 * Fails texts matching `pattern` (default: the secret-scan patterns: private
 * keys, OpenAI-style and AWS keys). `action: 'rewrite'` replaces each match
 * with `replacement` (default `'[redacted]'`) instead of blocking.
 *
 * @example
 * ```ts
 * import { regexGuardrail } from '@lousho/build-ai-agent';
 *
 * const ssn = regexGuardrail({ name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/, action: 'rewrite' });
 * ```
 */
export function regexGuardrail(options: {
  name: string;
  pattern?: RegExp | readonly RegExp[];
  action?: 'block' | 'rewrite';
  replacement?: string;
}): IoGuardrail {
  const { name, pattern = SECRET_PATTERNS.map((p) => p.pattern), action = 'block', replacement = '[redacted]' } = options;
  const patterns = pattern instanceof RegExp ? [pattern] : pattern;
  return {
    name,
    check: ({ text }) => {
      const hit = patterns.find((p) => text.search(p) !== -1);
      if (!hit) return { ok: true };
      const redacted = patterns.reduce((out, p) => out.replace(new RegExp(p.source, p.flags.replace('g', '') + 'g'), replacement), text);
      return { ok: false, reason: `matched ${hit}`, action, replacement: redacted };
    },
  };
}

/** Fails texts that mention one of `topics` (case-insensitive keyword match). */
export function denyTopicsGuardrail({ topics }: { topics: readonly string[] }): IoGuardrail {
  return {
    name: 'deny-topics',
    check: ({ text }) => {
      const topic = topics.find((t) => text.toLowerCase().includes(t.toLowerCase()));
      return topic === undefined ? { ok: true } : { ok: false, reason: `mentions the denied topic '${topic}'` };
    },
  };
}

/**
 * Asks `model` (an `LLMProvider` or a `"provider/model"` spec) whether the
 * text follows `instruction`: one call per check; a reply starting with
 * `PASS` passes, anything else fails with the reply as the reason.
 */
export function llmJudgeGuardrail({ model, instruction, name = 'llm-judge' }: { model: LLMProvider | string; instruction: string; name?: string }): IoGuardrail {
  let provider: LLMProvider | undefined;
  return {
    name,
    async check({ kind, text, signal }) {
      provider ??= typeof model === 'string' ? resolveProvider(model) : model;
      const { text: verdict } = await provider.generate({
        messages: [
          { role: 'system', content: `${instruction}\n\nJudge the ${kind} below. Reply with PASS if it is acceptable, otherwise FAIL: <reason>.` },
          { role: 'user', content: text },
        ],
        signal,
      });
      const reply = verdict.trim();
      return /^pass\b/i.test(reply) ? { ok: true } : { ok: false, reason: reply.replace(/^fail:?\s*/i, '') || 'the judge did not pass it' };
    },
  };
}
