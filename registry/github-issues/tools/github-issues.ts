import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';

function token(): string {
  const value = process.env.GITHUB_TOKEN;
  if (!value) throw new Error('GITHUB_TOKEN is not set; create a token with issues access and export it.');
  return value;
}

async function github(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed: HTTP ${response.status}`);
  return response.json();
}

interface ListedIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  pull_request?: unknown;
}

const repoArgs = {
  owner: z.string().describe('The user or organisation that owns the repository'),
  repo: z.string().describe('The repository name'),
};

const list = defineTool({
  name: 'github-issues-list',
  description: 'List issues of a GitHub repository (pull requests are filtered out)',
  input: z.object({
    ...repoArgs,
    state: z.enum(['open', 'closed', 'all']).default('open'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async execute({ owner, repo, state, limit }) {
    const issues = (await github(`/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}`)) as ListedIssue[];
    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, url: issue.html_url }));
  },
});

const create = defineTool({
  name: 'github-issues-create',
  description: 'Create an issue in a GitHub repository',
  input: z.object({
    ...repoArgs,
    title: z.string(),
    body: z.string().default(''),
  }),
  needsApproval: true,
  async execute({ owner, repo, title, body }) {
    const issue = (await github(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) })) as {
      number: number;
      html_url: string;
    };
    return { number: issue.number, url: issue.html_url };
  },
});

export default [list, create];
