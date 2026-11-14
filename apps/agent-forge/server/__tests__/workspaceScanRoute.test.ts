/**
 * W08a end to end: `GET/POST /workspaces/:ws/scan` over the shared
 * `CodeAgentCache`, `agentDirs` persistence on the registry entry, the
 * aggregate `GET /agents?ws=all` code items (Studio copy wins), the
 * X06a `/workspace/agent-dirs` routes reading the same cache, and DELETE
 * dropping the cached scan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import type { Express } from 'express';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { WorkspaceRegistry } from '../workspace/workspaceRegistry';
import { CodeAgentCache } from '../workspace/codeAgentScan';
import type { CodeAgentItem, WorkspaceScanResult } from '../../shared/wireTypes';

const TOKEN = 'w08a-scan-token-0123456789';
const YAML = 'model: mock/mock-1\ninstructions: hi\n';

function v2Spec(name: string): AgentSpecV2 {
  return { version: 2, name, model: 'mock/mock-1', instructions: `You are ${name}.` };
}

function write(root: string, rel: string, content = YAML): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('/workspaces/:ws/scan + aggregate code agents (W08a)', () => {
  let dir: string;
  let baseDir: string;
  let studioHome: string;
  let otherDir: string;
  let registry: WorkspaceRegistry;
  let cache: CodeAgentCache;
  let scans: number;
  let app: Express;
  let launchId: string;
  let otherId: string;

  const authed = (req: request.Test) => req.set(STUDIO_TOKEN_HEADER, TOKEN);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w08a-routes-'));
    baseDir = path.join(dir, 'launch');
    otherDir = path.join(dir, 'other');
    studioHome = path.join(dir, 'studio-home');
    for (const root of [baseDir, otherDir, studioHome]) fs.mkdirSync(root, { recursive: true });

    // Code-agent dirs: launch has agents/{a data,b code} + tools/c;
    // other has agents/x. Studio also owns agent 'a' in launch (dedupe).
    write(baseDir, 'agents/a/agent.yaml');
    write(baseDir, 'agents/b/agent.ts', 'export default {}\n');
    write(baseDir, 'tools/c/agent.yaml');
    write(otherDir, 'agents/x/agent.yaml');
    const launchRepo = new AgentRepo(baseDir);
    await launchRepo.writeSpec('a', v2Spec('a'));

    registry = new WorkspaceRegistry(path.join(studioHome, 'workspaces.json'));
    launchId = (await registry.ensure(baseDir)).id;
    otherId = (await registry.add(otherDir)).id;

    scans = 0;
    cache = new CodeAgentCache(() => {
      scans += 1;
      return new Date('2026-02-01T00:00:00.000Z');
    });

    const repo = new AgentRepo(baseDir);
    const agentStore = createFsAgentStore(baseDir, repo);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    app = createApp({
      agentStore,
      runManager,
      baseDir,
      studioHome,
      workspaceRegistry: registry,
      codeAgentCache: cache,
      access: { token: TOKEN },
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /workspaces/:ws/scan scans on first read with the default patterns, then serves the cache', async () => {
    const first = await authed(request(app).get(`/workspaces/${launchId}/scan`));
    expect(first.status).toBe(200);
    const scan = first.body as WorkspaceScanResult;
    expect(scan.workspaceId).toBe(launchId);
    expect(scan.patterns).toEqual(['agents/*/', 'src/agents/*/']);
    expect(scan.scannedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(scan.agents.map((a) => a.path)).toEqual(['agents/a', 'agents/b']);
    expect(scans).toBe(1);

    const second = await authed(request(app).get(`/workspaces/${launchId}/scan`));
    expect(second.status).toBe(200);
    expect(second.body).toEqual(scan);
    expect(scans).toBe(1);
  });

  it('GET /workspaces/:ws/scan rejects a malformed id (400) and an unknown workspace (404)', async () => {
    const malformed = await authed(request(app).get('/workspaces/bad!/scan'));
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('LOUSHO_WORKSPACE_ID_INVALID');

    const unknown = await authed(request(app).get('/workspaces/elsewhere-abc123/scan'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('LOUSHO_WORKSPACE_NOT_FOUND');
  });

  it('POST /workspaces/:ws/scan persists agentDirs, rescans with them and caches the result', async () => {
    const res = await authed(
      request(app).post(`/workspaces/${otherId}/scan`).send({ agentDirs: ['tools/*/', 'agents/*/'] })
    );
    expect(res.status).toBe(200);
    const scan = res.body as WorkspaceScanResult;
    expect(scan.patterns).toEqual(['tools/*/', 'agents/*/']);
    expect(scan.agents.map((a) => a.path)).toEqual(['agents/x']);
    expect((await registry.get(otherId))?.agentDirs).toEqual(['tools/*/', 'agents/*/']);

    // A bare GET now serves the stored patterns' cached result.
    const get = await authed(request(app).get(`/workspaces/${otherId}/scan`));
    expect(get.body).toEqual(scan);
    expect(scans).toBe(1);
  });

  it.each([
    ['.. traversal', { agentDirs: ['../x'] }],
    ['double star', { agentDirs: ['agents/**/'] }],
    ['empty list', { agentDirs: [] }],
    ['too many patterns', { agentDirs: Array.from({ length: 21 }, (_, i) => `p${i}/*/`) }],
    ['non-string pattern', { agentDirs: [42] }],
    ['non-array', { agentDirs: 'agents/*/' }],
  ])('POST /workspaces/:ws/scan rejects %s with the contract 400', async (_label, body) => {
    const res = await authed(request(app).post(`/workspaces/${launchId}/scan`).send(body));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Each pattern is a folder path like agents/*/ (no '..' or '**').",
      code: 'LOUSHO_AGENT_DIRS_INVALID',
    });
    expect((await registry.get(launchId))?.agentDirs).toBeUndefined();
  });

  it('POST /workspaces/:ws/scan without agentDirs rescans the stored/default patterns', async () => {
    const res = await authed(request(app).post(`/workspaces/${launchId}/scan`).send({}));
    expect(res.status).toBe(200);
    expect((res.body as WorkspaceScanResult).patterns).toEqual(['agents/*/', 'src/agents/*/']);
    expect(scans).toBe(1);
  });

  it('the aggregate list adds code items after workspace+observed, and a Studio agent id wins over a same-named code dir', async () => {
    const res = await authed(request(app).get('/agents').query({ ws: 'all' }));
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ kind: string; id: string; name: string; workspaceId: string | null }>;
    const code = items.filter((i) => i.kind === 'code') as CodeAgentItem[];
    expect(code.map((i) => `${i.workspaceId}:${i.id}`)).toEqual([
      // 'agents/a' in launch is omitted - Studio agent 'a' wins; code
      // items sort by workspace name ('launch' < 'other'), then path.
      `${launchId}:agents/b`,
      `${otherId}:agents/x`,
    ]);
    // Code items sort after every workspace/observed item.
    const lastWorkspace = items.map((i) => i.kind).lastIndexOf('workspace');
    expect(items.findIndex((i) => i.kind === 'code')).toBeGreaterThan(lastWorkspace);
    // One scan per workspace, shared with the scan routes' cache.
    expect(scans).toBe(2);

    // A second aggregate list hits the cache - no rescan.
    const again = await authed(request(app).get('/agents').query({ ws: 'all' }));
    expect(again.status).toBe(200);
    expect(scans).toBe(2);
  });

  it('/workspace/agent-dirs and its spec route read the same cache (X06a alignment)', async () => {
    // Default patterns: launch lists agents/a + agents/b.
    const dirs = await authed(request(app).get('/workspace/agent-dirs'));
    expect(dirs.status).toBe(200);
    expect((dirs.body as Array<{ path: string }>).map((d) => d.path)).toEqual(['agents/a', 'agents/b']);
    expect(scans).toBe(1);

    // tools/c is not in the default scan - the spec route 404s it even
    // though the dir holds a config.
    const miss = await authed(request(app).get('/workspace/agent-dirs/spec').query({ path: 'tools/c' }));
    expect(miss.status).toBe(404);

    // Persisting custom patterns on launch rescans; both routes agree.
    await authed(request(app).post(`/workspaces/${launchId}/scan`).send({ agentDirs: ['tools/*/'] }));
    const rescanned = await authed(request(app).get('/workspace/agent-dirs'));
    expect((rescanned.body as Array<{ path: string }>).map((d) => d.path)).toEqual(['tools/c']);
    const hit = await authed(request(app).get('/workspace/agent-dirs/spec').query({ path: 'tools/c' }));
    expect(hit.status).toBe(200);
    const stale = await authed(request(app).get('/workspace/agent-dirs/spec').query({ path: 'agents/a' }));
    expect(stale.status).toBe(404);
  });

  it('DELETE /workspaces/:ws drops the cached scan', async () => {
    await authed(request(app).get(`/workspaces/${otherId}/scan`));
    expect(cache.get(otherId)).toBeDefined();
    const del = await authed(request(app).delete(`/workspaces/${otherId}`));
    expect(del.status).toBe(204);
    expect(cache.get(otherId)).toBeUndefined();
  });
});
