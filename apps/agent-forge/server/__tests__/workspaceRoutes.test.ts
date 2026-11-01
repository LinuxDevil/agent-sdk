import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { WorkspaceList, WorkspaceListItem } from '../../shared/wireTypes';
import { workspaceIdFor } from '../workspace/workspaceId';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';

const TOKEN = 'w01-routes-token-0123456789';

/**
 * `GET/POST /workspaces` and `DELETE /workspaces/:ws` over the
 * `workspaces.json` registry (server/workspace/workspaceRegistry.ts).
 * `isLaunch` is a per-process fact (the launch folder can never leave the
 * list while Studio runs); `available`/`agentCount` are computed per
 * request, never stored. Every test uses a temp `studioHome` so nothing
 * writes to the real home folder, and a real `staticDir` so the SPA
 * fallback proves it never answers an API path.
 */
describe('/workspaces routes', () => {
  let baseDir: string;
  let studioHome: string;
  let staticDir: string;
  let registry: WorkspaceRegistry;
  let app: Express;
  let launchId: string;

  /** A folder with `n` agent spec files (or none) the registry can point at. */
  function workspaceFolder(name: string, agentIds: string[] = []): string {
    const root = path.join(studioHome, 'folders', name);
    fs.mkdirSync(root, { recursive: true });
    for (const id of agentIds) {
      const agentsDir = path.join(root, '.lousho', 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, `${id}.yaml`), 'version: 2\n');
    }
    return root;
  }

  const authed = (req: request.Test) => req.set(STUDIO_TOKEN_HEADER, TOKEN);

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w01-base-'));
    studioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w01-home-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w01-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>forge</title>');
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    registry = new WorkspaceRegistry(path.join(studioHome, 'workspaces.json'));
    launchId = (await registry.ensure(baseDir)).id;
    app = createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      staticDir,
      workspaceRegistry: registry,
      access: { token: TOKEN },
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(studioHome, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  it('every route needs the studio token', async () => {
    expect((await request(app).get('/workspaces')).status).toBe(401);
    expect((await request(app).post('/workspaces').send({ root: baseDir })).status).toBe(401);
    expect((await request(app).delete(`/workspaces/${launchId}`)).status).toBe(401);
  });

  it('GET /workspaces answers the launch workspace with defaultId, JSON even in prod mode', async () => {
    const res = await authed(request(app).get('/workspaces'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const list = res.body as WorkspaceList;
    expect(list.defaultId).toBe(launchId);
    expect(list.workspaces).toHaveLength(1);
    expect(list.workspaces[0]).toMatchObject({
      id: launchId,
      isLaunch: true,
      available: true,
      agentCount: 0,
    });
  });

  it('GET /workspaces sorts by name (case-insensitive), then id', async () => {
    const zulu = workspaceFolder('Zulu');
    const alpha = workspaceFolder('alpha');
    await registry.add(zulu);
    await registry.add(alpha);
    const res = await authed(request(app).get('/workspaces'));
    expect(res.status).toBe(200);
    const names = (res.body as WorkspaceList).workspaces.map((w) => w.name);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(names.indexOf('alpha')).toBeLessThan(names.indexOf('Zulu'));
  });

  it('POST /workspaces adds a folder and answers its WorkspaceListItem (201)', async () => {
    const b = workspaceFolder('beta', ['one', 'two']);
    const res = await authed(request(app).post('/workspaces').send({ root: b }));
    expect(res.status).toBe(201);
    const item = res.body as WorkspaceListItem;
    expect(item).toMatchObject({
      id: workspaceIdFor(b),
      name: 'beta',
      isLaunch: false,
      available: true,
      agentCount: 2,
    });
    expect((await registry.list()).map((r) => r.id)).toContain(item.id);
  });

  it('POST /workspaces of a registered folder answers 409 LOUSHO_WORKSPACE_EXISTS (also with a trailing separator)', async () => {
    const b = workspaceFolder('beta');
    const first = await authed(request(app).post('/workspaces').send({ root: b }));
    expect(first.status).toBe(201);
    const again = await authed(request(app).post('/workspaces').send({ root: `${b}${path.sep}` }));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: "'beta' is already in Studio.",
      code: 'LOUSHO_WORKSPACE_EXISTS',
      details: { id: workspaceIdFor(b) },
    });
    // The launch folder is already registered, so adding it is a 409 too.
    const launch = await authed(request(app).post('/workspaces').send({ root: baseDir }));
    expect(launch.status).toBe(409);
    expect(launch.body.code).toBe('LOUSHO_WORKSPACE_EXISTS');
    expect(launch.body.details).toEqual({ id: launchId });
  });

  it.each([
    ['a relative path', { root: path.join('some', 'relative') }, 'LOUSHO_WORKSPACE_ROOT_INVALID'],
    ['an empty root', { root: '  ' }, 'LOUSHO_WORKSPACE_ROOT_INVALID'],
    ['a missing root', {}, 'LOUSHO_WORKSPACE_ROOT_INVALID'],
  ])('POST /workspaces rejects %s with 400 %s', async (_label, body, code) => {
    const res = await authed(request(app).post('/workspaces').send(body));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
  });

  it('POST /workspaces rejects a missing folder (400 LOUSHO_WORKSPACE_ROOT_MISSING) and a file (400 LOUSHO_WORKSPACE_ROOT_NOT_DIR)', async () => {
    const missing = await authed(
      request(app).post('/workspaces').send({ root: path.join(studioHome, 'no-such-folder') })
    );
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('LOUSHO_WORKSPACE_ROOT_MISSING');

    const filePath = path.join(studioHome, 'notes.txt');
    fs.writeFileSync(filePath, 'hello');
    const notDir = await authed(request(app).post('/workspaces').send({ root: filePath }));
    expect(notDir.status).toBe(400);
    expect(notDir.body.code).toBe('LOUSHO_WORKSPACE_ROOT_NOT_DIR');
  });

  it('DELETE /workspaces/:ws removes the entry only - the folder stays on disk (204)', async () => {
    const b = workspaceFolder('beta');
    const id = (await registry.add(b)).id;
    const res = await authed(request(app).delete(`/workspaces/${id}`));
    expect(res.status).toBe(204);
    expect(fs.statSync(b).isDirectory()).toBe(true);
    const list = await authed(request(app).get('/workspaces'));
    expect((list.body as WorkspaceList).workspaces.map((w) => w.id)).not.toContain(id);
  });

  it('DELETE /workspaces/:ws rejects the launch workspace (409 LOUSHO_WORKSPACE_IN_USE)', async () => {
    const res = await authed(request(app).delete(`/workspaces/${launchId}`));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Studio was started in this folder, so it stays in the list while Studio runs.',
      code: 'LOUSHO_WORKSPACE_IN_USE',
    });
    expect(await registry.get(launchId)).toBeDefined();
  });

  it('DELETE /workspaces/:ws rejects a malformed id (400) and an unknown one (404)', async () => {
    const malformed = await authed(request(app).delete('/workspaces/bad!'));
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'Invalid workspace id', code: 'LOUSHO_WORKSPACE_ID_INVALID' });

    const unknown = await authed(request(app).delete('/workspaces/elsewhere-abc123'));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({
      error: "No workspace 'elsewhere-abc123'",
      code: 'LOUSHO_WORKSPACE_NOT_FOUND',
    });
  });

  it('a workspace whose folder was deleted on disk lists as available: false, agentCount: 0', async () => {
    const b = workspaceFolder('beta', ['one', 'two']);
    await registry.add(b);
    fs.rmSync(b, { recursive: true, force: true });
    const res = await authed(request(app).get('/workspaces'));
    expect(res.status).toBe(200);
    const item = (res.body as WorkspaceList).workspaces.find((w) => w.name === 'beta');
    expect(item).toMatchObject({ available: false, agentCount: 0 });
  });
});
