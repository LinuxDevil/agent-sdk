import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { createFsAgentStore } from '../fsAgentStore';

const spec: AgentSpec = {
  name: 'ops-pipeline',
  prompt: 'Coordinate the ops pipeline.',
  provider: { type: 'mock', model: 'mock-1' },
};

describe('createFsAgentStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-fsstore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a spec to .lousho/agents/<id>.yaml and reads it back via loadSpec()', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);

    const filePath = path.join(tmpDir, '.lousho', 'agents', 'ops-pipeline.yaml');
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = await store.load('ops-pipeline');
    expect(loaded).toEqual(spec);
  });

  it('returns undefined for a missing id and empty list before any save', async () => {
    const store = createFsAgentStore(tmpDir);
    expect(await store.load('missing')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('lists saved entries', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('ops-pipeline');
    expect(entries[0].spec).toEqual(spec);
  });

  it('removes a saved entry', async () => {
    const store = createFsAgentStore(tmpDir);
    await store.save('ops-pipeline', spec);
    await store.remove('ops-pipeline');
    expect(await store.load('ops-pipeline')).toBeUndefined();
  });
});
