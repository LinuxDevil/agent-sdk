/**
 * GitHub Integration Tools
 *
 * Provides a comprehensive set of tools for interacting with GitHub API.
 * These tools can be used directly in agents without reimplementation.
 *
 * @example
 * ```typescript
 * const githubTools = new GitHubTools({
 *   token: process.env.GITHUB_TOKEN,
 *   owner: 'myorg',
 *   repo: 'myrepo'
 * });
 *
 * const agent = new AgentBuilder()
 *   .withTools(githubTools)
 *   .build();
 * ```
 *
 * ## Required token scope (LOU-E14)
 *
 * The `config.token` this class is constructed with is expected to be
 * scoped to **PR creation and reading only**. Concretely, a fine-grained
 * GitHub Personal Access Token (or GitHub App installation token) needs
 * only:
 *   - **Pull requests: Read and write** - covers every `pulls/*` and
 *     `pulls/*\/files` endpoint this file calls EXCEPT merging (see
 *     below): list/get/create/update/close a PR, and reading a PR's
 *     changed files.
 *   - **Issues: Read and write** - GitHub's REST API backs PR
 *     conversation comments with the *issues* endpoints
 *     (`issues/{number}/comments`), so posting/reading a PR comment
 *     needs this even though it's conceptually a "PR" operation.
 *   - **Contents: Read-only** - covers `repos/{owner}/{repo}`,
 *     `branches`, `commits`, and `compare`, all of which this file only
 *     ever reads (never writes) in service of PR creation (e.g.
 *     resolving the repository's default branch, or a PR's changed
 *     commits).
 *
 * Endpoints this file calls that fall **outside** that scope - creating
 * or deleting a branch or a file (needs `Contents: Read and write`),
 * searching code, every issue-CRUD endpoint that isn't a PR comment
 * (needs `Issues: Read and write` used for something other than PR
 * comments), and **merging a PR** (LOU-E fix: `PUT pulls/{number}/merge`
 * requires GitHub's `Contents: Read and write` permission, NOT just
 * `Pull requests: write` - merging writes a merge commit to the base
 * branch's tree, which is a repository-content mutation, not a
 * PR-metadata one. A PR-creation/reading-scoped token as documented above
 * genuinely cannot perform it, so it's treated the same as the other
 * out-of-scope, higher-privilege operations below rather than as a PR
 * operation this class supports) - are NOT reachable with a
 * PR-creation/reading-scoped token and are deliberately gated below (see
 * `OUT_OF_SCOPE_TOOLS`): calling one of their tools throws before any
 * HTTP request is made, rather than failing at GitHub with an opaque 403.
 * This SDK never grants `Administration` or repository-deletion scopes to
 * this class at all - there is no code path here that could delete a
 * repository.
 */

import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';

// ============================================================================
// Type Definitions
// ============================================================================

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
}

export interface GitHubFile {
  path: string;
  content: string;
  size: number;
  sha: string;
  type: 'file' | 'dir';
}

export interface GitHubSearchResult {
  totalCount: number;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    url: string;
  }>;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  head: string;
  base: string;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

// ============================================================================
// GitHub REST API response shapes (LOU-E13)
//
// These intentionally capture only the fields this file actually reads
// out of each response, not the full GitHub REST API schema.
// ============================================================================

interface GitHubApiRepository {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
}

interface GitHubApiBranchSummary {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

interface GitHubApiBranchDetail {
  name: string;
  commit: { sha: string; commit: { message: string } };
  protected: boolean;
}

/** Response of GET/POST git/refs/heads/{branch} */
interface GitHubApiRef {
  ref: string;
  object: { sha: string };
}

interface GitHubApiContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  sha: string;
  /** Only present when fetching a single file's content (base64-encoded). */
  content?: string;
}

interface GitHubApiFileCommitResult {
  content: { path: string; sha: string; html_url: string };
  commit: { sha: string };
}

interface GitHubApiSearchCodeItem {
  name: string;
  path: string;
  sha: string;
  html_url: string;
}

interface GitHubApiSearchCodeResponse {
  total_count: number;
  items: GitHubApiSearchCodeItem[];
}

interface GitHubApiPullRequestSummary {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface GitHubApiPullRequestDetail {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

interface GitHubApiMergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

interface GitHubApiPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

interface GitHubApiComment {
  id: number;
  user: { login: string };
  body: string;
  path?: string;
  line?: number;
  created_at: string;
  html_url: string;
}

interface GitHubApiIssueSummary {
  number: number;
  title: string;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  created_at: string;
  /** Present (truthy) when this "issue" is actually a pull request. */
  pull_request?: unknown;
}

interface GitHubApiIssueDetail {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface GitHubApiCreateResult {
  number: number;
  html_url: string;
}

interface GitHubApiCommentResult {
  id: number;
  html_url: string;
}

interface GitHubApiCommitSummary {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  html_url: string;
}

interface GitHubApiCommitDetail {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  stats?: { additions: number; deletions: number; total: number };
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}

interface GitHubApiCompareResult {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
}

/** Request body for PUT contents/{path} (create-or-update file). */
interface CreateOrUpdateFileRequestBody {
  message: string;
  content: string;
  branch: string;
  sha?: string;
}

/** Request body for PATCH pulls/{number}. */
interface UpdatePullRequestBody {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
}

/** Request body for PUT pulls/{number}/merge. */
interface MergePullRequestBody {
  merge_method: 'merge' | 'squash' | 'rebase';
  commit_title?: string;
  commit_message?: string;
}

/** Request body for POST/PATCH issues. */
interface IssueRequestBody {
  title?: string;
  body?: string;
  assignees?: string[];
  labels?: string[];
  state?: 'open' | 'closed';
}

// ============================================================================
// GitHub Tools Registry
// ============================================================================

export class GitHubTools extends ToolRegistry {
  private config: GitHubConfig;
  private authHeader: string;
  private baseUrl: string;

  /**
   * Tool names whose underlying GitHub endpoint requires more than the
   * "Pull requests: write" + "Issues: write" + "Contents: read" scope
   * documented above (branch/file mutation, code search, and non-PR
   * issue CRUD). `register()` below wraps each of these tools' execute()
   * so calling one throws immediately - before any `fetch()` - instead
   * of only being caught by GitHub itself at request time.
   */
  private static readonly OUT_OF_SCOPE_TOOLS = new Set<string>([
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
    // LOU-E fix: merging a PR (PUT pulls/{number}/merge) needs GitHub's
    // "Contents: Read and write" permission, not just "Pull requests:
    // write" - see the scope documentation at the top of this file. A
    // PR-creation/reading-scoped token genuinely can't merge, so this is
    // out of scope the same as the other higher-privilege operations
    // above, not a PR operation this class supports.
    'github_merge_pull_request',
  ]);

  constructor(config: GitHubConfig) {
    super();
    this.config = config;
    this.authHeader = `Bearer ${config.token}`;
    this.baseUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    this.registerAllTools();
  }

  /**
   * Overrides ToolRegistry.register() to gate any tool named in
   * OUT_OF_SCOPE_TOOLS behind an error thrown from its execute(), instead
   * of the tool's real implementation - so an out-of-scope call fails
   * fast, before constructing or sending any GitHub API request. Every
   * registerX() method below still calls `this.register(...)` exactly as
   * before; this override applies uniformly without touching their
   * individual implementations.
   *
   * The disabled tool is a separate descriptor whose canonical `execute`
   * (the one the runtime calls, see getToolExecute()) and legacy
   * `tool.execute` both throw; the real implementation is never exposed.
   */
  public register(tool: DefinedTool): void;
  public register(name: string, descriptor: ToolDescriptor): void;
  public register(nameOrTool: string | DefinedTool, maybeDescriptor?: ToolDescriptor): void {
    const name = typeof nameOrTool === 'string' ? nameOrTool : nameOrTool.name;
    const descriptor = typeof nameOrTool === 'string' ? (maybeDescriptor as ToolDescriptor) : nameOrTool;
    if (GitHubTools.OUT_OF_SCOPE_TOOLS.has(name) && descriptor.tool) {
      const disabled = async () => {
        throw new Error(
          `GitHub tool '${name}' is out of scope for a PR-creation/reading-scoped token ` +
            `(requires broader permissions than "Pull requests: write" + "Issues: write" + ` +
            `"Contents: read" - see the scope documentation at the top of github.ts) and has ` +
            `been disabled.`
        );
      };
      // Out-of-scope tools above throw before ever making an HTTP request,
      // so there's no real outbound call for a sandbox boundary to be
      // meaningful on - they're deliberately left unflagged below.
      super.register(name, {
        ...descriptor,
        execute: disabled,
        tool: { ...descriptor.tool, execute: disabled as ToolDescriptor['tool']['execute'] },
      });
      return;
    }

    // LOU-K2: every remaining GitHub tool's execute() makes a real outbound
    // HTTP call to the GitHub API via the ambient global `fetch`. Flag it
    // requiresSandbox and route sandboxExecute() through
    // withSandboxedFetch(), which swaps `fetch` for a SandboxAdapter-routed
    // implementation just for the duration of the original execute() call -
    // so a caller going through executeToolWithSandboxGuard() (AgentExecutor,
    // resume.ts) gets the fetch call genuinely routed through the
    // configured SandboxAdapter, without every one of this file's ~30
    // register*() methods needing its own hand-written sandboxed
    // reimplementation. execute() itself is left completely unchanged -
    // still a real, directly-callable implementation - for callers that
    // invoke descriptor.tool.execute() directly rather than through the
    // guard (e.g. examples/ops-pipeline's guardedPr.ts).
    routeFetchThroughSandbox(descriptor);

    super.register(name, descriptor);
  }

  private registerAllTools() {
    // Repository operations
    this.registerGetRepository();
    this.registerListBranches();
    this.registerGetBranch();
    this.registerCreateBranch();
    this.registerDeleteBranch();
    
    // File operations
    this.registerListFiles();
    this.registerGetFile();
    this.registerCreateOrUpdateFile();
    this.registerDeleteFile();
    this.registerSearchCode();
    
    // Pull Request operations
    this.registerListPullRequests();
    this.registerGetPullRequest();
    this.registerCreatePullRequest();
    this.registerUpdatePullRequest();
    this.registerMergePullRequest();
    this.registerClosePullRequest();
    this.registerGetPRFiles();
    this.registerGetPRComments();
    this.registerAddPRComment();
    
    // Issue operations
    this.registerListIssues();
    this.registerGetIssue();
    this.registerCreateIssue();
    this.registerUpdateIssue();
    this.registerCloseIssue();
    this.registerAddIssueComment();
    
    // Commit operations
    this.registerListCommits();
    this.registerGetCommit();
    this.registerCompareCommits();
  }

  // ========================================================================
  // Repository Operations
  // ========================================================================

  private registerGetRepository() {
    this.register(
      defineTool({
        name: 'github_get_repository',
        displayName: 'Get GitHub Repository',
        description: 'Get information about the GitHub repository',
        input: z.object({}),
        execute: async () => {
          const response = await fetch(this.baseUrl, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to get repository');

          const data = (await response.json()) as GitHubApiRepository;
          return JSON.stringify({
            name: data.name,
            fullName: data.full_name,
            description: data.description,
            defaultBranch: data.default_branch,
            language: data.language,
            stargazersCount: data.stargazers_count,
            forksCount: data.forks_count,
            openIssuesCount: data.open_issues_count,
          }, null, 2);
        },
      })
    );
  }

  private registerListBranches() {
    this.register(
      defineTool({
        name: 'github_list_branches',
        displayName: 'List GitHub Branches',
        description: 'List all branches in the repository',
        input: z.object({
          protected: z.boolean().optional().describe('Filter by protected status'),
          perPage: z.number().optional().default(30).describe('Results per page'),
          page: z.number().optional().default(1).describe('Page number'),
        }),
        execute: async ({ protected: protectedFilter, perPage = 30, page = 1 }) => {
          let url = `${this.baseUrl}/branches?per_page=${perPage}&page=${page}`;
          if (protectedFilter !== undefined) {
            url += `&protected=${protectedFilter}`;
          }

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to list branches');

          const data = (await response.json()) as GitHubApiBranchSummary[];
          const branches: GitHubBranch[] = data.map((branch) => ({
            name: branch.name,
            sha: branch.commit.sha,
            protected: branch.protected,
          }));

          return JSON.stringify({ branches }, null, 2);
        },
      })
    );
  }

  private registerGetBranch() {
    this.register(
      defineTool({
        name: 'github_get_branch',
        displayName: 'Get GitHub Branch',
        description: 'Get information about a specific branch',
        input: z.object({
          branchName: z.string().describe('Branch name'),
        }),
        execute: async ({ branchName }) => {
          const response = await fetch(
            `${this.baseUrl}/branches/${branchName}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to get branch');

          const data = (await response.json()) as GitHubApiBranchDetail;
          return JSON.stringify({
            name: data.name,
            sha: data.commit.sha,
            protected: data.protected,
            commitMessage: data.commit.commit.message,
          }, null, 2);
        },
      })
    );
  }

  private registerCreateBranch() {
    this.register(
      defineTool({
        name: 'github_create_branch',
        displayName: 'Create GitHub Branch',
        description: 'Create a new branch in the repository',
        input: z.object({
          branchName: z.string().describe('Name for the new branch'),
          fromBranch: z.string().optional().describe('Source branch (default: repository default branch)'),
        }),
        execute: async ({ branchName, fromBranch }) => {
          // Get source branch SHA
          const sourceBranch = fromBranch || (await this.getDefaultBranch());
          const refResponse = await fetch(
            `${this.baseUrl}/git/refs/heads/${sourceBranch}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(refResponse, 'Failed to get source branch');

          const refData = (await refResponse.json()) as GitHubApiRef;
          const sha = refData.object.sha;

          // Create new branch
          const response = await fetch(
            `${this.baseUrl}/git/refs`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ref: `refs/heads/${branchName}`,
                sha,
              }),
            }
          );

          await assertOk(response, 'Failed to create branch');

          const data = (await response.json()) as GitHubApiRef;
          return JSON.stringify({
            ref: data.ref,
            sha: data.object.sha,
            branchName,
          }, null, 2);
        },
      })
    );
  }

  private registerDeleteBranch() {
    this.register(
      defineTool({
        name: 'github_delete_branch',
        displayName: 'Delete GitHub Branch',
        description: 'Delete a branch from the repository',
        input: z.object({
          branchName: z.string().describe('Branch name to delete'),
        }),
        execute: async ({ branchName }) => {
          const response = await fetch(
            `${this.baseUrl}/git/refs/heads/${branchName}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to delete branch');

          return JSON.stringify({ success: true, branchName });
        },
      })
    );
  }

  // ========================================================================
  // File Operations
  // ========================================================================

  private registerListFiles() {
    this.register(
      defineTool({
        name: 'github_list_files',
        displayName: 'List GitHub Files',
        description: 'List files and directories at a given path in the repository',
        input: z.object({
          path: z.string().default('').describe('Directory path (empty for root)'),
          ref: z.string().optional().describe('Branch, tag, or commit SHA'),
        }),
        execute: async ({ path = '', ref }) => {
          let url = `${this.baseUrl}/contents/${path}`;
          if (ref) {
            url += `?ref=${ref}`;
          }

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to list files');

          const data = (await response.json()) as GitHubApiContentItem | GitHubApiContentItem[];
          const files = Array.isArray(data) ? data : [data];

          const result = files.map((file) => ({
            name: file.name,
            path: file.path,
            type: file.type,
            size: file.size,
            sha: file.sha,
          }));

          return JSON.stringify({ files: result }, null, 2);
        },
      })
    );
  }

  private registerGetFile() {
    this.register(
      defineTool({
        name: 'github_get_file',
        displayName: 'Get GitHub File Content',
        description: 'Get the content of a specific file from the repository',
        input: z.object({
          path: z.string().describe('File path in repository'),
          ref: z.string().optional().describe('Branch, tag, or commit SHA'),
        }),
        execute: async ({ path, ref }) => {
          let url = `${this.baseUrl}/contents/${path}`;
          if (ref) {
            url += `?ref=${ref}`;
          }

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to get file');

          const data = (await response.json()) as GitHubApiContentItem;
          const content = Buffer.from(data.content ?? '', 'base64').toString('utf-8');
          
          return JSON.stringify({
            path: data.path,
            content,
            size: data.size,
            sha: data.sha,
          }, null, 2);
        },
      })
    );
  }

  private registerCreateOrUpdateFile() {
    this.register(
      defineTool({
        name: 'github_create_or_update_file',
        displayName: 'Create or Update GitHub File',
        description: 'Create a new file or update an existing file in the repository',
        input: z.object({
          path: z.string().describe('File path in repository'),
          content: z.string().describe('File content'),
          message: z.string().describe('Commit message'),
          branch: z.string().describe('Branch name'),
          sha: z.string().optional().describe('File SHA (required for updates, leave empty for new files)'),
        }),
        execute: async ({ path, content, message, branch, sha }) => {
          const body: CreateOrUpdateFileRequestBody = {
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
          };

          if (sha) {
            body.sha = sha;
          }

          const response = await fetch(
            `${this.baseUrl}/contents/${path}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          await assertOk(response, 'Failed to create/update file');

          const data = (await response.json()) as GitHubApiFileCommitResult;
          return JSON.stringify({
            path: data.content.path,
            sha: data.content.sha,
            url: data.content.html_url,
            commitSha: data.commit.sha,
          }, null, 2);
        },
      })
    );
  }

  private registerDeleteFile() {
    this.register(
      defineTool({
        name: 'github_delete_file',
        displayName: 'Delete GitHub File',
        description: 'Delete a file from the repository',
        input: z.object({
          path: z.string().describe('File path to delete'),
          message: z.string().describe('Commit message'),
          branch: z.string().describe('Branch name'),
          sha: z.string().describe('File SHA (required)'),
        }),
        execute: async ({ path, message, branch, sha }) => {
          const response = await fetch(
            `${this.baseUrl}/contents/${path}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message,
                sha,
                branch,
              }),
            }
          );

          await assertOk(response, 'Failed to delete file');

          return JSON.stringify({ success: true, path });
        },
      })
    );
  }

  private registerSearchCode() {
    this.register(
      defineTool({
        name: 'github_search_code',
        displayName: 'Search GitHub Code',
        description: 'Search for code in the repository',
        input: z.object({
          query: z.string().describe('Search query'),
          extension: z.string().optional().describe('File extension filter (e.g., "ts", "js")'),
          path: z.string().optional().describe('Path filter'),
        }),
        execute: async ({ query, extension, path }) => {
          let searchQuery = `${query} repo:${this.config.owner}/${this.config.repo}`;
          
          if (extension) {
            searchQuery += ` extension:${extension}`;
          }
          
          if (path) {
            searchQuery += ` path:${path}`;
          }

          const response = await fetch(
            `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to search code');

          const data = (await response.json()) as GitHubApiSearchCodeResponse;

          const result: GitHubSearchResult = {
            totalCount: data.total_count,
            items: data.items.slice(0, 10).map((item) => ({
              name: item.name,
              path: item.path,
              sha: item.sha,
              url: item.html_url,
            })),
          };

          return JSON.stringify(result, null, 2);
        },
      })
    );
  }

  // ========================================================================
  // Pull Request Operations
  // ========================================================================

  private registerListPullRequests() {
    this.register(
      defineTool({
        name: 'github_list_pull_requests',
        displayName: 'List GitHub Pull Requests',
        description: 'List pull requests in the repository',
        input: z.object({
          state: z.enum(['open', 'closed', 'all']).default('open').describe('PR state'),
          sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional().describe('Sort by'),
          direction: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
          perPage: z.number().optional().default(30).describe('Results per page'),
          page: z.number().optional().default(1).describe('Page number'),
        }),
        execute: async ({ state = 'open', sort, direction, perPage = 30, page = 1 }) => {
          let url = `${this.baseUrl}/pulls?state=${state}&per_page=${perPage}&page=${page}`;
          
          if (sort) url += `&sort=${sort}`;
          if (direction) url += `&direction=${direction}`;

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to list PRs');

          const data = (await response.json()) as GitHubApiPullRequestSummary[];

          const prs = data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.state,
            user: pr.user.login,
            head: pr.head.ref,
            base: pr.base.ref,
            url: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
          }));

          return JSON.stringify({ pullRequests: prs }, null, 2);
        },
      })
    );
  }

  private registerGetPullRequest() {
    this.register(
      defineTool({
        name: 'github_get_pull_request',
        displayName: 'Get GitHub Pull Request',
        description: 'Get detailed information about a specific pull request',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
        }),
        execute: async ({ prNumber }) => {
          const response = await fetch(
            `${this.baseUrl}/pulls/${prNumber}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to get PR');

          const data = (await response.json()) as GitHubApiPullRequestDetail;

          const pr: GitHubPullRequest = {
            number: data.number,
            title: data.title,
            body: data.body || '',
            state: data.state,
            url: data.html_url,
            head: data.head.ref,
            base: data.base.ref,
          };

          return JSON.stringify(pr, null, 2);
        },
      })
    );
  }

  private registerCreatePullRequest() {
    this.register(
      defineTool({
        name: 'github_create_pull_request',
        displayName: 'Create GitHub Pull Request',
        description: 'Create a new pull request',
        input: z.object({
          title: z.string().describe('PR title'),
          body: z.string().describe('PR description/body'),
          head: z.string().describe('Source branch name'),
          base: z.string().optional().describe('Target branch name (default: repository default branch)'),
          draft: z.boolean().optional().describe('Create as draft PR'),
        }),
        execute: async ({ title, body, head, base, draft }) => {
          const targetBase = base || (await this.getDefaultBranch());
          
          const response = await fetch(
            `${this.baseUrl}/pulls`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                title,
                body,
                head,
                base: targetBase,
                draft: draft || false,
              }),
            }
          );

          await assertOk(response, 'Failed to create PR');

          const data = (await response.json()) as GitHubApiCreateResult & { state: string };
          return JSON.stringify({
            number: data.number,
            url: data.html_url,
            state: data.state,
          }, null, 2);
        },
      })
    );
  }

  private registerUpdatePullRequest() {
    this.register(
      defineTool({
        name: 'github_update_pull_request',
        displayName: 'Update GitHub Pull Request',
        description: 'Update an existing pull request',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
          title: z.string().optional().describe('New title'),
          body: z.string().optional().describe('New body'),
          state: z.enum(['open', 'closed']).optional().describe('New state'),
        }),
        execute: async ({ prNumber, title, body, state }) => {
          const updates: UpdatePullRequestBody = {};
          if (title) updates.title = title;
          if (body) updates.body = body;
          if (state) updates.state = state;

          if (Object.keys(updates).length === 0) {
            throw new Error('At least one field must be provided to update');
          }

          const response = await fetch(
            `${this.baseUrl}/pulls/${prNumber}`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(updates),
            }
          );

          await assertOk(response, 'Failed to update PR');

          const data = (await response.json()) as GitHubApiPullRequestDetail;
          return JSON.stringify({
            number: data.number,
            state: data.state,
            url: data.html_url,
          });
        },
      })
    );
  }

  private registerMergePullRequest() {
    this.register(
      defineTool({
        name: 'github_merge_pull_request',
        displayName: 'Merge GitHub Pull Request',
        description: 'Merge a pull request',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
          commitTitle: z.string().optional().describe('Title for merge commit'),
          commitMessage: z.string().optional().describe('Message for merge commit'),
          mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().default('merge').describe('Merge method'),
        }),
        execute: async ({ prNumber, commitTitle, commitMessage, mergeMethod = 'merge' }) => {
          const body: MergePullRequestBody = {
            merge_method: mergeMethod,
          };

          if (commitTitle) body.commit_title = commitTitle;
          if (commitMessage) body.commit_message = commitMessage;

          const response = await fetch(
            `${this.baseUrl}/pulls/${prNumber}/merge`,
            {
              method: 'PUT',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          await assertOk(response, 'Failed to merge PR');

          const data = (await response.json()) as GitHubApiMergeResult;
          return JSON.stringify({
            merged: data.merged,
            sha: data.sha,
            message: data.message,
          });
        },
      })
    );
  }

  private registerClosePullRequest() {
    this.register(
      defineTool({
        name: 'github_close_pull_request',
        displayName: 'Close GitHub Pull Request',
        description: 'Close a pull request without merging',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
        }),
        execute: async ({ prNumber }) => {
          const response = await fetch(
            `${this.baseUrl}/pulls/${prNumber}`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ state: 'closed' }),
            }
          );

          await assertOk(response, 'Failed to close PR');

          return JSON.stringify({ success: true, prNumber, state: 'closed' });
        },
      })
    );
  }

  private registerGetPRFiles() {
    this.register(
      defineTool({
        name: 'github_get_pr_files',
        displayName: 'Get Pull Request Files',
        description: 'Get the list of files changed in a pull request',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
        }),
        execute: async ({ prNumber }) => {
          const response = await fetch(
            `${this.baseUrl}/pulls/${prNumber}/files`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to get PR files');

          const data = (await response.json()) as GitHubApiPRFile[];

          const files = data.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
          }));

          return JSON.stringify({ files }, null, 2);
        },
      })
    );
  }

  private registerGetPRComments() {
    this.register(
      defineTool({
        name: 'github_get_pr_comments',
        displayName: 'Get Pull Request Comments',
        description: 'Get comments on a pull request',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
        }),
        execute: async ({ prNumber }) => {
          const response = await fetch(
            `${this.baseUrl}/pulls/${prNumber}/comments`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to get PR comments');

          const data = (await response.json()) as GitHubApiComment[];

          const comments = data.map((comment) => ({
            id: comment.id,
            user: comment.user.login,
            body: comment.body,
            path: comment.path,
            line: comment.line,
            createdAt: comment.created_at,
          }));

          return JSON.stringify({ comments }, null, 2);
        },
      })
    );
  }

  private registerAddPRComment() {
    this.register(
      defineTool({
        name: 'github_add_pr_comment',
        displayName: 'Add Pull Request Comment',
        description: 'Add a comment to a pull request',
        input: z.object({
          prNumber: z.number().describe('Pull request number'),
          body: z.string().describe('Comment body'),
        }),
        execute: async ({ prNumber, body }) => {
          const response = await fetch(
            `${this.baseUrl}/issues/${prNumber}/comments`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body }),
            }
          );

          await assertOk(response, 'Failed to add PR comment');

          const data = (await response.json()) as GitHubApiCommentResult;
          return JSON.stringify({
            id: data.id,
            url: data.html_url,
          });
        },
      })
    );
  }

  // ========================================================================
  // Issue Operations
  // ========================================================================

  private registerListIssues() {
    this.register(
      defineTool({
        name: 'github_list_issues',
        displayName: 'List GitHub Issues',
        description: 'List issues in the repository',
        input: z.object({
          state: z.enum(['open', 'closed', 'all']).default('open').describe('Issue state'),
          labels: z.array(z.string()).optional().describe('Filter by labels'),
          assignee: z.string().optional().describe('Filter by assignee'),
          perPage: z.number().optional().default(30).describe('Results per page'),
          page: z.number().optional().default(1).describe('Page number'),
        }),
        execute: async ({ state = 'open', labels, assignee, perPage = 30, page = 1 }) => {
          let url = `${this.baseUrl}/issues?state=${state}&per_page=${perPage}&page=${page}`;
          
          if (labels && labels.length > 0) {
            url += `&labels=${labels.join(',')}`;
          }
          
          if (assignee) {
            url += `&assignee=${assignee}`;
          }

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to list issues');

          const data = (await response.json()) as GitHubApiIssueSummary[];

          const issues = data
            .filter((issue) => !issue.pull_request) // Exclude PRs
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              user: issue.user.login,
              labels: issue.labels.map((l) => l.name),
              assignees: issue.assignees.map((a) => a.login),
              url: issue.html_url,
              createdAt: issue.created_at,
            }));

          return JSON.stringify({ issues }, null, 2);
        },
      })
    );
  }

  private registerGetIssue() {
    this.register(
      defineTool({
        name: 'github_get_issue',
        displayName: 'Get GitHub Issue',
        description: 'Get detailed information about a specific issue',
        input: z.object({
          issueNumber: z.number().describe('Issue number'),
        }),
        execute: async ({ issueNumber }) => {
          const response = await fetch(
            `${this.baseUrl}/issues/${issueNumber}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to get issue');

          const data = (await response.json()) as GitHubApiIssueDetail;
          return JSON.stringify({
            number: data.number,
            title: data.title,
            body: data.body || '',
            state: data.state,
            user: data.user.login,
            labels: data.labels.map((l) => l.name),
            assignees: data.assignees.map((a) => a.login),
            url: data.html_url,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
          }, null, 2);
        },
      })
    );
  }

  private registerCreateIssue() {
    this.register(
      defineTool({
        name: 'github_create_issue',
        displayName: 'Create GitHub Issue',
        description: 'Create a new issue in the repository',
        input: z.object({
          title: z.string().describe('Issue title'),
          body: z.string().optional().describe('Issue body/description'),
          assignees: z.array(z.string()).optional().describe('Assignee usernames'),
          labels: z.array(z.string()).optional().describe('Label names'),
        }),
        execute: async ({ title, body, assignees, labels }) => {
          const issueData: IssueRequestBody = { title };
          
          if (body) issueData.body = body;
          if (assignees) issueData.assignees = assignees;
          if (labels) issueData.labels = labels;

          const response = await fetch(
            `${this.baseUrl}/issues`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(issueData),
            }
          );

          await assertOk(response, 'Failed to create issue');

          const data = (await response.json()) as GitHubApiCreateResult;
          return JSON.stringify({
            number: data.number,
            url: data.html_url,
          });
        },
      })
    );
  }

  private registerUpdateIssue() {
    this.register(
      defineTool({
        name: 'github_update_issue',
        displayName: 'Update GitHub Issue',
        description: 'Update an existing issue',
        input: z.object({
          issueNumber: z.number().describe('Issue number'),
          title: z.string().optional().describe('New title'),
          body: z.string().optional().describe('New body'),
          state: z.enum(['open', 'closed']).optional().describe('New state'),
          labels: z.array(z.string()).optional().describe('Labels to set'),
        }),
        execute: async ({ issueNumber, title, body, state, labels }) => {
          const updates: IssueRequestBody = {};
          if (title) updates.title = title;
          if (body) updates.body = body;
          if (state) updates.state = state;
          if (labels) updates.labels = labels;

          if (Object.keys(updates).length === 0) {
            throw new Error('At least one field must be provided to update');
          }

          const response = await fetch(
            `${this.baseUrl}/issues/${issueNumber}`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(updates),
            }
          );

          await assertOk(response, 'Failed to update issue');

          return JSON.stringify({ success: true, issueNumber });
        },
      })
    );
  }

  private registerCloseIssue() {
    this.register(
      defineTool({
        name: 'github_close_issue',
        displayName: 'Close GitHub Issue',
        description: 'Close an issue',
        input: z.object({
          issueNumber: z.number().describe('Issue number'),
        }),
        execute: async ({ issueNumber }) => {
          const response = await fetch(
            `${this.baseUrl}/issues/${issueNumber}`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ state: 'closed' }),
            }
          );

          await assertOk(response, 'Failed to close issue');

          return JSON.stringify({ success: true, issueNumber, state: 'closed' });
        },
      })
    );
  }

  private registerAddIssueComment() {
    this.register(
      defineTool({
        name: 'github_add_issue_comment',
        displayName: 'Add GitHub Issue Comment',
        description: 'Add a comment to an issue',
        input: z.object({
          issueNumber: z.number().describe('Issue number'),
          body: z.string().describe('Comment body'),
        }),
        execute: async ({ issueNumber, body }) => {
          const response = await fetch(
            `${this.baseUrl}/issues/${issueNumber}/comments`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body }),
            }
          );

          await assertOk(response, 'Failed to add issue comment');

          const data = (await response.json()) as GitHubApiCommentResult;
          return JSON.stringify({
            id: data.id,
            url: data.html_url,
          });
        },
      })
    );
  }

  // ========================================================================
  // Commit Operations
  // ========================================================================

  private registerListCommits() {
    this.register(
      defineTool({
        name: 'github_list_commits',
        displayName: 'List GitHub Commits',
        description: 'List commits in the repository',
        input: z.object({
          sha: z.string().optional().describe('Branch or commit SHA to start from'),
          path: z.string().optional().describe('Only commits containing this file path'),
          perPage: z.number().optional().default(30).describe('Results per page'),
          page: z.number().optional().default(1).describe('Page number'),
        }),
        execute: async ({ sha, path, perPage = 30, page = 1 }) => {
          let url = `${this.baseUrl}/commits?per_page=${perPage}&page=${page}`;
          
          if (sha) url += `&sha=${sha}`;
          if (path) url += `&path=${path}`;

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          await assertOk(response, 'Failed to list commits');

          const data = (await response.json()) as GitHubApiCommitSummary[];

          const commits = data.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message,
            author: commit.commit.author.name,
            date: commit.commit.author.date,
            url: commit.html_url,
          }));

          return JSON.stringify({ commits }, null, 2);
        },
      })
    );
  }

  private registerGetCommit() {
    this.register(
      defineTool({
        name: 'github_get_commit',
        displayName: 'Get GitHub Commit',
        description: 'Get detailed information about a specific commit',
        input: z.object({
          sha: z.string().describe('Commit SHA'),
        }),
        execute: async ({ sha }) => {
          const response = await fetch(
            `${this.baseUrl}/commits/${sha}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to get commit');

          const data = (await response.json()) as GitHubApiCommitDetail;
          return JSON.stringify({
            sha: data.sha,
            message: data.commit.message,
            author: data.commit.author.name,
            date: data.commit.author.date,
            stats: data.stats,
            files: data.files.map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          }, null, 2);
        },
      })
    );
  }

  private registerCompareCommits() {
    this.register(
      defineTool({
        name: 'github_compare_commits',
        displayName: 'Compare GitHub Commits',
        description: 'Compare two commits and see the differences',
        input: z.object({
          base: z.string().describe('Base commit SHA or branch'),
          head: z.string().describe('Head commit SHA or branch'),
        }),
        execute: async ({ base, head }) => {
          const response = await fetch(
            `${this.baseUrl}/compare/${base}...${head}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/vnd.github.v3+json',
              },
            }
          );

          await assertOk(response, 'Failed to compare commits');

          const data = (await response.json()) as GitHubApiCompareResult;
          return JSON.stringify({
            status: data.status,
            aheadBy: data.ahead_by,
            behindBy: data.behind_by,
            totalCommits: data.total_commits,
            files: data.files.map((f) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          }, null, 2);
        },
      })
    );
  }

  // ========================================================================
  // Helper Methods
  // ========================================================================

  private async getDefaultBranch(): Promise<string> {
    const response = await fetch(this.baseUrl, {
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get repository information');
    }

    const data = (await response.json()) as GitHubApiRepository;
    return data.default_branch;
  }
}

// Export convenience function to create GitHub tools
export function createGitHubTools(config: GitHubConfig): GitHubTools {
  return new GitHubTools(config);
}
