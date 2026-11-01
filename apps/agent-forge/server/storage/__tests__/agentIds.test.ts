/**
 * `slugAgentId`/`uniqueAgentId`/`copyAgentId` - the id helpers
 * `POST /agents` uses to turn display names into filesystem-safe,
 * collision-free agent ids (storage/agentIds.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { isValidAgentId } from '../../../shared/agentId';
import { AgentRepo } from '../agentRepo';
import { copyAgentId, slugAgentId, uniqueAgentId } from '../agentIds';

const SPEC: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run the ops checks.' };

describe('slugAgentId', () => {
  it("slugifies 'My Agent!!' to 'my-agent'", () => {
    expect(slugAgentId('My Agent!!')).toBe('my-agent');
  });

  it("answers 'agent' for an empty string", () => {
    expect(slugAgentId('')).toBe('agent');
    expect(slugAgentId('   !!!   ')).toBe('agent');
  });

  it('caps the slug at 64 chars', () => {
    const slug = slugAgentId('a'.repeat(200));
    expect(slug).toHaveLength(64);
    expect(slug).toBe('a'.repeat(64));
  });

  it('always produces an id that passes isValidAgentId', () => {
    const inputs = ['My Agent!!', '', 'a..b', '.hidden', '_under', '---', 'x'.repeat(200), 'café agent', '  lead'];
    for (const input of inputs) {
      expect(isValidAgentId(slugAgentId(input)), input).toBe(true);
    }
  });
});

describe('uniqueAgentId', () => {
  let baseDir: string;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06b-ids-'));
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('answers base, then base-2, base-3, ...', async () => {
    expect(uniqueAgentId(repo, 'ops')).toBe('ops');
    await repo.writeSpec('ops', SPEC);
    expect(uniqueAgentId(repo, 'ops')).toBe('ops-2');
    await repo.writeSpec('ops-2', SPEC);
    expect(uniqueAgentId(repo, 'ops')).toBe('ops-3');
  });

  it('does not reuse an id whose <id>/ sidecar dir exists (a deleted agent with history)', async () => {
    await repo.writeSpec('gone', SPEC);
    fs.mkdirSync(path.join(repo.sidecarDir('gone'), 'versions'), { recursive: true });
    await repo.remove('gone');
    expect(repo.exists('gone')).toBe(false);
    expect(fs.existsSync(repo.sidecarDir('gone'))).toBe(true);
    expect(uniqueAgentId(repo, 'gone')).toBe('gone-2');
  });
});

describe('copyAgentId', () => {
  let baseDir: string;
  let repo: AgentRepo;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d06b-ids-'));
    repo = new AgentRepo(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('answers <id>-copy, then <id>-copy-2, <id>-copy-3, ...', async () => {
    await repo.writeSpec('a', SPEC);
    expect(copyAgentId(repo, 'a')).toBe('a-copy');
    await repo.writeSpec('a-copy', SPEC);
    expect(copyAgentId(repo, 'a')).toBe('a-copy-2');
    await repo.writeSpec('a-copy-2', SPEC);
    expect(copyAgentId(repo, 'a')).toBe('a-copy-3');
  });

  it('does not reuse a copy id whose sidecar dir exists', async () => {
    await repo.writeSpec('a', SPEC);
    fs.mkdirSync(path.join(repo.sidecarDir('a-copy'), 'versions'), { recursive: true });
    expect(copyAgentId(repo, 'a')).toBe('a-copy-2');
  });
});
