import type { RunHistoryStep, SpanEvent } from '../../../shared/wireTypes';

/**
 * The history step whose `toolCalls` include the span's `gen_ai.tool.call.id`
 * — the SDK's tool call id attribute and the checkpoint's `toolCalls[].id`
 * are the same id — or `undefined`: a span without a call id, a call the
 * checkpoint history does not know, or a run with no checkpoints at all
 * (flow runs never produce steps). "Fork from here" needs the step so the
 * fork can restart at the checkpoint that produced the call.
 */
export function stepForToolSpan(steps: readonly RunHistoryStep[], span: SpanEvent): RunHistoryStep | undefined {
  const callId = span.attributes['gen_ai.tool.call.id'];
  if (typeof callId !== 'string' || callId === '') return undefined;
  return steps.find((step) => step.toolCalls.some((call) => call.id === callId));
}
