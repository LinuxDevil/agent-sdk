import { describe, it, expect } from 'vitest';
import { isDefinedTool } from '../../../tools/defineTool';
import type { ToolDescriptor } from '../../../types';
import { resolveToolRef } from './tools';

describe('resolveToolRef { builtin }', () => {
  it('builds a no-option builtin under its model-facing name', async () => {
    const tools = await resolveToolRef({ builtin: 'current_date' }, {}, 'tools.0');
    expect(Object.keys(tools)).toEqual(['current_date']);
    expect(isDefinedTool(tools['current_date'])).toBe(true);
  });

  it('builds every tool a multi-tool builtin stands for', async () => {
    const tools = await resolveToolRef({ builtin: 'todo' }, {}, 'tools.0');
    expect(Object.keys(tools).sort()).toEqual(['todo_read', 'todo_write']);
  });

  it('passes options through to the factory', async () => {
    const tools = await resolveToolRef({ builtin: 'web_fetch', options: { maxChars: 100 } }, {}, 'tools.0');
    expect(Object.keys(tools)).toEqual(['web_fetch']);
    expect(isDefinedTool(tools['web_fetch'])).toBe(true);
  });

  it('stamps approval and deferLoading on every resolved tool', async () => {
    const tools = await resolveToolRef({ builtin: 'web_fetch', approval: 'always', deferLoading: true }, {}, 'tools.0');
    const tool = tools['web_fetch'] as ToolDescriptor | undefined;
    expect(tool?.needsApproval).toBe(true);
    expect(tool?.deferLoading).toBe(true);
    expect(isDefinedTool(tool)).toBe(true);
  });

  it("maps approval 'never' to needsApproval false", async () => {
    const tools = await resolveToolRef({ builtin: 'day_name', approval: 'never' }, {}, 'tools.0');
    expect((tools['day_name'] as ToolDescriptor | undefined)?.needsApproval).toBe(false);
  });
});

describe('resolveToolRef { hosted }', () => {
  it('builds the hosted tool under its name with its options', async () => {
    const tools = await resolveToolRef({ hosted: 'web_search', options: { maxUses: 2 } }, {}, 'tools.0');
    expect(tools).toMatchObject({ web_search: { kind: 'hosted-tool', type: 'web_search', options: { maxUses: 2 } } });
  });
});

describe('resolveToolRef { hub }', () => {
  it('returns no tools when no hub is configured', async () => {
    const saved = process.env.LOUSHO_OBSERVE;
    delete process.env.LOUSHO_OBSERVE;
    try {
      await expect(resolveToolRef({ hub: true }, {}, 'tools.0')).resolves.toEqual({});
    } finally {
      if (saved !== undefined) process.env.LOUSHO_OBSERVE = saved;
    }
  });
});

describe('resolveToolRef unsupported kinds', () => {
  it('rejects file and registry refs (S04b)', async () => {
    await expect(resolveToolRef({ file: 'tools/x.ts' }, {}, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'tools.0',
    });
    await expect(resolveToolRef({ registry: 'r' }, {}, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'tools.0',
    });
  });

  it('rejects integration and openapi refs (S05)', async () => {
    await expect(resolveToolRef({ integration: 'github', credentials: {} }, {}, 'tools.1')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'tools.1',
    });
    await expect(resolveToolRef({ openapi: { url: 'https://x.test/openapi.json' } }, {}, 'tools.1')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'tools.1',
    });
  });
});
