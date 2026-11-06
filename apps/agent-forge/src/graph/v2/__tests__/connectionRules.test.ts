import { describe, expect, it } from 'vitest';

import { canConnect, CONNECTION_RULES } from '../connectionRules';
import type { AgentFields, NodeKind, NodeOfKind } from '../types';

/** Smallest valid `AgentNodeData.fields` for tests that never inspect the fields. */
const AGENT_FIELDS: AgentFields = { name: 'a', model: 'mock/mock-1', instructions: 'hi' };

/** One minimal data object per node kind, so tests can build nodes without repeating literals. */
const NODE_DATA: { [K in NodeKind]: NodeOfKind<K>['data'] } = {
  agent: { fields: AGENT_FIELDS, extra: {} },
  subagent: { key: 'research', item: { ref: 'agents/r.yaml' } },
  handoff: { item: { agent: 'helper' } },
  tool: { item: { builtin: 'http' } },
  mcp: { key: 'gh', item: { command: 'gh-mcp' } },
  skill: { item: { registry: 'changelog' } },
  memory: { item: { name: 'mem', scope: 'global', provider: { type: 'in-memory' } } },
  guardrail: { item: { id: 'g1', name: 'regex' } },
  permission: { item: { id: 'p1', tool: '*', action: 'allow' } },
  hook: { item: { id: 'h1', file: 'hooks/a.ts' } },
  output: { item: { jsonSchema: { type: 'object' } } },
  trigger: { item: { id: 't1', type: 'chat' } },
  abort: { item: { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' } },
  flow: { step: { type: 'agentStep', id: 's1' }, children: { shape: 'none' } },
  note: { text: 'hi' },
};

/** Minimal graph node of a kind; ids default to `<kind>:x` and owners to the root agent. */
function node<K extends NodeKind>(kind: K, over: { id?: string; owner?: string | null } = {}): NodeOfKind<K> {
  const base = {
    id: over.id ?? `${kind}:x`,
    kind,
    owner: over.owner === undefined ? 'agent' : over.owner,
    position: { x: 0, y: 0 },
    data: NODE_DATA[kind],
  };
  return base as unknown as NodeOfKind<K>;
}

describe('CONNECTION_RULES', () => {
  it('lists every node kind exactly once', () => {
    const kinds: NodeKind[] = [
      'agent', 'subagent', 'handoff', 'tool', 'mcp', 'skill', 'memory', 'guardrail',
      'permission', 'hook', 'output', 'trigger', 'abort', 'flow', 'note',
    ];
    expect(Object.keys(CONNECTION_RULES).sort()).toEqual(kinds.sort());
  });
});

describe('canConnect kind table', () => {
  /**
   * `trigger > agent` and `agent > output` are in the table but can never
   * connect: those edges always exist already, so the instance rules below
   * refuse them. They are asserted separately with their refusal reasons.
   */
  const ALWAYS_REFUSED = new Set(['trigger>agent', 'agent>output']);

  it.each(
    (Object.entries(CONNECTION_RULES) as Array<[NodeKind, readonly NodeKind[]]>).flatMap(
      ([sourceKind, targets]) =>
        targets
          .filter((targetKind) => !ALWAYS_REFUSED.has(`${sourceKind}>${targetKind}`))
          .map((targetKind) => [sourceKind, targetKind] as const),
    ),
  )('allows %s -> %s for a minimal pair of nodes', (sourceKind, targetKind) => {
    const sameOwner = sourceKind === 'tool' || sourceKind === 'mcp';
    const source = node(sourceKind, { id: sourceKind === 'agent' ? 'agent' : `${sourceKind}:s`, owner: 'agent' });
    const target = node(targetKind, { id: `${targetKind}:t`, owner: sameOwner ? 'agent' : 'other' });
    expect(canConnect(source, target)).toEqual({ ok: true });
  });

  it.each([
    ['note', 'agent'],
    ['tool', 'agent'],
    ['output', 'agent'],
    ['subagent', 'tool'],
  ] as Array<[NodeKind, NodeKind]>)('refuses %s -> %s', (sourceKind, targetKind) => {
    const source = node(sourceKind, { id: `${sourceKind}:s`, owner: 'agent' });
    const target = node(targetKind, { id: `${targetKind}:t`, owner: 'other' });
    expect(canConnect(source, target)).toEqual({
      ok: false,
      reason: `Can't connect ${sourceKind} → ${targetKind}`,
    });
  });
});

describe('canConnect instance rules', () => {
  it('allows agent -> subagent (the delegates edge)', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('subagent', { id: 'sub:billing', owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: true });
  });

  it('refuses subagent -> tool (subagents have no outgoing port)', () => {
    const source = node('subagent', { id: 'sub:billing', owner: 'agent' });
    const target = node('tool', { id: 'tool:x', owner: 'agent' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: "Can't connect subagent → tool" });
  });

  it('allows agent -> tool (the uses edge)', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('tool', { id: 'tool:http', owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: true });
  });

  it('allows agent -> handoff (the handsOff edge re-owns the handoff)', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('handoff', { id: 'handoff:billing', owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: true });
  });

  it('refuses handoff -> agent (a handoff is not an edge source)', () => {
    const source = node('handoff', { id: 'handoff:billing', owner: 'agent' });
    const target = node('agent', { id: 'sub:research', owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: "Can't connect handoff → agent" });
  });

  it('allows agent -> mcp (the uses edge)', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('mcp', { id: 'mcp:gh', owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: true });
  });

  it('refuses mcp -> tool (an mcp node only sources permission edges)', () => {
    const source = node('mcp', { id: 'mcp:gh', owner: 'agent' });
    const target = node('tool', { id: 'tool:http', owner: 'agent' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: "Can't connect mcp → tool" });
  });

  it('refuses tool -> agent (a tool is not an edge source)', () => {
    const source = node('tool', { id: 'tool:http', owner: 'agent' });
    const target = node('agent', { id: 'sub:research', owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: "Can't connect tool → agent" });
  });

  it('refuses tool -> tool', () => {
    const source = node('tool', { id: 'tool:a', owner: 'agent' });
    const target = node('tool', { id: 'tool:b', owner: 'agent' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: "Can't connect tool → tool" });
  });

  it('refuses a node connected to itself, before the kind table', () => {
    const tool = node('tool');
    expect(canConnect(tool, tool)).toEqual({ ok: false, reason: "Can't connect a node to itself" });
  });

  it('refuses trigger -> inline agent', () => {
    const source = node('trigger');
    const target = node('agent', { id: 'sub:research' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: 'Triggers start the main agent only' });
  });

  it('refuses trigger -> root agent (the edge already exists)', () => {
    const source = node('trigger');
    const target = node('agent', { id: 'agent' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: 'Triggers always start the main agent' });
  });

  it('refuses inline agent -> flow', () => {
    const source = node('agent', { id: 'sub:research' });
    const target = node('flow', { owner: 'other' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: 'Only the main agent runs a flow' });
  });

  it('refuses agent -> node already owned by that agent', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('tool', { owner: 'agent' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: 'Already attached to this agent' });
  });

  it('refuses agent -> output the agent does not own', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('output', { owner: 'other' });
    expect(canConnect(source, target)).toEqual({
      ok: false,
      reason: 'This agent already has an output schema',
    });
  });

  it('refuses agent -> output owned by the agent with the attach reason (rule order)', () => {
    const source = node('agent', { id: 'agent' });
    const target = node('output', { owner: 'agent' });
    expect(canConnect(source, target)).toEqual({ ok: false, reason: 'Already attached to this agent' });
  });

  it.each(['tool', 'mcp'] as const)('refuses %s -> permission of another agent', (sourceKind) => {
    const source = node(sourceKind, { owner: 'agent' });
    const target = node('permission', { owner: 'sub:research' });
    expect(canConnect(source, target)).toEqual({
      ok: false,
      reason: 'A rule only governs tools of the same agent',
    });
  });
});
