import { describe, it, expect } from 'vitest';
import { AGENT_OWNED, PAGE_OWNED, attachmentsSchema, parseAgentRef } from './agentRefs';

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = attachmentsSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path as (string | number)[], message: issue.message }));
}

const attachments = {
  schema: 'lousho.agents/1',
  agents: [
    { as: 'script', ref: 'workspace:script-writer', role: 'Writes the caption script.', model: 'anthropic/claude-sonnet-5-5', limits: { maxDurationMs: 60000, maxTurns: 8, maxCostUsd: 0.5 }, tools: { only: ['web_search'] } },
    { as: 'editor', ref: 'global:copy-editor@^1.2.0' },
    { as: 'hook', ref: 'local:hook-writer' },
  ],
};

describe('parseAgentRef', () => {
  it('the three ref forms parse; a bare name is an error', () => {
    expect(parseAgentRef('workspace:script-writer')).toEqual({ ok: true, ref: { kind: 'workspace', name: 'script-writer' } });
    expect(parseAgentRef('local:hook-writer')).toEqual({ ok: true, ref: { kind: 'local', name: 'hook-writer' } });
    expect(parseAgentRef('global:copy-editor@^1.2.0')).toEqual({ ok: true, ref: { kind: 'global', name: 'copy-editor', range: '^1.2.0' } });
    const bare = parseAgentRef('script-writer');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain('workspace:');
    expect(parseAgentRef('').ok).toBe(false);
    expect(parseAgentRef('other:script-writer').ok).toBe(false);
    expect(parseAgentRef('workspace:Script_Writer').ok).toBe(false);
    expect(parseAgentRef('workspace:a/b').ok).toBe(false);
    expect(parseAgentRef('workspace:a@1.0.0').ok).toBe(false);
    expect(parseAgentRef('local:a@1.0.0').ok).toBe(false);
  });

  it('the global ref requires a semver range', () => {
    for (const ref of ['global:copy-editor', 'global:copy-editor@', 'global:copy-editor@latest', 'global:copy-editor@1.2', 'global:copy-editor@>=1.0.0']) {
      const result = parseAgentRef(ref);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('range');
    }
    expect(parseAgentRef('global:copy-editor@1.2.3').ok).toBe(true);
    expect(parseAgentRef('global:copy-editor@~1.2.3').ok).toBe(true);
    expect(parseAgentRef('global:fact-checker@^1')).toEqual({ ok: true, ref: { kind: 'global', name: 'fact-checker', range: '^1' } });
    expect(parseAgentRef('global:fact-checker@~1.2').ok).toBe(true);
  });
});

describe('attachmentsSchema', () => {
  it('accepts a full attachments file', () => {
    const result = attachmentsSchema.safeParse(attachments);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(attachments);
  });

  it('rejects a malformed ref with its path', () => {
    const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'bare' }] });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['agents', 0, 'ref']);
  });

  it('duplicate alias is an error', () => {
    const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x' }, { as: 'b', ref: 'workspace:y' }, { as: 'a', ref: 'local:z' }] });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['agents', 2, 'as']);
    expect(issues[0].message).toContain("duplicate alias 'a'");
  });

  it('two invalid attachments report no duplicate alias', () => {
    const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'bare' }, { as: 'b', ref: 'bare' }] });
    expect(issues.map((issue) => issue.path)).toEqual([['agents', 0, 'ref'], ['agents', 1, 'ref']]);
    expect(issues.some((issue) => issue.message.includes('duplicate alias'))).toBe(false);
  });

  it('keeps the original issue code for an unknown key', () => {
    const result = attachmentsSchema.safeParse({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', temperature: 1 }] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  });

  it('tools.only narrows; tools.add is rejected with R13', () => {
    expect(issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', tools: { only: ['read_file'] } }] })).toEqual([]);
    const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', tools: { add: ['shell'] } }] });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['agents', 0, 'tools', 'add']);
    expect(issues[0].message).toContain('R13');
    expect(issues[0].message).toContain('live in the agent');
  });

  it('a forbidden key does not hide the attachments other errors', () => {
    const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'bare', model: 'nope', permissions: {} }] });
    expect(issues.map((issue) => issue.path).sort()).toEqual([['agents', 0, 'model'], ['agents', 0, 'permissions'], ['agents', 0, 'ref']]);
    expect(issues.find((issue) => issue.path[2] === 'permissions')?.message).toContain('R13');
  });

  it('case, whitespace and separator variants of a forbidden key get R13', () => {
    const variants: [string, unknown][] = [
      ['Permissions', { Permissions: {} }],
      [' secrets', { ' secrets': {} }],
      ['tools.Add', { tools: { Add: ['shell'] } }],
    ];
    for (const [name, extra] of variants) {
      const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', ...(extra as object) }] });
      expect(issues, name).toHaveLength(1);
      expect(issues[0].message).toContain('R13');
    }
  });

  it('rejects permissions, secrets and instructions with R13', () => {
    for (const key of ['permissions', 'secrets', 'instructions']) {
      const issues = issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', [key]: {} }] });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toEqual(['agents', 0, key]);
      expect(issues[0].message).toContain('R13');
    }
  });

  it('rejects other unknown keys, a bad alias, a bad model and non-positive limits', () => {
    expect(issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', temperature: 1 }] })).toHaveLength(1);
    expect(issuesOf({ ...attachments, agents: [{ as: 'Bad Alias', ref: 'workspace:x' }] })[0].path).toEqual(['agents', 0, 'as']);
    expect(issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', model: 'sonnet' }] })[0].path).toEqual(['agents', 0, 'model']);
    expect(issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', limits: { maxTurns: 0 } }] })[0].path).toEqual(['agents', 0, 'limits', 'maxTurns']);
    expect(issuesOf({ ...attachments, schema: 'lousho.agents/2' })[0].path).toEqual(['schema']);
    expect(issuesOf({ schema: 'lousho.agents/1' })[0].path).toEqual(['agents']);
    expect(issuesOf({ ...attachments, agents: ['workspace:x'] })[0].path).toEqual(['agents', 0]);
    expect(issuesOf({ ...attachments, agents: [{ as: 'a', ref: 'workspace:x', tools: null }] })[0].path).toEqual(['agents', 0, 'tools']);
  });
});

describe('AGENT_OWNED and PAGE_OWNED', () => {
  it('are disjoint', () => {
    const page = new Set<string>(PAGE_OWNED);
    expect(AGENT_OWNED.filter((field) => page.has(field))).toEqual([]);
  });

  it('list the documented fields', () => {
    expect([...AGENT_OWNED]).toEqual(['instructions', 'skills', 'tools', 'memory', 'default model']);
    expect([...PAGE_OWNED]).toEqual(['as', 'role', 'model', 'limits', 'tools.only', 'harness']);
  });
});
