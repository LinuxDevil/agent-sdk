import { describe, expect, it } from 'vitest';
import { SDKError, ValidationError } from '../../execution/errors';
import { defineMemory, type MemorySlot } from '../../memory/defineMemory';
import { inMemoryMemory } from '../../memory/providers';
import { readFixtureTree } from '../__fixtures__/readTree';
import { memorySource } from '../source/memorySource';
import { loadWorkspace, type LoadedWorkspace } from './loadWorkspace';
import { createSharedContextRun, resolveSharedContext } from './sharedContext';

const makeSlot = (file: { name: string }): MemorySlot => defineMemory({ name: file.name, scope: 'global', provider: inMemoryMemory() });
const skill = (name: string) => `---\nname: ${name}\ndescription: Use ${name}\n---\nBody of ${name}\n`;

function workspaceOf(files: Record<string, string>, mainAgent: unknown = null): LoadedWorkspace {
  const tree = { 'workspace.json': JSON.stringify({ id: 'demo', mainAgent }), ...files };
  const pages = { one: { files: [], inherits: { shared: [], profiles: [] }, attachments: [] }, two: { files: [], inherits: { shared: [], profiles: [] }, attachments: [] } };
  return { revision: 'r1', manifest: { id: 'demo', name: 'Demo', inheritsShared: (mainAgent as { inheritsShared?: boolean } | null)?.inheritsShared === true, pages }, tree, problems: [] };
}

describe('resolveSharedContext', () => {
  it('instructions are ordered by file name', () => {
    const workspace = workspaceOf({
      'shared/instructions/b-second.md': 'second',
      'shared/instructions/a-first.md': 'first',
      'shared/instructions/10-tenth.md': 'tenth',
      'shared/instructions/notes.txt': 'ignored',
    });
    const context = resolveSharedContext(workspace);
    expect(context.instructions.map((item) => item.file)).toEqual(['shared/instructions/10-tenth.md', 'shared/instructions/a-first.md', 'shared/instructions/b-second.md']);
    expect(context.instructions.map((item) => item.text)).toEqual(['tenth', 'first', 'second']);
  });

  it('a skill clash is an error naming both files', () => {
    const workspace = workspaceOf({
      'shared/skills/alpha/SKILL.md': skill('same'),
      'shared/skills/beta/SKILL.md': skill('same'),
    });
    let caught: unknown;
    try {
      resolveSharedContext(workspace);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SDKError);
    expect((caught as SDKError).code).toBe('LOUSHO_SKILL_INVALID');
    expect((caught as Error).message).toContain('shared/skills/alpha/SKILL.md');
    expect((caught as Error).message).toContain('shared/skills/beta/SKILL.md');
    expect(() => resolveSharedContext(workspace, { override: true })).toThrow(/alpha[\s\S]*beta/);
  });

  it('a skill clashes with a skill passed in, and the passed skill wins with override', () => {
    const workspace = workspaceOf({ 'shared/skills/alpha/SKILL.md': skill('same') });
    const own = { file: 'agents/a/skills/same/SKILL.md', skill: { name: 'same', description: 'mine', content: 'mine' } };
    expect(() => resolveSharedContext(workspace, { skills: [own] })).toThrow(/agents\/a\/skills\/same\/SKILL\.md/);
    expect(resolveSharedContext(workspace, { skills: [own], override: true }).skills).toEqual([own]);
    expect(resolveSharedContext(workspace, { skills: [{ ...own, skill: { ...own.skill, name: 'other' } }] }).skills.map((item) => item.skill.name)).toEqual(['same', 'other']);
  });

  it('two pages see the same shared memory instance', () => {
    const workspace = workspaceOf({ 'shared/memory/notes.ts': 'export default {}' });
    const run = createSharedContextRun();
    const one = resolveSharedContext(workspace, { run, createMemory: makeSlot, audience: { page: 'one' } });
    const two = resolveSharedContext(workspace, { run, createMemory: makeSlot, audience: { page: 'two' } });
    expect(one.memorySlots[0]?.name).toBe('notes');
    expect(one.memorySlots[0]?.slot).toBeDefined();
    expect(one.memorySlots[0]?.slot).toBe(two.memorySlots[0]?.slot);
    const otherRun = resolveSharedContext(workspace, { run: createSharedContextRun(), createMemory: makeSlot });
    expect(otherRun.memorySlots[0]?.slot).not.toBe(one.memorySlots[0]?.slot);
  });

  it('shared memory files need createMemory and a run', () => {
    const workspace = workspaceOf({ 'shared/memory/notes.ts': 'export default {}' });
    let caught: unknown;
    try {
      resolveSharedContext(workspace, { run: createSharedContextRun() });
    } catch (error) {
      caught = error;
    }
    expect((caught as SDKError).code).toBe('LOUSHO_MEMORY_INVALID');
    expect((caught as Error).message).toContain('shared/memory/notes.ts');
    expect(() => resolveSharedContext(workspace, { createMemory: makeSlot })).toThrow(ValidationError);
    expect(resolveSharedContext(workspaceOf({}), {}).memorySlots).toEqual([]);
  });

  it('memory slots are named by file stem in file order', () => {
    const workspace = workspaceOf({ 'shared/memory/zeta.ts': 'x', 'shared/memory/alpha.ts': 'x', 'shared/memory/readme.md': 'x' });
    const made: string[] = [];
    const context = resolveSharedContext(workspace, {
      run: createSharedContextRun(),
      createMemory: (file) => {
        made.push(file.file);
        return makeSlot(file);
      },
    });
    expect(context.memorySlots.map((item) => item.name)).toEqual(['alpha', 'zeta']);
    expect(made).toEqual(['shared/memory/alpha.ts', 'shared/memory/zeta.ts']);
  });

  it('the main agent gets shared instructions only with inheritsShared', () => {
    const files = { 'shared/instructions/a.md': 'shared voice', 'shared/knowledge/k.md': 'k' };
    const without = workspaceOf(files, { dir: './main-agent' });
    const withShared = workspaceOf(files, { dir: './main-agent', inheritsShared: true });
    const none = workspaceOf(files, null);
    expect(resolveSharedContext(without, { audience: 'main-agent' }).instructions).toEqual([]);
    expect(resolveSharedContext(without, { audience: 'main-agent' }).resources).toEqual([]);
    expect(resolveSharedContext(none, { audience: 'main-agent' }).instructions).toEqual([]);
    expect(resolveSharedContext(withShared, { audience: 'main-agent' }).instructions.map((item) => item.text)).toEqual(['shared voice']);
    expect(resolveSharedContext(without, { audience: { page: 'one' } }).instructions.map((item) => item.text)).toEqual(['shared voice']);
  });

  it('shared resources are read-only handles capped by maxResourceBytes', () => {
    const workspace = workspaceOf({ 'shared/knowledge/small.md': 'tiny', 'shared/brand/big.md': 'x'.repeat(40), 'shared/resources/data.json': '{"a":1}' });
    const context = resolveSharedContext(workspace, { maxResourceBytes: 16 });
    const byRef = Object.fromEntries(context.resources.map((item) => [item.ref, item]));
    expect(Object.keys(byRef)).toEqual(['shared:brand/big.md', 'shared:knowledge/small.md', 'shared:resources/data.json']);
    expect(byRef['shared:knowledge/small.md']).toMatchObject({ inlined: true, text: 'tiny', bytes: 4 });
    expect(byRef['shared:brand/big.md']).toMatchObject({ inlined: false, bytes: 40 });
    expect(byRef['shared:brand/big.md']?.text).toBeUndefined();
    expect(Object.isFrozen(byRef['shared:knowledge/small.md'])).toBe(true);
    expect(resolveSharedContext(workspace).resources.every((item) => item.inlined)).toBe(true);
    expect(() => resolveSharedContext(workspace, { maxResourceBytes: -1 })).toThrow(ValidationError);
  });

  it('parsed JSON resources are inlined as their text', () => {
    const workspace = workspaceOf({});
    const tree = { ...workspace.tree, 'shared/brand/palette.json': { primary: '#fff' } };
    const [item] = resolveSharedContext({ ...workspace, tree }).resources;
    expect(item?.text).toBe('{\n  "primary": "#fff"\n}\n');
  });

  it('an unknown page is a validation error', () => {
    expect(() => resolveSharedContext(workspaceOf({}), { audience: { page: 'nope' } })).toThrow(ValidationError);
  });

  it('resolves the Marketing fixture', async () => {
    const files = Object.fromEntries(Object.entries(readFixtureTree('marketing')).map(([path, value]) => [path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`]));
    const loaded = await loadWorkspace(memorySource(files), { mode: 'default' });
    const context = resolveSharedContext(loaded, { audience: { page: 'instagram-videos' } });
    expect(context.instructions.map((item) => item.file)).toEqual(['shared/instructions/00-brand-voice.md']);
    expect(context.resources.map((item) => item.ref)).toEqual(['shared:brand/palette.json']);
  });
});
