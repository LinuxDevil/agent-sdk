import { describe, it, expect } from 'vitest';
import type { WorkspaceContext, WorkspaceResolver } from '../context';
import { rejectUpgradeWith, resolveWsWorkspace } from '../wsWorkspace';
import type { Socket } from 'node:net';

/**
 * `?ws=` on WebSocket upgrades (W02b): missing means the default
 * workspace, a known id resolves its context, `all`/malformed/repeated
 * are 400 and unknown is 404 - the same boundary the HTTP middleware
 * draws, minus the header (browsers cannot set one on a WebSocket).
 */

const launch: WorkspaceContext = {
  ref: { id: 'launch-abc123', name: 'launch', root: '/launch', addedAt: '', lastOpenedAt: '' },
} as WorkspaceContext;
const other: WorkspaceContext = {
  ref: { id: 'other-def456', name: 'other', root: '/other', addedAt: '', lastOpenedAt: '' },
} as WorkspaceContext;

const workspaces: WorkspaceResolver = {
  resolve: async (id) => (id === undefined || id === 'all' ? launch : id === other.ref.id ? other : id === launch.ref.id ? launch : undefined),
  defaultId: () => launch.ref.id,
  retain: () => () => {},
};

function wsUrl(path: string, query = ''): URL {
  return new URL(`ws://studio.local${path}${query}`);
}

describe('resolveWsWorkspace', () => {
  it('no ?ws= resolves the default workspace', async () => {
    const result = await resolveWsWorkspace(wsUrl('/agents/x/stream'), workspaces);
    expect(result).toEqual({ ok: true, ctx: launch });
  });

  it('a registered ?ws= id resolves that workspace', async () => {
    const result = await resolveWsWorkspace(wsUrl('/events', `?ws=${other.ref.id}`), workspaces);
    expect(result).toEqual({ ok: true, ctx: other });
  });

  it('the launch id resolves the launch context', async () => {
    const result = await resolveWsWorkspace(wsUrl('/events', `?ws=${launch.ref.id}`), workspaces);
    expect(result).toEqual({ ok: true, ctx: launch });
  });

  it('?ws=all is a 400 - there is no aggregate stream', async () => {
    const result = await resolveWsWorkspace(wsUrl('/events', '?ws=all'), workspaces);
    expect(result).toEqual({ ok: false, status: 400, error: 'Aggregate workspace streams are not supported' });
  });

  it.each(['nope!', '../x', 'UPPER-abc123', 'x-12345'])('?ws=%s is a 400 invalid id', async (bad) => {
    const result = await resolveWsWorkspace(wsUrl('/events', `?ws=${encodeURIComponent(bad)}`), workspaces);
    expect(result).toEqual({ ok: false, status: 400, error: 'Invalid workspace id' });
  });

  it('?ws= repeated is a 400', async () => {
    const result = await resolveWsWorkspace(wsUrl('/events', '?ws=a-abc123&ws=b-def456'), workspaces);
    expect(result).toEqual({ ok: false, status: 400, error: 'Invalid workspace id' });
  });

  it('a well-formed unknown id is a 404 naming it', async () => {
    const result = await resolveWsWorkspace(wsUrl('/events', '?ws=ghost-abc123'), workspaces);
    expect(result).toEqual({ ok: false, status: 404, error: "No workspace 'ghost-abc123'" });
  });
});

describe('rejectUpgradeWith', () => {
  it('writes the HTTP status line and destroys the socket', () => {
    const written: string[] = [];
    const socket = {
      end: (data: string) => written.push(data),
    } as unknown as Socket;
    rejectUpgradeWith(socket, 404);
    expect(written).toEqual(['HTTP/1.1 404 Not Found\r\n\r\n']);
  });
});
