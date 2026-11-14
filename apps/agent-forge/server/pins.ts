/**
 * "Run from here" pins (T04): recorded tool results replayed through a
 * `preToolCall` hook instead of re-executing the tool. The client pins a
 * tool call's recorded result from a node's spans sheet
 * (`src/state/pins.ts`); `POST /agents/:id/run` carries them as `pins`
 * and RunManager adds `pinnedResultsHook(pins)` to that launch's
 * `extraHooks` only - pins are never stored and never sent on chat turns.
 *
 * A `preToolCall` `{ result }` outcome skips the tool entirely (and its
 * approval prompt - no side effect happens, so there is nothing to
 * approve). The hook matches the FIRST pin whose `toolName` equals the
 * call's and whose `args` (when set) stable-stringify-equal the call's.
 */
import type { AgentHook, ToolCallHookContext } from '@linuxdevil/lousho';
import { stableStringify } from '../shared/stableJson';
import type { ToolPin } from '../shared/wireTypes';

/** The most pins one run request may carry. */
export const MAX_PINS = 50;

/** The hook's registered name (visible in `lousho.tool.replaced_by_hook` on the span). */
const PINS_HOOK_NAME = 'studio-pins';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pinProblem(pin: unknown, index: number): string | undefined {
  const at = `pins[${index}]`;
  if (!isRecord(pin)) return `${at} must be an object`;
  if (typeof pin.nodeId !== 'string' || pin.nodeId === '') return `${at}.nodeId must be a non-empty string`;
  if (typeof pin.toolName !== 'string' || pin.toolName === '') return `${at}.toolName must be a non-empty string`;
  if (pin.args !== undefined && !isRecord(pin.args)) return `${at}.args must be an object`;
  if (!('result' in pin)) return `${at}.result is required`;
  return undefined;
}

/**
 * The 400 message for a malformed `pins` request field, or `undefined`
 * when `value` is a valid pins array (absent/undefined included - a run
 * without pins is the normal case).
 */
export function pinsProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "'pins' must be an array of { nodeId, toolName, args?, result }";
  if (value.length > MAX_PINS) return `'pins' may hold at most ${MAX_PINS} entries`;
  for (let i = 0; i < value.length; i++) {
    const problem = pinProblem(value[i], i);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * One `AgentHook` ('studio-pins') whose `preToolCall` returns `{ result }`
 * for the first pin matching `ctx.toolName` (and `ctx.args` when the pin
 * carries `args`, compared by `stableStringify` so key order is ignored).
 * First match wins; a pin that matches nothing is simply unused.
 */
export function pinnedResultsHook(pins: readonly ToolPin[]): AgentHook {
  return {
    name: PINS_HOOK_NAME,
    preToolCall(ctx: ToolCallHookContext) {
      for (const pin of pins) {
        if (pin.toolName !== ctx.toolName) continue;
        if (pin.args !== undefined && stableStringify(pin.args) !== stableStringify(ctx.args)) continue;
        return { result: pin.result };
      }
      return undefined;
    },
  };
}
