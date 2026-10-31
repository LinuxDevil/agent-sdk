/**
 * `spec.handoffs` compiled into `createAgent({ handoffs })` elements: the
 * host supplies the target agent for `spec.agent`, and the entry's
 * `toolName`/`description`/named `inputFilter` become the SDK handoff's
 * options. A host that cannot resolve targets is told so with
 * LOUSHO_SPEC_UNSUPPORTED, matching the spec-side "not supported yet"
 * contract. No `node:*` needed.
 */
import { handoff, handoffFilters, type Handoff } from '../../../handoffs';
import type { SimpleAgent } from '../../../createAgent';
import { ConfigurationError } from '../../../execution/errors';
import type { HandoffSpec } from '../handoffs';

/** What handoffFromSpec needs; S16 resolves subagent names from the spec itself and agent ids through Studio. */
export interface HandoffHost {
  /** The target agent for `spec.agent`. Absent → handoffs are unsupported on this host. */
  resolveHandoffAgent?(agent: string): Promise<SimpleAgent>;
}

/** One `spec.handoffs[index]` entry as createAgent({ handoffs })'s element. */
export async function handoffFromSpec(spec: HandoffSpec, host: HandoffHost, index: number): Promise<Handoff> {
  if (host.resolveHandoffAgent === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: 'handoffs.${index}' needs a host that can resolve handoff targets; this host cannot.`,
      `handoffs.${index}`,
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  const target = await host.resolveHandoffAgent(spec.agent);
  return handoff(target, {
    ...(spec.toolName && { toolName: spec.toolName }),
    ...(spec.description && { description: spec.description }),
    ...(spec.inputFilter && { inputFilter: handoffFilters[spec.inputFilter] }),
  });
}
