import { describe, it, expect } from 'vitest';
import { upgradeSpec, V1_TOOL_NAMES } from './upgrade';

const v1 = { name: 'bot', prompt: 'Hi', provider: { type: 'anthropic', model: 'claude-sonnet-5-5' } };

describe('upgradeSpec', () => {
  it('converts a minimal v1 spec, emitting keys in contract order', () => {
    const upgraded = upgradeSpec(v1);
    expect(upgraded).toEqual({
      version: 2,
      name: 'bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Hi',
    });
    expect(Object.keys(upgraded)).toEqual(['version', 'name', 'model', 'instructions']);
  });

  it('maps v1 tool names to { builtin } refs, passing unknown names through', () => {
    const upgraded = upgradeSpec({ ...v1, tools: ['http', 'web-fetch', 'github'] });
    expect(upgraded.tools).toEqual([{ builtin: 'http_request' }, { builtin: 'web_fetch' }, { builtin: 'github' }]);
  });

  it('publishes the same name map as V1_TOOL_NAMES', () => {
    expect(V1_TOOL_NAMES).toEqual({
      http: 'http_request',
      'current-date': 'current_date',
      'day-name': 'day_name',
      'web-fetch': 'web_fetch',
    });
  });

  it('omits tools when the v1 list is absent or empty', () => {
    expect(upgradeSpec(v1)).not.toHaveProperty('tools');
    expect(upgradeSpec({ ...v1, tools: [] })).not.toHaveProperty('tools');
  });

  it('turns requiresApproval: true into one ask rule for every tool', () => {
    const upgraded = upgradeSpec({ ...v1, policy: { requiresApproval: true } });
    expect(upgraded.permissions).toEqual([{ id: 'p1', tool: '*', action: 'ask' }]);
  });

  it('turns a requiresApproval list into one ask rule with mapped tool names', () => {
    const upgraded = upgradeSpec({ ...v1, policy: { requiresApproval: ['http'] } });
    expect(upgraded.permissions).toEqual([{ id: 'p1', tool: ['http_request'], action: 'ask' }]);
  });

  it('emits no permissions for requiresApproval false or an empty list', () => {
    for (const requiresApproval of [false, []] as const) {
      expect(upgradeSpec({ ...v1, policy: { requiresApproval } })).not.toHaveProperty('permissions');
    }
  });

  it('maps policy.guardrails to guardrails with g1... ids, splitting on out of options', () => {
    const upgraded = upgradeSpec({
      ...v1,
      policy: { guardrails: ['pii', { name: 'regex', pattern: 'x', on: 'tools' }] },
    });
    expect(upgraded.guardrails).toEqual([
      { id: 'g1', name: 'pii' },
      { id: 'g2', name: 'regex', on: 'tools', options: { pattern: 'x' } },
    ]);
  });

  it('lifts policy.limits, askQuestion and compaction to the top level', () => {
    const upgraded = upgradeSpec({
      ...v1,
      policy: { limits: { maxSteps: 4 }, askQuestion: true, compaction: { thresholdPercent: 0.8 } },
    });
    expect(upgraded.limits).toEqual({ maxSteps: 4 });
    expect(upgraded.askQuestion).toBe(true);
    expect(upgraded.compaction).toEqual({ thresholdPercent: 0.8 });
  });

  it('maps policy.hooks to inline hooks, dropping nodeKey', () => {
    const upgraded = upgradeSpec({
      ...v1,
      policy: {
        hooks: [{ nodeKey: 'tool:http', id: 'h1', name: 'redact', phase: 'post', point: 'toolCall', code: 'return ctx;' }],
      },
    });
    expect(upgraded.hooks).toEqual([{ id: 'h1', inline: { name: 'redact', point: 'postToolCall', code: 'return ctx;' } }]);
  });

  it('maps every phase/point combination to the v2 hook point name', () => {
    const combos = [
      ['pre', 'toolCall', 'preToolCall'],
      ['pre', 'generate', 'preGenerate'],
      ['post', 'toolCall', 'postToolCall'],
      ['post', 'generate', 'postGenerate'],
    ] as const;
    for (const [phase, point, expected] of combos) {
      const upgraded = upgradeSpec({ ...v1, policy: { hooks: [{ id: 'h', name: 'n', phase, point, code: 'c' }] } });
      expect(upgraded.hooks).toEqual([{ id: 'h', inline: { name: 'n', point: expected, code: 'c' } }]);
    }
  });

  it('throws LOUSHO_SPEC_INVALID for a policy.hooks that is not a serialized hook list', () => {
    for (const hooks of ['nope', [{ id: 'h1' }]] as const) {
      expect(() => upgradeSpec({ ...v1, policy: { hooks } })).toThrow(
        expect.objectContaining({
          code: 'LOUSHO_SPEC_INVALID',
          message: expect.stringContaining('policy.hooks must be a list of { id, name, phase, point, code }'),
        })
      );
    }
  });

  it('moves policy.flow to a top-level flow unchanged', () => {
    const flow = { code: 'f', name: 'F' };
    expect(upgradeSpec({ ...v1, policy: { flow } }).flow).toEqual(flow);
  });

  it('drops harness-specific policy keys it does not map', () => {
    const upgraded = upgradeSpec({ ...v1, policy: { sandbox: 'docker' } });
    expect(upgraded).not.toHaveProperty('sandbox');
    expect(upgraded).not.toHaveProperty('policy');
  });

  it('adds t1... ids to triggers and renames a cron input to prompt', () => {
    const upgraded = upgradeSpec({
      ...v1,
      triggers: [
        { type: 'cron', cron: '0 9 * * *', input: 'Go' },
        { type: 'webhook', path: '/x' },
      ],
    });
    expect(upgraded.triggers).toEqual([
      { id: 't1', type: 'cron', cron: '0 9 * * *', prompt: 'Go' },
      { id: 't2', type: 'webhook', path: '/x' },
    ]);
  });

  it('keeps a cron input that already has a prompt', () => {
    const upgraded = upgradeSpec({ ...v1, triggers: [{ type: 'cron', cron: '0 9 * * *', input: 'I', prompt: 'P' }] });
    expect(upgraded.triggers).toEqual([{ id: 't1', type: 'cron', cron: '0 9 * * *', input: 'I', prompt: 'P' }]);
  });

  it('passes mcpServers through in the record form v1 parsing produces', () => {
    const upgraded = upgradeSpec({ ...v1, mcpServers: [{ name: 'fs', command: 'npx' }] });
    expect(upgraded.mcpServers).toEqual({ fs: { command: 'npx' } });
  });

  it('returns version: 2 input unchanged', () => {
    const alreadyV2 = { version: 2, name: 'x' };
    expect(upgradeSpec(alreadyV2)).toBe(alreadyV2);
  });

  it('throws LOUSHO_SPEC_INVALID naming the missing field for invalid v1 input', () => {
    expect(() => upgradeSpec({ name: 'bot' })).toThrow(
      expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID', message: expect.stringContaining("'prompt'") })
    );
  });

  it('throws LOUSHO_SPEC_INVALID for non-object input', () => {
    expect(() => upgradeSpec('nope')).toThrow(expect.objectContaining({ code: 'LOUSHO_SPEC_INVALID' }));
  });
});
