import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { listAllInbox, countAllInbox, type InboxAggregateDeps } from '../inboxAggregate';
import { AlertStore } from '../alertStore';
import { WorkspaceRegistry, type WorkspaceEntry } from '../../workspace/workspaceRegistry';
import { AgentRepo } from '../../storage/agentRepo';
import { DraftStore } from '../../storage/draftStore';
import type { WorkspaceContext } from '../../workspace/context';
import type { InboxService } from '../inboxService';
import type { InboxItem } from '../../../shared/wireTypes';

const SPEC: AgentSpecV2 = { version: 2, name: 'agent', model: 'mock/mock-1', instructions: 'Do a thing.' };

/** A warm-context stub: only the members the aggregate reads (`ref`, `repo`, `inbox.list`). */
function warmCtx(ref: WorkspaceEntry, items: InboxItem[]): WorkspaceContext {
  return {
    ref,
    repo: new AgentRepo(ref.root),
    inbox: { list: async () => items } as unknown as InboxService,
  } as unknown as WorkspaceContext;
}

function draftItem(workspaceId: string, agentId: string, at: string): InboxItem {
  return {
    id: `draft:${agentId}:d1`,
    kind: 'draft',
    agentId,
    workspaceId,
    agentName: agentId,
    title: 'Pending change',
    detail: 'reason',
    at,
    draftId: 'd1',
    origin: 'manual',
    gated: false,
  };
}

describe('inboxAggregate (W09a)', () => {
  let dir: string;
  let studioDir: string;
  let registry: WorkspaceRegistry;
  let alerts: AlertStore;
  let warmA: WorkspaceEntry;
  let warmB: WorkspaceEntry;
  let coldC: WorkspaceEntry;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w09a-inbox-'));
    studioDir = path.join(dir, 'studio');
    fs.mkdirSync(studioDir, { recursive: true });
    registry = new WorkspaceRegistry(path.join(studioDir, 'workspaces.json'));
    alerts = new AlertStore(path.join(studioDir, 'alerts.json'));
    for (const name of ['wa', 'wb', 'wc']) fs.mkdirSync(path.join(dir, name), { recursive: true });
    warmA = await registry.add(path.join(dir, 'wa'));
    warmB = await registry.add(path.join(dir, 'wb'));
    coldC = await registry.add(path.join(dir, 'wc'));
    // A pending draft in the COLD workspace C: written straight to its
    // stores - listing must never build a context for it.
    const repoC = new AgentRepo(coldC.root);
    await repoC.writeSpec('cold-agent', { ...SPEC, name: 'Cold Agent' });
    await new DraftStore(repoC).create('cold-agent', {
      patch: { description: 'x' },
      origin: 'manual',
      reason: 'cold draft',
      baseVersion: null,
      baseSpecHash: 'h',
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function deps(warm: WorkspaceContext[]): InboxAggregateDeps {
    return { registry, warm: () => warm, alerts };
  }

  it('merges warm-service items and cold disk-only items, each with its workspaceId', async () => {
    const approval: InboxItem = {
      id: 'approval:a1:ap1',
      kind: 'approval',
      agentId: 'a1',
      workspaceId: warmA.id,
      agentName: 'A One',
      title: 'Approve shell?',
      detail: '{}',
      at: '2026-01-01T00:00:00.000Z',
      approvalId: 'ap1',
      toolName: 'shell',
      args: {},
      expiresAt: null,
    };
    const items = await listAllInbox(deps([warmCtx(warmA, [approval])]));
    const cold = items.find((item) => item.workspaceId === coldC.id);
    expect(cold).toMatchObject({
      kind: 'draft',
      agentId: 'cold-agent',
      agentName: 'Cold Agent',
      detail: 'cold draft',
    });
    expect(items.find((item) => item.id === approval.id)).toMatchObject({ workspaceId: warmA.id });
    // B contributed nothing and was never built - warm() held only A.
    expect(items.filter((item) => item.workspaceId === warmB.id)).toHaveLength(0);
  });

  it('lists every undismissed alert exactly once, even when a warm service also reports it', async () => {
    const alertA = await alerts.add({
      kind: 'auto_disabled',
      agentId: 'cold-agent',
      workspaceId: coldC.id,
      title: 'cold-agent was auto-disabled',
      detail: null,
      payload: {},
    });
    // The warm service's own list still carries its workspace's alert
    // rows; the aggregate filters them and adds the global list once.
    const warmAlert = {
      id: `alert:cold-agent:${alertA.id}`,
      kind: 'alert',
      agentId: 'cold-agent',
      workspaceId: warmA.id,
      agentName: 'cold-agent',
      title: 'stale copy',
      detail: null,
      at: alertA.createdAt,
      alertId: alertA.id,
      alertKind: 'auto_disabled',
      payload: {},
    } satisfies InboxItem;
    const items = await listAllInbox(deps([warmCtx(warmA, [warmAlert])]));
    const alertRows = items.filter((item) => item.kind === 'alert');
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]).toMatchObject({ alertId: alertA.id, workspaceId: coldC.id, agentName: 'Cold Agent' });
  });

  it('sorts the merge by the per-workspace contract order and counts it', async () => {
    const soon = {
      ...draftItem(warmA.id, 'a1', '2026-01-02T00:00:00.000Z'),
      id: 'approval:a1:soon',
      kind: 'approval',
      approvalId: 'soon',
      toolName: 't',
      args: {},
      expiresAt: '2026-01-01T01:00:00.000Z',
    } as InboxItem;
    const later = {
      ...draftItem(warmB.id, 'b1', '2026-01-03T00:00:00.000Z'),
      id: 'approval:b1:later',
      kind: 'approval',
      approvalId: 'later',
      toolName: 't',
      args: {},
      expiresAt: '2026-01-05T00:00:00.000Z',
    } as InboxItem;
    const items = await listAllInbox(deps([warmCtx(warmA, [soon]), warmCtx(warmB, [later])]));
    const approvalOrder = items.filter((i) => i.kind === 'approval').map((i) => i.id);
    expect(approvalOrder).toEqual(['approval:a1:soon', 'approval:b1:later']);
    // The cold draft (no expiresAt) sorts after both deadline rows.
    expect(items.at(-1)?.kind).toBe('draft');
    expect(await countAllInbox(deps([warmCtx(warmA, [soon]), warmCtx(warmB, [later])]))).toBe(items.length);
  });

  it('skips a workspace whose folder vanished instead of failing the list', async () => {
    fs.rmSync(path.join(dir, 'wc'), { recursive: true, force: true });
    const items = await listAllInbox(deps([]));
    expect(items.every((item) => item.workspaceId !== coldC.id)).toBe(true);
  });
});
