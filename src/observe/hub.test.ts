/**
 * The Context Hub end to end: publish/query over real HTTP, scope
 * enforcement daemon side (private isolation, fleet visibility), upsert
 * semantics per (namespace, agent_id, key), TTL expiry, and the SDK's
 * `hub()`/`hubTools()` surface.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startObserveDaemon, type ObserveDaemon } from './daemon';
import { hub, hubTools, type HubEntry } from './hubClient';

const daemons: ObserveDaemon[] = [];
let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-hub-'));
});

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

async function start(): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0 });
  daemons.push(daemon);
  return daemon;
}

const url = (daemon: ObserveDaemon, path: string): string => `http://127.0.0.1:${daemon.port}${path}`;
const base = (daemon: ObserveDaemon): string => url(daemon, '');

const publish = (daemon: ObserveDaemon, body: unknown): Promise<Response> =>
  fetch(url(daemon, '/api/v1/hub'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const query = async (daemon: ObserveDaemon, qs: string): Promise<{ entries: HubEntry[] }> =>
  (await (await fetch(url(daemon, `/api/v1/hub?${qs}`))).json()) as { entries: HubEntry[] };

describe('POST /api/v1/hub', () => {
  it('publishes an entry and upserts the same (namespace, agent, key) in place', async () => {
    const daemon = await start();
    const first = await publish(daemon, { agent_id: 'a', namespace: 'facts', key: 'sky', value: 'blue' });
    expect(first.status).toBe(201);
    const again = await publish(daemon, { agent_id: 'a', namespace: 'facts', key: 'sky', value: 'gray', scope: 'fleet' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);
    const { entries } = await query(daemon, 'agent_id=a');
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('gray');
    expect(entries[0].scope).toBe('fleet');
  });

  it('JSON-encodes non-string values and stores strings verbatim', async () => {
    const daemon = await start();
    await publish(daemon, { agent_id: 'a', namespace: 'n', key: 'obj', value: { x: 1 } });
    const { entries } = await query(daemon, 'agent_id=a&key=obj');
    expect(entries[0].value).toBe('{"x":1}');
  });

  it('rejects a bad body with 400', async () => {
    const daemon = await start();
    expect((await publish(daemon, { agent_id: 'a', namespace: 'n' })).status).toBe(400);
    expect((await publish(daemon, { agent_id: 'a', namespace: 'n', key: 'k', value: 'v', scope: 'world' })).status).toBe(400);
  });
});

describe('GET /api/v1/hub scope enforcement', () => {
  it("keeps another agent's private entries invisible, shares fleet entries, and defaults to both kinds", async () => {
    const daemon = await start();
    await publish(daemon, { agent_id: 'a', namespace: 'facts', key: 'mine', value: 'a-private' });
    await publish(daemon, { agent_id: 'a', namespace: 'facts', key: 'ours', value: 'a-fleet', scope: 'fleet' });
    await publish(daemon, { agent_id: 'b', namespace: 'facts', key: 'theirs', value: 'b-private' });
    await publish(daemon, { agent_id: 'b', namespace: 'facts', key: 'everyones', value: 'b-fleet', scope: 'fleet' });

    const bPrivate = await query(daemon, 'agent_id=b&scope=private');
    expect(bPrivate.entries.map((e) => e.value)).toEqual(['b-private']);

    const bFleet = await query(daemon, 'agent_id=b&scope=fleet');
    expect(new Set(bFleet.entries.map((e) => e.value))).toEqual(new Set(['a-fleet', 'b-fleet']));

    const bAll = await query(daemon, 'agent_id=b');
    expect(new Set(bAll.entries.map((e) => e.value))).toEqual(new Set(['b-private', 'a-fleet', 'b-fleet']));

    const namespaced = await query(daemon, 'agent_id=b&namespace=other');
    expect(namespaced.entries).toHaveLength(0);
  });

  it('requires the caller agent_id and a known scope', async () => {
    const daemon = await start();
    expect((await fetch(url(daemon, '/api/v1/hub'))).status).toBe(400);
    expect((await fetch(url(daemon, '/api/v1/hub?agent_id=a&scope=world'))).status).toBe(400);
  });

  it('hides entries past their ttl', async () => {
    const daemon = await start();
    await publish(daemon, { agent_id: 'a', namespace: 'n', key: 'gone', value: 'v', ttl: 30 });
    await publish(daemon, { agent_id: 'a', namespace: 'n', key: 'stays', value: 'v' });
    expect((await query(daemon, 'agent_id=a')).entries.map((e) => e.key).sort()).toEqual(['gone', 'stays']);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const { entries } = await query(daemon, 'agent_id=a');
    expect(entries.map((e) => e.key)).toEqual(['stays']);
  });
});

describe('hub() client', () => {
  it('publishes and queries under the given agent identity', async () => {
    const daemon = await start();
    const a = hub({ url: base(daemon), agentId: 'agent-a' })!;
    const b = hub({ url: base(daemon), agentId: 'agent-b' })!;
    await a.publish({ namespace: 'facts', key: 'sky', value: 'blue' });
    await a.publish({ namespace: 'facts', key: 'motto', value: 'share me', scope: 'fleet' });

    expect((await a.query({ scope: 'private' })).map((e) => e.key)).toEqual(['sky']);
    expect((await b.query({ scope: 'private' }))).toHaveLength(0);
    expect((await b.query({ scope: 'fleet' })).map((e) => e.key)).toEqual(['motto']);
    expect(a.agentId).toBe('agent-a');
  });

  it('resolves the caller identity from .lousho/identity/ like the reporter', async () => {
    const daemon = await start();
    const client = hub({ url: base(daemon), agentName: 'mira', project: 'testproj', cwd })!;
    await client.publish({ namespace: 'n', key: 'k', value: 'v' });
    const { entries } = await query(daemon, `agent_id=${client.agentId}`);
    expect(entries[0].agent_id).toBe(client.agentId);
    expect(entries[0].agent_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is undefined when no daemon is configured', () => {
    expect(hub({ env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it('follows LOUSHO_OBSERVE when no url is passed', async () => {
    const daemon = await start();
    const client = hub({ env: { LOUSHO_OBSERVE: base(daemon) } as NodeJS.ProcessEnv, agentId: 'e-agent' })!;
    await client.publish({ namespace: 'n', key: 'k', value: 'v' });
    expect((await query(daemon, 'agent_id=e-agent')).entries).toHaveLength(1);
  });
});

describe('hubTools()', () => {
  it('returns [] when no hub is configured', () => {
    expect(hubTools({ env: {} as NodeJS.ProcessEnv })).toEqual([]);
  });

  it('exposes hub_publish and hub_query as agent tools over the client', async () => {
    const daemon = await start();
    const tools = hubTools({ url: base(daemon), agentId: 'tool-agent' });
    expect(tools.map((t) => t.name).sort()).toEqual(['hub_publish', 'hub_query']);

    const ctx = {
      toolCallId: 't1',
      messages: [],
      getToken: async () => {
        throw new Error('no oauth in tests');
      },
      requireAuth: () => {
        throw new Error('no oauth in tests');
      },
    };
    const published = (await tools[0].execute({ namespace: 'facts', key: 'sky', value: 'blue', scope: 'private' }, ctx)) as {
      ok: boolean;
      entry: HubEntry;
    };
    expect(published.ok).toBe(true);
    expect(published.entry.agent_id).toBe('tool-agent');

    const read = (await tools[1].execute({ scope: 'private' }, ctx)) as { entries: HubEntry[] };
    expect(read.entries.map((e) => e.key)).toEqual(['sky']);
  });
});
