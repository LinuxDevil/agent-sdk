import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec } from './loadSpec';

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-spec-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('loadSpec', () => {
  it('loads a .yaml spec file', () => {
    const filePath = tmpFile(
      'agent.yaml',
      `
name: yaml-agent
prompt: You are a YAML-defined agent.
provider:
  type: mock
  model: mock-model-1
tools:
  - http
`
    );

    const spec = loadSpec(filePath);
    expect(spec).toEqual({
      name: 'yaml-agent',
      prompt: 'You are a YAML-defined agent.',
      provider: { type: 'mock', model: 'mock-model-1' },
      tools: ['http'],
    });
  });

  it('loads an equivalent .json spec file', () => {
    const filePath = tmpFile(
      'agent.json',
      JSON.stringify({
        name: 'json-agent',
        prompt: 'You are a JSON-defined agent.',
        provider: { type: 'mock', model: 'mock-model-1' },
        tools: ['http'],
      })
    );

    const spec = loadSpec(filePath);
    expect(spec.name).toBe('json-agent');
    expect(spec.provider).toEqual({ type: 'mock', model: 'mock-model-1' });
  });

  it('throws naming the missing field when prompt is absent', () => {
    const filePath = tmpFile(
      'invalid.json',
      JSON.stringify({
        name: 'incomplete-agent',
        provider: { type: 'openai', model: 'gpt-4o-mini' },
      })
    );

    expect(() => loadSpec(filePath)).toThrow(/'prompt'/);
  });

  it('throws for an unsupported extension', () => {
    const filePath = tmpFile('agent.txt', 'not a spec');
    expect(() => loadSpec(filePath)).toThrow(/unsupported extension/);
  });
});
