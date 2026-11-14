import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { startStudioServer, type StudioServerHandle } from '../index';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { createUpgradeRouter } from '../ws/upgradeRouter';
import { attachEventsWebSocket, type AllEventsDeps } from '../events/eventsWs';
import { StudioEventBus } from '../events/eventBus';
import { AlertStore } from '../inbox/alertStore';
import { AgentRepo } from '../storage/agentRepo';
import type { WorkspaceContext, WorkspaceResolver } from '../workspace/context';
import type { WorkspaceEntry } from '../workspace/workspaceRegistry';
import type { AllEventsFrame } from '../../shared/wireTypes';

const TOKEN = 'w09a-events-token';

const SPEC: AgentSpecV2 = { version: 2, name: 'ev-agent', model: 'mock/mock-1', instructions: 'Check the queues.' };

/** The frames a socket collects, with a waiter per predicate. */
function collector(ws: WebSocket): { frames: AllEventsFrame[]; waitFor(pred: (f: AllEventsFrame) => boolean, ms?: number): Promise<AllEventsFrame> } {
  const frames: AllEventsFrame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as AllEventsFrame));
  return {
    frames,
    waitFor(pred, ms = 5000) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + ms;
        const tick = () => {
          const found = frames.find(pred);
          if (found) return resolve(found);
          if (Date.now() > deadline) return reject(new Error('timed out waiting for a WS frame'));
          setTimeout(tick, 10);
        };
        tick();
      });
    },
  };
}

describe('WS /events?ws=all (startStudioServer)', () => {
  let dir: string;
  let launchDir: string;
  let otherDir: string;
  let handle: StudioServerHandle | undefined;
  let launchId: string;
  let otherId: string;

  const api = () => request(`http://127.0.0.1:${handle!.port}`);
  const wsUrl = (path: string, query = '') => `ws://127.0.0.1:${handle!.port}${path}?token=${TOKEN}${query}`;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w09a-events-'));
    launchDir = path.join(dir, 'launch');
    otherDir = path.join(dir, 'other');
    fs.mkdirSync(launchDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    handle = await startStudioServer({
      port: 0,
      host: '127.0.0.1',
      baseDir: launchDir,
      studioHome: path.join(dir, 'studio-home'),
      staticDir: false,
      observe: false,
      judge: false,
      token: TOKEN,
    });
    const list = await api().get('/workspaces').set(STUDIO_TOKEN_HEADER, TOKEN);
    launchId = list.body.defaultId;
    const added = await api().post('/workspaces').set(STUDIO_TOKEN_HEADER, TOKEN).send({ root: otherDir });
    expect(added.status).toBe(201);
    otherId = added.body.id;
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forwards every workspace\'s events tagged with workspaceId, joining contexts built later', async () => {
    const ws = new WebSocket(wsUrl('/events', '&ws=all'));
    const { waitFor } = collector(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      // The connect-time Studio-wide count frame.
      const initial = await waitFor((f) => f.type === 'inbox.count' && f.workspaceId === 'all');
      expect(initial).toMatchObject({ type: 'inbox.count', workspaceId: 'all' });

      // Launch workspace's event.
      const putA = await api().put('/agents/ev-a').set(STUDIO_TOKEN_HEADER, TOKEN).send({ spec: SPEC });
      expect(putA.status).toBe(204);
      const frameA = await waitFor((f) => f.type === 'agent.changed' && f.agentId === 'ev-a');
      expect(frameA).toMatchObject({ type: 'agent.changed', agentId: 'ev-a', workspaceId: launchId });

      // B's first request builds its context - onBuilt must attach it to
      // the already-open aggregate socket.
      const putB = await api()
        .put('/agents/ev-b')
        .set(STUDIO_TOKEN_HEADER, TOKEN)
        .set('x-lousho-workspace', otherId)
        .send({ spec: SPEC });
      expect(putB.status).toBe(204);
      const frameB = await waitFor((f) => f.type === 'agent.changed' && f.agentId === 'ev-b');
      expect(frameB).toMatchObject({ type: 'agent.changed', agentId: 'ev-b', workspaceId: otherId });
    } finally {
      ws.close();
    }
  });

  it('republishes the Studio-wide inbox.count after a draft lands in a built-later workspace', async () => {
    const ws = new WebSocket(wsUrl('/events', '&ws=all'));
    const { frames, waitFor } = collector(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const initial = await waitFor((f) => f.type === 'inbox.count' && f.workspaceId === 'all');
      const startCount = (initial as { count: number }).count;

      // Build B, then create a pending draft there: B's InboxService
      // recounts (250 ms debounce) and publishes its own inbox.count,
      // which the aggregate socket turns into a fresh 'all' total.
      await api().put('/agents/drafty').set(STUDIO_TOKEN_HEADER, TOKEN).set('x-lousho-workspace', otherId).send({ spec: SPEC });
      const draft = await api()
        .post('/agents/drafty/draft')
        .set(STUDIO_TOKEN_HEADER, TOKEN)
        .set('x-lousho-workspace', otherId)
        .send({ patch: { description: 'x' }, origin: 'manual', reason: 'r' });
      expect(draft.status).toBe(201);

      const bumped = await waitFor(
        (f) => f.type === 'inbox.count' && f.workspaceId === 'all' && (f as { count: number }).count > startCount,
        8000
      );
      expect((bumped as { count: number }).count).toBe(startCount + 1);
      // B's own per-workspace count frame also crossed the socket, tagged.
      expect(frames.some((f) => f.type === 'inbox.count' && f.workspaceId === otherId)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it('?ws=all does not retain workspaces - the resolver\'s retain stays untouched', async () => {
    // Router-level: a fake resolver records retain calls; the aggregate
    // branch must subscribe buses without holding any context warm.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w09a-retain-'));
    try {
      const entry = {
        id: 'wa-aaaaaa',
        name: 'wa',
        root,
        addedAt: '',
        lastOpenedAt: '',
      } as WorkspaceEntry;
      const retainCalls: string[] = [];
      const ctx = {
        ref: entry,
        repo: new AgentRepo(root),
        events: new StudioEventBus(),
        inbox: { list: async () => [] },
      } as unknown as WorkspaceContext;
      const resolver: WorkspaceResolver = {
        resolve: async (id) => (id === undefined || id === entry.id ? ctx : undefined),
        defaultId: () => entry.id,
        retain: (id) => {
          retainCalls.push(id);
          return () => {};
        },
      };
      const registry = { list: async () => [entry] } as unknown as AllEventsDeps['registry'];
      const alerts = new AlertStore(path.join(root, 'alerts.json'));
      const deps: AllEventsDeps = {
        registry,
        warm: () => [ctx],
        alerts,
        onBuilt: () => () => {},
        onDisposed: () => () => {},
      };
      const server = http.createServer((_req, res) => res.end('ok'));
      const router = createUpgradeRouter(server);
      attachEventsWebSocket(router, resolver, deps);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
        const all = new WebSocket(`ws://127.0.0.1:${port}/events?ws=all`);
        await new Promise<void>((resolve, reject) => {
          all.once('open', () => resolve());
          all.once('error', reject);
        });
        // The connect-time count frame proves the aggregate path ran.
        const first = await new Promise<AllEventsFrame>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no count frame')), 3000);
          all.once('message', (data) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(data)) as AllEventsFrame);
          });
        });
        expect(first).toMatchObject({ type: 'inbox.count', workspaceId: 'all' });
        all.close();

        const single = new WebSocket(`ws://127.0.0.1:${port}/events?ws=${entry.id}`);
        await new Promise<void>((resolve, reject) => {
          single.once('open', () => resolve());
          single.once('error', reject);
        });
        single.close();
        expect(retainCalls).toEqual([entry.id]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
