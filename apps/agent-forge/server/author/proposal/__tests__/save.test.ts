import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { agentSpecV2Schema, type AgentSpecV2 } from 'lousho';
import type { AuthorToolFailure, ProposalOutput } from '../../../../shared/authorWire';
import type { StudioEvent } from '../../../../shared/wireTypes';
import { AgentRepo, defaultMeta } from '../../../storage/agentRepo';
import { VersionStore } from '../../../storage/versionStore';
import { specHash } from '../../../storage/specHash';
import { StudioEventBus } from '../../../events/eventBus';
import { AuthorSessionStore } from '../../sessionStore';
import { writeProposal, type WriteContext } from '../save';

/**
 * writeProposal (AA10b): the one write path behind the
 * save tools and the card's Apply button. Real AgentRepo / VersionStore /
 * AuthorSessionStore over a temp dir, so the assertions read the files
 * Studio would actually write.
 */

const BASE_SPEC: AgentSpecV2 = agentSpecV2Schema.parse({
  version: 2,
  name: 'Support triage',
  description: 'Routes support mail.',
  model: 'mock/mock-1',
  instructions: 'You triage support mail.',
  triggers: [{ id: 't1', type: 'chat' }],
}) as AgentSpecV2;

function card(proposalId: string, over: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    ok: true,
    proposalId,
    kind: 'create',
    spec: BASE_SPEC,
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: false,
    ...over,
  };
}

describe('writeProposal', () => {
  let dir: string;
  let sessionsDir: string;
  let repo: AgentRepo;
  let versions: VersionStore;
  let sessions: AuthorSessionStore;
  let bus: StudioEventBus;
  let published: StudioEvent[];
  let sessionId: string;

  const savedSpec: AgentSpecV2 = { ...BASE_SPEC, name: 'Existing bot' };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lou-aa10b-save-'));
    sessionsDir = path.join(dir, 'sessions');
    repo = new AgentRepo(dir);
    versions = new VersionStore(repo);
    sessions = new AuthorSessionStore(sessionsDir);
    bus = new StudioEventBus();
    published = [];
    bus.subscribe((event) => published.push(event));
    sessionId = (await sessions.create(undefined, 'ws-test')).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(over: Partial<WriteContext> = {}): WriteContext {
    return { sessionId, requestText: 'make me a bot', agents: repo, versions, sessions, bus, ...over };
  }

  function failure(result: unknown): AuthorToolFailure {
    expect(result).toMatchObject({ ok: false });
    return result as AuthorToolFailure;
  }

  it('create: writes the card spec exactly, disabled, author-stamped, versioned and linked to the session', async () => {
    const result = await writeProposal({ kind: 'create' }, card('call_p1'), ctx());
    expect(result).toEqual({
      ok: true,
      agentId: 'support-triage',
      version: 1,
      name: 'Support triage',
      enabled: false,
    });

    // The written spec deep-equals the card's spec (no re-sent copy).
    expect(await repo.readSpec('support-triage')).toEqual(BASE_SPEC);
    const meta = await repo.readMeta('support-triage');
    expect(meta.enabled).toBe(false);
    expect(meta.createdFrom).toEqual({ kind: 'author', ref: sessionId });

    const [item] = await versions.list('support-triage');
    expect(item).toMatchObject({
      version: 1,
      kind: 'create',
      source: 'author',
      requestText: 'make me a bot',
      authorSessionId: sessionId,
    });

    const session = await sessions.get(sessionId);
    expect(session?.createdAgentIds).toEqual(['support-triage']);
    expect(published).toEqual([{ type: 'agent.changed', agentId: 'support-triage', reason: 'version' }]);
  });

  it('update: writes the card spec, captures an author version and reports the saved meta.enabled', async () => {
    await repo.writeSpec('a', savedSpec);
    await repo.writeMeta('a', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled: true });
    await versions.capture('a', { kind: 'create', source: 'editor' });
    const updated: AgentSpecV2 = { ...savedSpec, description: 'Now it also files bugs.' };

    const result = await writeProposal(
      { kind: 'update', agentId: 'a' },
      card('call_u1', { kind: 'update', agentId: 'a', spec: updated, baseSpecHash: specHash(savedSpec) }),
      ctx({ requestText: 'also file bugs' })
    );
    expect(result).toEqual({ ok: true, agentId: 'a', version: 2, name: 'Existing bot', enabled: true });
    expect(await repo.readSpec('a')).toEqual(updated);
    const [item] = await versions.list('a');
    expect(item).toMatchObject({
      version: 2,
      kind: 'update',
      source: 'author',
      requestText: 'also file bugs',
      authorSessionId: sessionId,
    });
    expect(published).toEqual([{ type: 'agent.changed', agentId: 'a', reason: 'version' }]);
  });

  it('update on a spec the store already holds reports the latest version (no-op skip)', async () => {
    await repo.writeSpec('a', savedSpec);
    await repo.writeMeta('a', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled: true });
    await versions.capture('a', { kind: 'create', source: 'editor' });

    const result = await writeProposal(
      { kind: 'update', agentId: 'a' },
      card('call_u1', { kind: 'update', agentId: 'a', spec: savedSpec, baseSpecHash: specHash(savedSpec) }),
      ctx()
    );
    // The identical write is a no-op capture: the result names the existing version.
    expect(result).toMatchObject({ ok: true, version: 1 });
    expect(await versions.list('a')).toHaveLength(1);
  });

  it('update after a canvas edit refuses BASE_CHANGED and writes nothing', async () => {
    await repo.writeSpec('a', savedSpec);
    await repo.writeMeta('a', defaultMeta('2026-01-01T00:00:00.000Z'));
    await versions.capture('a', { kind: 'create', source: 'editor' });
    // The canvas moved the spec after the card was proposed.
    const onCanvas: AgentSpecV2 = { ...savedSpec, description: 'Canvas edit' };
    await repo.writeSpec('a', onCanvas);

    const result = failure(
      await writeProposal(
        { kind: 'update', agentId: 'a' },
        card('call_u1', {
          kind: 'update',
          agentId: 'a',
          spec: { ...savedSpec, description: 'Card edit' },
          baseSpecHash: specHash(savedSpec),
        }),
        ctx()
      )
    );
    expect(result.code).toBe('BASE_CHANGED');
    expect(await repo.readSpec('a')).toEqual(onCanvas);
    expect(await versions.list('a')).toHaveLength(1);
  });

  it('update on a deleted agent refuses AGENT_GONE', async () => {
    const result = failure(
      await writeProposal(
        { kind: 'update', agentId: 'ghost' },
        card('call_u1', { kind: 'update', agentId: 'ghost', baseSpecHash: 'sha256:any' }),
        ctx()
      )
    );
    expect(result.code).toBe('AGENT_GONE');
    expect(result.error).toContain('"ghost"');
  });

  it('a tampered stored spec refuses INVALID_STORED_PROPOSAL', async () => {
    const tampered = card('call_p1', { spec: { version: 2, name: 'x' } as unknown as AgentSpecV2 });
    const result = failure(await writeProposal({ kind: 'create' }, tampered, ctx()));
    expect(result.code).toBe('INVALID_STORED_PROPOSAL');
    expect(result.error).toContain('AgentSpec checks');
    expect(repo.listIds()).toEqual([]);
  });

  it('a throwing store becomes WRITE_FAILED', async () => {
    const throwing = {
      listIds: () => [],
      writeSpec: async () => {
        throw new Error('disk full');
      },
    } as unknown as AgentRepo;
    const result = failure(await writeProposal({ kind: 'create' }, card('call_p1'), ctx({ agents: throwing })));
    expect(result.code).toBe('WRITE_FAILED');
    expect(result.error).toContain('disk full');
    // A failure never marks the session's createdAgentIds.
    expect((await sessions.get(sessionId))?.createdAgentIds).toEqual([]);
  });
});
