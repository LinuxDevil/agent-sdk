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
 */

import { tool } from 'ai';
import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';

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
// GitHub Tools Registry
// ============================================================================

export class GitHubTools extends ToolRegistry {
  private config: GitHubConfig;
  private authHeader: string;
  private baseUrl: string;

  constructor(config: GitHubConfig) {
    super();
    this.config = config;
    this.authHeader = `Bearer ${config.token}`;
    this.baseUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    this.registerAllTools();
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
    this.register('github_get_repository', {
      displayName: 'Get GitHub Repository',
      tool: tool({
        description: 'Get information about the GitHub repository',
        parameters: z.object({}),
        execute: async () => {
          const response = await fetch(this.baseUrl, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get repository: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
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
      }),
    });
  }

  private registerListBranches() {
    this.register('github_list_branches', {
      displayName: 'List GitHub Branches',
      tool: tool({
        description: 'List all branches in the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to list branches: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          const branches: GitHubBranch[] = data.map((branch: any) => ({
            name: branch.name,
            sha: branch.commit.sha,
            protected: branch.protected,
          }));

          return JSON.stringify({ branches }, null, 2);
        },
      }),
    });
  }

  private registerGetBranch() {
    this.register('github_get_branch', {
      displayName: 'Get GitHub Branch',
      tool: tool({
        description: 'Get information about a specific branch',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get branch: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            name: data.name,
            sha: data.commit.sha,
            protected: data.protected,
            commitMessage: data.commit.commit.message,
          }, null, 2);
        },
      }),
    });
  }

  private registerCreateBranch() {
    this.register('github_create_branch', {
      displayName: 'Create GitHub Branch',
      tool: tool({
        description: 'Create a new branch in the repository',
        parameters: z.object({
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

          if (!refResponse.ok) {
            const errorText = await refResponse.text();
            throw new Error(`Failed to get source branch: ${refResponse.statusText} - ${errorText}`);
          }

          const refData = await refResponse.json();
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create branch: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            ref: data.ref,
            sha: data.object.sha,
            branchName,
          }, null, 2);
        },
      }),
    });
  }

  private registerDeleteBranch() {
    this.register('github_delete_branch', {
      displayName: 'Delete GitHub Branch',
      tool: tool({
        description: 'Delete a branch from the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete branch: ${response.statusText} - ${errorText}`);
          }

          return JSON.stringify({ success: true, branchName });
        },
      }),
    });
  }

  // ========================================================================
  // File Operations
  // ========================================================================

  private registerListFiles() {
    this.register('github_list_files', {
      displayName: 'List GitHub Files',
      tool: tool({
        description: 'List files and directories at a given path in the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to list files: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          const files = Array.isArray(data) ? data : [data];
          
          const result = files.map((file: any) => ({
            name: file.name,
            path: file.path,
            type: file.type,
            size: file.size,
            sha: file.sha,
          }));

          return JSON.stringify({ files: result }, null, 2);
        },
      }),
    });
  }

  private registerGetFile() {
    this.register('github_get_file', {
      displayName: 'Get GitHub File Content',
      tool: tool({
        description: 'Get the content of a specific file from the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get file: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          
          return JSON.stringify({
            path: data.path,
            content,
            size: data.size,
            sha: data.sha,
          }, null, 2);
        },
      }),
    });
  }

  private registerCreateOrUpdateFile() {
    this.register('github_create_or_update_file', {
      displayName: 'Create or Update GitHub File',
      tool: tool({
        description: 'Create a new file or update an existing file in the repository',
        parameters: z.object({
          path: z.string().describe('File path in repository'),
          content: z.string().describe('File content'),
          message: z.string().describe('Commit message'),
          branch: z.string().describe('Branch name'),
          sha: z.string().optional().describe('File SHA (required for updates, leave empty for new files)'),
        }),
        execute: async ({ path, content, message, branch, sha }) => {
          const body: any = {
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create/update file: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            path: data.content.path,
            sha: data.content.sha,
            url: data.content.html_url,
            commitSha: data.commit.sha,
          }, null, 2);
        },
      }),
    });
  }

  private registerDeleteFile() {
    this.register('github_delete_file', {
      displayName: 'Delete GitHub File',
      tool: tool({
        description: 'Delete a file from the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete file: ${response.statusText} - ${errorText}`);
          }

          return JSON.stringify({ success: true, path });
        },
      }),
    });
  }

  private registerSearchCode() {
    this.register('github_search_code', {
      displayName: 'Search GitHub Code',
      tool: tool({
        description: 'Search for code in the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to search code: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
          const result: GitHubSearchResult = {
            totalCount: data.total_count,
            items: data.items.slice(0, 10).map((item: any) => ({
              name: item.name,
              path: item.path,
              sha: item.sha,
              url: item.html_url,
            })),
          };

          return JSON.stringify(result, null, 2);
        },
      }),
    });
  }

  // ========================================================================
  // Pull Request Operations
  // ========================================================================

  private registerListPullRequests() {
    this.register('github_list_pull_requests', {
      displayName: 'List GitHub Pull Requests',
      tool: tool({
        description: 'List pull requests in the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to list PRs: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
          const prs = data.map((pr: any) => ({
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
      }),
    });
  }

  private registerGetPullRequest() {
    this.register('github_get_pull_request', {
      displayName: 'Get GitHub Pull Request',
      tool: tool({
        description: 'Get detailed information about a specific pull request',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get PR: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
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
      }),
    });
  }

  private registerCreatePullRequest() {
    this.register('github_create_pull_request', {
      displayName: 'Create GitHub Pull Request',
      tool: tool({
        description: 'Create a new pull request',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create PR: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            number: data.number,
            url: data.html_url,
            state: data.state,
          }, null, 2);
        },
      }),
    });
  }

  private registerUpdatePullRequest() {
    this.register('github_update_pull_request', {
      displayName: 'Update GitHub Pull Request',
      tool: tool({
        description: 'Update an existing pull request',
        parameters: z.object({
          prNumber: z.number().describe('Pull request number'),
          title: z.string().optional().describe('New title'),
          body: z.string().optional().describe('New body'),
          state: z.enum(['open', 'closed']).optional().describe('New state'),
        }),
        execute: async ({ prNumber, title, body, state }) => {
          const updates: any = {};
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update PR: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            number: data.number,
            state: data.state,
            url: data.html_url,
          });
        },
      }),
    });
  }

  private registerMergePullRequest() {
    this.register('github_merge_pull_request', {
      displayName: 'Merge GitHub Pull Request',
      tool: tool({
        description: 'Merge a pull request',
        parameters: z.object({
          prNumber: z.number().describe('Pull request number'),
          commitTitle: z.string().optional().describe('Title for merge commit'),
          commitMessage: z.string().optional().describe('Message for merge commit'),
          mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().default('merge').describe('Merge method'),
        }),
        execute: async ({ prNumber, commitTitle, commitMessage, mergeMethod = 'merge' }) => {
          const body: any = {
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to merge PR: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            merged: data.merged,
            sha: data.sha,
            message: data.message,
          });
        },
      }),
    });
  }

  private registerClosePullRequest() {
    this.register('github_close_pull_request', {
      displayName: 'Close GitHub Pull Request',
      tool: tool({
        description: 'Close a pull request without merging',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to close PR: ${response.statusText} - ${errorText}`);
          }

          return JSON.stringify({ success: true, prNumber, state: 'closed' });
        },
      }),
    });
  }

  private registerGetPRFiles() {
    this.register('github_get_pr_files', {
      displayName: 'Get Pull Request Files',
      tool: tool({
        description: 'Get the list of files changed in a pull request',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get PR files: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
          const files = data.map((file: any) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
          }));

          return JSON.stringify({ files }, null, 2);
        },
      }),
    });
  }

  private registerGetPRComments() {
    this.register('github_get_pr_comments', {
      displayName: 'Get Pull Request Comments',
      tool: tool({
        description: 'Get comments on a pull request',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get PR comments: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
          const comments = data.map((comment: any) => ({
            id: comment.id,
            user: comment.user.login,
            body: comment.body,
            path: comment.path,
            line: comment.line,
            createdAt: comment.created_at,
          }));

          return JSON.stringify({ comments }, null, 2);
        },
      }),
    });
  }

  private registerAddPRComment() {
    this.register('github_add_pr_comment', {
      displayName: 'Add Pull Request Comment',
      tool: tool({
        description: 'Add a comment to a pull request',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to add PR comment: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            id: data.id,
            url: data.html_url,
          });
        },
      }),
    });
  }

  // ========================================================================
  // Issue Operations
  // ========================================================================

  private registerListIssues() {
    this.register('github_list_issues', {
      displayName: 'List GitHub Issues',
      tool: tool({
        description: 'List issues in the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to list issues: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
          const issues = data
            .filter((issue: any) => !issue.pull_request) // Exclude PRs
            .map((issue: any) => ({
              number: issue.number,
              title: issue.title,
              state: issue.state,
              user: issue.user.login,
              labels: issue.labels.map((l: any) => l.name),
              assignees: issue.assignees.map((a: any) => a.login),
              url: issue.html_url,
              createdAt: issue.created_at,
            }));

          return JSON.stringify({ issues }, null, 2);
        },
      }),
    });
  }

  private registerGetIssue() {
    this.register('github_get_issue', {
      displayName: 'Get GitHub Issue',
      tool: tool({
        description: 'Get detailed information about a specific issue',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get issue: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            number: data.number,
            title: data.title,
            body: data.body || '',
            state: data.state,
            user: data.user.login,
            labels: data.labels.map((l: any) => l.name),
            assignees: data.assignees.map((a: any) => a.login),
            url: data.html_url,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
          }, null, 2);
        },
      }),
    });
  }

  private registerCreateIssue() {
    this.register('github_create_issue', {
      displayName: 'Create GitHub Issue',
      tool: tool({
        description: 'Create a new issue in the repository',
        parameters: z.object({
          title: z.string().describe('Issue title'),
          body: z.string().optional().describe('Issue body/description'),
          assignees: z.array(z.string()).optional().describe('Assignee usernames'),
          labels: z.array(z.string()).optional().describe('Label names'),
        }),
        execute: async ({ title, body, assignees, labels }) => {
          const issueData: any = { title };
          
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create issue: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            number: data.number,
            url: data.html_url,
          });
        },
      }),
    });
  }

  private registerUpdateIssue() {
    this.register('github_update_issue', {
      displayName: 'Update GitHub Issue',
      tool: tool({
        description: 'Update an existing issue',
        parameters: z.object({
          issueNumber: z.number().describe('Issue number'),
          title: z.string().optional().describe('New title'),
          body: z.string().optional().describe('New body'),
          state: z.enum(['open', 'closed']).optional().describe('New state'),
          labels: z.array(z.string()).optional().describe('Labels to set'),
        }),
        execute: async ({ issueNumber, title, body, state, labels }) => {
          const updates: any = {};
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update issue: ${response.statusText} - ${errorText}`);
          }

          return JSON.stringify({ success: true, issueNumber });
        },
      }),
    });
  }

  private registerCloseIssue() {
    this.register('github_close_issue', {
      displayName: 'Close GitHub Issue',
      tool: tool({
        description: 'Close an issue',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to close issue: ${response.statusText} - ${errorText}`);
          }

          return JSON.stringify({ success: true, issueNumber, state: 'closed' });
        },
      }),
    });
  }

  private registerAddIssueComment() {
    this.register('github_add_issue_comment', {
      displayName: 'Add GitHub Issue Comment',
      tool: tool({
        description: 'Add a comment to an issue',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to add issue comment: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            id: data.id,
            url: data.html_url,
          });
        },
      }),
    });
  }

  // ========================================================================
  // Commit Operations
  // ========================================================================

  private registerListCommits() {
    this.register('github_list_commits', {
      displayName: 'List GitHub Commits',
      tool: tool({
        description: 'List commits in the repository',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to list commits: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          
          const commits = data.map((commit: any) => ({
            sha: commit.sha,
            message: commit.commit.message,
            author: commit.commit.author.name,
            date: commit.commit.author.date,
            url: commit.html_url,
          }));

          return JSON.stringify({ commits }, null, 2);
        },
      }),
    });
  }

  private registerGetCommit() {
    this.register('github_get_commit', {
      displayName: 'Get GitHub Commit',
      tool: tool({
        description: 'Get detailed information about a specific commit',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get commit: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            sha: data.sha,
            message: data.commit.message,
            author: data.commit.author.name,
            date: data.commit.author.date,
            stats: data.stats,
            files: data.files.map((f: any) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          }, null, 2);
        },
      }),
    });
  }

  private registerCompareCommits() {
    this.register('github_compare_commits', {
      displayName: 'Compare GitHub Commits',
      tool: tool({
        description: 'Compare two commits and see the differences',
        parameters: z.object({
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

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to compare commits: ${response.statusText} - ${errorText}`);
          }

          const data = await response.json();
          return JSON.stringify({
            status: data.status,
            aheadBy: data.ahead_by,
            behindBy: data.behind_by,
            totalCommits: data.total_commits,
            files: data.files.map((f: any) => ({
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          }, null, 2);
        },
      }),
    });
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

    const data = await response.json();
    return data.default_branch;
  }
}

// Export convenience function to create GitHub tools
export function createGitHubTools(config: GitHubConfig): GitHubTools {
  return new GitHubTools(config);
}
