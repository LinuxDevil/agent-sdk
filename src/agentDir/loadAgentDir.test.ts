import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { z } from 'zod';
import { loadAgentDir, resolveAgentDir } from './index';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { explainImportError } from './importModule';
import { closest } from './closest';

const fixture = (name: string): string => path.join(__dirname, '__fixtures__', name);
const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }): string =>
  String(call.messages.find((m) => m.role === 'system')?.content);
const toolMessages = (call: { messages: readonly { role: string; content: unknown }[] }): string[] =>
  call.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('resolveAgentDir', () => {
  it('discovers every layout: ts config, ts tools (default + named), skills (both layouts), subagents', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('full'), { provider: mockModel(['x']) });

    expect(manifest.name).toBe('full');
    expect(manifest.description).toBe('Fixture agent covering every layout');
    expect(manifest.tools).toEqual(['echo', 'add', 'double']);
    expect(manifest.skills).toEqual(['changelog', 'release']);
    expect(manifest.subagents).toEqual(['researcher']);
    expect(manifest.files.map((f) => path.relative(fixture('full'), f).split(path.sep).join('/'))).toEqual([
      'agent.ts',
      'instructions.md',
      'tools/a_echo.ts',
      'tools/b_math.ts',
    ]);
    expect(config.instructions).toBe('You are the fixture agent. Use your tools and skills.');
    expect(config.maxSteps).toBe(4);
    expect(config.toolConcurrency).toBe(1);
    expect(Array.isArray(config.tools) && config.tools.map((t) => t.name)).toEqual([
      'echo',
      'add',
      'double',
      'delegate_to_researcher',
    ]);
  });

  it('loads .js tools with a .json config', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('js-json'), { provider: mockModel(['x']) });
    expect(manifest.tools).toEqual(['ping']);
    expect(config.name).toBe('js-json-agent');
    expect(config.maxSteps).toBe(3);
  });

  it('loads a .yaml config with inline instructions and no other files', async () => {
    const { config, manifest } = await resolveAgentDir(fixture('yaml-inline'));
    expect(config.instructions).toBe('You are the YAML fixture agent.');
    expect(config.maxSteps).toBe(2);
    expect(config.tools).toBeUndefined();
    expect(config.skills).toBeUndefined();
    expect(manifest).toMatchObject({ tools: [], skills: [], subagents: [] });
    expect(manifest.files).toHaveLength(1);
  });

  it('lets overrides win over files', async () => {
    const provider = mockModel(['x']);
    const { config } = await resolveAgentDir(fixture('js-json'), {
      provider,
      name: 'renamed',
      instructions: 'override prompt',
      maxSteps: 9,
    });
    expect(config).toMatchObject({ name: 'renamed', instructions: 'override prompt', maxSteps: 9, provider });
    const viaAlias = await resolveAgentDir(fixture('js-json'), { prompt: 'alias prompt' });
    expect(viaAlias.config.instructions).toBe('alias prompt');
  });

  it('drops a file-level provider/model string when a provider instance is overridden', async () => {
    const provider = mockModel(['x']);
    const tweaked = await resolveAgentDir(fixture('full'), { provider, model: 'bare-model-id' });
    expect(tweaked.config).toMatchObject({ provider, model: 'bare-model-id' });
  });

  it('replaces discovered tools and skills when overridden, without reading them', async () => {
    const mine = defineTool({ name: 'mine', description: 'd', input: z.object({}), execute: () => 1 });
    const { config } = await resolveAgentDir(fixture('full'), {
      provider: mockModel(['x']),
      tools: [mine],
      skills: [],
    });
    expect(config.tools).toEqual([mine]);
    expect(config.skills).toEqual([]);
  });

  it('rejects a path that is not a directory', async () => {
    await expect(resolveAgentDir(path.join(fixture('full'), 'instructions.md'))).rejects.toThrow(
      /is not a directory/
    );
  });
});

describe('loadAgentDir', () => {
  it('returns a working createAgent() agent whose disk tools and skills are callable', async () => {
    const model = mockModel([
      {
        toolCalls: [
          { name: 'echo', args: { text: 'hi' } },
          { name: 'add', args: { a: 2, b: 3 } },
          { name: 'load_skill', args: { name: 'release' } },
        ],
      },
      'All done.',
    ]);
    const agent = await loadAgentDir(fixture('full'), { provider: model });

    const result = await agent.send('go');

    expect(result.text).toBe('All done.');
    const first = model.calls[0];
    expect(systemOf(first)).toContain('You are the fixture agent.');
    expect(systemOf(first)).toContain('- changelog: How to write a changelog entry');
    expect(systemOf(first)).not.toContain('Bump the version');
    expect(first.tools?.map((t) => t.function.name).sort()).toEqual([
      'add',
      'delegate_to_researcher',
      'double',
      'echo',
      'load_skill',
    ]);
    const outputs = toolMessages(model.calls[1]).join('\n');
    expect(outputs).toContain('echo: hi');
    expect(outputs).toContain('5');
    expect(outputs).toContain('Bump the version');
  });

  it('runs a .js tool', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'ping' }] }, 'ok']);
    const agent = await loadAgentDir(fixture('js-json'), { provider: model });
    await agent.send('ping it');
    expect(toolMessages(model.calls[1]).join('')).toContain('pong');
  });

  it('delegates to a sub-agent directory, which uses its own tools and inherits the provider override', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'delegate_to_researcher', args: { task: 'find cats' } }] },
      { toolCalls: [{ name: 'lookup', args: { topic: 'cats' } }] },
      'Cats are great.',
      'The researcher says cats are great.',
    ]);
    const agent = await loadAgentDir(fixture('full'), { provider: model });

    const result = await agent.send('research cats');

    expect(result.text).toBe('The researcher says cats are great.');
    const parentTool = model.calls[0].tools?.find((t) => t.function.name === 'delegate_to_researcher');
    expect(parentTool?.function.description).toContain('Looks facts up');
    expect(systemOf(model.calls[1])).toContain('You are the researcher.');
    expect(toolMessages(model.calls[2]).join('')).toContain('fact about cats');
    expect(toolMessages(model.calls[3]).join('')).toContain('Cats are great.');
  });
});

describe('validation errors', () => {
  it('names the directory when instructions are missing', async () => {
    const dir = fixture('err-no-instructions');
    const error = await resolveAgentDir(dir).catch((e: Error) => e);
    expect((error as Error).message).toContain(dir);
    expect((error as Error).message).toContain(path.join(dir, 'instructions.md'));
    expect((error as Error).message).toMatch(/has no instructions/);
  });

  it('says what a tools file exported, and shows a defineTool example', async () => {
    const file = path.join(fixture('err-bad-tool'), 'tools', 'nothing.ts');
    const error = (await resolveAgentDir(fixture('err-bad-tool')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain('default: object, helper: number');
    expect(error.message).toContain('defineTool({ name:');
  });

  it('names both files for a duplicate tool name', async () => {
    const dir = path.join(fixture('err-dup-tools'), 'tools');
    const error = (await resolveAgentDir(fixture('err-dup-tools')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("duplicate tool name 'same_name'");
    expect(error.message).toContain(path.join(dir, 'one.ts'));
    expect(error.message).toContain(path.join(dir, 'two.ts'));
  });

  it('suggests the right key for unknown config keys', async () => {
    const file = path.join(fixture('err-unknown-key'), 'agent.json');
    const error = (await resolveAgentDir(fixture('err-unknown-key')).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(file);
    expect(error.message).toContain("'modle' (did you mean 'model'?)");
    expect(error.message).toContain("'prompt2'");
    expect(error.message).toContain('Allowed keys:');
  });

  it('requires a description on a sub-agent directory', async () => {
    const dir = path.join(fixture('err-subagent-no-description'), 'subagents', 'helper');
    const error = (await resolveAgentDir(fixture('err-subagent-no-description'), {
      provider: mockModel(['x']),
    }).catch((e: Error) => e)) as Error;
    expect(error.message).toContain(dir);
    expect(error.message).toContain("needs a 'description'");
  });

  it('rejects two config files, double instructions and invalid JSON, each naming the path', async () => {
    await expect(resolveAgentDir(fixture('err-two-configs'))).rejects.toThrow(
      /more than one config file \(agent\.json, agent\.yaml\)/
    );
    await expect(resolveAgentDir(fixture('err-double-instructions'))).rejects.toThrow(
      /instructions are given twice/
    );
    await expect(resolveAgentDir(fixture('err-bad-json'))).rejects.toThrow(
      new RegExp(`${path.join(fixture('err-bad-json'), 'agent.json').replace(/\\/g, '\\\\')}: invalid JSON`)
    );
  });
});

describe('helpers', () => {
  it('explains a missing TypeScript loader with the fix, only for .ts files', () => {
    const cause = Object.assign(new Error('Unknown file extension ".ts"'), {
      code: 'ERR_UNKNOWN_FILE_EXTENSION',
    });
    const ts = explainImportError('/x/tools/a.ts', cause);
    expect(ts.message).toContain('/x/tools/a.ts');
    expect(ts.message).toContain('npx tsx your-script.ts');
    expect(ts.message).toContain('compile');
    expect(explainImportError('/x/tools/a.js', cause).message).toContain('failed to import /x/tools/a.js');
    expect(explainImportError('/x/a.ts', new Error('boom')).message).toContain('failed to import /x/a.ts: boom');
  });

  it('suggests close keys and nothing for distant ones', () => {
    expect(closest('maxStep', ['maxSteps', 'name'])).toBe('maxSteps');
    expect(closest('prompt', ['instructions', 'name'])).toBe('instructions');
    expect(closest('zzzzzzzz', ['maxSteps', 'name'])).toBeUndefined();
  });
});
