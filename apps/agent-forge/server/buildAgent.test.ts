import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigurationError, type AgentSpec } from '@lousho/build-ai-agent';
import { buildAgentFromSpec } from './buildAgent';
import { SecretsStore } from './secretsStore';

const BASE_SPEC: AgentSpec = {
  name: 'test-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

describe('buildAgentFromSpec - R1 provider resolution', () => {
  let baseDir: string;
  let secretsStore: SecretsStore;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-buildagent-'));
    secretsStore = new SecretsStore(baseDir);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it('resolves the mock provider unchanged when the spec asks for mock', () => {
    const built = buildAgentFromSpec(BASE_SPEC, 'agent-1', undefined, { secretsStore });
    expect(built.provider.name).toBe('mock');
  });

  it('fails with an actionable LOUSHO_PROVIDER_MISSING_API_KEY error, not a silent mock run, when a real provider has no key (Eve DUI-F4)', () => {
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'openai', model: 'gpt-4o' } };
    let caught: unknown;
    try {
      buildAgentFromSpec(spec, 'agent-2', undefined, { secretsStore });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).code).toBe('LOUSHO_PROVIDER_MISSING_API_KEY');
    expect((caught as Error).message).toMatch(/No API key for provider 'openai'.*Settings.*OPENAI_API_KEY.*'mock'/);
  });

  it('resolves the real provider when a key is stored in secretsStore', () => {
    secretsStore.setKey('openai', 'sk-test-key');
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'openai', model: 'gpt-4o' } };
    const built = buildAgentFromSpec(spec, 'agent-3', undefined, { secretsStore });
    expect(built.provider.name).toBe('openai');
  });

  it('resolves the real provider from an env var when no key is stored', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-key';
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'anthropic', model: 'claude-3-5-sonnet-latest' } };
    const built = buildAgentFromSpec(spec, 'agent-4', undefined, { secretsStore });
    expect(built.provider.name).toBe('anthropic');
  });

  it('prefers a stored key over an env var when both are present', () => {
    process.env.OPENAI_API_KEY = 'sk-env-key';
    secretsStore.setKey('openai', 'sk-stored-key');
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'openai', model: 'gpt-4o' } };
    const built = buildAgentFromSpec(spec, 'agent-5', undefined, { secretsStore });
    expect(built.provider.name).toBe('openai');
  });

  it('fails the same way when no secretsStore is supplied at all', () => {
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'anthropic', model: 'claude-3-5-sonnet-latest' } };
    expect(() => buildAgentFromSpec(spec, 'agent-6')).toThrow(/No API key for provider 'anthropic'.*ANTHROPIC_API_KEY/);
  });

  it('never substitutes mock for an env-only real provider (ollama)', () => {
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'ollama', model: 'llama3' } };
    const built = buildAgentFromSpec(spec, 'agent-ollama', undefined, { secretsStore });
    expect(built.provider.name).not.toBe('mock');
  });

  it("passes an env-only provider's own config error on with a pointer to the fix (openrouter without a key)", () => {
    delete process.env.OPENROUTER_API_KEY;
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'openrouter', model: 'openai/gpt-4o-mini' } };
    expect(() => buildAgentFromSpec(spec, 'agent-or', undefined, { secretsStore })).toThrow(/Provider 'openrouter' is not usable/);
  });

  it('still throws for a genuinely unrecognized provider type (a real config error, not a missing key)', () => {
    const spec: AgentSpec = { ...BASE_SPEC, provider: { type: 'definitely-not-a-real-provider', model: 'x' } };
    expect(() => buildAgentFromSpec(spec, 'agent-bad-provider', undefined, { secretsStore })).toThrow();
  });

  it('threads a configured hook timeout through to the compiled hook registry without throwing', () => {
    const spec: AgentSpec = {
      ...BASE_SPEC,
      policy: {
        hooks: [
          { nodeKey: 'llm', id: 'h1', name: 'redact', phase: 'pre', point: 'toolCall', code: 'return ctx;' },
        ],
      } as unknown as AgentSpec['policy'],
    };
    const built = buildAgentFromSpec(spec, 'agent-7', undefined, { secretsStore, hookTimeoutMs: 250 });
    expect(built.hooks).toBeDefined();
  });
});
