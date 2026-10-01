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
    expect(() => loadSpec(filePath)).toThrow(expect.objectContaining({ code: 'LOUSHY_SPEC_INVALID' }));
  });

  it('suggests the spec field a top-level typo meant (LOU-D2)', () => {
    const typo = tmpFile(
      'typo.yaml',
      'name: a\nprompt: hi\nprovider:\n  type: mock\n  model: m\ntool:\n  - http\n'
    );
    expect(() => loadSpec(typo)).toThrow(
      expect.objectContaining({
        code: 'LOUSHY_SPEC_UNKNOWN_FIELD',
        message: expect.stringContaining("unknown field 'tool' (did you mean 'tools'?)"),
      })
    );

    const missing = tmpFile('promt.yaml', 'name: a\npromt: hi\nprovider:\n  type: mock\n  model: m\n');
    expect(() => loadSpec(missing)).toThrow(
      expect.objectContaining({
        code: 'LOUSHY_SPEC_INVALID',
        message: expect.stringMatching(/'prompt': .*; unknown field 'promt' \(did you mean 'prompt'\?\)/),
      })
    );

    const unrelated = tmpFile('extra.yaml', 'name: a\nprompt: hi\nprovider:\n  type: mock\n  model: m\ndescription: x\n');
    expect(loadSpec(unrelated).name).toBe('a');
  });

  it('loads mcpServers from YAML (LOU-D20)', () => {
    const filePath = tmpFile(
      'mcp.yaml',
      `
name: mcp-agent
prompt: hi
provider:
  type: mock
  model: m
mcpServers:
  fs:
    command: npx
    args: [-y, "@modelcontextprotocol/server-filesystem"]
    env:
      ROOT: /tmp
  docs:
    url: https://example.com/mcp
`
    );
    expect(loadSpec(filePath).mcpServers).toEqual({
      fs: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: { ROOT: '/tmp' },
      },
      docs: { url: 'https://example.com/mcp' },
    });
  });

  it('names the mcpServers entry in the error for a bad entry (LOU-D20)', () => {
    const filePath = tmpFile(
      'bad-mcp.json',
      JSON.stringify({
        name: 'a',
        prompt: 'b',
        provider: { type: 'mock', model: 'm' },
        mcpServers: { files: { args: ['x'] }, ok: { command: 'npx' } },
      })
    );
    expect(() => loadSpec(filePath)).toThrow(
      /'mcpServers\.files': AgentSpec validation failed: missing 'command'/
    );
  });

  it('throws for an unsupported extension', () => {
    const filePath = tmpFile('agent.txt', 'not a spec');
    expect(() => loadSpec(filePath)).toThrow(/unsupported extension/);
    expect(() => loadSpec(filePath)).toThrow(expect.objectContaining({ code: 'LOUSHY_SPEC_UNSUPPORTED_FORMAT' }));
  });
});
