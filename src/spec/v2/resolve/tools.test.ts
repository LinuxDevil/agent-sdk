import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { importModule } from '../../../agentDir/importModule';
import { isDefinedTool } from '../../../tools/defineTool';
import type { ToolDescriptor, ToolExecutionContext } from '../../../types';
import { resolveToolRef } from './tools';

const fixtures = path.join(__dirname, '..', '__fixtures__');
const registryDir = path.join(fixtures, 'registry-agent');

/** The unconfined default export of a fixture tool file (importModule caches by URL, as resolveToolRef does). */
async function fixtureTool(dir: string, rel: string): Promise<unknown> {
  return (await importModule(path.join(dir, rel))).default;
}

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

describe('resolveToolRef { file }', () => {
  it('resolves a tool file under baseDir to its tools', async () => {
    const tools = await resolveToolRef({ file: 'tools/echo.ts' }, { baseDir: fixtures }, 'tools.0');
    expect(Object.keys(tools)).toEqual(['echo']);
    const echo = tools['echo'];
    expect(isDefinedTool(echo)).toBe(true);
    if (!isDefinedTool(echo)) throw new Error('unreachable');
    await expect(echo.execute({ text: 'hi' }, {} as ToolExecutionContext)).resolves.toBe('hi');
  });

  it("stamps approval 'always' as needsApproval on the resolved tools", async () => {
    const tools = await resolveToolRef({ file: 'tools/echo.ts', approval: 'always' }, { baseDir: fixtures }, 'tools.0');
    expect((tools['echo'] as ToolDescriptor | undefined)?.needsApproval).toBe(true);
  });

  it('rejects a file that does not exist', async () => {
    await expect(resolveToolRef({ file: 'tools/missing.ts' }, { baseDir: fixtures }, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'tools.0',
      message: expect.stringContaining('does not exist'),
    });
  });

  it('rejects a file that exports no tool', async () => {
    await expect(resolveToolRef({ file: 'tools/not-a-tool.ts' }, { baseDir: fixtures }, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_AGENT_DIR_INVALID',
    });
  });

  it('confines a file the install receipt covers', async () => {
    const tools = await resolveToolRef({ file: 'tools/echo.ts' }, { baseDir: registryDir }, 'tools.0');
    expect(Object.keys(tools)).toEqual(['echo']);
    expect(tools['echo']).not.toBe(await fixtureTool(registryDir, 'tools/echo.ts'));
  });
});

describe('resolveToolRef { registry }', () => {
  it('resolves a receipt item to its tools, confined to its manifest', async () => {
    const tools = await resolveToolRef({ registry: 'echo-kit' }, { baseDir: registryDir }, 'tools.0');
    expect(Object.keys(tools)).toEqual(['echo']);
    const echo = tools['echo'] as ToolDescriptor;
    expect(echo).not.toBe(await fixtureTool(registryDir, 'tools/echo.ts'));
    await expect(echo.execute?.({ text: 'hi' }, {} as ToolExecutionContext)).resolves.toBe('hi');
  });

  it('rejects a name the receipt does not record', async () => {
    await expect(resolveToolRef({ registry: 'missing-kit' }, { baseDir: registryDir }, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_REGISTRY_ITEM_NOT_FOUND',
      field: 'tools.0',
    });
  });

  it('rejects a name when the folder has no receipt at all', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-tools-'));
    await expect(resolveToolRef({ registry: 'echo-kit' }, { baseDir: dir }, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_REGISTRY_ITEM_NOT_FOUND',
    });
  });

  it('rejects an item whose type is not tool', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-tools-'));
    writeFileSync(
      path.join(dir, 'lousho-registry.json'),
      JSON.stringify({
        v: 1,
        items: {
          'echo-kit': { type: 'skill', registry: 'test', installedAt: '2026-01-01T00:00:00.000Z', permissions: {}, files: [] },
        },
      })
    );
    await expect(resolveToolRef({ registry: 'echo-kit' }, { baseDir: dir }, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      message: expect.stringContaining('is a skill, not a tool'),
    });
  });

  it('rejects a tool item with no files under tools/', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-tools-'));
    writeFileSync(
      path.join(dir, 'lousho-registry.json'),
      JSON.stringify({
        v: 1,
        items: {
          'echo-kit': {
            type: 'tool',
            registry: 'test',
            installedAt: '2026-01-01T00:00:00.000Z',
            permissions: {},
            files: [{ path: 'skills/echo/SKILL.md', sha256: '0' }],
          },
        },
      })
    );
    await expect(resolveToolRef({ registry: 'echo-kit' }, { baseDir: dir }, 'tools.0')).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      message: expect.stringContaining('has no files under tools/'),
    });
  });
});

describe('resolveToolRef unsupported kinds', () => {
  it('rejects file and registry refs without a baseDir', async () => {
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
