import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec } from 'lousho';
import { TriggerRegistry } from 'lousho/triggers';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentStore, AgentStoreEntry } from '../../src/persistence/AgentStore';
import { WORKSPACE_ID_RE } from '../../shared/workspace';
import { workspaceIdFor, workspaceRefFor } from '../workspace/workspaceId';
import { AgentRepo } from '../storage/agentRepo';
import { VersionStore } from '../storage/versionStore';
import type { WorkspaceContext } from '../workspace/context';

const SPEC: AgentSpec = {
  name: 'stub-agent',
  prompt: 'You are a stub.',
  provider: { type: 'mock', model: 'mock-1' },
};

/**
 * The workspace seam: every per-agent route reads its stores from
 * `workspaceOf(req)` (x-lousho-workspace header / ?ws=, else the launch
 * folder's single workspace). Studio still serves exactly one workspace,
 * so nothing user-visible changes - these tests pin the seam, the
 * `GET /workspace` ref and the 400/404 id validation.
 */
describe('workspace seam', () => {
  let baseDir: string;
  let agentStore: AgentStore;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w00-seam-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('GET /workspace returns the launch folder and its WorkspaceRef', async () => {
    const app = createApp({ agentStore, runManager, baseDir });
    const res = await request(app).get('/workspace');
    expect(res.status).toBe(200);
    expect(res.body.baseDir).toBe(baseDir);
    expect(res.body.workspace).toEqual({
      id: workspaceIdFor(baseDir),
      name: path.basename(baseDir),
      root: baseDir,
      addedAt: expect.any(String),
      lastOpenedAt: expect.any(String),
    });
    expect(res.body.workspace.id).toMatch(WORKSPACE_ID_RE);
  });

  it('serves the default workspace for no id, its id, ?ws=all and the header', async () => {
    const app = createApp({ agentStore, runManager, baseDir });
    const id = workspaceIdFor(baseDir);
    for (const req of [
      request(app).get('/agents'),
      request(app).get(`/agents?ws=${id}`),
      request(app).get('/agents?ws=all'),
      request(app).get('/agents').set('x-lousho-workspace', id),
    ]) {
      const res = await req;
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('rejects an unknown workspace id 404 and a malformed one 400', async () => {
    const app = createApp({ agentStore, runManager, baseDir });
    const unknown = await request(app).get('/agents').set('x-lousho-workspace', 'other-abc123');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "No workspace 'other-abc123'", code: 'LOUSHO_WORKSPACE_NOT_FOUND' });
    const invalid = await request(app).get('/agents').set('x-lousho-workspace', '../x');
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'Invalid workspace id', code: 'LOUSHO_WORKSPACE_ID_INVALID' });
  });

  it('lets the header win over a malformed ?ws=', async () => {
    const app = createApp({ agentStore, runManager, baseDir });
    const res = await request(app).get('/agents?ws=bad!').set('x-lousho-workspace', workspaceIdFor(baseDir));
    expect(res.status).toBe(200);
  });

  it('createApp({ workspace }) routes read the given context, not a closed-over store', async () => {
    const entries: AgentStoreEntry[] = [{ id: 'stub-agent', spec: SPEC, updatedAt: 't' }];
    const status = vi.fn().mockReturnValue({ agentId: 'x', status: 'idle', updatedAt: 't' });
    const repo = new AgentRepo(baseDir);
    const workspace: WorkspaceContext = {
      ref: workspaceRefFor(baseDir),
      repo,
      agentStore: {
        list: async () => entries,
        load: async () => undefined,
        save: async () => {},
        remove: async () => {},
      },
      versions: new VersionStore(repo),
      runs: { status } as unknown as RunManager,
      chatTriggers: new TriggerRegistry(),
    };
    const app = createApp({ workspace, baseDir });

    const list = await request(app).get('/agents');
    expect(list.status).toBe(200);
    expect(list.body).toEqual(entries);

    const res = await request(app).get('/agents/x/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    expect(status).toHaveBeenCalledWith('x');
  });
});
