import { describe, expect, it } from 'vitest';

import {
  AGENT_FIELD_KEYS,
  ROOT_AGENT_ID,
  ROOT_ONLY_SECTIONS,
  SECTION_KIND,
  SECTION_ORDER,
} from '../types';
import type {
  AgentFieldKey,
  AgentFields,
  AgentNodeData,
  EdgeKind,
  EmptySection,
  FlowChildren,
  Graph,
  GraphEdge,
  GraphNode,
  GraphPosition,
  NodeKind,
  NodeOfKind,
  Problem,
  SectionKey,
} from '../types';
import type {
  AbortListenerSpec,
  AgentFlow,
  AgentSpecV2,
  EvalGateSpec,
  GuardrailSpec,
  HandoffSpec,
  HookSpec,
  McpServerSpec,
  MemorySpec,
  PermissionRuleSpec,
  SecretRef,
  SkillRef,
  SubagentSpec,
  ToolRef,
  TriggerSpec,
} from '../specTypes';

describe('spec key coverage', () => {
  /**
   * Compile-time contract checks: `AGENT_FIELD_KEYS` must list every
   * `AgentSpecV2` key that is not a section, `version` or `evals` — if a spec
   * ticket adds a key and forgets this list, these lines stop compiling.
   */
  it('covers every AgentSpecV2 key with a field key, a section, version or evals', () => {
    type SpecKey = keyof AgentSpecV2;
    type MissingField = Exclude<SpecKey, AgentFieldKey | SectionKey | 'version' | 'evals'>;
    type MissingSection = Exclude<'triggers' | 'tools' | 'mcpServers' | 'skills' | 'memory' | 'subagents'
      | 'handoffs' | 'guardrails' | 'permissions' | 'hooks' | 'output' | 'abortListeners' | 'flow', SpecKey>;
    const missingField: [MissingField] extends [never] ? true : never = true;
    const missingSection: [MissingSection] extends [never] ? true : never = true;
    expect(missingField).toBe(true);
    expect(missingSection).toBe(true);
  });

  it('keeps AGENT_FIELD_KEYS free of section keys, version and evals', () => {
    const reserved = new Set<string>([...SECTION_ORDER, 'version', 'evals']);
    expect(AGENT_FIELD_KEYS.some((key) => reserved.has(key))).toBe(false);
    expect(new Set(AGENT_FIELD_KEYS).size).toBe(AGENT_FIELD_KEYS.length);
  });
});

describe('SECTION_ORDER', () => {
  it('covers every section key exactly once, in canonical walk order', () => {
    expect(SECTION_ORDER).toEqual([
      'triggers', 'tools', 'mcpServers', 'skills', 'memory', 'subagents', 'handoffs',
      'guardrails', 'permissions', 'hooks', 'output', 'abortListeners', 'flow',
    ]);
    expect(new Set(SECTION_ORDER).size).toBe(SECTION_ORDER.length);
  });

  it('maps every section to a node kind', () => {
    for (const key of SECTION_ORDER) {
      expect(SECTION_KIND[key], key).toBeTruthy();
    }
    expect(Object.keys(SECTION_KIND).sort()).toEqual([...SECTION_ORDER].sort());
  });

  it('marks triggers, abortListeners and flow as root-only', () => {
    expect(ROOT_ONLY_SECTIONS).toEqual(['triggers', 'abortListeners', 'flow']);
  });
});

describe('graph model shapes', () => {
  it('builds a minimal graph with a node, an edge, a problem and an empty section', () => {
    const position: GraphPosition = { x: 0, y: 0 };
    const fields: AgentFields = { name: 'a', model: 'mock/mock-1', instructions: 'hi' };
    const data: AgentNodeData = { fields, extra: { evals: [] } };
    const agent: NodeOfKind<'agent'> = {
      id: ROOT_AGENT_ID,
      kind: 'agent',
      owner: null,
      position,
      data,
    };
    const children: FlowChildren = { shape: 'steps', ids: ['flow:s1', 'flow:s2'] };
    const flowNode: GraphNode = {
      id: 'flow:root',
      kind: 'flow',
      owner: ROOT_AGENT_ID,
      position,
      data: { step: { type: 'sequence', id: 'root' }, children },
    };
    const emptySection: EmptySection = { owner: ROOT_AGENT_ID, key: 'tools' };
    const edge: GraphEdge = {
      id: 'edge-1',
      kind: 'uses' satisfies EdgeKind,
      source: ROOT_AGENT_ID,
      target: 'tool:http',
    };
    const problem: Problem = { nodeId: ROOT_AGENT_ID, severity: 'warning', message: 'p' };
    const graph: Graph = {
      version: 2,
      nodes: [agent, flowNode],
      emptySections: [emptySection],
      unplaced: ['flow:root'],
    };
    expect(graph.nodes).toHaveLength(2);
    expect(edge.kind).toBe('uses');
    expect(problem.severity).toBe('warning');
  });

  it('types one of each spec item through the node data variants', () => {
    // One value per *NodeData item type — the point is that these compile.
    const tool: ToolRef = { builtin: 'http' };
    const skill: SkillRef = { registry: 'changelog' };
    const mcp: McpServerSpec = { command: 'gh-mcp' };
    const memory: MemorySpec = { name: 'mem', scope: 'global', provider: { type: 'in-memory' } };
    const subagent: SubagentSpec = { ref: 'agents/r.yaml' };
    const handoff: HandoffSpec = { agent: 'helper' };
    const guardrail: GuardrailSpec = { id: 'g1', name: 'regex' };
    const permission: PermissionRuleSpec = { id: 'p1', tool: '*', action: 'allow' };
    const hook: HookSpec = { id: 'h1', file: 'hooks/a.ts' };
    const trigger: TriggerSpec = { id: 't1', type: 'chat' };
    const abort: AbortListenerSpec = { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' };
    const evalGate: EvalGateSpec = { dataset: 'd', gates: [{ maxSteps: 5 }], minPassRate: 1 };
    const secret: SecretRef = { env: 'TOKEN' };
    const flow: AgentFlow = { code: 'c', name: 'f' };
    const output: NonNullable<AgentSpecV2['output']> = { jsonSchema: { type: 'object' } };
    expect([tool, skill, mcp, memory, subagent, handoff, guardrail, permission, hook, trigger,
      abort, evalGate, secret, flow, output]).toHaveLength(15);
  });
});

describe('NodeKind', () => {
  it('has the 15 kinds', () => {
    const kinds: NodeKind[] = [
      'agent', 'subagent', 'handoff', 'tool', 'mcp', 'skill', 'memory', 'guardrail',
      'permission', 'hook', 'output', 'trigger', 'abort', 'flow', 'note',
    ];
    expect(kinds).toHaveLength(15);
  });
});
