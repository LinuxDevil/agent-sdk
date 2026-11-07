import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { testToolContext } from 'lousho/testing';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorToolDeps, CatalogService } from '../index';
import type { AuthorTurn } from '../../turnRunner';
import type { WorkspaceContext } from '../../../workspace/context';
import { AgentRepo, defaultMeta } from '../../../storage/agentRepo';
import { specHash } from '../../../storage/specHash';
import { applyAuthorPatch } from '../../draft/toSpec';
import { proposalTurnState } from '../../proposal/turnState';
import { passReview } from '../../proposal/review';
import { AuthorSessionStore } from '../../sessionStore';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolFailure,
  AuthorToolPart,
  ProposalOutput,
} from '../../../../shared/authorWire';
import { AUTHOR_TOOL_FACTORIES, buildAuthorTools } from '../index';

/**
 * proposeAgentUpdate (AA09): the patch card for an EXISTING agent - patch
 * semantics over the saved spec, anchored instructionsEdits, and folding
 * of an earlier unsaved card for the same agent (stored transcript or
 * this turn's proposal record). Nothing is ever written to disk.
 */

const SAVED: AgentSpecV2 = {
  version: 2,
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'mock/mock-1',
  instructions: 'You triage support mail. Pick a queue. Reply politely.',
  tools: [{ builtin: 'web_fetch' }, { builtin: 'http_request' }],
  triggers: [{ id: 't1', type: 'chat' }],
};

const SAVED_HASH = specHash(SAVED);

/** A workspace rooted in a fresh tmpdir (the agent file is written per test by `writeAgent`). */
function workspace(): { root: string; repo: AgentRepo } {
  const root = mkdtempSync(path.join(tmpdir(), 'aa09-'));
  return { root, repo: new AgentRepo(root) };
}

function turn(storedTranscript: AuthorMessage[] = []): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-test',
    focus: { mode: 'edit', agentId: 'a' },
    storedTranscript,
    userMessage: { id: 'm-1', role: 'user', text: 'change it', at: '2026-01-01T00:00:00.000Z' },
    signal: new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
  };
}

function fakeCatalog(): CatalogService {
  return {
    listModels: () => [{ id: 'mock/mock-1' }] as never,
    listTools: () => [{ name: 'web_fetch' }, { name: 'http_request' }] as never,
    listGuardrails: () => [],
    listTriggerTypes: () => [{ type: 'chat' }] as never,
    listSkills: async () => [],
    listKits: async () => [],
    listRegistryMcpServers: async () => [],
  };
}

function fakeDeps(repo: AgentRepo, over: Partial<AuthorToolDeps> = {}): AuthorToolDeps {
  return {
    workspace: async () => ({ repo } as unknown as WorkspaceContext),
    catalog: fakeCatalog(),
    templates: { list: async () => [] },
    probeMcp: async () => ({ ok: true, tools: [] }),
    docsDir: '/nonexistent-docs',
    reviewDraft: passReview,
    requirements: async () => [],
    sessions: new AuthorSessionStore('/unused-sessions'),
    secrets: { secretStatus: (name) => ({ name, hasValue: false, masked: null, updatedAt: null }) },
    ...over,
  };
}

function updateTool(t: AuthorTurn, deps: AuthorToolDeps) {
  return buildAuthorTools(t, deps).find(
    (candidate) => ((candidate as { name?: string }).name ?? candidate.displayName) === 'proposeAgentUpdate'
  )!;
}

async function call(
  tool: ReturnType<typeof updateTool>,
  args: Record<string, unknown>,
  toolCallId = 'call_a'
): Promise<ProposalOutput | AuthorToolFailure> {
  return (await tool.execute!(args as never, testToolContext({ toolCallId }))) as
    | ProposalOutput
    | AuthorToolFailure;
}

/** `applyAuthorPatch` as a spec-only helper for building pending-card fixtures. */
function patchedSpec(patch: Parameters<typeof applyAuthorPatch>[1]): AgentSpecV2 {
  const built = applyAuthorPatch(SAVED, patch);
  if (!built.ok) throw new Error('fixture patch did not build');
  return built.spec;
}

/** An ok `proposeAgentUpdate` tool part as a previous turn persisted it. */
function proposePart(toolCallId: string, output: ProposalOutput): AuthorToolPart {
  return { type: 'tool', name: 'proposeAgentUpdate', toolCallId, input: { agentId: 'a' }, output, state: 'done' };
}

function assistantMsg(parts: AuthorToolPart[]): AuthorAssistantMessage {
  return { id: `m_${parts.map((p) => p.toolCallId).join('_')}`, role: 'assistant', parts, at: '2026-01-01T00:00:00.000Z' };
}

/** The ProposalOutput a stored open card carries, as turn 1's tool result recorded it. */
function cardOutput(proposalId: string, spec: AgentSpecV2, baseSpecHash = SAVED_HASH): ProposalOutput {
  return {
    ok: true,
    proposalId,
    kind: 'update',
    agentId: 'a',
    spec,
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash,
    enabled: true,
  };
}

/** The open-card transcript a second turn sees after turn 1 proposed `spec`. */
function transcriptWithCard(proposalId: string, spec: AgentSpecV2, extra: AuthorMessage[] = []): AuthorMessage[] {
  return [assistantMsg([proposePart(proposalId, cardOutput(proposalId, spec))]), ...extra];
}

async function writeAgent(repo: AgentRepo, spec: AgentSpecV2 = SAVED, enabled = true): Promise<void> {
  await repo.writeSpec('a', spec);
  await repo.writeMeta('a', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled });
}

describe('proposeAgentUpdate', () => {
  it('is registered in AUTHOR_TOOL_FACTORIES', () => {
    const { repo } = workspace();
    const names = AUTHOR_TOOL_FACTORIES.map((factory) => factory(turn(), fakeDeps(repo))).map(
      (tool) => (tool as { name?: string }).name ?? tool.displayName
    );
    expect(names).toContain('proposeAgentUpdate');
  });

  it('patch { tools: [] } on an agent with 2 tools removes each, carrying nothing, writing nothing', async () => {
    const { root, repo } = workspace();
    await writeAgent(repo);
    const before = readdirSync(root, { recursive: true });
    const specBefore = readFileSync(repo.specPath('a'), 'utf8');

    const t = turn();
    const output = (await call(updateTool(t, fakeDeps(repo)), { agentId: 'a', patch: { tools: [] } })) as ProposalOutput;

    expect(output.ok).toBe(true);
    expect(output.kind).toBe('update');
    expect(output.agentId).toBe('a');
    expect(output.proposalId).toBe('call_a');
    expect(output.baseSpecHash).toBe(SAVED_HASH);
    expect(output.enabled).toBe(true);
    expect(output.carriedOver).toBe(false);
    expect(output.carriedFields).toEqual([]);
    expect(output.spec.tools ?? []).toEqual([]);
    const removes = output.changes.filter((change) => change.op === 'remove');
    expect(removes.map((change) => change.field)).toEqual(['tools[web_fetch]', 'tools[http_request]']);
    expect(proposalTurnState(t).proposed.get('update:a')).toBe(output);
    expect(readdirSync(root, { recursive: true })).toEqual(before);
    expect(readFileSync(repo.specPath('a'), 'utf8')).toBe(specBefore);
  });

  it('reports meta.enabled on the card', async () => {
    const { repo } = workspace();
    await writeAgent(repo, SAVED, false);
    const output = (await call(updateTool(turn(), fakeDeps(repo)), {
      agentId: 'a',
      patch: { description: 'Shorter pitch.' },
    })) as ProposalOutput;
    expect(output.enabled).toBe(false);
  });

  it('an unknown agentId is AGENT_NOT_FOUND', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const output = (await call(updateTool(turn(), fakeDeps(repo)), {
      agentId: 'ghost',
      patch: { description: 'x' },
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('AGENT_NOT_FOUND');
  });

  it('an empty patch and no instructionsEdits is EMPTY_PATCH', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const output = (await call(updateTool(turn(), fakeDeps(repo)), { agentId: 'a', patch: {} })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('EMPTY_PATCH');
    expect(output.error).toBe('The patch changes nothing.');
  });

  it('patch.instructions plus instructionsEdits is EDITS_AND_INSTRUCTIONS', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const output = (await call(updateTool(turn(), fakeDeps(repo)), {
      agentId: 'a',
      patch: { instructions: 'Full rewrite.' },
      instructionsEdits: [{ oldText: 'Pick a queue.', newText: 'Pick the queue.' }],
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('EDITS_AND_INSTRUCTIONS');
  });

  it('a { file } instructions field is INSTRUCTIONS_IN_FILE naming the file', async () => {
    const { repo } = workspace();
    await writeAgent(repo, { ...SAVED, instructions: { file: 'prompts/triage.md' } });
    const output = (await call(updateTool(turn(), fakeDeps(repo)), {
      agentId: 'a',
      patch: {},
      instructionsEdits: [{ oldText: 'Pick a queue.', newText: 'Pick the queue.' }],
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('INSTRUCTIONS_IN_FILE');
    expect(output.error).toContain('"prompts/triage.md"');
  });

  it('a valid pair of anchored edits applies both to the saved instructions', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const output = (await call(updateTool(turn(), fakeDeps(repo)), {
      agentId: 'a',
      patch: {},
      instructionsEdits: [
        { oldText: 'Pick a queue.', newText: 'Pick the queue.' },
        { oldText: 'Reply politely.', newText: '' },
      ],
    })) as ProposalOutput;
    expect(output.ok).toBe(true);
    expect(output.spec.instructions).toBe('You triage support mail. Pick the queue. ');
  });

  it('an anchor that matches nothing fails with the current instructions and retryWith', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const output = (await call(updateTool(turn(), fakeDeps(repo)), {
      agentId: 'a',
      patch: {},
      instructionsEdits: [{ oldText: 'No such sentence.', newText: 'x' }],
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('ANCHOR_NOT_FOUND');
    expect(output.currentInstructions).toBe(SAVED.instructions);
    expect(output.retryWith).toBe('instructions');
  });

  it('folds an unsaved card from the stored transcript: both changes land, earlier field is carried', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const pendingSpec = patchedSpec({ description: 'Turn 1 rewrote the pitch.' });
    const t = turn(transcriptWithCard('p1', pendingSpec));

    const output = (await call(updateTool(t, fakeDeps(repo)), {
      agentId: 'a',
      patch: { tools: [] },
    })) as ProposalOutput;

    expect(output.ok).toBe(true);
    expect(output.spec.description).toBe('Turn 1 rewrote the pitch.');
    expect(output.spec.tools ?? []).toEqual([]);
    expect(output.carriedOver).toBe(true);
    expect(output.carriedFields).toEqual(['description']);
    const fields = output.changes.map((change) => change.field);
    expect(fields).toContain('description');
    expect(fields).toEqual(expect.arrayContaining(['tools[web_fetch]', 'tools[http_request]']));
  });

  it('folds an unsaved card proposed earlier in the SAME turn', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const t = turn();
    const tool = updateTool(t, fakeDeps(repo));
    await call(tool, { agentId: 'a', patch: { description: 'Same-turn rewrite.' } }, 'call_1');
    const output = (await call(tool, { agentId: 'a', patch: { tools: [] } }, 'call_2')) as ProposalOutput;

    expect(output.ok).toBe(true);
    expect(output.spec.description).toBe('Same-turn rewrite.');
    expect(output.spec.tools ?? []).toEqual([]);
    expect(output.carriedFields).toEqual(['description']);
  });

  it('does not fold a stored card that was discarded', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const pendingSpec = patchedSpec({ description: 'Discarded rewrite.' });
    const discard: AuthorToolPart = {
      type: 'tool',
      name: 'discardPendingChanges',
      toolCallId: 'd1',
      input: { agentId: 'a' },
      output: { ok: true },
      state: 'done',
    };
    const t = turn([assistantMsg([proposePart('p1', cardOutput('p1', pendingSpec)), discard])]);
    const output = (await call(updateTool(t, fakeDeps(repo)), {
      agentId: 'a',
      patch: { tools: [] },
    })) as ProposalOutput;
    expect(output.ok).toBe(true);
    expect(output.spec.description).toBe(SAVED.description);
    expect(output.carriedOver).toBe(false);
    expect(output.carriedFields).toEqual([]);
  });

  it('does not fold a stored card that was already saved (Apply uiEvent)', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const pendingSpec = patchedSpec({ description: 'Already saved rewrite.' });
    const saveEvent: AuthorMessage = {
      id: 'm_save',
      role: 'user',
      text: '',
      at: '2026-01-01T00:00:00.000Z',
      uiEvent: { kind: 'save', proposalId: 'p1', agentId: 'a', version: 2 },
    };
    const t = turn(transcriptWithCard('p1', pendingSpec, [saveEvent]));
    const output = (await call(updateTool(t, fakeDeps(repo)), {
      agentId: 'a',
      patch: { tools: [] },
    })) as ProposalOutput;
    expect(output.ok).toBe(true);
    expect(output.spec.description).toBe(SAVED.description);
    expect(output.carriedOver).toBe(false);
  });

  it('does not fold when the turn discarded or saved the card this turn', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const pendingSpec = patchedSpec({ description: 'Turn-state rewrite.' });
    for (const mark of ['discarded', 'saved'] as const) {
      const t = turn(transcriptWithCard('p1', pendingSpec));
      proposalTurnState(t)[mark].add('update:a');
      const output = (await call(updateTool(t, fakeDeps(repo)), {
        agentId: 'a',
        patch: { tools: [] },
      })) as ProposalOutput;
      expect(output.ok).toBe(true);
      expect(output.spec.description).toBe(SAVED.description);
      expect(output.carriedOver).toBe(false);
    }
  });

  it('ignores a pending card whose base no longer matches the saved spec (canvas edit)', async () => {
    const { repo } = workspace();
    await writeAgent(repo); // disk now holds SAVED
    const staleSpec = patchedSpec({ description: 'Card based on an older spec.' });
    const card = cardOutput('p1', staleSpec, specHash({ ...SAVED, description: 'The spec the card was built on.' }));
    const t = turn([assistantMsg([proposePart('p1', card)])]);
    const output = (await call(updateTool(t, fakeDeps(repo)), {
      agentId: 'a',
      patch: { tools: [] },
    })) as ProposalOutput;
    expect(output.ok).toBe(true);
    expect(output.spec.description).toBe(SAVED.description);
    expect(output.carriedOver).toBe(false);
    expect(output.carriedFields).toEqual([]);
  });

  it('retries a missed anchor against the saved instructions and drops instructions from carriedFields', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    // The pending card rewrote instructions entirely (anchors no longer match)
    // AND changed the description; the edits only fit the saved text.
    const pendingSpec = patchedSpec({
      description: 'Pending pitch.',
      instructions: 'A wholly rewritten prompt with no shared anchors.',
    });
    const t = turn(transcriptWithCard('p1', pendingSpec));
    const output = (await call(updateTool(t, fakeDeps(repo)), {
      agentId: 'a',
      patch: {},
      instructionsEdits: [{ oldText: 'Pick a queue.', newText: 'Pick the queue.' }],
    })) as ProposalOutput;

    expect(output.ok).toBe(true);
    expect(output.spec.instructions).toBe('You triage support mail. Pick the queue. Reply politely.');
    expect(output.spec.description).toBe('Pending pitch.');
    expect(output.carriedOver).toBe(true);
    expect(output.carriedFields).toEqual(['description']);
  });

  it('an anchor that fails against both bases reports the folded base instructions', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const pendingSpec = patchedSpec({ instructions: 'Pending prompt text.' });
    const t = turn(transcriptWithCard('p1', pendingSpec));
    const output = (await call(updateTool(t, fakeDeps(repo)), {
      agentId: 'a',
      patch: {},
      instructionsEdits: [{ oldText: 'Matches neither text.', newText: 'x' }],
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('ANCHOR_NOT_FOUND');
    expect(output.currentInstructions).toBe('Pending prompt text.');
    expect(output.retryWith).toBe('instructions');
  });

  it('a failing review returns its failure and leaves proposed empty', async () => {
    const { repo } = workspace();
    await writeAgent(repo);
    const reviewFailure: AuthorToolFailure = {
      ok: false,
      code: 'DRAFT_REVIEW',
      error: 'The change would not run.',
      userMessage: 'The Author is still working on the change.',
    };
    const t = turn();
    const output = (await call(
      updateTool(t, fakeDeps(repo, { reviewDraft: async () => ({ pass: false, failure: reviewFailure }) })),
      { agentId: 'a', patch: { tools: [] } }
    )) as AuthorToolFailure;
    expect(output).toBe(reviewFailure);
    expect(proposalTurnState(t).proposed.size).toBe(0);
  });
});
