import { describe, it, expect } from 'vitest';
import { keyedItems, skillKey, toolKey } from '../../shared/nodeIds';

/**
 * The stable item keys the canvas (`tool:<key>` node ids in a later
 * ticket) and the SpecChange diff (`tools[<key>]` field names) share:
 * `toolKey`/`skillKey` pick a ref's natural name, `keyedItems` dedupes a
 * keyed list as `x`, `x#2`, `x#3` in list order.
 */
describe('toolKey', () => {
  it('names every ToolRef kind: builtin, registry, hosted, file, integration, openapi, hub', () => {
    expect(toolKey({ builtin: 'web_fetch' })).toBe('web_fetch');
    expect(toolKey({ registry: 'github-issues' })).toBe('github-issues');
    expect(toolKey({ hosted: 'web_search' })).toBe('web_search');
    expect(toolKey({ file: 'tools/fetch-url.ts' })).toBe('fetch-url');
    expect(toolKey({ integration: 'github', credentials: {} })).toBe('github');
    expect(toolKey({ openapi: { url: 'https://api.example.com/openapi.json' } })).toBe(
      'https://api.example.com/openapi.json'
    );
    expect(toolKey({ hub: true })).toBe('hub');
  });

  it('prefers an explicit id over the natural name, strips the file extension', () => {
    expect(toolKey({ id: 'fetcher', builtin: 'web_fetch' })).toBe('fetcher');
    expect(toolKey({ file: 'a/b/my-tool.mts' })).toBe('my-tool');
    expect(toolKey({ file: 'dir\\win-tool.cjs' })).toBe('win-tool');
  });
});

describe('skillKey', () => {
  it('names a skill by inline name, dir basename or registry name', () => {
    expect(skillKey({ inline: { name: 'summarise', description: 'd', content: 'c' } })).toBe('summarise');
    expect(skillKey({ dir: 'skills/changelog' })).toBe('changelog');
    expect(skillKey({ registry: 'changelog' })).toBe('changelog');
  });
});

describe('keyedItems', () => {
  it('dedupes repeated keys as x, x#2, x#3 in list order', () => {
    const items = [{ k: 'x' }, { k: 'x' }, { k: 'y' }, { k: 'x' }];
    expect(keyedItems(items, (item) => item.k).map(({ key }) => key)).toEqual(['x', 'x#2', 'y', 'x#3']);
  });
});
