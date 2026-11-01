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

describe('RuntimeClient version methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });
  const ITEM = { version: 2, kind: 'update', source: 'editor', specHash: 'sha256:x' };

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it('listVersions GETs /agents/:id/versions', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, [ITEM]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listVersions('a1')).resolves.toEqual([ITEM]);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/versions');
    expect(init.method).toBe('GET');
  });

  it('getVersion GETs /agents/:id/versions/:n', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ...ITEM, snapshot: { spec: {}, labels: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await client.getVersion('a1', 3);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/versions/3');
    expect(init.method).toBe('GET');
  });

  it('diffVersion GETs /versions/:n/diff, adding ?against= only when given', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await client.diffVersion('a1', 2);
    expect(lastCall(fetchMock)[0]).toBe('/agents/a1/versions/2/diff');
    await client.diffVersion('a1', 2, 1);
    expect(lastCall(fetchMock)[0]).toBe('/agents/a1/versions/2/diff?against=1');
  });

  it('restoreVersion POSTs /versions/:n/restore', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { ...ITEM, kind: 'restore' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.restoreVersion('a1', 1)).resolves.toMatchObject({ kind: 'restore' });
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/versions/1/restore');
    expect(init.method).toBe('POST');
  });

  it('saveVersion POSTs /versions and reports created from the status: 201 vs 200', async () => {
    let fetchMock = vi.fn(async () => jsonResponse(201, ITEM));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.saveVersion('a1')).resolves.toEqual({ item: ITEM, created: true });
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1/versions');
    expect(init.method).toBe('POST');

    fetchMock = vi.fn(async () => jsonResponse(200, ITEM));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.saveVersion('a1')).resolves.toEqual({ item: ITEM, created: false });
  });

  it('version calls reject with the server message on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: "No version 9 of 'a1'" })));
    await expect(client.getVersion('a1', 9)).rejects.toMatchObject({ status: 404 });
    await expect(client.saveVersion('a1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('RuntimeClient agent methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it('listAgents GETs /agents?view=legacy (the v1 canvas still reads the legacy view)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listAgents()).resolves.toEqual([]);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents?view=legacy');
    expect(init.method).toBe('GET');
  });

  it('loadAgent GETs /agents/:id?view=legacy and resolves undefined on a 404', async () => {
    const spec = { name: 'a1', prompt: 'hi', provider: { type: 'mock', model: 'mock-1' } };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, spec)));
    await expect(client.loadAgent('a1')).resolves.toEqual(spec);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: "No saved agent 'a1'" })));
    await expect(client.loadAgent('a1')).resolves.toBeUndefined();
  });

  it('saveAgent PUTs the bare v1 spec to /agents/:id', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const spec = { name: 'a1', prompt: 'hi', provider: { type: 'mock', model: 'mock-1' } };
    await client.saveAgent('a1', spec as never);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(spec);
  });

  it('listAgentItems GETs /agents', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listAgentItems()).resolves.toEqual([]);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents');
    expect(init.method).toBe('GET');
  });

  it('getAgentRecord GETs /agents/:id and resolves undefined on a 404', async () => {
    const record = { id: 'a1', spec: { version: 2 }, latestVersion: 3 };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, record)));
    await expect(client.getAgentRecord('a1')).resolves.toEqual(record);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: "No saved agent 'a1'" })));
    await expect(client.getAgentRecord('a1')).resolves.toBeUndefined();
  });

  it('saveAgentSpec PUTs { spec } to /agents/:id', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const spec = { version: 2, name: 'a1', model: 'mock/mock-1', instructions: 'hi' };
    await client.saveAgentSpec('a1', spec as never);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/agents/a1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ spec });
  });
});

describe('RuntimeClient named-secret methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });
  const STATUS = { name: 'GITHUB_TOKEN', hasValue: true, masked: '••••••••c123', updatedAt: '2026-01-01T00:00:00Z' };

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it('listSecrets GETs /settings/secrets', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, [STATUS]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listSecrets()).resolves.toEqual([STATUS]);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/settings/secrets');
    expect(init.method).toBe('GET');
  });

  it('getSecretStatus GETs /settings/secrets/:name, encoding the name', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, STATUS));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.getSecretStatus('GITHUB_TOKEN')).resolves.toEqual(STATUS);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/settings/secrets/GITHUB_TOKEN');
    expect(init.method).toBe('GET');
  });

  it('setSecret PUTs { value } to /settings/secrets/:name', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, STATUS));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.setSecret('GITHUB_TOKEN', 'ghp_abc123')).resolves.toEqual(STATUS);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/settings/secrets/GITHUB_TOKEN');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ value: 'ghp_abc123' });
  });

  it('removeSecret DELETEs /settings/secrets/:name', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.removeSecret('GITHUB_TOKEN')).resolves.toBeUndefined();
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/settings/secrets/GITHUB_TOKEN');
    expect(init.method).toBe('DELETE');
  });

  it('secret calls reject with the server message on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'bad name' })));
    await expect(client.getSecretStatus('1BAD')).rejects.toMatchObject({ message: 'bad name', status: 400 });
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

describe('RuntimeClient workspace methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });
  const ITEM = {
    id: 'proj-abc123',
    name: 'proj',
    root: '/home/me/proj',
    addedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    isLaunch: false,
    available: true,
    agentCount: 2,
  };

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it('listWorkspaces GETs /workspaces', async () => {
    const list = { defaultId: 'launch-def456', workspaces: [ITEM] };
    const fetchMock = vi.fn(async () => jsonResponse(200, list));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listWorkspaces()).resolves.toEqual(list);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/workspaces');
    expect(init.method).toBe('GET');
  });

  it('addWorkspace POSTs the folder path in the body (never in the URL)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, ITEM));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.addWorkspace('/home/me/proj')).resolves.toEqual(ITEM);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/workspaces');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ root: '/home/me/proj' });
  });

  it('removeWorkspace DELETEs /workspaces/:id', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.removeWorkspace('proj-abc123')).resolves.toBeUndefined();
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/workspaces/proj-abc123');
    expect(init.method).toBe('DELETE');
  });
});

describe('RuntimeClient template methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RuntimeClient({ token: 't' });

  /** The last fetch call's [path, init]. */
  function lastCall(fetchMock: { mock: { calls: unknown[][] } }): [string, RequestInit] {
    const [path, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return [path, init];
  }

  it('listTemplates GETs /templates', async () => {
    const summary = { id: 'pr-reviewer', title: 'Pull request reviewer' };
    const fetchMock = vi.fn(async () => jsonResponse(200, [summary]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.listTemplates()).resolves.toEqual([summary]);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/templates');
    expect(init.method).toBe('GET');
  });

  it('getTemplate GETs /templates/:id (encoded) and resolves undefined on a 404', async () => {
    const detail = { summary: { id: 'pr-reviewer' }, spec: { version: 2 }, readme: '# hi' };
    const fetchMock = vi.fn(async () => jsonResponse(200, detail));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.getTemplate('pr-reviewer')).resolves.toEqual(detail);
    const [path, init] = lastCall(fetchMock);
    expect(path).toBe('/templates/pr-reviewer');
    expect(init.method).toBe('GET');

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: "No template 'ghost'" })));
    await expect(client.getTemplate('ghost')).resolves.toBeUndefined();
  });
});
