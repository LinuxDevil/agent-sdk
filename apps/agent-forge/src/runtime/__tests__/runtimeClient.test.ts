import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuntimeClient, RuntimeApiError } from '../runtimeClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * An agent named "My Agent" made `GET /agents/My%20Agent/chats`
 * answer 400 `{ error }`; listChats() returned that object as the session
 * list and the Chat tab crashed with `n.filter is not a function`.
 */
describe('RuntimeClient error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });

  it.each([
    ['listChats', () => client.listChats('My Agent')],
    ['debugState', () => client.debugState('My Agent')],
    ['getChat', () => client.getChat('My Agent')],
    ['newChat', () => client.newChat('My Agent')],
    ['listProviderKeys', () => client.listProviderKeys()],
    ['listSettingsProfiles', () => client.listSettingsProfiles()],
    ['listDeployAdapters', () => client.listDeployAdapters()],
    ['removeProviderKey', () => client.removeProviderKey('openai')],
  ])('%s rejects with the server message on a non-ok response', async (_name, call) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'Invalid agent id' })));
    const promise = call();
    await expect(promise).rejects.toBeInstanceOf(RuntimeApiError);
    await expect(promise).rejects.toMatchObject({ message: 'Invalid agent id', status: 400 });
  });

  it('sends the studio token on every request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await client.listChats('a1');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get('x-lousho-studio-token')).toBe('t');
  });

  it('deployAgent returns a failed build (422 with a DeployResult) and throws on other errors', async () => {
    const failed = { adapter: 'docker', exitCode: 1, stdout: '', stderr: 'boom' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(422, failed)));
    await expect(client.deployAgent('a1', 'docker')).resolves.toEqual(failed);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: "No saved agent 'a1'" })));
    await expect(client.deployAgent('a1', 'docker')).rejects.toMatchObject({ status: 404 });
  });
});

describe('RuntimeClient draft methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });
  const DRAFT = { id: 'd1', agentId: 'a1', status: 'pending', patch: { description: 'x' } };

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it('getDraft returns the draft, or undefined on a 204 (none pending)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, DRAFT));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.getDraft('a1')).resolves.toEqual(DRAFT);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/draft');
    expect(init.method).toBe('GET');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(client.getDraft('a1')).resolves.toBeUndefined();
  });

  it('createDraft POSTs the request to /agents/:id/draft', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, DRAFT));
    vi.stubGlobal('fetch', fetchMock);
    const req = { patch: { description: 'x' }, origin: 'author' as const, reason: 'why' };
    await expect(client.createDraft('a1', req)).resolves.toEqual(DRAFT);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/draft');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(req);
  });

  it('withdrawDraft DELETEs /agents/:id/draft', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ...DRAFT, status: 'withdrawn' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.withdrawDraft('a1')).resolves.toMatchObject({ status: 'withdrawn' });
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/draft');
    expect(init.method).toBe('DELETE');
  });

  it('approveDraft POSTs the settle request to /draft/approve, defaulting to {}', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ...DRAFT, status: 'approved' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.approveDraft('a1', { draftId: 'd1', note: 'ok' })).resolves.toMatchObject({
      status: 'approved',
    });
    let [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/draft/approve');
    expect(JSON.parse(String(init.body))).toEqual({ draftId: 'd1', note: 'ok' });

    await client.approveDraft('a1');
    [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/draft/approve');
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('rejectDraft POSTs the settle request to /draft/reject', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ...DRAFT, status: 'rejected' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.rejectDraft('a1', { note: 'no' })).resolves.toMatchObject({ status: 'rejected' });
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/draft/reject');
    expect(JSON.parse(String(init.body))).toEqual({ note: 'no' });
  });

  it('draft calls reject with the server message on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'This draft was replaced. Reload to see the current one.' })));
    await expect(client.approveDraft('a1', { draftId: 'stale' })).rejects.toMatchObject({
      message: 'This draft was replaced. Reload to see the current one.',
      status: 409,
    });
  });
});

describe('RuntimeClient catalog methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it.each([
    ['catalogTools', '/catalog/tools', () => client.catalogTools()],
    ['catalogGuardrails', '/catalog/guardrails', () => client.catalogGuardrails()],
    ['catalogTriggers', '/catalog/triggers', () => client.catalogTriggers()],
    ['catalogSkills', '/catalog/skills', () => client.catalogSkills()],
    ['catalogKits', '/catalog/kits', () => client.catalogKits()],
  ])('%s GETs %s', async (_name, path, call) => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await expect(call()).resolves.toEqual([]);
    const [calledPath, init] = lastCall(fetchMock);
    expect(calledPath).toBe(path);
    expect(init.method).toBe('GET');
  });

  it('catalogModels GETs /catalog/models, adding ?provider= only when given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await client.catalogModels();
    expect(lastCall(fetchMock)[0]).toBe('/catalog/models');
    await client.catalogModels('anthropic');
    expect(lastCall(fetchMock)[0]).toBe('/catalog/models?provider=anthropic');
  });

  it('catalog calls reject with the server message on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: "'provider' must be a non-empty string" })));
    await expect(client.catalogModels('')).rejects.toMatchObject({
      message: "'provider' must be a non-empty string",
      status: 400,
    });
  });
});
