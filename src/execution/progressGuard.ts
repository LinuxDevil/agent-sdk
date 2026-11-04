import type { Message } from '../providers';
import { textOf } from '../providers/content';
import { stableStringify } from '../testing/fingerprint';
import { ConfigurationError, SDKError } from './errors';
import type { AgentHook, PreToolCallOutcome, ToolCallHookContext, ToolCallHookResult } from './hooks';

const GUARD_NAME = 'progress-guard';
const GUARD_MARKER = `[${GUARD_NAME}]`;
const MAX_SIGNATURE_CHARS = 200;

/** Why a tool call failed, as far as its error kind and message can tell. */
export type ToolFailureClass = 'bad-input' | 'timeout' | 'missing-capability' | 'permission' | 'unknown';

/** Options for {@link createProgressGuard}. */
export interface ProgressGuardOptions {
  /** Identical calls returning the same result allowed before the call is denied (default 3). */
  maxRepeats?: number;
  /** Failures of a tool with the same error allowed before the tool is denied for the run (default 3). */
  maxFailures?: number;
  /** Denials allowed before the next denial stops the run with `LOUSHO_RUN_NO_PROGRESS` (default 3). */
  maxDenials?: number;
  /** Tools the guard never denies, such as one that polls and may rightly repeat. */
  ignoreTools?: readonly string[];
  /** The tool to suggest when a tool keeps failing, by tool name. */
  fallbacks?: Readonly<Record<string, string>>;
}

const PATTERNS: readonly (readonly [ToolFailureClass, RegExp])[] = [
  ['timeout', /timed?[ -]?out|etimedout|deadline exceeded/i],
  ['permission', /permission|forbidden|unauthori[sz]ed|eacces|eperm|\b40[13]\b/i],
  ['missing-capability', /not found|no such|enoent|not supported|unsupported|\b404\b|\b501\b/i],
  ['bad-input', /invalid|malformed|must be|is required|expected|\b400\b|\b422\b/i],
];

/** Classifies a failed tool call from its `ToolErrorKind` and error message. */
export function classifyToolFailure(failure: { kind?: string; message: string }): ToolFailureClass {
  if (failure.kind === 'validation') return 'bad-input';
  if (failure.kind === 'not-found') return 'missing-capability';
  if (failure.kind === 'denied' || failure.kind === 'rejected') return 'permission';
  return PATTERNS.find(([, pattern]) => pattern.test(failure.message))?.[0] ?? 'unknown';
}

const ADVICE: Record<ToolFailureClass, string> = {
  'bad-input': 'Check the arguments against the tool description before calling it again.',
  timeout: 'Retry at most once with a smaller request, or use another approach.',
  'missing-capability': 'What you asked for does not exist here, so use another approach.',
  permission: 'Retrying will not change this permission failure, so use another approach or ask the user.',
  unknown: 'Do not repeat the same call; change the approach.',
};

interface ToolFailure {
  kind?: string;
  message: string;
}

function failureOf(content: string): ToolFailure | undefined {
  try {
    const parsed = JSON.parse(content) as { error?: unknown; message?: unknown; kind?: unknown } | null;
    if (typeof parsed?.message !== 'string' || typeof parsed.error !== 'string') return undefined;
    return { message: parsed.message, ...(typeof parsed.kind === 'string' && { kind: parsed.kind }) };
  } catch {
    return undefined;
  }
}

function signature(message: string): string {
  return message.replace(/\d+/g, '#').trim().toLowerCase().slice(0, MAX_SIGNATURE_CHARS);
}

interface PastCall {
  toolName: string;
  args: string;
  content: string;
  failure?: ToolFailure;
}

function normalizedArgs(raw: string): string {
  try {
    return stableStringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function pastCalls(messages: readonly Message[]): PastCall[] {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) results.set(message.toolCallId, textOf(message));
  }
  return messages.flatMap((message) =>
    (message.role === 'assistant' ? (message.toolCalls ?? []) : []).flatMap((call) => {
      const content = results.get(call.id);
      if (content === undefined) return [];
      const failure = failureOf(content);
      return [{ toolName: call.function.name, args: normalizedArgs(call.function.arguments), content, ...(failure && { failure }) }];
    })
  );
}

function isDenial(call: PastCall): boolean {
  return call.failure?.kind === 'denied' && call.failure.message.includes(GUARD_MARKER);
}

function positiveWhole(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`createProgressGuard: ${name} must be a positive whole number, got ${value}.`, name);
  }
  return value;
}

function mostRepeated<T>(items: readonly T[], keyOf: (item: T) => string): { item: T; count: number } | undefined {
  const counts = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const entry = counts.get(key);
    counts.set(key, { item, count: (entry?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0];
}

/**
 * A hook that stops a run wasting its budget: it adds advice to a repeated tool failure, denies a call that
 * keeps returning the same result or a tool that keeps failing the same way, and stops the run if denials continue.
 */
export function createProgressGuard(options: ProgressGuardOptions = {}): AgentHook {
  const maxRepeats = positiveWhole('maxRepeats', options.maxRepeats ?? 3);
  const maxFailures = positiveWhole('maxFailures', options.maxFailures ?? 3);
  const maxDenials = positiveWhole('maxDenials', options.maxDenials ?? 3);
  const ignored = new Set(options.ignoreTools);
  const fallbackFor = (toolName: string) => {
    const fallback = options.fallbacks?.[toolName];
    return fallback ? ` Try '${fallback}' instead.` : '';
  };

  const deny = (ctx: ToolCallHookContext, past: readonly PastCall[], reason: string, failure?: ToolFailureClass): PreToolCallOutcome => {
    const denials = past.filter(isDenial).length;
    if (denials >= maxDenials) {
      ctx.emit?.({ type: 'heal.action', action: 'stop', toolName: ctx.toolName, reason, ...(failure && { failure }) });
      throw new SDKError(`The run was stopped after ${denials} denied calls made no progress; the last was to '${ctx.toolName}'.`, 'LOUSHO_RUN_NO_PROGRESS');
    }
    ctx.emit?.({ type: 'heal.action', action: 'deny', toolName: ctx.toolName, reason, ...(failure && { failure }) });
    return { deny: `${GUARD_MARKER} ${reason}` };
  };

  return {
    name: GUARD_NAME,
    preToolCall(ctx) {
      if (ignored.has(ctx.toolName)) return undefined;
      const past = pastCalls(ctx.messages);
      const own = past.filter((call) => call.toolName === ctx.toolName && !isDenial(call));
      const failed = own.flatMap((call) => (call.failure ? [call.failure] : []));
      const worst = mostRepeated(failed, (failure) => signature(failure.message));
      if (worst && worst.count >= maxFailures) {
        const failure = classifyToolFailure(worst.item);
        return deny(ctx, past, `'${ctx.toolName}' failed ${worst.count} times with a ${failure} error: ${worst.item.message} ${ADVICE[failure]}${fallbackFor(ctx.toolName)}`, failure);
      }
      const args = stableStringify(ctx.args);
      const same = own.filter((call) => call.args === args && !call.failure);
      const repeated = mostRepeated(same, (call) => call.content);
      if (repeated && repeated.count >= maxRepeats) {
        return deny(ctx, past, `'${ctx.toolName}' was called ${repeated.count} times with these arguments and returned the same result each time. Use that result or change the approach.${fallbackFor(ctx.toolName)}`);
      }
      return undefined;
    },
    postToolCall(ctx, result: ToolCallHookResult) {
      if (!result.error || ignored.has(ctx.toolName) || result.error.includes(GUARD_MARKER)) return undefined;
      const key = signature(result.error);
      const seen = pastCalls(ctx.messages).some((call) => call.toolName === ctx.toolName && call.failure && signature(call.failure.message) === key);
      if (!seen) return undefined;
      const kind = (result.result as { kind?: unknown } | null)?.kind;
      const failure = classifyToolFailure({ message: result.error, ...(typeof kind === 'string' && { kind }) });
      const hint = `This is a ${failure} error you have hit before. ${ADVICE[failure]}${fallbackFor(ctx.toolName)}`;
      ctx.emit?.({ type: 'heal.action', action: 'hint', toolName: ctx.toolName, reason: hint, failure });
      const base = typeof result.result === 'object' && result.result !== null ? result.result : { result: result.result };
      return { result: { ...base, hint } };
    },
  };
}
