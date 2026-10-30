/**
 * `spec.guardrails` compiled into `createAgent({ guardrails })`: each entry
 * builds its named starter-set guardrail from `options` (with `onTripped` as
 * its `action` where the built-in can rewrite), is named by its spec `id`
 * (so two `regex` entries are told apart and trips map to `guard:<id>`
 * nodes), and lands on each side `on` names (default input and output, as
 * v1).
 */
import type { AgentGuardrails, IoGuardrail } from '../../../execution/ioGuardrails';
import { buildSpecGuardrail } from '../../guardrailBuilders';
import { GUARDRAIL_OPTIONS } from '../../guardrailOptions';
import { REWRITABLE_GUARDRAILS, guardrailSidesOf, type GuardrailSide, type GuardrailSpec } from '../guardrails';

/** The options one entry's built-in is constructed with: `onTripped` as `action` where it can rewrite. */
function entryOptions(entry: GuardrailSpec): Record<string, unknown> {
  const options = entry.options ?? {};
  const rewritable = REWRITABLE_GUARDRAILS.includes(entry.name);
  const tripped = entry.onTripped === 'block' || entry.onTripped === 'rewrite' ? entry.onTripped : undefined;
  const action = (rewritable ? tripped : undefined) ?? options.action;
  return { ...options, ...(action !== undefined && rewritable && { action }) };
}

/** `spec.guardrails` as createAgent({ guardrails }); undefined when the list is empty. */
export function guardrailsFromSpec(entries: readonly GuardrailSpec[]): AgentGuardrails | undefined {
  const lists: Record<GuardrailSide, IoGuardrail[]> = { input: [], output: [], tools: [] };
  for (const entry of entries) {
    const parsed = GUARDRAIL_OPTIONS[entry.name].parse(entryOptions(entry));
    const guardrail: IoGuardrail = {
      ...buildSpecGuardrail(entry.name, parsed),
      name: entry.id,
      ...(entry.runInParallel && { runInParallel: true }),
    };
    for (const side of guardrailSidesOf(entry)) lists[side].push(guardrail);
  }
  const compiled = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0));
  return Object.keys(compiled).length > 0 ? compiled : undefined;
}
