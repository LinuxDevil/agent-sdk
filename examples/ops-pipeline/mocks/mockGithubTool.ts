/**
 * Mock GitHub API (LOU-J8) - same call shape as the REAL github tool's
 * `github_create_pull_request` (src/tools/built-in/github.ts): takes
 * {title, body, head, base}, returns JSON matching {number, url, state}.
 * Never makes a real network call, so the ops-pipeline demo runs with zero
 * external network access.
 */
import { ToolDescriptor } from '../../../src/types';

export interface MockCreatedPullRequest {
  title: string;
  body: string;
  head: string;
  base?: string;
}

export interface MockGithubTool {
  tool: ToolDescriptor;
  createdPullRequests: MockCreatedPullRequest[];
}

export function createMockGithubTool(options: { log?: (message: string) => void } = {}): MockGithubTool {
  const createdPullRequests: MockCreatedPullRequest[] = [];
  let nextNumber = 1;

  const tool: ToolDescriptor = {
    displayName: 'Create GitHub Pull Request (mock)',
    tool: {
      description: 'Mock: creates a pull request',
      parameters: {} as any,
      execute: async (args: MockCreatedPullRequest) => {
        createdPullRequests.push(args);
        const number = nextNumber++;
        const url = `https://github.com/mock-org/mock-repo/pull/${number}`;
        options.log?.(`[mock github] created PR #${number} "${args.title}" (${args.head}) -> ${url}`);
        return JSON.stringify(
          {
            number,
            url,
            state: 'open',
          },
          null,
          2
        );
      },
    } as any,
  };

  return { tool, createdPullRequests };
}
