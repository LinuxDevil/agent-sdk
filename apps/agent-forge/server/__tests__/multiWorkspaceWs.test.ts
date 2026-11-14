import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { startStudioServer, type StudioServerHandle } from '../index';
import { deferred, resetSteerGate, setSteerGateScript } from './steerGate';

/**
 * W02b end to end: `startStudioServer` with a second workspace registered
 * through `POST /workspaces`, then real WebSocket clients. `?ws=<id>`
 * picks the workspace on `WS /agents/:id/stream` and `WS /events`;
 * refused upgrades answer plain HTTP statuses, and the token gate still
 * runs before workspace resolution (401 wins over a bad `?ws=`).
 */

const TOKEN = 'w02b-test-token';

const STEER_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'stream-agent',
  model: 'steergate/steer-1',
  instructions: 'You are a test agent.',
};

/** One JSON message off a ws socket, or `undefined` after `ms`. */
function nextMessage(ws: WebSocket, ms = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), ms);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
  });
}

/** The HTTP status a refused upgrade answers with. */
function upgradeStatus(url: string): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
    ws.once('error', (err) => {
      const match = /Unexpected server response: (\d+)/.exec(err.message);
      resolve(match ? Number(match[1]) : -1);
    });
  });
}

function wsUrl(handle: StudioServerHandle, path: string, query = ''): string {
  return `ws://127.0.0.1:${handle.port}${path}?token=${TOKEN}${query}`;
}

describe('WebSocket ?ws= workspace selection', () => {
  let dir: string;
  let launchDir: string;
  let otherDir: string;
  let handle: StudioServerHandle | undefined;
  let otherId: string;

  const api = () => request(`http://127.0.0.1:${handle!.port}`);

  beforeEach(() => {
    resetSteerGate();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w02b-ws-'));
    launchDir = path.join(dir, 'launch');
    otherDir = path.join(dir, 'other');
    fs.mkdirSync(launchDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<void> {
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
    const added = await api()
      .post('/workspaces')
      .set('x-lousho-studio-token', TOKEN)
      .send({ root: otherDir });
    expect(added.status).toBe(201);
    otherId = added.body.id;
  }

  it('?ws=<B> streams B\'s run status; no ws streams the launch workspace', async () => {
    await boot();
    // B's 'stream-agent' run parks on the steergate gate -> 'running'.
    const gate = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gate.promise });
    const run = await api()
      .post('/agents/stream-agent/run')
      .set('x-lousho-studio-token', TOKEN)
      .set('x-lousho-workspace', otherId)
      .send({ input: 'hi', spec: STEER_SPEC });
    expect(run.status).toBe(202);

    const wsB = new WebSocket(wsUrl(handle!, '/agents/stream-agent/stream', `&ws=${otherId}`));
    const wsA = new WebSocket(wsUrl(handle!, '/agents/stream-agent/stream'));
    try {
      const statusB = (await nextMessage(wsB)) as { type: string; payload: { status: string } };
      expect(statusB.type).toBe('status');
      expect(statusB.payload.status).toBe('running');

      const statusA = (await nextMessage(wsA)) as { type: string; payload: { status: string } };
      expect(statusA.type).toBe('status');
      expect(statusA.payload.status).toBe('idle');
    } finally {
      wsA.close();
      wsB.close();
      gate.resolve();
    }
  });

  it('?ws=<B> on /events carries B\'s agent.changed; the launch socket does not', async () => {
    await boot();
    const wsB = new WebSocket(wsUrl(handle!, '/events', `&ws=${otherId}`));
    const wsA = new WebSocket(wsUrl(handle!, '/events'));
    try {
      await new Promise<void>((resolve, reject) => {
        let open = 0;
        const onOpen = () => (++open === 2 ? resolve() : undefined);
        wsA.once('open', onOpen);
        wsB.once('open', onOpen);
        wsA.once('error', reject);
        wsB.once('error', reject);
      });
      const put = await api()
        .put('/agents/ev-agent')
        .set('x-lousho-studio-token', TOKEN)
        .set('x-lousho-workspace', otherId)
        .send({ spec: { version: 2, name: 'ev-agent', model: 'mock/mock-1', instructions: 'Check the queues.' } });
      expect(put.status).toBe(204);

      const eventB = (await nextMessage(wsB)) as { type: string; agentId: string };
      expect(eventB.type).toBe('agent.changed');
      expect(eventB.agentId).toBe('ev-agent');

      // A's bus never saw it: nothing arrives in a beat.
      const got = await Promise.race([
        nextMessage(wsA, 400).then(() => true, () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400)),
      ]);
      expect(got).toBe(false);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it('bad, unknown and missing-token upgrades are refused before workspace resolution', async () => {
    await boot();
    expect(await upgradeStatus(wsUrl(handle!, '/events', '&ws=nope!'))).toBe(400);
    expect(await upgradeStatus(wsUrl(handle!, '/events', '&ws=ghost-abc123'))).toBe(404);
    // No token at all: the shared gate answers 401 even with a bad ?ws=.
    expect(await upgradeStatus(`ws://127.0.0.1:${handle!.port}/events?ws=nope!`)).toBe(401);
  });
});
