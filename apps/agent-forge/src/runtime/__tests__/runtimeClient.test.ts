import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuntimeClient, RuntimeApiError } from '../runtimeClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Eve DUI-F3: an agent named "My Agent" made `GET /agents/My%20Agent/chats`
 * answer 400 `{ error }`; listChats() returned that object as the session
 * list and the Chat tab crashed with `n.filter is not a function`.
 */
describe('RuntimeClient error handling (Eve DUI-F3)', () => {
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
