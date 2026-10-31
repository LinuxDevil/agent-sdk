import { describe, it, expect } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { computeChangedFields } from '../../../shared/specFields';
import type { SpecSnapshot } from '../../../shared/wireTypes';

/** Every spec field plus 'labels', in the canonical order the version index stores them. */
const EXPECTED_ORDER = [
  'name',
  'description',
  'model',
  'fallbackModels',
  'instructions',
  'instructionsByFamily',
  'promptRef',
  'modelSettings',
  'reasoning',
  'tools',
  'mcpServers',
  'skills',
  'memory',
  'subagents',
  'subagentOptions',
  'maxSubagentDepth',
  'handoffs',
  'maxHandoffs',
  'guardrails',
  'permissions',
  'permissionMode',
  'approvalTtlMs',
  'askQuestion',
  'hooks',
  'output',
  'limits',
  'maxSteps',
  'compaction',
  'retry',
  'rateLimit',
  'promptCaching',
  'toolSearch',
  'codeMode',
  'triggers',
  'abortListeners',
  'flow',
  'evals',
  'labels',
];

/** A spec with a non-empty value in every field (pending sections included - this is data, not a validated doc). */
const FULL_SPEC = {
  version: 2,
  name: 'full',
  description: 'Everything set.',
  model: 'mock/mock-1',
  fallbackModels: ['mock/mock-2'],
  instructions: 'Do everything.',
  instructionsByFamily: { gpt: 'Be terse.' },
  promptRef: 'prompt@label',
  modelSettings: { temperature: 0.5 },
  reasoning: 'low',
  tools: [{ builtin: 'web_fetch' }],
  mcpServers: { srv: { transport: 'stdio', command: 'run' } },
  skills: [{ registry: 'summarizer' }],
  memory: { recall: { slot: 'x' } },
  subagents: [{ name: 'helper' }],
  subagentOptions: { maxConcurrent: 2 },
  maxSubagentDepth: 1,
  handoffs: [{ target: 'other-agent' }],
  maxHandoffs: 2,
  guardrails: [{ id: 'g1', name: 'pii' }],
  permissions: [{ tool: '*', action: 'ask' }],
  permissionMode: 'strict',
  approvalTtlMs: 5000,
  askQuestion: true,
  hooks: [{ id: 'h1', inline: { name: 'log', point: 'preGenerate', code: 'return true' } }],
  output: { jsonSchema: { type: 'object' } },
  limits: { maxCostUsd: 1 },
  maxSteps: 10,
  compaction: true,
  retry: { maxAttempts: 2 },
  rateLimit: { requestsPerMinute: 10 },
  promptCaching: 'auto',
  toolSearch: { threshold: 0.5 },
  codeMode: true,
  triggers: [{ type: 'cron', cron: '0 9 * * *' }],
  abortListeners: [{ id: 'a1', when: 'true' }],
  flow: { nodes: [] },
  evals: [{ id: 'e1' }],
} as unknown as AgentSpecV2;

function snapshot(spec: Record<string, unknown>, labels: string[] = []): SpecSnapshot {
  return {
    spec: { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run.', ...spec } as AgentSpecV2,
    labels,
  };
}

describe('computeChangedFields', () => {
  it('with no `before`, lists every non-empty field of `after` in canonical order', () => {
    expect(computeChangedFields(undefined, { spec: FULL_SPEC, labels: ['ops'] })).toEqual(EXPECTED_ORDER);
  });

  it('lists only the changed fields, in canonical (not alphabetical) order', () => {
    const before = snapshot({ evals: [{ id: 'e1' }] });
    const after = snapshot({ name: 'renamed', evals: [{ id: 'e2' }] });
    expect(computeChangedFields(before, after)).toEqual(['name', 'evals']);
  });

  it('treats empty values as absent: [], "", {}, null and undefined are all equivalent', () => {
    const before = snapshot({ tools: [], description: '', modelSettings: {}, fallbackModels: undefined }, []);
    const after = snapshot({}, []);
    expect(computeChangedFields(before, after)).toEqual([]);
    // ...and adding an empty value is no change either.
    expect(computeChangedFields(after, before)).toEqual([]);
  });

  it('ignores nested object key order', () => {
    const before = snapshot({ modelSettings: { temperature: 0.5, topP: 0.9, nested: { a: 1, b: 2 } } });
    const after = snapshot({ modelSettings: { nested: { b: 2, a: 1 }, topP: 0.9, temperature: 0.5 } });
    expect(computeChangedFields(before, after)).toEqual([]);
  });

  it('keeps array order meaningful (labels reordered is a change)', () => {
    const before = snapshot({}, ['a', 'b']);
    const after = snapshot({}, ['b', 'a']);
    expect(computeChangedFields(before, after)).toEqual(['labels']);
  });
});
