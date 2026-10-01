import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubTools, createGitHubTools } from './github';
import { NoopSandbox } from '../../security/sandboxCore';
import type { SandboxAdapter } from '../../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../../execution/sandboxGuard';

describe('GitHubTools scope enforcement (LOU-E14)', () => {
  let githubTools: GitHubTools;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    githubTools = createGitHubTools({
      token: 'test-token',
      owner: 'test-owner',
      repo: 'test-repo',
    });
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const outOfScopeTools = [
    'github_create_branch',
    'github_delete_branch',
    'github_create_or_update_file',
    'github_delete_file',
    'github_search_code',
    'github_list_issues',
    'github_get_issue',
    'github_create_issue',
    'github_update_issue',
    'github_close_issue',
    'github_add_issue_comment',
    // LOU-E fix: merging a PR needs "Contents: Read and write", which a
    // PR-creation/reading-scoped token doesn't have.
    'github_merge_pull_request',
  ];

  it.each(outOfScopeTools)('%s throws before making any HTTP request', async (toolName) => {
    const descriptor = githubTools.get(toolName);
    expect(descriptor).toBeDefined();
    expect(descriptor?.tool.execute).toBeDefined();

    await expect(descriptor!.tool.execute!({}, {} as any)).rejects.toThrow(/out of scope/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('there is no repo-delete (or any repo-deletion) tool present on the registry at all', () => {
    const allNames = githubTools.list();
    const deletionLike = allNames.filter(
      (name) => name.includes('delete') && !name.includes('branch') && !name.includes('file')
    );
    expect(deletionLike).toEqual([]);
    expect(githubTools.has('github_delete_repository')).toBe(false);
    expect(githubTools.has('github_repo_delete')).toBe(false);
  });

  it('in-scope PR-creation tool (github_create_pull_request) still makes its HTTP request normally', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ number: 1, html_url: 'https://github.com/test-owner/test-repo/pull/1', state: 'open' }),
    });

    const descriptor = githubTools.get('github_create_pull_request');
    expect(descriptor).toBeDefined();

    const result = await descriptor!.tool.execute!(
      { title: 'My PR', body: 'body', head: 'feature', base: 'main' },
      {} as any
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result as string);
    expect(parsed.number).toBe(1);
  });

  it('in-scope PR-reading tool (github_get_pull_request) still makes its HTTP request normally', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 5,
        title: 'title',
        body: 'body',
        state: 'open',
        html_url: 'https://github.com/test-owner/test-repo/pull/5',
        head: { ref: 'feature' },
        base: { ref: 'main' },
      }),
    });

    const descriptor = githubTools.get('github_get_pull_request');
    const result = await descriptor!.tool.execute!({ prNumber: 5 }, {} as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result as string);
    expect(parsed.number).toBe(5);
  });

  it('every registered tool remains present (out-of-scope tools are disabled, not removed)', () => {
    const allNames = githubTools.list();
    expect(allNames.length).toBeGreaterThan(0);
    for (const outOfScope of outOfScopeTools) {
      expect(allNames).toContain(outOfScope);
    }
  });
});

describe('GitHubTools sandbox seam (LOU-K2)', () => {
  let githubTools: GitHubTools;

  beforeEach(() => {
    githubTools = createGitHubTools({
      token: 'test-token',
      owner: 'test-owner',
      repo: 'test-repo',
    });
  });

  it('flags requiresSandbox on an in-scope (real-fetching) tool, and leaves execute() untouched', async () => {
    const descriptor = githubTools.get('github_get_pull_request');
    expect(descriptor?.requiresSandbox).toBe(true);
    expect(typeof descriptor?.sandboxExecute).toBe('function');

    // execute() itself is still real and directly callable (unsandboxed
    // callers like examples/ops-pipeline's guardedPr.ts rely on this).
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 5,
        title: 't',
        body: 'b',
        state: 'open',
        html_url: 'https://github.com/test-owner/test-repo/pull/5',
        head: { ref: 'feature' },
        base: { ref: 'main' },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await descriptor!.tool.execute!({ prNumber: 5 }, {} as any);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result as string).number).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not flag requiresSandbox on an out-of-scope tool (it never reaches the network)', () => {
    const descriptor = githubTools.get('github_create_branch');
    expect(descriptor?.requiresSandbox).toBeUndefined();
  });

  it('(b) a custom SandboxAdapter actually gets invoked for the outbound GitHub API call', async () => {
    const runSpy = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('node');
      expect(args[0]).toBe('-e');
      return {
        stdout: JSON.stringify({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            number: 7,
            title: 'sandboxed',
            body: 'b',
            state: 'open',
            html_url: 'https://github.com/test-owner/test-repo/pull/7',
            head: { ref: 'feature' },
            base: { ref: 'main' },
          }),
        }),
        stderr: '',
        exitCode: 0,
      };
    });
    const customSandbox: SandboxAdapter = { name: 'custom-test-sandbox', run: runSpy, writeFile: vi.fn() };

    const descriptor = githubTools.get('github_get_pull_request')!;
    const result = await executeToolWithSandboxGuard('github_get_pull_request', descriptor, { prNumber: 7 }, customSandbox);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result as string).number).toBe(7);
  });

  it('(c) fails closed when requiresSandbox is true but sandboxExecute is missing', async () => {
    const descriptor = githubTools.get('github_get_pull_request')!;
    const broken = { ...descriptor, sandboxExecute: undefined };

    await expect(
      executeToolWithSandboxGuard('github_get_pull_request', broken, { prNumber: 1 }, NoopSandbox)
    ).rejects.toThrow(/requiresSandbox but does not implement sandboxExecute/);
  });
});

describe('GitHubTools github_update_pull_request execute()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const run = (args: Record<string, unknown>) =>
    createGitHubTools({ token: 'test-token', owner: 'test-owner', repo: 'test-repo' })
      .get('github_update_pull_request')!
      .tool.execute!(args as any, {} as any);

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PATCHes title, body and state and returns number/state/url', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ number: 12, state: 'closed', html_url: 'https://github.com/test-owner/test-repo/pull/12', other: 1 }),
    });

    const result = await run({ prNumber: 12, title: 'T', body: 'B', state: 'closed' });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/test-owner/test-repo/pulls/12');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({ title: 'T', body: 'B', state: 'closed' });
    expect(JSON.parse(result as string)).toEqual({
      number: 12,
      state: 'closed',
      url: 'https://github.com/test-owner/test-repo/pull/12',
    });
  });

  it.each([
    ['title', { title: 'Only' }],
    ['body', { body: 'Only' }],
    ['state', { state: 'open' }],
  ])('sends only %s when it is the sole field', async (_name, args) => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ number: 1, state: 'open', html_url: 'u' }) });

    await run({ prNumber: 1, ...args });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual(args);
  });

  it('throws before any request when no fields are provided', async () => {
    await expect(run({ prNumber: 1 })).rejects.toThrow('At least one field must be provided to update');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on a non-OK response', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Unprocessable Entity', text: async () => 'bad state' });

    await expect(run({ prNumber: 1, title: 'x' })).rejects.toThrow(
      'Failed to update PR: Unprocessable Entity - bad state'
    );
  });
});

describe('GitHubTools github_update_issue real implementation', () => {
  // github_update_issue is in OUT_OF_SCOPE_TOOLS, so the registry replaces its
  // execute() with a thrower and the real implementation is unreachable through
  // the public API. To still test that implementation, temporarily remove the
  // name from the (private static) scope set while constructing the registry,
  // then restore it so no other test is affected.
  let fetchSpy: ReturnType<typeof vi.fn>;
  let issueTool: { execute?: (args: any, ctx: any) => unknown };

  beforeEach(() => {
    const scopeSet = (GitHubTools as any).OUT_OF_SCOPE_TOOLS as Set<string>;
    scopeSet.delete('github_update_issue');
    try {
      issueTool = createGitHubTools({ token: 'test-token', owner: 'test-owner', repo: 'test-repo' }).get(
        'github_update_issue'
      )!.tool as any;
    } finally {
      scopeSet.add('github_update_issue');
    }
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (args: Record<string, unknown>) => issueTool.execute!(args, {} as any);

  it('keeps the public registry gated (scope set restored)', async () => {
    const gated = createGitHubTools({ token: 't', owner: 'o', repo: 'r' }).get('github_update_issue')!;
    await expect(gated.tool.execute!({ issueNumber: 1, title: 'x' } as any, {} as any)).rejects.toThrow(/out of scope/i);
  });

  it('PATCHes title, body, state and labels and returns success', async () => {
    fetchSpy.mockResolvedValue({ ok: true });

    const result = await run({ issueNumber: 3, title: 'T', body: 'B', state: 'closed', labels: ['bug'] });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/test-owner/test-repo/issues/3');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({ title: 'T', body: 'B', state: 'closed', labels: ['bug'] });
    expect(JSON.parse(result as string)).toEqual({ success: true, issueNumber: 3 });
  });

  it.each([
    ['title', { title: 'Only' }],
    ['body', { body: 'Only' }],
    ['state', { state: 'open' }],
    ['labels (empty array clears them)', { labels: [] }],
  ])('sends only %s when it is the sole field', async (_name, args) => {
    fetchSpy.mockResolvedValue({ ok: true });

    await run({ issueNumber: 4, ...args });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual(args);
  });

  it('throws before any request when no fields are provided', async () => {
    await expect(run({ issueNumber: 5 })).rejects.toThrow('At least one field must be provided to update');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on a non-OK response', async () => {
    fetchSpy.mockResolvedValue({ ok: false, statusText: 'Forbidden', text: async () => 'nope' });

    await expect(run({ issueNumber: 5, title: 'x' })).rejects.toThrow('Failed to update issue: Forbidden - nope');
  });
});
