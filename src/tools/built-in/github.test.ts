import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubTools, createGitHubTools } from './github';

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
