/**
 * X06a routes: `GET /workspace/agent-dirs` lists agent directories under
 * the workspace root; `GET /workspace/agent-dirs/spec?path=` reads a
 * data-config dir back as an AgentSpecV2 - 400 on escapes, 404 on
 * unlisted dirs, 422 with the SDK code on code/broken configs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { CodeAgentDir, CodeAgentSpecResponse } from '../../shared/wireTypes';

const AGENT_YAML = 'model: mock/mock-1\ninstructions: You are the fixture agent.\n';

function write(root: string, rel: string, content: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('/workspace/agent-dirs', () => {
  let baseDir: string;
  let studioHome: string;
  let app: () => ReturnType<typeof createApp>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-x06a-routes-'));
    studioHome = path.join(baseDir, '.lousho');
    const agentStore = createFsAgentStore(baseDir);
    const repo = new AgentRepo(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    app = () =>
      createApp({
        agentStore,
        runManager,
        baseDir,
        studioHome,
        secretsStore: new SecretsStore(studioPathsFor(studioHome)),
      });
    write(baseDir, 'agents/a/agent.yaml', AGENT_YAML);
    write(baseDir, 'agents/b/agent.ts', 'export default {}\n');
    write(baseDir, 'node_modules/x/agent.yaml', AGENT_YAML);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('lists agent dirs with kind, sorted by path', async () => {
    const res = await request(app()).get('/workspace/agent-dirs');
    expect(res.status).toBe(200);
    const dirs = res.body as CodeAgentDir[];
    expect(dirs.map((d) => [d.path, d.configKind])).toEqual([
      ['agents/a', 'data'],
      ['agents/b', 'code'],
    ]);
    expect(dirs[0].configFile).toBe('agent.yaml');
    expect(dirs[1].configFile).toBe('agent.ts');
  });

  it('returns the spec for a data-config dir, with warnings for dropped fields', async () => {
    write(baseDir, 'agents/c/agent.yaml', 'model: mock/mock-1\ninstructions: hi\n');
    const res = await request(app()).get('/workspace/agent-dirs/spec').query({ path: 'agents/c' });
    expect(res.status).toBe(200);
    const body = res.body as CodeAgentSpecResponse;
    expect(body.path).toBe('agents/c');
    expect(body.spec).toMatchObject({ version: 2, name: 'c', model: 'mock/mock-1' });
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('serves the cached spec on a second read', async () => {
    const first = await request(app()).get('/workspace/agent-dirs/spec').query({ path: 'agents/a' });
    expect(first.status).toBe(200);
    const second = await request(app()).get('/workspace/agent-dirs/spec').query({ path: 'agents/a' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it.each([['../outside'], ['/etc'], ['agents/../../x'], ['C:\\Windows']])(
    'answers 400 LOUSHO_REQUEST_INVALID for path=%s',
    async (path) => {
      const res = await request(app()).get('/workspace/agent-dirs/spec').query({ path });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_REQUEST_INVALID');
    }
  );

  it('answers 404 for a well-formed dir that is not a listed agent dir', async () => {
    write(baseDir, 'plain/readme.txt', 'x');
    const res = await request(app()).get('/workspace/agent-dirs/spec').query({ path: 'plain' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No agent directory at 'plain'");
  });

  it('answers 422 with the SDK code for a code config', async () => {
    const res = await request(app()).get('/workspace/agent-dirs/spec').query({ path: 'agents/b' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
  });

  it('answers 422 for a broken data config', async () => {
    write(baseDir, 'agents/broken/agent.yaml', 'model: [unclosed\n');
    const res = await request(app()).get('/workspace/agent-dirs/spec').query({ path: 'agents/broken' });
    expect(res.status).toBe(422);
    expect(typeof res.body.code).toBe('string');
  });
});
