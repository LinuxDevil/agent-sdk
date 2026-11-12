/**
 * R08b - channel triggers: `channelFromTrigger` secret mapping, per-agent
 * mount/status, the `/hooks/:agentId/channel/<kind>` middleware (filter
 * skip, abort listeners, raw-byte replay into the SDK handler) and the
 * remount-on-spec-change contract.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createAgent, type AgentSpecV2, type SimpleAgent } from 'lousho';
import { mockModel } from 'lousho/testing';
import type { SecretRef, TriggerSpec } from 'lousho/spec';

import { AgentRepo } from '../storage/agentRepo';
import { DraftStore } from '../storage/draftStore';
import { SuggestionStore } from '../storage/suggestionStore';
import { VersionStore } from '../storage/versionStore';
import { IdleVersioner } from '../storage/idleVersioner';
import { StudioEventBus } from '../events/eventBus';
import { PassRunner } from '../passes/passRunner';
import { createApp } from '../app';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { AgentHost } from '../host/agentHost';
import type { RunManager } from '../runRegistry';
import type { InboxService } from '../inbox/inboxService';
import type { CronTriggers } from '../triggers/cronTriggers';
import type { WorkspaceContext } from '../workspace/context';
import { workspaceRefFor } from '../workspace/workspaceId';
import { TriggerRegistry } from 'lousho/triggers';
import {
  CHANNEL_SECRET_KEYS,
  ChannelTriggers,
  channelFromTrigger,
  type ChannelKind,
  type ChannelTrigger,
} from '../triggers/channelTriggers';
import type { HostRun, TriggerHost } from '../triggers/triggerHost';

const AGENT = 'a1';

const HTTP_TRIGGER: ChannelTrigger = { id: 't-http', type: 'channel', channel: 'http', secrets: {} };

function specWith(triggers: TriggerSpec[], extra: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'chan-agent',
    model: 'mock/mock-1',
    instructions: 'Answer briefly.',
    triggers,
    ...extra,
  } as AgentSpecV2;
}

/** Resolves `{ secret: name }` from `secrets`, `{ env: name }` from the env, strings pass through. */
function resolver(secrets: Record<string, string>) {
  return (ref: SecretRef | string): string | undefined => {
    if (typeof ref === 'string') return ref;
    if ('env' in ref) return process.env[ref.env];
    return secrets[ref.secret];
  };
}

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-triggers-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  app: Express;
  channels: ChannelTriggers;
  repo: AgentRepo;
  buildAgent: ReturnType<typeof vi.fn<[agentId: string], Promise<SimpleAgent>>>;
  host: {
    runsOf: ReturnType<typeof vi.fn<[agentId: string], HostRun[]>>;
    cancel: ReturnType<typeof vi.fn<[runKey: string, reason: string], 'queued' | 'running' | undefined>>;
    isEnabled: ReturnType<typeof vi.fn<[agentId: string], boolean>>;
  };
  baseDir: string;
}

async function harness(
  spec: AgentSpecV2,
  options: { secrets?: Record<string, string>; agent?: SimpleAgent; runs?: HostRun[]; enabled?: boolean } = {}
): Promise<Harness> {
  const baseDir = tmpDir();
  const repo = new AgentRepo(baseDir);
  await repo.writeSpec(AGENT, spec);
  const buildAgent = vi.fn<[agentId: string], Promise<SimpleAgent>>(async () => {
    if (options.agent !== undefined) return options.agent;
    return createAgent({ provider: mockModel(['Pong']) }) as unknown as SimpleAgent;
  });
  const host = {
    runsOf: vi.fn<[agentId: string], HostRun[]>(() => options.runs ?? []),
    cancel: vi.fn<[runKey: string, reason: string], 'queued' | 'running' | undefined>(() => 'queued'),
    isEnabled: vi.fn<[agentId: string], boolean>(() => options.enabled ?? true),
  };
  const channels = new ChannelTriggers({
    host: host as unknown as TriggerHost,
    repo,
    buildAgent,
    resolve: resolver(options.secrets ?? {}),
    log: vi.fn(),
  });
  await channels.mount(AGENT);
  const app = express();
  const handler = channels.handler();
  app.use((req, res, next) => handler(req, res, next));
  return { app, channels, repo, buildAgent, host, baseDir };
}

describe('channelFromTrigger', () => {
  // Every SecretRef resolves to a factory-valid non-empty value (the refs
  // are named `s-<key>`, so discord's publicKey gets real hex).
  const resolveAll = (ref: SecretRef | string): string | undefined => {
    if (typeof ref === 'string') return ref;
    if ('env' in ref) return process.env[ref.env];
    return ref.secret === 's-publicKey' ? 'ab'.repeat(32) : 'resolved';
  };

  for (const kind of Object.keys(CHANNEL_SECRET_KEYS) as ChannelKind[]) {
    it(`builds the ${kind} channel when every required secret resolves`, () => {
      const trigger: ChannelTrigger = {
        id: `t-${kind}`,
        type: 'channel',
        channel: kind,
        secrets: Object.fromEntries(
          [...CHANNEL_SECRET_KEYS[kind].required, ...CHANNEL_SECRET_KEYS[kind].optional].map((key) => [
            key,
            { secret: `s-${key}` },
          ])
        ),
      };
      const made = channelFromTrigger(trigger, resolveAll);
      expect('channel' in made).toBe(true);
      if ('channel' in made) expect(made.channel.name).toBe(kind);
    });
  }

  it('reports the first missing required key by name only', () => {
    const trigger: ChannelTrigger = {
      id: 't-tg',
      type: 'channel',
      channel: 'telegram',
      secrets: { botToken: { secret: 'bt' } },
    };
    expect(channelFromTrigger(trigger, resolver({ bt: 'x' }))).toEqual({
      error: 'Channel telegram needs secretToken',
    });
  });

  it('treats an unresolved optional key as absent, not an error', () => {
    const trigger: ChannelTrigger = {
      id: 't-tg',
      type: 'channel',
      channel: 'telegram',
      secrets: {
        botToken: { secret: 'bt' },
        secretToken: { secret: 'st' },
        botUsername: { secret: 'missing' },
      },
    };
    const made = channelFromTrigger(trigger, resolver({ bt: 'x', st: 'y' }));
    expect('channel' in made).toBe(true);
  });

  it("falls back to the spec name for github's botName", () => {
    const trigger: ChannelTrigger = {
      id: 't-gh',
      type: 'channel',
      channel: 'github',
      secrets: { webhookSecret: { secret: 'wh' }, token: { secret: 'tok' } },
    };
    const made = channelFromTrigger(trigger, resolver({ wh: 'x', tok: 'y' }), 'my-agent');
    expect('channel' in made).toBe(true);
    // No botName secret and no specName -> still an error naming the key.
    expect(channelFromTrigger(trigger, resolver({ wh: 'x', tok: 'y' }))).toEqual({
      error: 'Channel github needs botName',
    });
  });
});

describe('ChannelTriggers.mount / status', () => {
  it('serves the http channel end to end through the SDK handler', async () => {
    const replies = ['Pong', 'Again'];
    const agent = createAgent({ provider: mockModel(replies) });
    const { app, channels, buildAgent } = await harness(specWith([HTTP_TRIGGER]), {
      agent: agent as unknown as SimpleAgent,
    });

    const first = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u1', input: 'ping' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ text: 'Pong', finishReason: 'stop' });

    // Same session continues the conversation; the next scripted reply lands.
    const second = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u1', input: 'ping again' });
    expect(second.status).toBe(200);
    expect(second.body.text).toBe('Again');
    expect(buildAgent).toHaveBeenCalledWith(AGENT);

    expect(channels.status(AGENT)).toEqual([
      { triggerId: 't-http', channel: 'http', url: `/hooks/${AGENT}/channel/http`, error: null },
    ]);
  });

  it('answers 200 skipped disabled for a turned-off agent and never calls the SDK handler (R09)', async () => {
    const agent = createAgent({ provider: mockModel(['Pong']) });
    const { app } = await harness(specWith([HTTP_TRIGGER]), {
      agent: agent as unknown as SimpleAgent,
      enabled: false,
    });

    const res = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u1', input: 'ping' });

    expect(res.status).toBe(200);
    // The SDK handler's `{ text }` reply never happens - platforms see the skip.
    expect(res.body).toEqual({ ok: true, skipped: 'disabled' });
  });

  it('answers 404-shaped fallthrough for a channel path with no mounted trigger', async () => {
    const { app } = await harness(specWith([HTTP_TRIGGER]));
    const res = await request(app).post(`/hooks/${AGENT}/channel/telegram`).send('{}');
    // No telegram trigger mounted -> next() -> express default 404.
    expect(res.status).toBe(404);
  });

  it('does not serve a trigger whose required secret is missing, and status names the key', async () => {
    // The spec schema requires the secretToken KEY; the mount error covers
    // the SecretRef that does not resolve to a value.
    const tg: ChannelTrigger = {
      id: 't-tg',
      type: 'channel',
      channel: 'telegram',
      secrets: { botToken: { secret: 'bt' }, secretToken: { secret: 'st' } },
    };
    const { app, channels, buildAgent } = await harness(specWith([tg]), { secrets: { bt: 'x' } });

    expect(channels.status(AGENT)).toEqual([
      {
        triggerId: 't-tg',
        channel: 'telegram',
        url: `/hooks/${AGENT}/channel/telegram`,
        error: 'Channel telegram needs secretToken',
      },
    ]);
    expect(buildAgent).not.toHaveBeenCalled();
    const res = await request(app).post(`/hooks/${AGENT}/channel/telegram`).send('{}');
    expect(res.status).toBe(404);
  });

  it('serves only the first of two triggers on the same channel kind', async () => {
    const mk = (id: string): ChannelTrigger => ({
      id,
      type: 'channel',
      channel: 'telegram',
      secrets: { botToken: { secret: 'bt' }, secretToken: { secret: 'st' } },
    });
    const { channels } = await harness(specWith([mk('t1'), mk('t2')]), {
      secrets: { bt: 'x', st: 'y' },
      agent: createAgent({ provider: mockModel(['ok']) }) as unknown as SimpleAgent,
    });

    const rows = channels.status(AGENT);
    expect(rows.find((r) => r.triggerId === 't1')?.error).toBeNull();
    expect(rows.find((r) => r.triggerId === 't2')?.error).toBe('Only one telegram channel per agent');
  });

  it('remounts on spec change: the next request runs the rebuilt agent', async () => {
    const first = createAgent({ provider: mockModel(['First']) });
    const { app, repo, channels, buildAgent } = await harness(specWith([HTTP_TRIGGER]), {
      agent: first as unknown as SimpleAgent,
    });

    const before = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 's', input: 'hi' });
    expect(before.body.text).toBe('First');

    // Edit the working copy (new instructions -> the host reloads -> onReload remounts).
    await repo.writeSpec(AGENT, specWith([HTTP_TRIGGER], { instructions: 'Answer differently.' }));
    buildAgent.mockImplementation(async () => createAgent({ provider: mockModel(['Second']) }) as unknown as SimpleAgent);
    await channels.mount(AGENT);

    const after = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 's2', input: 'hi' });
    expect(after.body.text).toBe('Second');
    expect(buildAgent).toHaveBeenCalledTimes(2);
  });
});

describe('channel request pipeline', () => {
  it('skips the SDK handler with 200 { ok, skipped: filter } when the filter is not true', async () => {
    const filtered: ChannelTrigger = { ...HTTP_TRIGGER, filter: 'event.body.input === "go"' };
    const agent = createAgent({ provider: mockModel(['Pong', 'Pong']) });
    const { app } = await harness(specWith([filtered]), { agent: agent as unknown as SimpleAgent });

    const skipped = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u1', input: 'stop' });
    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({ ok: true, skipped: 'filter' });

    const kept = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u1', input: 'go' });
    expect(kept.status).toBe(200);
    expect(kept.body.text).toBe('Pong');
  });

  it('replays the exact raw bytes to the SDK handler (signature verification sees them)', async () => {
    // Slack's signing secret is checked over the raw body; a body whose
    // bytes would change under re-serialization (key order/whitespace)
    // must still verify. Sign it by hand with the real algorithm.
    const { createHmac } = await import('node:crypto');
    const body = '{"token":"x","team_id":"T1","type":"event_callback","event":{"type":"message","text":"hi"}}';
    const signingSecret = 'slack-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const basestring = `v0:${timestamp}:${body}`;
    const signature = `v0=${createHmac('sha256', signingSecret).update(basestring).digest('hex')}`;

    const slack: ChannelTrigger = {
      id: 't-slack',
      type: 'channel',
      channel: 'slack',
      secrets: { signingSecret: { secret: 'ss' }, botToken: { secret: 'bt' } },
    };
    // A slack event the SDK parses but whose session turn we do not need to
    // inspect - a wrong/altered body fails signature first (401), the exact
    // bytes pass it (any non-401 proves the replay preserved them).
    const { app } = await harness(specWith([slack]), {
      secrets: { ss: signingSecret, bt: 'xoxb-fake' },
      agent: createAgent({ provider: mockModel(['ok']) }) as unknown as SimpleAgent,
    });

    // A tampered signature over the same bytes must still 401 - proving the
    // SDK verified the replayed raw body, not a re-serialized one.
    const bad = await request(app)
      .post(`/hooks/${AGENT}/channel/slack`)
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', 'v0=deadbeef')
      .send(body);
    expect(bad.status).toBe(401);

    const res = await request(app)
      .post(`/hooks/${AGENT}/channel/slack`)
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', signature)
      .send(body);

    expect(res.status).not.toBe(401);
  });

  it('runs abort listeners before SDK handling and does not block the request', async () => {
    const run: HostRun = {
      runKey: 'rk-old',
      agentId: AGENT,
      triggerId: 't-http',
      event: { input: 'old request' },
      input: 'old request',
      status: 'queued',
      enqueuedAt: '2026-01-01T00:00:00.000Z',
    };
    const spec = specWith(
      [HTTP_TRIGGER],
      {
        abortListeners: [
          {
            id: 'l1',
            triggerId: 't-http',
            when: 'event.channel == "http"',
            match: 'run.event.input == "old request"',
            scope: 'both',
          },
        ],
      } as Partial<AgentSpecV2>
    );
    const agent = createAgent({ provider: mockModel(['Pong']) });
    const { app, host } = await harness(spec, {
      agent: agent as unknown as SimpleAgent,
      runs: [run],
    });

    const res = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u1', input: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('Pong');
    expect(host.cancel).toHaveBeenCalledWith('rk-old', 'abort_listener:l1');
    // The event the listener matched on carries channel + lower-cased header names + parsed body.
    expect(host.runsOf).toHaveBeenCalledWith(AGENT);
  });
});

describe('channel route inside createApp', () => {
  const emptyStore: LegacyAgentStore = {
    list: async () => [],
    load: async () => undefined,
    save: async () => {},
    remove: async () => {},
  };

  it('serves the channel before the /hooks raw-body middleware can consume the stream', async () => {
    const baseDir = tmpDir();
    const repo = new AgentRepo(baseDir);
    await repo.writeSpec(AGENT, specWith([HTTP_TRIGGER]));
    const channels = new ChannelTriggers({
      host: { runsOf: () => [], cancel: () => undefined, isEnabled: () => true } as unknown as TriggerHost,
      repo,
      buildAgent: async () => createAgent({ provider: mockModel(['ViaApp']) }) as unknown as SimpleAgent,
      resolve: resolver({}),
      log: vi.fn(),
    });
    await channels.mount(AGENT);

    const workspace: WorkspaceContext = {
      ref: workspaceRefFor(baseDir),
      repo,
      agentStore: emptyStore,
      versions: new VersionStore(repo),
      drafts: new DraftStore(repo),
      idleVersioner: new IdleVersioner({ capture: async () => {} }),
      suggestions: new SuggestionStore(repo),
      host: {} as AgentHost,
      runs: {} as RunManager,
      chatTriggers: new TriggerRegistry(),
      events: new StudioEventBus(),
      passes: new PassRunner({ baseDir }),
      inbox: {} as InboxService,
      triggers: {} as TriggerHost,
      cron: {} as CronTriggers,
      channels,
    };
    const app = createApp({ workspace, baseDir });

    const res = await request(app)
      .post(`/hooks/${AGENT}/channel/http`)
      .set('content-type', 'application/json')
      .send({ sessionKey: 'u9', input: 'ping' });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('ViaApp');
  });
});
