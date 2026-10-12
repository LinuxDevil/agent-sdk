/**
 * REPRO: uniqueToolCallIds() (providerFetch.ts:316-368) corrupts a streamed
 * tool call whose deltas repeat `id` without an `index` field.
 *
 * ToolCallIds.assign() only keys repeated ids by `${choice.index}:${call.index}`
 * (line 348). OpenAI proper always sends `index`, but this rewrite exists
 * precisely for non-conforming OpenAI-compatible servers ("Some
 * OpenAI-compatible servers (and Gemini behind proxies)...", line 310-314).
 * When `index` is absent, each delta carrying the same id falls into
 * `idFor(id, undefined)`, sees the id already `used`, and gets a NEW suffix -
 * so one logical call becomes call_1, call_1_2, call_1_3 ... each holding one
 * fragment of the arguments JSON.
 *
 * Expected: the repeated id keeps its first assignment (like the indexed path).
 * Actual:   every subsequent delta is renamed -> the AI SDK reassembles N
 *           separate tool calls, each with a truncated fragment of `arguments`.
 */
import { uniqueToolCallIds } from '../../../src/providers/providerFetch';

const rewrite = uniqueToolCallIds();

// A server that (a) repeats the call's id on every delta and (b) omits `index`.
const delta1 = JSON.stringify({
  choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"city":"Par' } }] } }],
});
const delta2 = JSON.stringify({
  choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', function: { arguments: 'is","unit' } }] } }],
});
const delta3 = JSON.stringify({
  choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', function: { arguments: 's":"C"}' } }] } }],
});

const out = [delta1, delta2, delta3].map((d) => rewrite(d) ?? d);
const ids = out.map((d) => (JSON.parse(d) as any).choices[0].delta.tool_calls[0].id);
console.log('call ids after rewrite:', ids);

// Control: same stream WITH `index` keeps one id (the documented behavior).
const rewriteIndexed = uniqueToolCallIds();
const idxDelta = (args: string) =>
  JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'f', arguments: args } }] } }] });
const idxIds = [idxDelta('{"a":'), idxDelta('1'), idxDelta('}')].map((d) => (JSON.parse(rewriteIndexed(d) ?? d) as any).choices[0].delta.tool_calls[0].id);
console.log('control (with index):    ', idxIds);

if (new Set(ids).size === 1) {
  console.log('OK: unindexed repeated id kept');
} else {
  console.log('BUG CONFIRMED: one streamed call became', new Set(ids).size, 'phantom calls; its arguments JSON is split across them and none parses');
}
