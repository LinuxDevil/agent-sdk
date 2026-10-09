import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

const OPENAI_SPEC: AgentSpec = {
  name: 'needs-key',
  prompt: 'You are a helpful agent.',
  provider: { type: 'openai', model: 'gpt-4o-mini' },
};

/**
 * Eve DUI-F4: with no API key the studio used to run the mock provider and
 * answer "This is a mock response." - the only hint was a log line.
 */
describe('a real provider with no key (Eve DUI-F4)', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let runManager: RunManager;
  const savedKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dui-f4-'));
    const agentStore = createFsAgentStore(baseDir);
    const secretsStore = new SecretsStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
      secretsStore,
    });
    app = createApp({ agentStore, runManager, baseDir, secretsStore });
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('Run answers 422 with an actionable message and never starts a mock run', async () => {
    const res = await request(app).post('/agents/a1/run').send({ input: 'hi', spec: OPENAI_SPEC });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No API key for provider 'openai'.*Settings.*OPENAI_API_KEY/);
    expect(runManager.status('a1').status).not.toBe('running');
    expect(runManager.status('a1').resultText).toBeUndefined();
  });

  it('Chat answers 422 and takes the unsent message back out of the transcript', async () => {
    await request(app).put('/agents/a2').send(OPENAI_SPEC).expect(204);
    const res = await request(app).post('/agents/a2/message').send({ message: 'hello?' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No API key for provider 'openai'/);
    expect(runManager.chatState('a2').messages).toEqual([]);
  });

  it("reports the provider a run actually used in the status (for the Topbar's env pill)", async () => {
    const spec: AgentSpec = { ...OPENAI_SPEC, provider: { type: 'mock', model: 'mock-1' } };
    await request(app).post('/agents/a3/run').send({ input: 'hi', spec }).expect(202);
    expect(runManager.status('a3').provider).toBe('mock/mock-1');
  });
});
