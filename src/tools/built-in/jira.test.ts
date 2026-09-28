import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createJiraTools } from './jira';
import { NoopSandbox } from '../../security/sandboxCore';
import type { SandboxAdapter } from '../../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../../execution/sandboxGuard';

describe('JiraTools sandbox seam (LOU-K2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags requiresSandbox on every registered tool and implements sandboxExecute', () => {
    const jiraTools = createJiraTools({
      baseUrl: 'https://jira.test',
      email: 'bot@example.com',
      apiToken: 'token',
    });

    for (const name of jiraTools.list()) {
      const descriptor = jiraTools.get(name)!;
      expect(descriptor.requiresSandbox, `${name} should require sandbox`).toBe(true);
      expect(typeof descriptor.sandboxExecute, `${name} should implement sandboxExecute`).toBe('function');
    }
  });

  it('execute() is left unchanged and still makes a real request directly (unsandboxed callers)', async () => {
    const jiraTools = createJiraTools({
      baseUrl: 'https://jira.test',
      email: 'bot@example.com',
      apiToken: 'token',
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        key: 'PROJ-1',
        fields: {
          summary: 's',
          description: null,
          issuetype: { name: 'Task' },
          status: { name: 'Open' },
          project: { key: 'PROJ' },
          created: '2024-01-01',
          updated: '2024-01-01',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const descriptor = jiraTools.get('jira_get_ticket')!;
    const result = await descriptor.tool.execute!({ ticketKey: 'PROJ-1' }, {} as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result as string).key).toBe('PROJ-1');
  });

  it('(a) NoopSandbox: sandboxExecute() hits a real local Jira-shaped server, same result as execute()', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          key: 'PROJ-2',
          fields: {
            summary: 'sandboxed summary',
            description: null,
            issuetype: { name: 'Bug' },
            status: { name: 'Open' },
            project: { key: 'PROJ' },
            created: '2024-01-01',
            updated: '2024-01-01',
          },
        })
      );
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });

    try {
      const jiraTools = createJiraTools({
        baseUrl: `http://127.0.0.1:${port}`,
        email: 'bot@example.com',
        apiToken: 'token',
      });
      const descriptor = jiraTools.get('jira_get_ticket')!;

      const result = await executeToolWithSandboxGuard(
        'jira_get_ticket',
        descriptor,
        { ticketKey: 'PROJ-2' },
        NoopSandbox
      );

      expect(JSON.parse(result as string).summary).toBe('sandboxed summary');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('(b) a custom SandboxAdapter actually gets invoked for the outbound Jira API call', async () => {
    const runSpy = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('node');
      expect(args[0]).toBe('-e');
      return {
        stdout: JSON.stringify({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key: 'PROJ-3',
            fields: {
              summary: 'from custom sandbox',
              description: null,
              issuetype: { name: 'Task' },
              status: { name: 'Open' },
              project: { key: 'PROJ' },
              created: '2024-01-01',
              updated: '2024-01-01',
            },
          }),
        }),
        stderr: '',
        exitCode: 0,
      };
    });
    const customSandbox: SandboxAdapter = { name: 'custom-test-sandbox', run: runSpy, writeFile: vi.fn() };

    const jiraTools = createJiraTools({
      baseUrl: 'https://jira.test',
      email: 'bot@example.com',
      apiToken: 'token',
    });
    const descriptor = jiraTools.get('jira_get_ticket')!;

    const result = await executeToolWithSandboxGuard(
      'jira_get_ticket',
      descriptor,
      { ticketKey: 'PROJ-3' },
      customSandbox
    );

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result as string).summary).toBe('from custom sandbox');
  });

  it('(c) fails closed when requiresSandbox is true but sandboxExecute is missing', async () => {
    const jiraTools = createJiraTools({
      baseUrl: 'https://jira.test',
      email: 'bot@example.com',
      apiToken: 'token',
    });
    const descriptor = jiraTools.get('jira_get_ticket')!;
    const broken = { ...descriptor, sandboxExecute: undefined };

    await expect(
      executeToolWithSandboxGuard('jira_get_ticket', broken, { ticketKey: 'PROJ-1' }, NoopSandbox)
    ).rejects.toThrow(/requiresSandbox but does not implement sandboxExecute/);
  });
});
