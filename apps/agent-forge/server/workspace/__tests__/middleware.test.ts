import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TriggerRegistry } from '@lousho/build-ai-agent/triggers';
import { ALL_WORKSPACES } from '../../../shared/workspace';
import type { AgentStore } from '../../../src/persistence/AgentStore';
import type { RunManager } from '../../runRegistry';
import { AgentRepo } from '../../storage/agentRepo';
import { VersionStore } from '../../storage/versionStore';
import { singleWorkspace, type WorkspaceContext, type WorkspaceResolver } from '../context';
import { requestedWorkspaceId, workspaceMiddleware, workspaceOf } from '../middleware';

const emptyStore: AgentStore = {
  list: async () => [],
  load: async () => undefined,
  save: async () => {},
  remove: async () => {},
};

function ctx(id: string): WorkspaceContext {
  const repo = new AgentRepo(`/root/${id}`);
  return {
    ref: { id, name: id, root: `/root/${id}`, addedAt: 'a', lastOpenedAt: 'a' },
    repo,
    agentStore: emptyStore,
    versions: new VersionStore(repo),
    runs: {} as RunManager,
    chatTriggers: new TriggerRegistry(),
  };
}

/** A bare app: the middleware, then one route echoing the resolved workspace id. */
function appWith(resolver: WorkspaceResolver) {
  const app = express();
  app.use(express.json());
  app.use(workspaceMiddleware(resolver));
  app.get('/echo', (req, res) => res.json({ id: workspaceOf(req).ref.id }));
  // Same fallback error shape app.ts uses.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const main = ctx('main-abc123');
const app = appWith(singleWorkspace(main));

describe('workspaceMiddleware (single workspace)', () => {
  it('no id resolves the default workspace', async () => {
    const res = await request(app).get('/echo');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('main-abc123');
  });

  it.each(['?ws=all', `?ws=${ALL_WORKSPACES}`])('%s resolves the default workspace', async (qs) => {
    expect((await request(app).get(`/echo${qs}`)).body.id).toBe('main-abc123');
  });

  it('x-lousho-workspace: all resolves the default workspace', async () => {
    expect((await request(app).get('/echo').set('x-lousho-workspace', 'all')).body.id).toBe('main-abc123');
  });

  it('the workspace id resolves its context', async () => {
    expect((await request(app).get('/echo?ws=main-abc123')).body.id).toBe('main-abc123');
    expect((await request(app).get('/echo').set('x-lousho-workspace', 'main-abc123')).body.id).toBe('main-abc123');
  });

  it('a valid but unknown id is a 404 LOUSHO_WORKSPACE_NOT_FOUND', async () => {
    const res = await request(app).get('/echo').set('x-lousho-workspace', 'other-abc123');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No workspace 'other-abc123'", code: 'LOUSHO_WORKSPACE_NOT_FOUND' });
  });

  it.each(['../x', 'bad!', 'UPPER-abc123', 'x-12345'])(
    'malformed id %s is a 400 LOUSHO_WORKSPACE_ID_INVALID',
    async (bad) => {
      const res = await request(app).get('/echo').set('x-lousho-workspace', bad);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid workspace id', code: 'LOUSHO_WORKSPACE_ID_INVALID' });
    }
  );

  it('?ws= given twice is a 400', async () => {
    const res = await request(app).get('/echo?ws=a&ws=b');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_WORKSPACE_ID_INVALID');
  });

  it('the header wins over ?ws=, even a malformed one', async () => {
    const res = await request(app).get('/echo?ws=bad!').set('x-lousho-workspace', 'main-abc123');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('main-abc123');
  });

  it('the header wins over a repeated ?ws=', async () => {
    const res = await request(app).get('/echo?ws=a&ws=b').set('x-lousho-workspace', 'main-abc123');
    expect(res.status).toBe(200);
  });
});

describe('workspaceMiddleware (resolver with a second workspace)', () => {
  it('a known non-default id resolves that context', async () => {
    const other = ctx('other-abc123');
    const resolver: WorkspaceResolver = {
      resolve: async (id) => (id === 'other-abc123' ? other : id === undefined ? main : undefined),
      defaultId: () => main.ref.id,
    };
    const res = await request(appWith(resolver)).get('/echo?ws=other-abc123');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('other-abc123');
  });
});

describe('workspaceOf', () => {
  it('throws on a request the middleware never saw (route answers 500)', async () => {
    const bare = express();
    bare.get('/echo', (req, res) => res.json({ id: workspaceOf(req).ref.id }));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    bare.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    const res = await request(bare).get('/echo');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('workspaceOf() ran on a request the workspace middleware did not see');
  });
});

describe('requestedWorkspaceId', () => {
  it('prefers a non-empty trimmed header over the query', async () => {
    const seen: (string | undefined)[] = [];
    const probe = express();
    probe.get('/probe', (req, res) => {
      seen.push(requestedWorkspaceId(req));
      res.end();
    });
    await request(probe).get('/probe?ws=query-id').set('x-lousho-workspace', '  header-id  ');
    await request(probe).get('/probe?ws=query-id');
    await request(probe).get('/probe').set('x-lousho-workspace', '   ');
    expect(seen).toEqual(['header-id', 'query-id', undefined]);
  });
});
