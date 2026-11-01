import { describe, it, expect } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { diffSpecs } from '../specChange';
import type { SpecSnapshot } from '../../../shared/wireTypes';

/**
 * `diffSpecs` - the `SpecChange[]` the version diff route, draft cards and
 * Author proposal cards render: one entry per changed plain field, per-item
 * entries for keyed lists (`tools[web-fetch]`), and a unified line diff for
 * instructions.
 */
function snapshot(spec: Record<string, unknown>, labels: string[] = []): SpecSnapshot {
  return {
    spec: { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run.', ...spec } as AgentSpecV2,
    labels,
  };
}

describe('diffSpecs', () => {
  it('returns [] for identical snapshots and for equivalent empties (undefined vs [])', () => {
    const snap = snapshot({ description: 'Triage.', tools: [{ builtin: 'http' }] }, ['ops']);
    expect(diffSpecs(snap, { spec: { ...snap.spec }, labels: [...snap.labels] })).toEqual([]);

    const without = snapshot({ description: undefined, tools: [] });
    const withEmpty = snapshot({ description: [] });
    expect(diffSpecs(without, withEmpty)).toEqual([]);
    expect(diffSpecs(withEmpty, without)).toEqual([]);
  });

  it('reports an added tool as one add: tools[web-fetch], "Tool: web-fetch", section Tools', () => {
    const before = snapshot({ tools: [] });
    const after = snapshot({ tools: [{ builtin: 'web-fetch' }] });
    expect(diffSpecs(before, after)).toEqual([
      {
        field: 'tools[web-fetch]',
        label: 'Tool: web-fetch',
        section: 'Tools',
        op: 'add',
        after: { builtin: 'web-fetch' },
      },
    ]);
  });

  it('keys two identical builtin refs as http and http#2', () => {
    const before = snapshot({ tools: [{ builtin: 'http' }] });
    const after = snapshot({ tools: [{ builtin: 'http' }, { builtin: 'http' }] });
    expect(diffSpecs(before, after)).toEqual([
      {
        field: 'tools[http#2]',
        label: 'Tool: http#2',
        section: 'Tools',
        op: 'add',
        after: { builtin: 'http' },
      },
    ]);
  });

  it('reports an edit on the one guardrail that changed and nothing for untouched ones', () => {
    const guardrails = [
      { id: 'g1', name: 'pii' },
      { id: 'g2', name: 'regex' },
    ];
    const before = snapshot({ guardrails });
    const after = snapshot({ guardrails: [guardrails[0], { ...guardrails[1], options: { action: 'block' } }] });
    expect(diffSpecs(before, after)).toEqual([
      {
        field: 'guardrails[g2]',
        label: 'Guardrail: g2',
        section: 'Safety',
        op: 'edit',
        before: guardrails[1],
        after: after.spec.guardrails![1],
      },
    ]);
  });

  it('reports a renamed MCP server key as one remove plus one add', () => {
    const server = { transport: 'stdio', command: 'run' };
    const before = snapshot({ mcpServers: { github: server } });
    const after = snapshot({ mcpServers: { github2: server } });
    expect(diffSpecs(before, after)).toEqual([
      {
        field: 'mcpServers[github2]',
        label: 'MCP server: github2',
        section: 'Tools',
        op: 'add',
        after: server,
      },
      {
        field: 'mcpServers[github]',
        label: 'MCP server: github',
        section: 'Tools',
        op: 'remove',
        before: server,
      },
    ]);
  });

  it('emits items in after-order, then removed items in before-order', () => {
    const before = snapshot({ tools: [{ builtin: 'a' }, { builtin: 'b' }, { builtin: 'c' }] });
    const after = snapshot({ tools: [{ builtin: 'c' }, { builtin: 'd' }] });
    const changes = diffSpecs(before, after);
    // 'c' moved but is unchanged per-item (keyed diff ignores list order of items themselves)...
    expect(changes.map((c) => `${c.op}:${c.field}`)).toEqual(['add:tools[d]', 'remove:tools[a]', 'remove:tools[b]']);
  });

  it('line-diffs a mid-file instructions change: gap, context, del, add, context, gap', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const before = snapshot({ instructions: lines.join('\n') });
    const afterLines = [...lines];
    afterLines[19] = 'line 20 changed';
    const after = snapshot({ instructions: afterLines.join('\n') });

    const changes = diffSpecs(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: 'instructions', label: 'Instructions', section: 'Instructions', op: 'edit' });
    expect(changes[0].lines).toEqual([
      { kind: 'gap', count: 16 },
      { kind: 'context', text: 'line 17' },
      { kind: 'context', text: 'line 18' },
      { kind: 'context', text: 'line 19' },
      { kind: 'del', text: 'line 20' },
      { kind: 'add', text: 'line 20 changed' },
      { kind: 'context', text: 'line 21' },
      { kind: 'context', text: 'line 22' },
      { kind: 'context', text: 'line 23' },
      { kind: 'gap', count: 17 },
    ]);
  });

  it('treats instructions string -> { file } as a plain edit with no lines', () => {
    const before = snapshot({ instructions: 'Run.' });
    const after = snapshot({ instructions: { file: 'prompts/run.md' } });
    const changes = diffSpecs(before, after);
    expect(changes).toEqual([
      {
        field: 'instructions',
        label: 'Instructions',
        section: 'Instructions',
        op: 'edit',
        before: 'Run.',
        after: { file: 'prompts/run.md' },
      },
    ]);
  });

  it('reports every present field as an add when there is no before snapshot', () => {
    const after = snapshot({ description: 'Triage.', tools: [{ builtin: 'web-fetch' }, { builtin: 'http' }] }, ['ops']);
    const changes = diffSpecs(undefined, after);
    expect(changes).toEqual([
      { field: 'name', label: 'Name', section: 'Identity', op: 'add', after: 'ops' },
      { field: 'description', label: 'Description', section: 'Identity', op: 'add', after: 'Triage.' },
      { field: 'model', label: 'Model', section: 'Model', op: 'add', after: 'mock/mock-1' },
      {
        field: 'instructions',
        label: 'Instructions',
        section: 'Instructions',
        op: 'add',
        after: 'Run.',
      },
      {
        field: 'tools[web-fetch]',
        label: 'Tool: web-fetch',
        section: 'Tools',
        op: 'add',
        after: { builtin: 'web-fetch' },
      },
      { field: 'tools[http]', label: 'Tool: http', section: 'Tools', op: 'add', after: { builtin: 'http' } },
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'add', after: ['ops'] },
    ]);
  });

  it('orders changes by SPEC_FIELD_ORDER (name before model before labels, not alphabetical)', () => {
    const before = snapshot({}, []);
    const after = snapshot({ name: 'renamed', model: 'mock/mock-2' }, ['ops']);
    expect(diffSpecs(before, after).map((c) => c.field)).toEqual(['name', 'model', 'labels']);
  });

  it('diffs labels as a plain field: add, remove and edit', () => {
    expect(diffSpecs(snapshot({}, []), snapshot({}, ['ops']))).toEqual([
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'add', after: ['ops'] },
    ]);
    expect(diffSpecs(snapshot({}, ['ops']), snapshot({}, []))).toEqual([
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'remove', before: ['ops'] },
    ]);
    expect(diffSpecs(snapshot({}, ['ops']), snapshot({}, ['ops', 'nightly']))).toEqual([
      { field: 'labels', label: 'Labels', section: 'Identity', op: 'edit', before: ['ops'], after: ['ops', 'nightly'] },
    ]);
  });

  it('reports a removed field as one remove and a new plain field as one add', () => {
    const before = snapshot({ description: 'Triage.', promptRef: 'p@1' });
    const after = snapshot({});
    expect(diffSpecs(before, after)).toEqual([
      { field: 'description', label: 'Description', section: 'Identity', op: 'remove', before: 'Triage.' },
      { field: 'promptRef', label: 'Prompt reference', section: 'Instructions', op: 'remove', before: 'p@1' },
    ]);
    expect(diffSpecs(snapshot({}), snapshot({ permissionMode: 'strict' }))).toEqual([
      {
        field: 'permissionMode',
        label: 'Permission mode',
        section: 'Safety',
        op: 'add',
        after: 'strict',
      },
    ]);
  });
});
