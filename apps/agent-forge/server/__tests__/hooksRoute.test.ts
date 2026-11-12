import { createHmac } from 'node:crypto';

import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { TriggerRegistry } from 'lousho/triggers';
import type { TriggerSpec } from 'lousho/spec';

import { createApp } from '../app';
import { SecretsStore } from '../secretsStore';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import type { RunManager } from '../runRegistry';
import type { AgentHost } from '../host/agentHost';
import { AgentRepo } from '../storage/agentRepo';
import { DraftStore } from '../storage/draftStore';
import { SuggestionStore } from '../storage/suggestionStore';
import { VersionStore } from '../storage/versionStore';
import { IdleVersioner } from '../storage/idleVersioner';
import { StudioEventBus } from '../events/eventBus';
import { PassRunner } from '../passes/passRunner';
import type { InboxService } from '../inbox/inboxService';
import type { HostRun, TriggerHost } from '../triggers/triggerHost';
import type { ChannelTriggers } from '../triggers/channelTriggers';
import type { CronTriggers } from '../triggers/cronTriggers';
import type { WorkspaceContext } from '../workspace/context';
import { workspaceRefFor } from '../workspace/workspaceId';

const AGENT = 'agent1';
const SECRET = 's3cr3t';

const SIGNED: TriggerSpec = {
  id: 't1',
  type: 'webhook',
  path: '/hooks/t1',
  promptTemplate: 'Event: {{event.action}}',
  secret: { secret: 'wh' },
};

const OPEN: TriggerSpec = {
  id: 't2',
  type: 'webhook',
  path: '/hooks/open',
  promptTemplate: 'Got {{event.body}}',
};

const FILTERED: TriggerSpec = {
  id: 't3',
  type: 'webhook',
  path: '/hooks/filtered',
  promptTemplate: 'run it',
  filter: 'event.action === "deploy"',
};

const EMPTY: TriggerSpec = {
  id: 't4',
  type: 'webhook',
  path: '/hooks/empty',
  promptTemplate: '{{event.nothing}}',
};

const emptyStore: LegacyAgentStore = {
  list: async () => [],
  load: async () => undefined,
  save: async () => {},
  remove: async () => {},
};

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function appWith(
  triggers: TriggerSpec[],
  dispatch: Mock = vi.fn(() => ({ ok: true as const, runKey: 'rk1', started: true })),
  hostExtra: Record<string, unknown> = {}
) {
  const baseDir = `/tmp/hooks-${Math.random().toString(36).slice(2)}`;
  const repo = new AgentRepo(baseDir);
  const host = {
    triggersOf: () => triggers,
    dispatch,
    runsOf: () => [],
    cancel: () => undefined,
    isEnabled: () => true,
    log: () => {},
    ...hostExtra,
  } as unknown as TriggerHost;
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
    triggers: host,
    cron: {} as CronTriggers,
    channels: {} as ChannelTriggers,
  };
  const secrets = new SecretsStore(baseDir);
  secrets.setSecret('wh', SECRET);
  const app = createApp({ workspace, baseDir, secretsStore: secrets });
  return { app: app as Express, dispatch, repo };
}

describe('POST /hooks/:agentId/<path>', () => {
  it('accepts a valid HMAC signature and dispatches the rendered prompt', async () => {
    const { app, dispatch } = appWith([SIGNED]);
    const body = JSON.stringify({ action: 'deploy' });
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/t1`)
      .set('content-type', 'application/json')
      .set('x-signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, runKey: 'rk1', started: true, cancelled: [] });
    expect(dispatch).toHaveBeenCalledWith({
      agentId: AGENT,
      triggerId: 't1',
      input: 'Event: deploy',
      event: { action: 'deploy' },
    });
  });

  it('rejects a wrong signature with 401', async () => {
    const { app, dispatch } = appWith([SIGNED]);
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/t1`)
      .set('content-type', 'application/json')
      .set('x-signature-256', sign('{}', 'wrong'))
      .send('{}');

    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('accepts an unsigned trigger from a loopback Host', async () => {
    const { app, dispatch } = appWith([OPEN]);
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/open`)
      .set('host', '127.0.0.1:4750')
      .send('plain text body');

    expect(res.status).toBe(202);
    // Non-JSON bodies become { body: <text> } for the template scope.
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ input: 'Got plain text body' }));
  });

  it('rejects an unsigned trigger from a non-loopback Host with the local-calls message', async () => {
    const { app, dispatch } = appWith([OPEN]);
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/open`)
      .set('host', 'staging.example.com')
      .send('x');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This webhook has no secret, so it only accepts local calls.');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips dispatch when the filter evaluates non-true', async () => {
    const { app, dispatch } = appWith([FILTERED]);
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/filtered`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ action: 'push' }));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ skipped: 'filter' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('runs the trigger when the filter passes', async () => {
    const { app, dispatch } = appWith([FILTERED]);
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/filtered`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ action: 'deploy' }));

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
    expect(dispatch).toHaveBeenCalled();
  });

  it('answers 422 when the template renders empty', async () => {
    const { app, dispatch } = appWith([EMPTY]);
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/empty`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({}));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('The prompt template rendered empty.');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown agent/path', async () => {
    const { app } = appWith([SIGNED]);
    const res = await request(app).post(`/hooks/${AGENT}/hooks/nope`).send('{}');
    expect(res.status).toBe(404);
  });

  it('maps queue_full to 429 LOUSHO_TRIGGER_QUEUE_FULL', async () => {
    const dispatch = vi.fn(() => ({ ok: false as const, reason: 'queue_full' as const }));
    const { app } = appWith([OPEN], dispatch);
    const res = await request(app).post(`/hooks/${AGENT}/hooks/open`).send('x');

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LOUSHO_TRIGGER_QUEUE_FULL');
  });

  it('runs abort listeners before dispatch and reports the cancelled runKeys (R03b)', async () => {
    // The queued run event 1 started; event 2's `when`/`match` pair it.
    const runs: HostRun[] = [
      {
        runKey: 't2:run1',
        agentId: AGENT,
        triggerId: 't2',
        event: { pr: 7, action: 'opened' },
        input: 'Got {"pr":7,"action":"opened"}',
        status: 'queued',
        enqueuedAt: new Date().toISOString(),
      },
    ];
    const cancelled: Array<{ runKey: string; reason: string }> = [];
    const { app, repo } = appWith([OPEN], undefined, {
      runsOf: () => runs,
      cancel: (runKey: string, reason: string) => {
        const found = runs.find((r) => r.runKey === runKey);
        if (found === undefined) return undefined;
        cancelled.push({ runKey, reason });
        runs.splice(runs.indexOf(found), 1);
        return found.status;
      },
    });
    await repo.writeSpec(AGENT, {
      version: 2,
      name: 'agent1',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Help.',
      triggers: [{ id: 't2', type: 'webhook', path: '/open', promptTemplate: 'Got {{event.body}}' }],
      abortListeners: [
        {
          id: 'l1',
          triggerId: 't2',
          when: "event.action == 'closed'",
          match: 'run.event.pr == event.pr',
          scope: 'both',
        },
      ],
    });

    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/open`)
      .set('host', '127.0.0.1:4750')
      .send(JSON.stringify({ pr: 7, action: 'closed' }));

    expect(res.status).toBe(202);
    expect(res.body.cancelled).toEqual(['t2:run1']);
    expect(cancelled).toEqual([{ runKey: 't2:run1', reason: 'abort_listener:l1' }]);
  });

  it('does not cancel a run for a different PR (R03b match scope)', async () => {
    const runs: HostRun[] = [
      {
        runKey: 't2:run1',
        agentId: AGENT,
        triggerId: 't2',
        event: { pr: 8, action: 'opened' },
        input: 'x',
        status: 'running',
        enqueuedAt: new Date().toISOString(),
      },
    ];
    const cancel = vi.fn(() => 'running' as const);
    const { app, repo } = appWith([OPEN], undefined, { runsOf: () => runs, cancel });
    await repo.writeSpec(AGENT, {
      version: 2,
      name: 'agent1',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Help.',
      triggers: [{ id: 't2', type: 'webhook', path: '/open', promptTemplate: 'Got {{event.body}}' }],
      abortListeners: [
        {
          id: 'l1',
          triggerId: 't2',
          when: "event.action == 'closed'",
          match: 'run.event.pr == event.pr',
          scope: 'both',
        },
      ],
    });

    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/open`)
      .set('host', '127.0.0.1:4750')
      .send(JSON.stringify({ pr: 7, action: 'closed' }));

    expect(res.status).toBe(202);
    expect(res.body.cancelled).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('answers 409 LOUSHO_AGENT_DISABLED for a turned-off agent after auth (R09)', async () => {
    const { app, dispatch } = appWith([SIGNED], undefined, { isEnabled: () => false });
    const body = JSON.stringify({ action: 'deploy' });
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/t1`)
      .set('content-type', 'application/json')
      .set('x-signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOUSHO_AGENT_DISABLED');
    expect(res.body.error).toBe('Agent is turned off');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still rejects an unauthenticated call on a disabled agent before the enabled gate (R09)', async () => {
    // Auth runs first: an unsigned remote call gets 403, never the 409 that
    // would confirm the agent exists.
    const { app } = appWith([OPEN], undefined, { isEnabled: () => false });
    const res = await request(app)
      .post(`/hooks/${AGENT}/hooks/open`)
      .set('host', 'staging.example.com')
      .send('x');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('This webhook has no secret, so it only accepts local calls.');
  });
});
