/**
 * `PATCH /agents/:id/meta { labels }` - L13's label contract end to end:
 * `shared/labels.ts` normalises before storing and a `LabelError` is a
 * 400 `{ error, code: 'LOUSHO_LABELS_INVALID' }` carrying the message.
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
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';

describe('PATCH /agents/:id/meta labels (L13)', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l13-labels-'));
    agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir });
  const patch = (id: string, body: object) => request(app()).patch(`/agents/${id}/meta`).send(body);

  const createAgent = async (name = 'ops'): Promise<void> => {
    await request(app()).post('/agents').send({ from: 'blank', name });
  };

  it('normalises before storing: trim, collapse whitespace, lowercase, dedupe, drop empties', async () => {
    await createAgent();
    const res = await patch('ops', { labels: ['  Support ', 'support', 'Billing  Ops', ''] });
    expect(res.status).toBe(200);
    expect(res.body.labels).toEqual(['support', 'billing ops']);
    expect((await repo.readMeta('ops')).labels).toEqual(['support', 'billing ops']);
  });

  it('400s LOUSHO_LABELS_INVALID with the LabelError message for 21 labels', async () => {
    await createAgent();
    const res = await patch('ops', { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_LABELS_INVALID');
    expect(res.body.error).toBe('An agent can have at most 20 labels.');
    expect((await repo.readMeta('ops')).labels).toEqual([]);
  });

  it('400s LOUSHO_LABELS_INVALID naming the label for a 33-char label', async () => {
    await createAgent();
    const tooLong = 'x'.repeat(33);
    const res = await patch('ops', { labels: ['fine', tooLong] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_LABELS_INVALID');
    expect(res.body.error).toBe(`Label "${tooLong}" is longer than 32 characters.`);
    expect((await repo.readMeta('ops')).labels).toEqual([]);
  });

  it.each([[{ labels: 'ops' }], [{ labels: [1, 2] }], [{ labels: null }]])(
    '400s LOUSHO_LABELS_INVALID "Labels must be text." for %j',
    async (body) => {
      await createAgent();
      const res = await patch('ops', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOUSHO_LABELS_INVALID');
      expect(res.body.error).toBe('Labels must be text.');
    }
  );
});
