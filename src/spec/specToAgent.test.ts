import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec } from './loadSpec';
import { specToAgent } from './specToAgent';
import { createAgent } from '../createAgent';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider, MockLLMProvider } from '../providers/mock';

const RESPONSES = ['deterministic response one', 'deterministic response two'];

beforeAll(() => {
  // Registered once so both the spec-built agent and the createAgent()-built
  // agent below can each construct their OWN MockLLMProvider instance with
  // the same scripted response list, making their behavior directly
  // comparable without sharing mutable state between them.
  LLMProviderRegistry.register('mock', () => createMockProvider({ responses: RESPONSES }));
});

describe('specToAgent', () => {
  it('produces behavior identical to an equivalent createAgent()-built agent for the same input', async () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-spec-equiv-')),
      'agent.yaml'
    );
    fs.writeFileSync(
      filePath,
      `
name: equivalence-agent
prompt: You are a deterministic test agent.
provider:
  type: mock
  model: mock-model-1
`
    );

    const specAgent = specToAgent(loadSpec(filePath));
    const directAgent = createAgent({
      prompt: 'You are a deterministic test agent.',
      provider: new MockLLMProvider({ responses: RESPONSES }),
    });

    const specResult = await specAgent.send('hello');
    const directResult = await directAgent.send('hello');

    expect(specResult.text).toBe(directResult.text);
    expect(specResult.finishReason).toBe(directResult.finishReason);
    expect(specResult.toolCalls).toEqual(directResult.toolCalls);
  });

  it('throws naming an unrecognized tool', () => {
    expect(() =>
      specToAgent({
        name: 'x',
        prompt: 'x',
        provider: { type: 'mock', model: 'm' },
        tools: ['not-a-real-tool'],
      })
    ).toThrow(/unknown tool 'not-a-real-tool'/);
  });

  it('throws a guiding error for a credentialed tool (github/jira) with no config field', () => {
    expect(() =>
      specToAgent({
        name: 'x',
        prompt: 'x',
        provider: { type: 'mock', model: 'm' },
        tools: ['github'],
      })
    ).toThrow(/needs credentials/);
  });
});

describe('specToAgent model selection (LOU-U1)', () => {
  it("sends the spec's provider.model to provider.generate()", async () => {
    const received: Array<string | undefined> = [];
    LLMProviderRegistry.register('mock', (config) => {
      const provider = createMockProvider({ ...config, responses: RESPONSES });
      const generate = provider.generate.bind(provider);
      provider.generate = (options) => {
        received.push(options.model);
        return generate(options);
      };
      return provider;
    });
    try {
      const agent = specToAgent({
        name: 'model-agent',
        prompt: 'You are a test agent.',
        provider: { type: 'mock', model: 'spec-model-7' },
      });
      await agent.send('hello');
    } finally {
      LLMProviderRegistry.register('mock', () => createMockProvider({ responses: RESPONSES }));
    }

    expect(received).toEqual(['spec-model-7']);
  });
});

describe('specToAgent mcpServers (LOU-D20)', () => {
  it('exposes the parsed servers on the result (connecting is TODO(LOU-D20.2))', () => {
    const mcpServers = { fs: { command: 'npx' }, docs: { url: 'https://example.com/mcp' } };
    const provider = { type: 'mock', model: 'm' };
    const agent = specToAgent({ name: 'mcp-agent', prompt: 'x', provider, mcpServers });
    expect(agent.mcpServers).toEqual(mcpServers);
    expect(specToAgent({ name: 'n', prompt: 'x', provider }).mcpServers).toEqual({});
  });
});
