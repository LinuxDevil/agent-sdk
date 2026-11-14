import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { AgentRepo } from '../../storage/agentRepo';
import { buildAgentListItems } from '../agentListItems';
import type { AgentRunStatusPayload } from '../../../shared/wireTypes';

/**
 * W06a unit coverage for the extracted `AgentListItem[]` builder:
 * the same source shape serves the single-workspace `GET /agents`
 * (with `runStatus`) and the cold workspaces of `?ws=all` (without).
 */

function v2Spec(name: string): AgentSpecV2 {
  return { version: 2, name, model: 'mock/mock-1', instructions: `You are ${name}.` };
}

function runStatus(status: AgentRunStatusPayload['status']): AgentRunStatusPayload {
  return { agentId: 'a', status, updatedAt: '2026-01-02T00:00:00.000Z' };
}

describe('buildAgentListItems', () => {
  let dir: string;
  let repo: AgentRepo;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w06a-items-'));
    repo = new AgentRepo(dir);
    await repo.writeSpec('alpha', v2Spec('alpha'));
    await repo.writeSpec('beta', v2Spec('beta'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists every readable agent sorted by id, with spec/meta fields', async () => {
    const items = await buildAgentListItems({ repo, root: dir });
    expect(items.map((i) => i.id)).toEqual(['alpha', 'beta']);
    expect(items[0]).toMatchObject({ id: 'alpha', name: 'alpha', model: 'mock/mock-1', enabled: true });
    expect(items[0].counts).toBeDefined();
  });

  it('with runStatus: a non-idle live run wins over persisted traces', async () => {
    const items = await buildAgentListItems({
      repo,
      root: dir,
      runStatus: (id) => ({ ...runStatus('running'), agentId: id, traceId: 'tr-1' }),
    });
    const alpha = items.find((i) => i.id === 'alpha');
    expect(alpha?.lastRun).toEqual({ status: 'running', at: '2026-01-02T00:00:00.000Z', traceId: 'tr-1' });
  });

  it('with runStatus idle and no traces: lastRun is absent', async () => {
    const items = await buildAgentListItems({ repo, root: dir, runStatus: (id) => ({ ...runStatus('idle'), agentId: id }) });
    expect(items.every((i) => i.lastRun === undefined)).toBe(true);
  });

  it('without runStatus (cold workspace): still lists agents, no live status consulted', async () => {
    const spy = vi.fn();
    const items = await buildAgentListItems({ repo, root: dir, runStatus: undefined });
    expect(items).toHaveLength(2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips an unreadable spec with a console.warn instead of failing the list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Corrupt beta's spec file so readSpec throws.
    const file = path.join(dir, '.lousho', 'agents', 'beta.yaml');
    fs.writeFileSync(file, 'version: 2\nname: [unclosed\n');
    const items = await buildAgentListItems({ repo, root: dir });
    expect(items.map((i) => i.id)).toEqual(['alpha']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('beta'));
    warn.mockRestore();
  });
});
