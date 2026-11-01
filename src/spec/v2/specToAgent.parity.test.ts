/**
 * v1/v2 parity: every valid v1 AgentSpec must behave the same through v1
 * `specToAgent(spec)` and through `specV2ToAgent(upgradeSpec(spec))`. Both
 * sides build their own MockLLMProvider through the registry with the same
 * scripted RESPONSES, so `send()` results are directly comparable.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LLMProviderRegistry } from '../../providers/llm';
import { createMockProvider } from '../../providers/mock';
import { mockModel } from '../../testing';
import { loadSpec } from '../loadSpec';
import { compilePolicy } from '../policy';
import type { AgentSpec } from '../schema';
import { specToAgent, type SpecAgent } from '../specToAgent';
import { guardrailSidesOf } from './guardrails';
import { compileSpec, specV2ToAgent, type SpecAgentV2 } from './specToAgent';
import { upgradeSpec, V1_TOOL_NAMES } from './upgrade';

const RESPONSES = ['deterministic response one', 'deterministic response two'];

beforeAll(() => {
  LLMProviderRegistry.register('mock', () => createMockProvider({ responses: RESPONSES }));
});

afterEach(() => {
  // The approval tests re-register 'mock' with a scripted model; restore the
  // RESPONSES factory for the next fixture.
  LLMProviderRegistry.register('mock', () => createMockProvider({ responses: RESPONSES }));
});

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

function host() {
  return { baseDir: mkdtempSync(path.join(tmpdir(), 'lousho-parity-')) };
}

/** The shared fixture base: name, prompt and the registered mock provider. */
function base(): AgentSpec {
  return { name: 'parity-agent', prompt: 'You are a test agent.', provider: { type: 'mock', model: 'm' } };
}

/** The spec compiled both ways: v1's sync specToAgent, v2's async specV2ToAgent over upgradeSpec. */
async function both(spec: AgentSpec): Promise<{ v1: SpecAgent; v2: SpecAgentV2 }> {
  return { v1: specToAgent(spec), v2: await specV2ToAgent(upgradeSpec(spec), host()) };
}

/** `send('hello')` on both agents: same text and same finishReason (each mock consumed RESPONSES[0]). */
async function assertSameHello(v1: SpecAgent, v2: SpecAgentV2): Promise<void> {
  const [r1, r2] = await Promise.all([v1.send('hello'), v2.send('hello')]);
  expect(r1.text).toBe('deterministic response one');
  expect(r2.text).toBe(r1.text);
  expect(r2.finishReason).toBe(r1.finishReason);
}

/** Same sorted model-facing tool names (v1 names map through V1_TOOL_NAMES). */
async function assertSameToolNames(spec: AgentSpec): Promise<void> {
  const v1Names = (spec.tools ?? []).map((name) => V1_TOOL_NAMES[name] ?? name).sort();
  const compiled = await compileSpec(upgradeSpec(spec), host());
  expect(Object.keys(compiled.config.tools ?? {}).sort()).toEqual(v1Names);
}

/**
 * A mock turn calling the spec's http tool ends `awaiting-approval` on both
 * sides. `MockLLMProvider` cannot produce this call (its hardcoded
 * `{ input: 'mock input' }` arguments fail http_request's schema before the
 * permission gate runs), so each side gets a scripted mockModel that calls
 * its own model-facing name — v1 tools keep the spec's names ('http'), v2
 * resolves the builtin ('http_request') — with args that pass validation.
 */
async function assertBothPauseForApproval(spec: AgentSpec): Promise<void> {
  const args = { url: 'https://example.com', method: 'GET' };
  LLMProviderRegistry.register('mock', () => mockModel([{ toolCalls: [{ name: 'http', args }] }]));
  const pausedV1 = await specToAgent(spec).send('go');
  expect(pausedV1.finishReason).toBe('awaiting-approval');
  LLMProviderRegistry.register('mock', () => mockModel([{ toolCalls: [{ name: 'http_request', args }] }]));
  const pausedV2 = await (await specV2ToAgent(upgradeSpec(spec), host())).send('go');
  expect(pausedV2.finishReason).toBe('awaiting-approval');
}

describe('specToAgent / specV2ToAgent parity', () => {
  it('(a) a minimal spec runs identically', async () => {
    const spec = base();
    const { v1, v2 } = await both(spec);
    await assertSameHello(v1, v2);
    await assertSameToolNames(spec);
  });

  it('(c) a tools list resolves to the same model-facing tool names', async () => {
    const spec: AgentSpec = { ...base(), tools: ['http', 'current-date', 'day-name', 'web-fetch'] };
    const { v1, v2 } = await both(spec);
    await assertSameHello(v1, v2);
    await assertSameToolNames(spec);
  });

  it('(d) a stdio MCP server compiles to the same config (config only, not connected)', async () => {
    const spec: AgentSpec = { ...base(), mcpServers: { fs: { command: 'npx', args: ['-y', 'mcp-fs'] } } };
    const { v1, v2 } = await both(spec);
    expect(v1.mcpServers).toEqual(spec.mcpServers);
    expect(v2.mcpServers).toEqual(spec.mcpServers);
    const compiled = await compileSpec(upgradeSpec(spec), host());
    expect(compiled.config.mcpServers).toEqual(spec.mcpServers);
    await assertSameToolNames(spec);
  });

  it('(b) policy.yaml: replies, tool names, policy scalars, guardrail sides and approval pauses all match', async () => {
    const spec = loadSpec(path.join(FIXTURES, 'policy.yaml'));
    const { v1, v2 } = await both(spec);
    await assertSameHello(v1, v2);
    await assertSameToolNames(spec);

    const policy = compilePolicy(spec.policy);
    const upgraded = upgradeSpec(spec);
    const compiled = await compileSpec(upgraded, host());
    expect(compiled.config.limits).toEqual(policy.limits);
    expect(compiled.config.askQuestion).toEqual(policy.askQuestion);
    expect(compiled.config.compaction).toEqual(policy.compaction);

    // Same guardrail count and order per side (names differ: v2 trips by entry id).
    const v1g = policy.guardrails ?? {};
    const v2g = compiled.config.guardrails ?? {};
    for (const side of ['input', 'output', 'tools'] as const) {
      expect(v2g[side]?.map((guardrail) => guardrail.name) ?? []).toEqual(
        (upgraded.guardrails ?? []).filter((entry) => guardrailSidesOf(entry).includes(side)).map((entry) => entry.id)
      );
      expect(v2g[side]?.length ?? 0).toBe(v1g[side]?.length ?? 0);
    }

    await assertBothPauseForApproval(spec);
  });

  it('(e) requiresApproval: a mock http_request turn pauses on both sides', async () => {
    const spec: AgentSpec = { ...base(), tools: ['http'], policy: { requiresApproval: true } };
    const { v1, v2 } = await both(spec);
    await assertSameHello(v1, v2);
    await assertBothPauseForApproval(spec);
  });

  it('(f) a cron trigger upgrades to a t<N> id on the spec — never agent config', async () => {
    const spec: AgentSpec = { ...base(), triggers: [{ type: 'cron', cron: '0 9 * * *', input: 'Weekly report.' }] };
    const upgraded = upgradeSpec(spec);
    expect(upgraded.triggers?.[0]).toMatchObject({ id: 't1', type: 'cron', prompt: 'Weekly report.' });

    // v1 runs the spec ignoring triggers; v2 carries them on agent.spec
    // (trigger → runtime wiring is S22b) and never puts them on the
    // createAgent config.
    const { v1, v2 } = await both(spec);
    expect(v2.spec.triggers?.[0]).toMatchObject({ id: 't1', type: 'cron' });
    await assertSameHello(v1, v2);
    const compiled = await compileSpec(upgraded, host());
    expect(compiled.config).not.toHaveProperty('triggers');
  });
});
