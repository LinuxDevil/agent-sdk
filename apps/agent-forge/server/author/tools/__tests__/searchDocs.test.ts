import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocsIndex, searchDocs } from '../docsIndex';
import { buildAuthorTools, type AuthorToolDeps } from '../index';
import type { AuthorTurn } from '../../turnRunner';
import type { AuthorToolFailure } from '../../../../shared/authorWire';
import type { WorkspaceContext } from '../../../workspace/context';
import { AuthorSessionStore } from '../../sessionStore';

/**
 * searchDocs + the docsIndex it reads: `__fixtures__/docs` holds two
 * small files; the handoffs section of guide.md must outrank everything
 * for "handoff input filter", excerpts must stay inside their bounds,
 * and a missing folder is an UNAVAILABLE tool failure, never a throw.
 */

const fixtureDocs = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'docs');

const TURN: AuthorTurn = {
  sessionId: 'sess-1',
  requestId: 'req-test',
  focus: { mode: 'create' },
  storedTranscript: [],
  userMessage: { id: 'm-1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
  signal: new AbortController().signal,
  stepsRemaining: () => 12,
  state: new Map(),
};

function deps(docsDir: string): AuthorToolDeps {
  return {
    workspace: async () => ({}) as WorkspaceContext,
    catalog: {
      listModels: () => [],
      listTools: () => [],
      listGuardrails: () => [],
      listTriggerTypes: () => [],
      listSkills: async () => [],
      listKits: async () => [],
      listRegistryMcpServers: async () => [],
    },
    templates: { list: async () => [] },
    probeMcp: async () => ({ ok: true, tools: [] }),
    docsDir,
    reviewDraft: async () => ({ pass: true }),
    requirements: async () => [],
    sessions: new AuthorSessionStore('/unused-sessions'),
    secrets: { secretStatus: (name) => ({ name, hasValue: false, masked: null, updatedAt: null }) },
  };
}

describe('loadDocsIndex + searchDocs', () => {
  it('"handoff input filter" returns the handoffs section first', async () => {
    const index = await loadDocsIndex(fixtureDocs);
    expect(index).toBeDefined();
    const hits = searchDocs(index!, 'handoff input filter', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe('Studio Guide › Handoffs and context');
    expect(hits[0].path).toBe('docs/guide.md#handoffs-and-context');
  });

  it('every hit keeps title, path and an excerpt inside its bounds', async () => {
    const index = await loadDocsIndex(fixtureDocs);
    const hits = searchDocs(index!, 'handoff input filter', 5);
    for (const hit of hits) {
      expect(hit.title).toMatch(/^(Studio Guide|Reference)/);
      expect(hit.path).toMatch(/^docs\/[a-z-]+\.md#[a-z0-9-]+$/);
      expect(hit.excerpt.length).toBeLessThanOrEqual(302);
    }
  });

  it('a mid-body hit centres the excerpt ~80 chars before it with both ellipses', async () => {
    const index = await loadDocsIndex(fixtureDocs);
    const hits = searchDocs(index!, 'filter decides', 5);
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0];
    expect(first.excerpt).toMatch(/^…/);
    expect(first.excerpt).toMatch(/…$/);
    expect(first.excerpt).toMatch(/filter\s+decides/);
    expect(first.excerpt.length).toBeLessThanOrEqual(302);
  });

  it('ranks heading hits above body-only hits and drops score 0', async () => {
    const index = await loadDocsIndex(fixtureDocs);
    const hits = searchDocs(index!, 'models', 8);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe('docs/reference.md#models');
    const noMatch = searchDocs(index!, 'zzz-nothing-matches', 5);
    expect(noMatch).toEqual([]);
  });

  it('stop-words and one-letter words are ignored', async () => {
    const index = await loadDocsIndex(fixtureDocs);
    // 'a', 'an', 'the', 'to', 'of', 'in', 'or', 'and' score nothing on their own.
    expect(searchDocs(index!, 'the and of in a an to or', 5)).toEqual([]);
  });
});

/** The call name a ToolDescriptor carries (`defineTool` results), else its display name. */
function nameOf(tool: ReturnType<typeof buildAuthorTools>[number]): string {
  return (tool as { name?: string }).name ?? tool.displayName;
}

describe('searchDocs tool', () => {
  const tool = (): ReturnType<typeof buildAuthorTools>[number] =>
    buildAuthorTools(TURN, deps(fixtureDocs)).find((candidate) => nameOf(candidate) === 'searchDocs')!;

  it('returns { ok, items } capped by limit', async () => {
    const found = tool();
    const result = (await found.execute!({ query: 'list', limit: 1 } as never, { toolCallId: 'c' } as never)) as {
      ok: boolean;
      items: unknown[];
    };
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('a missing docs folder is UNAVAILABLE with user copy, not a throw', async () => {
    const missing = buildAuthorTools(TURN, deps(path.join(fixtureDocs, 'nope'))).find(
      (candidate) => nameOf(candidate) === 'searchDocs'
    )!;
    const result = (await missing.execute!({ query: 'handoff' } as never, { toolCallId: 'c' } as never)) as AuthorToolFailure;
    expect(result).toMatchObject({
      ok: false,
      code: 'UNAVAILABLE',
      error: 'The docs folder is missing from this install.',
      userMessage: "Docs search isn't available here.",
    });
  });
});
