import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchDaemonAgents, toObservedItems, type DaemonAgentRow, type WorkspaceMatch } from '../observedAgents';

/**
 * W07a: the observed-agents merge - daemon fetch failure modes and the
 * pure placement/filter/group/sort logic.
 */

const row = (over: Partial<DaemonAgentRow>): DaemonAgentRow => ({
  agent_id: 'r1',
  project: 'proj-a',
  name: 'agent',
  version: '1.0.0',
  first_seen: 1000,
  last_heartbeat: 2000,
  status: 'healthy',
  hostname: 'h1',
  pid: 1,
  runs_today: 0,
  error_rate_today: 0,
  ...over,
});

const WS: WorkspaceMatch[] = [
  { id: 'alpha-1a2b3c', projects: new Set(['alpha-1a2b3c', 'alpha-pack']), agentIds: new Set(['support-bot']) },
  { id: 'beta-2b3c4d', projects: new Set(['beta-2b3c4d', 'beta-pack']), agentIds: new Set(['other-bot']) },
];

describe('toObservedItems', () => {
  it('places rows under the workspace whose project matches (package name), grouping instances', () => {
    const items = toObservedItems(
      [
        row({ agent_id: 'w1', name: 'billing-worker', project: 'alpha-pack', hostname: 'h1' }),
        row({ agent_id: 'w2', name: 'billing-worker', project: 'alpha-pack', hostname: 'h2', status: 'stale' }),
        row({ agent_id: 'n1', name: 'nightly', project: 'ci' }),
      ],
      WS
    );
    expect(items).toHaveLength(2);
    const worker = items.find((i) => i.name === 'billing-worker')!;
    expect(worker.workspaceId).toBe('alpha-1a2b3c');
    expect(worker.instances).toBe(2);
    expect(worker.status).toBe('healthy'); // best of the group: healthy beats stale
    const nightly = items.find((i) => i.name === 'nightly')!;
    expect(nightly.workspaceId).toBeNull();
    expect(nightly.project).toBe('ci');
  });

  it('status precedence is healthy > stale > down > stopped (best wins)', () => {
    const items = toObservedItems(
      [
        row({ name: 'a', project: 'ci', status: 'down' }),
        row({ name: 'a', project: 'ci', agent_id: 'r2', status: 'healthy' }),
        row({ name: 'a', project: 'ci', agent_id: 'r3', status: 'stopped' }),
      ],
      []
    );
    expect(items[0].status).toBe('healthy');
  });

  it('drops Studio\'s own rows: agent-id names, playground, studio-passes, <id>-evals', () => {
    const items = toObservedItems(
      [
        row({ name: 'support-bot', project: 'alpha-pack' }), // in W.agentIds
        row({ name: 'support-bot-evals', project: 'alpha-pack' }), // -evals prefix in agentIds
        row({ name: 'playground', project: 'alpha-pack' }),
        row({ name: 'studio-passes', project: 'whatever' }),
        row({ name: 'other-bot', project: 'beta-pack' }), // beta's own
        row({ name: 'real-external', project: 'alpha-pack' }), // not an agent id -> kept, placed in alpha
      ],
      WS
    );
    expect(items.map((i) => i.name)).toEqual(['real-external']);
    expect(items[0].workspaceId).toBe('alpha-1a2b3c');
  });

  it('keeps an Elsewhere row even when its name matches a workspace agent id', () => {
    const items = toObservedItems([row({ name: 'support-bot', project: 'unrelated' })], WS);
    expect(items).toHaveLength(1);
    expect(items[0].workspaceId).toBeNull();
  });

  it('aggregates lastSeenAt (max heartbeat), runsToday and run-weighted errorRateToday', () => {
    const items = toObservedItems(
      [
        row({ name: 'svc', project: 'ci', agent_id: 'a', last_heartbeat: 5000, first_seen: 100, runs_today: 10, error_rate_today: 0.5 }),
        row({ name: 'svc', project: 'ci', agent_id: 'b', last_heartbeat: null, first_seen: 3000, runs_today: 30, error_rate_today: 0.1 }),
      ],
      []
    );
    const svc = items[0];
    expect(svc.lastSeenAt).toBe(new Date(5000).toISOString());
    expect(svc.runsToday).toBe(40);
    expect(svc.errorRateToday).toBeCloseTo((0.5 * 10 + 0.1 * 30) / 40);
    expect(svc.id).toBe('a'); // newest instance's agent_id
  });

  it('a null name keeps agent_id as the name; null project lands in Elsewhere', () => {
    const items = toObservedItems([row({ name: null, project: null, agent_id: 'anon-1' })], WS);
    expect(items[0].name).toBe('anon-1');
    expect(items[0].project).toBeNull();
    expect(items[0].workspaceId).toBeNull();
  });

  it('matches on the workspace id itself (LOUSHO_OBSERVE_PROJECT=<id>)', () => {
    const items = toObservedItems([row({ name: 'deployed', project: 'beta-2b3c4d' })], WS);
    expect(items[0].workspaceId).toBe('beta-2b3c4d');
  });
});

describe('fetchDaemonAgents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the agents array on a 200', async () => {
    const agents = [row({})];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agents }), { status: 200 })));
    await expect(fetchDaemonAgents()).resolves.toEqual(agents);
  });

  it('answers undefined on a non-2xx and on a bad body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(fetchDaemonAgents()).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })));
    await expect(fetchDaemonAgents()).resolves.toBeUndefined();
  });

  it('answers undefined on a fetch failure (daemon down)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    await expect(fetchDaemonAgents()).resolves.toBeUndefined();
  });
});
