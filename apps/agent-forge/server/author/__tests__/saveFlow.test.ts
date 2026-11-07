import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mockModel, type MockModel } from 'lousho/testing';
import type { AgentSpecV2 } from 'lousho';
import { AuthorSessionStore } from '../sessionStore';
import { SettingsStore } from '../../settingsStore';
import { SecretsStore } from '../../secretsStore';
import { AuthorTurnRunner } from '../turnRunner';
import { buildAuthorTools, type AuthorToolDeps, type CatalogService } from '../tools/index';
import { passReview } from '../proposal/review';
import { AgentRepo, defaultMeta } from '../../storage/agentRepo';
import { VersionStore } from '../../storage/versionStore';
import { StudioEventBus } from '../../events/eventBus';
import type { WorkspaceContext } from '../../workspace/context';
import type { AuthorSession, AuthorServerEvent, AuthorToolPart, ProposalOutput } from '../../../shared/authorWire';
import type { AuthorDraft } from '../draft/schema';

/**
 * The end-to-end save flow (AA10b): a real AuthorTurnRunner drives the
 * real propose + save tools over a real workspace, scripted by mockModel.
 * Turn 1 proposes (a card lands in the stored transcript), turn 2 saves -
 * and everything the write produces is on disk, not in the model's input.
 */

const DRAFT: AuthorDraft = {
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'mock/mock-1',
  instructions: 'You triage support mail and pick the queue.',
};

function fakeCatalog(): CatalogService {
  return {
    listModels: () => [{ id: 'mock/mock-1' }, { id: 'anthropic/claude-sonnet-5-5' }] as never,
    listTools: () => [] as never,
    listGuardrails: () => [],
    listTriggerTypes: () => [{ type: 'chat' }] as never,
    listSkills: async () => [],
    listKits: async () => [],
    listRegistryMcpServers: async () => [],
  };
}

describe('Author save flow', () => {
  let dir: string;
  let repo: AgentRepo;
  let store: AuthorSessionStore;
  let session: AuthorSession;
  let deps: AuthorToolDeps;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa10b-flow-'));
    repo = new AgentRepo(dir);
    store = new AuthorSessionStore(path.join(dir, 'sessions'));
    const workspace = {
      repo,
      versions: new VersionStore(repo),
      events: new StudioEventBus(),
    } as unknown as WorkspaceContext;
    deps = {
      workspace: async () => workspace,
      sessions: store,
      catalog: fakeCatalog(),
      templates: { list: async () => [] },
      probeMcp: async () => ({ ok: true, tools: [] }),
      docsDir: '/nonexistent-docs',
      reviewDraft: passReview,
      requirements: async () => [],
      secrets: { secretStatus: (name) => ({ name, hasValue: false, masked: null, updatedAt: null }) },
    };
    session = await store.create(undefined, 'ws-test');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeRunner(model: MockModel): AuthorTurnRunner {
    return new AuthorTurnRunner({
      sessions: store,
      settings: new SettingsStore(dir),
      secrets: new SecretsStore(dir),
      systemPrompt: () => 'You are the lousho Agent Author.',
      buildTools: (turn) => buildAuthorTools(turn, deps),
      turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
      providerFor: () => model,
    });
  }

  function turnEnd(runner: AuthorTurnRunner): Promise<AuthorServerEvent> {
    return new Promise((resolve) => {
      runner.on('event', (_sid, ev) => {
        if (ev.type === 'turn.finished' || ev.type === 'turn.error') resolve(ev);
      });
    });
  }

  /** Every tool part across the stored transcript's assistant messages. */
  async function toolParts(): Promise<AuthorToolPart[]> {
    const stored = await store.get(session.id);
    return (stored?.transcript ?? []).flatMap((message) =>
      message.role === 'assistant' ? message.parts.filter((part): part is AuthorToolPart => part.type === 'tool') : []
    );
  }

  /** The output of the done tool part named `name` with call id `toolCallId`. */
  async function toolOutput(name: string, toolCallId: string): Promise<Record<string, unknown>> {
    const part = (await toolParts()).find((p) => p.name === name && p.toolCallId === toolCallId);
    expect(part?.state).toBe('done');
    return part?.output as Record<string, unknown>;
  }

  it('turn 1 proposes, turn 2 saves: files, meta, version and session link all land', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgent', args: { draft: DRAFT }, id: 'call_p1' }] },
      { text: 'Here is the card.' },
      { toolCalls: [{ name: 'saveAgent', args: { proposalId: 'call_p1' }, id: 'call_s1' }] },
      { text: 'Saved.' },
    ]);
    const runner = makeRunner(model);

    let end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t1', text: 'build me a support triage bot' });
    await end;

    end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t2', text: 'yes, save it' });
    await end;

    // The save tool's result.
    expect(await toolOutput('saveAgent', 'call_s1')).toMatchObject({
      ok: true,
      agentId: 'support-triage',
      version: 1,
      name: 'Support triage',
      enabled: false,
    });

    // The agent file exists, deep-equal to the stored card's spec.
    const card = (await toolOutput('proposeAgent', 'call_p1')) as unknown as ProposalOutput;
    expect(await repo.readSpec('support-triage')).toEqual(card.spec);

    // New agents save disabled and carry the author provenance.
    const meta = await repo.readMeta('support-triage');
    expect(meta.enabled).toBe(false);
    expect(meta.createdFrom).toEqual({ kind: 'author', ref: session.id });

    // Version 1 is an author version naming the user text that asked for it.
    const versions = new VersionStore(repo);
    const [item] = await versions.list('support-triage');
    expect(item).toMatchObject({
      version: 1,
      kind: 'create',
      source: 'author',
      requestText: 'build me a support triage bot',
      authorSessionId: session.id,
    });

    // The session records the agent it created.
    expect((await store.get(session.id))?.createdAgentIds).toEqual(['support-triage']);
  });

  it('propose and save in the same turn -> UNANSWERED, nothing written', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgent', args: { draft: DRAFT }, id: 'call_p1' }] },
      { toolCalls: [{ name: 'saveAgent', args: { proposalId: 'call_p1' }, id: 'call_s1' }] },
      { text: 'Done.' },
    ]);
    const runner = makeRunner(model);
    const end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t1', text: 'make it and save it' });
    await end;

    expect(await toolOutput('saveAgent', 'call_s1')).toMatchObject({ ok: false, code: 'UNANSWERED' });
    expect(repo.listIds()).toEqual([]);
    expect((await store.get(session.id))?.createdAgentIds).toEqual([]);
  });

  it('a second save of the same card in one turn -> ALREADY_SAVED', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgent', args: { draft: DRAFT }, id: 'call_p1' }] },
      { text: 'Here is the card.' },
      { toolCalls: [{ name: 'saveAgent', args: { proposalId: 'call_p1' }, id: 'call_s1' }] },
      { toolCalls: [{ name: 'saveAgent', args: { proposalId: 'call_p1' }, id: 'call_s2' }] },
      { text: 'Done.' },
    ]);
    const runner = makeRunner(model);

    let end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t1', text: 'build the bot' });
    await end;
    end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t2', text: 'save it, twice' });
    await end;

    expect(await toolOutput('saveAgent', 'call_s1')).toMatchObject({ ok: true, agentId: 'support-triage' });
    expect(await toolOutput('saveAgent', 'call_s2')).toMatchObject({ ok: false, code: 'ALREADY_SAVED' });
    // Exactly one agent and exactly one version landed.
    expect(repo.listIds()).toEqual(['support-triage']);
    expect(await new VersionStore(repo).list('support-triage')).toHaveLength(1);
  });

  it('saveAgentUpdate writes the update card over the saved spec', async () => {
    // An agent already on disk, then one turn proposes the update and the next saves it.
    const saved: AgentSpecV2 = {
      version: 2,
      name: 'Triage',
      model: 'mock/mock-1',
      instructions: 'You triage.',
      triggers: [{ id: 't1', type: 'chat' }],
    };
    await repo.writeSpec('triage', saved);
    await repo.writeMeta('triage', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled: false });
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgentUpdate', args: { agentId: 'triage', patch: { description: 'Files bugs too.' } }, id: 'call_u1' }] },
      { text: 'Here is the card.' },
      { toolCalls: [{ name: 'saveAgentUpdate', args: { agentId: 'triage', proposalId: 'call_u1' }, id: 'call_s1' }] },
      { text: 'Saved.' },
    ]);
    const runner = makeRunner(model);

    let end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t1', text: 'change the description' });
    await end;
    end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa10b-t2', text: 'apply it' });
    await end;

    expect(await toolOutput('saveAgentUpdate', 'call_s1')).toMatchObject({
      ok: true,
      agentId: 'triage',
      version: 1,
      enabled: false,
    });
    expect((await repo.readSpec('triage'))?.description).toBe('Files bugs too.');
    const [item] = await new VersionStore(repo).list('triage');
    expect(item).toMatchObject({ version: 1, kind: 'update', source: 'author' });
  });

  /** An agent on disk for the update-side tests (same spec the AA10b update test saves). */
  async function seedTriage(): Promise<AgentSpecV2> {
    const saved: AgentSpecV2 = {
      version: 2,
      name: 'Triage',
      model: 'mock/mock-1',
      instructions: 'You triage.',
      triggers: [{ id: 't1', type: 'chat' }],
    };
    await repo.writeSpec('triage', saved);
    await repo.writeMeta('triage', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled: false });
    return saved;
  }

  it('turn 2 discards then saves the same update card -> NO_PROPOSAL, nothing written', async () => {
    await seedTriage();
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgentUpdate', args: { agentId: 'triage', patch: { description: 'First.' } }, id: 'call_u1' }] },
      { text: 'Here is the card.' },
      { toolCalls: [{ name: 'discardPendingChanges', args: { agentId: 'triage' }, id: 'call_d1' }] },
      { toolCalls: [{ name: 'saveAgentUpdate', args: { agentId: 'triage', proposalId: 'call_u1' }, id: 'call_s1' }] },
      { text: 'Done.' },
    ]);
    const runner = makeRunner(model);

    let end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa11-t1', text: 'change the description' });
    await end;
    end = turnEnd(runner);
    await runner.start(session.id, { requestId: 'req-aa11-t2', text: 'never mind, drop it and save' });
    await end;

    expect(await toolOutput('discardPendingChanges', 'call_d1')).toMatchObject({ ok: true, agentId: 'triage' });
    expect(await toolOutput('saveAgentUpdate', 'call_s1')).toMatchObject({ ok: false, code: 'NO_PROPOSAL' });
    // The discard touched nothing saved.
    expect((await repo.readSpec('triage'))?.description).toBeUndefined();
    expect(await new VersionStore(repo).list('triage')).toHaveLength(0);
  });

  it('the discard part in the stored transcript resets the gate: a later save -> NO_PROPOSAL', async () => {
    await seedTriage();
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgentUpdate', args: { agentId: 'triage', patch: { description: 'First.' } }, id: 'call_u1' }] },
      { text: 'Here is the card.' },
      { toolCalls: [{ name: 'discardPendingChanges', args: { agentId: 'triage' }, id: 'call_d1' }] },
      { text: 'Dropped it.' },
      { toolCalls: [{ name: 'saveAgentUpdate', args: { agentId: 'triage', proposalId: 'call_u1' }, id: 'call_s1' }] },
      { text: 'Done.' },
    ]);
    const runner = makeRunner(model);

    for (const [requestId, text] of [
      ['req-aa11-t1', 'change it'],
      ['req-aa11-t2', 'drop that'],
      ['req-aa11-t3', 'actually save it'],
    ] as const) {
      const end = turnEnd(runner);
      await runner.start(session.id, { requestId, text });
      await end;
    }

    // The stored transcript's ok discard part reset the card's status to
    // none, so turn 3's save scan finds no open card.
    expect(await toolOutput('saveAgentUpdate', 'call_s1')).toMatchObject({ ok: false, code: 'NO_PROPOSAL' });
  });

  it('proposing again in a later turn after discarding does not fold the dropped card', async () => {
    await seedTriage();
    const model = mockModel([
      { toolCalls: [{ name: 'proposeAgentUpdate', args: { agentId: 'triage', patch: { description: 'First.' } }, id: 'call_u1' }] },
      { text: 'Here is the card.' },
      { toolCalls: [{ name: 'discardPendingChanges', args: { agentId: 'triage' }, id: 'call_d1' }] },
      { text: 'Dropped it.' },
      { toolCalls: [{ name: 'proposeAgentUpdate', args: { agentId: 'triage', patch: { description: 'Second.' } }, id: 'call_u2' }] },
      { text: 'Here is the new card.' },
    ]);
    const runner = makeRunner(model);

    for (const [requestId, text] of [
      ['req-aa11-t1', 'change it'],
      ['req-aa11-t2', 'drop that'],
      ['req-aa11-t3', 'new idea'],
    ] as const) {
      const end = turnEnd(runner);
      await runner.start(session.id, { requestId, text });
      await end;
    }

    const card = (await toolOutput('proposeAgentUpdate', 'call_u2')) as unknown as ProposalOutput;
    expect(card.carriedOver).toBe(false);
    expect(card.carriedFields).toEqual([]);
    expect(card.spec.description).toBe('Second.');
  });
});
