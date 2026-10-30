import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveIntegrationRef, resolveOpenApiRef } from './integrationTools';

describe('resolveIntegrationRef', () => {
  it('builds the github tools from env-ref and literal credentials', async () => {
    const tools = await resolveIntegrationRef(
      { integration: 'github', credentials: { token: { env: 'GITHUB_TOKEN' }, owner: 'acme', repo: 'web' } },
      { env: { GITHUB_TOKEN: 't' } },
      'tools.0'
    );
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThanOrEqual(20);
    expect(names.every((name) => name.startsWith('github_'))).toBe(true);
  });

  it('builds the jira tools', async () => {
    const tools = await resolveIntegrationRef(
      {
        integration: 'jira',
        credentials: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: { secret: 'jira' } },
      },
      { resolveSecret: () => 't' },
      'tools.0'
    );
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith('jira_'))).toBe(true);
  });

  it('builds the email tool under send_email', async () => {
    const tools = await resolveIntegrationRef(
      { integration: 'email', credentials: { apiKey: { secret: 'resend' } } },
      { resolveSecret: () => 'k' },
      'tools.0'
    );
    expect(Object.keys(tools)).toEqual(['send_email']);
  });

  it('builds the slack tool under slack_alert', async () => {
    const tools = await resolveIntegrationRef(
      { integration: 'slack', credentials: { webhookUrl: { env: 'SLACK_HOOK' } } },
      { env: { SLACK_HOOK: 'https://hooks.slack.com/x' } },
      'tools.0'
    );
    expect(Object.keys(tools)).toEqual(['slack_alert']);
  });

  it('fails at build time when a credential secret is missing', async () => {
    await expect(
      resolveIntegrationRef(
        { integration: 'github', credentials: { token: { env: 'GITHUB_TOKEN' }, owner: 'acme', repo: 'web' } },
        { env: {} },
        'tools.0'
      )
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_SECRET_MISSING', field: 'tools.0.credentials.token' });
  });
});

describe('resolveOpenApiRef', () => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Orders', version: '1.0.0' },
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/refunds': {
        post: {
          operationId: 'refund',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };

  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(document));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it('builds one tool per included operation, from a loopback document', async () => {
    const tools = await resolveOpenApiRef({ openapi: { url, include: ['getOrder'] } }, {}, 'tools.0');
    expect(Object.keys(tools)).toHaveLength(1);
  });

  it('builds every operation and marks mutating ones as needing approval', async () => {
    const tools = await resolveOpenApiRef({ openapi: { url } }, {}, 'tools.0');
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools['refund']?.needsApproval).toBeTruthy();
    expect(tools['getOrder']?.needsApproval).toBeFalsy();
  });

  it("honours the ref's own approval 'never'", async () => {
    const tools = await resolveOpenApiRef({ openapi: { url, approval: 'never' } }, {}, 'tools.0');
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools['refund']?.needsApproval).toBeFalsy();
  });

  it('fails at build time when the bearer token secret is missing', async () => {
    await expect(
      resolveOpenApiRef({ openapi: { url, bearerToken: { env: 'LOUSHO_TEST_MISSING_TOKEN' } } }, { env: {} }, 'tools.0')
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_SECRET_MISSING', field: 'tools.0.openapi.bearerToken' });
  });
});
