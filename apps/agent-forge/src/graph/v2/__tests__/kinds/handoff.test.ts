import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: one handoff to a sibling subagent, one to an outside agent. */
const WORKED = `version: 2
name: support-triage
model: anthropic/claude-sonnet-5-5
instructions: Triage tickets.
subagents:
  billing: { ref: agents/billing.yaml }
handoffs:
  - agent: billing
    toolName: transfer_to_billing
    inputFilter: removeToolCalls
  - agent: escalations
`;

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(over: Record<string, unknown>): ReturnType<typeof specToGraph> {
  return specToGraph(specOf(over));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

describe('specToGraph: handoff worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces one handoff node per entry, each owned by the root agent', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'agent',
      'sub:billing',
      'handoff:billing',
      'handoff:escalations',
    ]);
    const [billing, escalations] = graph.nodes.slice(2);
    expect(billing).toMatchObject({
      kind: 'handoff',
      owner: 'agent',
      data: {
        item: { agent: 'billing', toolName: 'transfer_to_billing', inputFilter: 'removeToolCalls' },
      },
    });
    expect(escalations).toMatchObject({
      kind: 'handoff',
      owner: 'agent',
      data: { item: { agent: 'escalations' } },
    });
  });

  it('derives the owner edges plus the handoff -> sub:billing edge (none for escalations)', () => {
    expect(deriveEdges(graph).map((e) => e.id)).toEqual([
      'delegates:agent->sub:billing',
      'handsOff:agent->handoff:billing',
      'handsOff:handoff:billing->sub:billing',
      'handsOff:agent->handoff:escalations',
    ]);
  });

  it('labels the derived handsOff edges', () => {
    expect(deriveEdges(graph).map((e) => e.label)).toEqual([
      'delegates',
      'hands off',
      'hands off',
      'hands off',
    ]);
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('handoffRules.validate', () => {
  it('requires a target', () => {
    const graph = graphOf({ handoffs: [{ agent: '' }] });
    expect(validateGraph(graph)).toStrictEqual([
      error('handoff:new', 'Pick who this hands off to', 'handoffs[0].agent'),
    ]);
  });

  it('flags two handoffs resolving to the same tool name', () => {
    const graph = graphOf({
      handoffs: [{ agent: 'billing' }, { agent: 'refunds', toolName: 'transfer_to_billing' }],
    });
    expect(validateGraph(graph)).toStrictEqual([
      error(
        'handoff:billing',
        "Two handoffs use the tool name 'transfer_to_billing'",
        'handoffs[0].toolName',
      ),
      error(
        'handoff:refunds',
        "Two handoffs use the tool name 'transfer_to_billing'",
        'handoffs[1].toolName',
      ),
    ]);
  });

  it('flags two handoffs sharing an explicit tool name', () => {
    const graph = graphOf({
      handoffs: [
        { agent: 'billing', toolName: 'go' },
        { agent: 'refunds', toolName: 'go' },
      ],
    });
    expect(validateGraph(graph)).toStrictEqual([
      error('handoff:billing', "Two handoffs use the tool name 'go'", 'handoffs[0].toolName'),
      error('handoff:refunds', "Two handoffs use the tool name 'go'", 'handoffs[1].toolName'),
    ]);
  });

  it('scopes the tool-name clash to siblings of the same owner', () => {
    const graph = graphOf({
      subagents: {
        a: {
          inline: {
            name: 'a',
            description: 'd',
            model: 'mock/mock-1',
            instructions: 'x',
            handoffs: [{ agent: 'x' }],
          },
        },
      },
      handoffs: [{ agent: 'x' }],
    });
    expect(validateGraph(graph)).toStrictEqual([]);
  });

  it('refuses a handoff to the root agent itself', () => {
    const graph = specToGraph(
      specOf({ name: 'triage', handoffs: [{ agent: 'triage' }] })
    );
    expect(validateGraph(graph)).toStrictEqual([
      error('handoff:triage', 'An agent cannot hand off to itself', 'handoffs[0].agent'),
    ]);
  });

  it('refuses a handoff to the inline agent that owns it', () => {
    const graph = graphOf({
      subagents: {
        a: {
          inline: {
            name: 'a',
            description: 'd',
            model: 'mock/mock-1',
            instructions: 'x',
            handoffs: [{ agent: 'a' }],
          },
        },
      },
    });
    expect(validateGraph(graph)).toStrictEqual([
      error(
        'sub:a/handoff:a',
        'An agent cannot hand off to itself',
        'subagents.a.inline.handoffs[0].agent',
      ),
    ]);
  });

  it('accepts the worked example', () => {
    expect(validateGraph(specToGraph(parse(WORKED) as AgentSpecV2))).toStrictEqual([]);
  });
});
