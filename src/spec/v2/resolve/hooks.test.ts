import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { hooksFromSpec } from './hooks';

const fixtures = path.join(__dirname, '..', '__fixtures__');

const redact = { id: 'redact', inline: { name: 'Redact PII', point: 'postToolCall', code: 'return ctx;' } } as const;

describe('hooksFromSpec file entries', () => {
  it('loads a hook file under baseDir', async () => {
    const hooks = await hooksFromSpec([{ id: 'h1', file: 'hooks/spy.ts' }], { baseDir: fixtures });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('spy');
    expect(typeof hooks[0].preToolCall).toBe('function');
  });

  it('loads every hook a file default-exports, keeping their names', async () => {
    const hooks = await hooksFromSpec([{ id: 'h1', file: 'hooks/list.ts' }], { baseDir: fixtures });
    expect(hooks.map((hook) => hook.name)).toEqual(['a', 'b']);
  });

  it('rejects a file whose default export is not a hook', async () => {
    await expect(hooksFromSpec([{ id: 'h1', file: 'hooks/bad.ts' }], { baseDir: fixtures })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'hooks.0.file',
      message: expect.stringContaining('the default export must be a hook'),
    });
  });

  it('rejects a file that does not exist', async () => {
    await expect(hooksFromSpec([{ id: 'h1', file: 'hooks/missing.ts' }], { baseDir: fixtures })).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'hooks.0.file',
      message: expect.stringContaining('does not exist'),
    });
  });

  it('rejects a file entry without a baseDir', async () => {
    await expect(hooksFromSpec([{ id: 'h1', file: 'hooks/spy.ts' }], {})).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'hooks.0',
    });
  });
});

describe('hooksFromSpec inline entries', () => {
  it('builds the hook through host.inlineHook and names it by id', async () => {
    const inlineHook = vi.fn(() => ({ name: 'ignored', postToolCall: async () => {} }));
    const hooks = await hooksFromSpec([redact], { inlineHook });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('redact');
    expect(inlineHook).toHaveBeenCalledWith({ id: 'redact', name: 'Redact PII', point: 'postToolCall', code: 'return ctx;' });
  });

  it('skips a disabled inline hook without calling inlineHook', async () => {
    const inlineHook = vi.fn(() => ({ name: 'ignored' }));
    const hooks = await hooksFromSpec([{ id: 'off', inline: { ...redact.inline, enabled: false } }], { inlineHook });
    expect(hooks).toEqual([]);
    expect(inlineHook).not.toHaveBeenCalled();
  });

  it('rejects an inline entry when the host has no hook sandbox', async () => {
    await expect(hooksFromSpec([redact], {})).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'hooks.0',
      message: expect.stringContaining('inline code'),
    });
  });
});

describe('hooksFromSpec across entries', () => {
  it('rejects two hooks with the same name', async () => {
    const inlineHook = vi.fn(() => ({ name: 'ignored' }));
    await expect(
      hooksFromSpec(
        [
          { id: 'x', file: 'hooks/spy.ts' },
          { id: 'spy', inline: { name: 'n', point: 'preGenerate', code: 'c' } },
        ],
        { baseDir: fixtures, inlineHook }
      )
    ).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'hooks',
      message: expect.stringContaining("two hooks are named 'spy'"),
    });
  });
});
