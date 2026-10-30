import { describe, it, expect } from 'vitest';
import { upgradeSpec, type AgentSpec, type AgentSpecV2 } from '@lousho/build-ai-agent';
import { mergeLegacySave, toLegacySpec } from '../legacySpec';

const base: AgentSpec = { name: 'bot', prompt: 'Be helpful.', provider: { type: 'mock', model: 'm1' } };

const fixtures: [string, AgentSpec][] = [
  ['minimal', base],
  [
    'tools + requiresApproval true',
    { ...base, tools: ['http_request', 'web_fetch'], policy: { requiresApproval: true } },
  ],
  [
    'requiresApproval list + guardrails with options',
    {
      ...base,
      policy: {
        requiresApproval: ['http_request', 'web_fetch'],
        guardrails: [{ name: 'pii' }, { name: 'max-length', on: 'input', maxChars: 500 }],
      },
    },
  ],
  [
    'hooks + flow',
    {
      ...base,
      policy: {
        hooks: [{ nodeKey: 'h1', id: 'h1', name: 'lint', phase: 'pre', point: 'toolCall', code: 'return ctx' }],
        flow: { start: 's1', steps: [{ id: 's1', kind: 'agent' }] },
      },
    },
  ],
];

describe('toLegacySpec(upgradeSpec(v1)) round trip', () => {
  it.each(fixtures)('%s deep-equals the fixture', (_name, fixture) => {
    expect(toLegacySpec(upgradeSpec(fixture))).toEqual(fixture);
  });
});

describe('toLegacySpec', () => {
  it('renders file instructions as a pointer note', () => {
    const spec = { version: 2, name: 'bot', model: 'mock/m1', instructions: { file: 'prompts/bot.md' } } as AgentSpecV2;
    expect(toLegacySpec(spec).prompt).toBe('(instructions in file prompts/bot.md)');
  });

  it('a model without / becomes { type: model, model }', () => {
    const spec = { version: 2, name: 'bot', model: 'ollama', instructions: 'x' } as AgentSpecV2;
    expect(toLegacySpec(spec).provider).toEqual({ type: 'ollama', model: 'ollama' });
  });
});

describe('mergeLegacySave', () => {
  it('returns the upgraded spec when nothing is stored', () => {
    expect(mergeLegacySave(undefined, base)).toEqual(upgradeSpec(base));
  });

  it('keeps v2-only keys and replaces instructions when only the prompt changed', () => {
    const stored = {
      version: 2,
      name: 'bot',
      model: 'mock/m1',
      instructions: 'old prompt',
      description: 'kept',
      skills: [{ registry: 'summarizer' }],
      guardrails: [{ id: 'g9', name: 'pii' }],
    } as unknown as AgentSpecV2;
    const legacy = { ...toLegacySpec(stored), prompt: 'new prompt' };
    const merged = mergeLegacySave(stored, legacy);
    expect(merged.instructions).toBe('new prompt');
    expect(merged.description).toBe('kept');
    expect((merged as { skills?: unknown }).skills).toEqual([{ registry: 'summarizer' }]);
    // Guardrails did not change on the v1 side, so the stored ids survive.
    expect(merged.guardrails).toBe(stored.guardrails);
  });

  it('keeps stored non-builtin tool refs, then the upgraded tools, when tools change', () => {
    const stored = {
      version: 2,
      name: 'bot',
      model: 'mock/m1',
      instructions: 'x',
      tools: [{ builtin: 'web_fetch' }, { registry: 'toolkit-extra' }],
    } as unknown as AgentSpecV2;
    const before = toLegacySpec(stored);
    expect(before.tools).toEqual(['web_fetch', 'toolkit-extra']);
    const merged = mergeLegacySave(stored, { ...before, tools: ['http_request'] });
    expect((merged as { tools?: unknown }).tools).toEqual([
      { registry: 'toolkit-extra' },
      { builtin: 'http_request' },
    ]);
  });

  it('drops a v2 key the v1 save cleared', () => {
    const stored = {
      version: 2,
      name: 'bot',
      model: 'mock/m1',
      instructions: 'x',
      permissions: [{ id: 'p1', tool: '*', action: 'ask' }],
    } as unknown as AgentSpecV2;
    const before = toLegacySpec(stored);
    expect(before.policy?.requiresApproval).toBe(true);
    const legacy = { ...before, policy: { ...before.policy, requiresApproval: undefined } };
    const merged = mergeLegacySave(stored, legacy);
    expect(merged.permissions).toBeUndefined();
  });
});
