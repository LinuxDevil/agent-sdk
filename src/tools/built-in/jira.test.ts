import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createJiraTools } from './jira';
import { NoopSandbox } from '../../security/sandboxCore';
import type { SandboxAdapter } from '../../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../../execution/sandboxGuard';
import { getToolExecute, getToolInputSchema } from '../toolContract';

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

  it('every tool exposes a canonical inputSchema and execute', () => {
    const jiraTools = createJiraTools({
      baseUrl: 'https://jira.test',
      email: 'bot@example.com',
      apiToken: 'token',
    });

    expect(jiraTools.list()).toHaveLength(20);
    for (const name of jiraTools.list()) {
      const descriptor = jiraTools.get(name)!;
      expect(getToolInputSchema(descriptor), `${name} inputSchema`).toBeDefined();
      expect(getToolExecute(descriptor), `${name} execute`).toBeTypeOf('function');
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

describe('JiraTools jira_create_ticket / jira_update_ticket execute()', () => {
  const makeTools = () =>
    createJiraTools({ baseUrl: 'https://jira.test', email: 'bot@example.com', apiToken: 'token' });
  const adf = (text: string) => ({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('jira_create_ticket', () => {
    const run = (args: Record<string, unknown>) =>
      makeTools().get('jira_create_ticket')!.tool.execute!(args as any, {} as any);

    it('sends only required fields when optionals are omitted and returns key/id/self', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ key: 'PROJ-9', id: '10009', self: 'https://jira.test/rest/api/3/issue/10009', extra: 'x' }),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const result = await run({ projectKey: 'PROJ', issueType: 'Task', summary: 'Sum', description: 'Desc' });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://jira.test/rest/api/3/issue');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        fields: {
          project: { key: 'PROJ' },
          issuetype: { name: 'Task' },
          summary: 'Sum',
          description: adf('Desc'),
        },
      });
      expect(JSON.parse(result as string)).toEqual({
        key: 'PROJ-9',
        id: '10009',
        self: 'https://jira.test/rest/api/3/issue/10009',
      });
    });

    it('includes priority, assignee, labels and components when provided', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'PROJ-10', id: '1', self: 's' }) });
      vi.stubGlobal('fetch', fetchSpy);

      await run({
        projectKey: 'PROJ',
        issueType: 'Bug',
        summary: 'S',
        description: 'D',
        priority: 'High',
        assignee: 'acct-123',
        labels: ['a', 'b'],
        components: ['api', 'ui'],
      });

      const fields = JSON.parse(fetchSpy.mock.calls[0][1].body).fields;
      expect(fields.priority).toEqual({ name: 'High' });
      expect(fields.assignee).toEqual({ accountId: 'acct-123' });
      expect(fields.labels).toEqual(['a', 'b']);
      expect(fields.components).toEqual([{ name: 'api' }, { name: 'ui' }]);
    });

    it('omits labels and components when they are empty arrays', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'K', id: '1', self: 's' }) });
      vi.stubGlobal('fetch', fetchSpy);

      await run({ projectKey: 'P', issueType: 'Task', summary: 'S', description: 'D', labels: [], components: [] });

      const fields = JSON.parse(fetchSpy.mock.calls[0][1].body).fields;
      expect(fields).not.toHaveProperty('labels');
      expect(fields).not.toHaveProperty('components');
    });

    it('throws a descriptive error on a non-OK response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, statusText: 'Bad Request', text: async () => 'project is required' })
      );

      await expect(
        run({ projectKey: 'P', issueType: 'Task', summary: 'S', description: 'D' })
      ).rejects.toThrow('Failed to create ticket: Bad Request - project is required');
    });
  });

  describe('jira_update_ticket', () => {
    const run = (args: Record<string, unknown>) =>
      makeTools().get('jira_update_ticket')!.tool.execute!(args as any, {} as any);

    it('PUTs all provided fields and returns success', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);

      const result = await run({
        ticketKey: 'PROJ-5',
        summary: 'New',
        description: 'Newdesc',
        priority: 'Low',
        labels: ['x'],
      });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://jira.test/rest/api/3/issue/PROJ-5');
      expect(init.method).toBe('PUT');
      expect(init.headers.Authorization).toMatch(/^Basic /);
      expect(JSON.parse(init.body)).toEqual({
        fields: { summary: 'New', description: adf('Newdesc'), priority: { name: 'Low' }, labels: ['x'] },
      });
      expect(JSON.parse(result as string)).toEqual({ success: true, ticketKey: 'PROJ-5' });
    });

    it.each([
      ['summary', { summary: 'Only' }, { summary: 'Only' }],
      ['description', { description: 'Only' }, { description: adf('Only') }],
      ['priority', { priority: 'High' }, { priority: { name: 'High' } }],
      ['labels (even empty, to clear them)', { labels: [] }, { labels: [] }],
    ])('sends just %s when it is the only field', async (_label, args, expectedFields) => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);

      await run({ ticketKey: 'PROJ-6', ...args });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ fields: expectedFields });
    });

    it('throws before any request when no fields are provided', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(run({ ticketKey: 'PROJ-7' })).rejects.toThrow('At least one field must be provided to update');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws a descriptive error on a non-OK response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, statusText: 'Not Found', text: async () => 'no such issue' })
      );

      await expect(run({ ticketKey: 'PROJ-404', summary: 'x' })).rejects.toThrow(
        'Failed to update ticket: Not Found - no such issue'
      );
    });
  });
});
