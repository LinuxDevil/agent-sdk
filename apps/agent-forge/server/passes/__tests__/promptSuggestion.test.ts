import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import type { ObservationRow } from 'lousho/traces';
import type { PromptSuggestion } from '../../../shared/wireTypes';
import { AgentRepo } from '../../storage/agentRepo';
import { VersionStore } from '../../storage/versionStore';
import { SuggestionStore, promptHash } from '../../storage/suggestionStore';
import { StudioEventBus } from '../../events/eventBus';
import { SecretsStore } from '../../secretsStore';
import { SettingsStore } from '../../settingsStore';
import { studioPathsFor } from '../../workspace/studioPaths';
import type { InboxService } from '../../inbox/inboxService';
import {
  PassOutputError,
  PassSkippedError,
  PassUnavailableError,
  PassRefusedError,
  type PassContext,
  type PassJob,
  type PassResult,
  type PassRunner,
} from '../passRunner';

const callPassModel = vi.hoisted(() => vi.fn());
vi.mock('../passModel', () => ({ callPassModel }));

import {
  PROMPT_SUGGESTION_SYSTEM_PROMPT,
  applyPromptSuggestion,
  buildSuggestionPrompt,
  enqueuePromptSuggestion,
  promptSuggestionOutputSchema,
  validateSuggestion,
  type PromptSuggestionDeps,
} from '../promptSuggestion';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  instructions: 'Check the queues. Be helpful.',
};

const INSTRUCTIONS = SPEC.instructions as string;

const EDIT_OUTPUT = {
  oldText: 'Be helpful.',
  newText: 'Always cite sources.',
  confidence: 'high' as const,
  optimizationClass: 'Missing operational fact' as const,
  evidence: 'Calls #2 and #3 repeat #1.',
  expectedSaving: '~800 tokens per run',
  risk: 'Citations may lengthen answers.',
  validationPlan: ['Re-run the friction trace'],
};

function obs(over: Partial<ObservationRow> & { obs_id: string }): ObservationRow {
  return {
    trace_id: 't1',
    session_id: null,
    agent_id: 'a1',
    parent_obs_id: null,
    kind: 'tool',
    name: 'fetch',
    start: 0,
    end: 1,
    status: 'ok',
    input: '{}',
    output: 'ok',
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...over,
  };
}

const TRACE_BODY = {
  trace_id: 'trace-1',
  observations: [
    obs({ obs_id: 'r', kind: 'agent', name: 'invoke_agent ops', parent_obs_id: null, output: 'done' }),
    obs({ obs_id: 'o1', name: 'fetch_page', input: '{"url":"a"}', status: 'error', output: 'boom' }),
  ],
  scores: [],
};

describe('promptSuggestion pass', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let versions: VersionStore;
  let suggestions: SuggestionStore;
  let events: StudioEventBus;
  let inboxRefresh: Mock;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let enqueue: Mock<[PassJob<unknown>], Promise<PassResult<unknown>>>;
  let passRunner: PassRunner;
  let deps: PromptSuggestionDeps;

  const ctx = (): PassContext => ({
    attempt: 1,
    signal: new AbortController().signal,
    record: vi.fn(),
  });

  const runJob = async (job: PassJob<unknown>): Promise<PassResult<unknown>> => {
    try {
      return { ok: true, value: await job.run(ctx()) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PassUnavailableError) return { ok: false, outcome: 'unavailable', error: message };
      if (error instanceof PassRefusedError) return { ok: false, outcome: 'refused', error: message };
      if (error instanceof PassSkippedError) return { ok: false, outcome: 'skipped', error: message };
      if (error instanceof PassOutputError) return { ok: false, outcome: 'failed', error: message };
      return { ok: false, outcome: 'failed', error: message };
    }
  };

  const stubTraceFetch = (body: unknown = TRACE_BODY, status = 200) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    );
  };

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r05-prompt-'));
    repo = new AgentRepo(baseDir);
    versions = new VersionStore(repo);
    suggestions = new SuggestionStore(repo);
    events = new StudioEventBus();
    inboxRefresh = vi.fn(async () => undefined);
    settings = new SettingsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    secrets = new SecretsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    enqueue = vi.fn(runJob);
    passRunner = { enqueue } as unknown as PassRunner;
    deps = {
      passRunner,
      repo,
      versions,
      suggestions,
      events,
      inbox: { refresh: inboxRefresh } as unknown as InboxService,
      secretsStore: secrets,
      settings,
      workspaceId: 'ws-1',
    };
    callPassModel.mockReset();
    await repo.writeSpec('ops', SPEC);
    stubTraceFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('a valid reply stores the record with both hashes, publishes suggestion.new and refreshes the inbox', async () => {
    callPassModel.mockResolvedValue(EDIT_OUTPUT);
    const publish = vi.spyOn(events, 'publish');

    const { suggestionId } = await enqueuePromptSuggestion(deps, 'ops', 'trace-1');
    const settled = enqueue.mock.results.at(-1)?.value as Promise<PassResult<unknown>>;
    const result = await settled;

    expect(result.ok).toBe(true);
    const job = enqueue.mock.calls[0][0];
    expect(job).toMatchObject({ kind: 'prompt_suggestion', key: 'ops:trace-1', agentId: 'ops', workspaceId: 'ws-1' });
    const stored = await suggestions.get('ops', suggestionId);
    expect(stored).toMatchObject({
      kind: 'prompt_edit',
      id: suggestionId,
      agentId: 'ops',
      sourceTraceId: 'trace-1',
      oldText: 'Be helpful.',
      newText: 'Always cite sources.',
      status: 'open',
      resolvedAt: null,
      appliedVersion: null,
    });
    expect((stored as PromptSuggestion).expectedPromptHash).toBe(promptHash(INSTRUCTIONS));
    expect((stored as PromptSuggestion).proposedPromptHash).toBe(promptHash('Check the queues. Always cite sources.'));
    expect(publish).toHaveBeenCalledWith({ type: 'suggestion.new', agentId: 'ops', suggestionId });
    expect(inboxRefresh).toHaveBeenCalled();
  });

  it('sends the model the digest, never the raw observations, inside the prompt contract', async () => {
    callPassModel.mockResolvedValue({ noSuggestion: true, reason: 'clean run' });
    await enqueuePromptSuggestion(deps, 'ops', 'trace-1');
    await (enqueue.mock.results.at(-1)?.value as Promise<PassResult<unknown>>);

    const input = callPassModel.mock.calls[0][0];
    expect(input.system).toBe(PROMPT_SUGGESTION_SYSTEM_PROMPT);
    expect(input.prompt).toContain('Agent: ops');
    expect(input.prompt).toContain('=== CURRENT INSTRUCTIONS ===\nCheck the queues. Be helpful.');
    expect(input.prompt).toContain('=== RUN TRACE ===');
    expect(input.prompt).toContain('#1 fetch_page error');
    expect(input.prompt).not.toContain('"obs_id"');
  });

  it('a noSuggestion verdict stores nothing and completes', async () => {
    callPassModel.mockResolvedValue({ noSuggestion: true, reason: 'nothing worth fixing' });
    const { suggestionId } = await enqueuePromptSuggestion(deps, 'ops', 'trace-1');
    const result = await (enqueue.mock.results.at(-1)?.value as Promise<PassResult<unknown>>);
    expect(result).toEqual({ ok: true, value: null });
    expect(await suggestions.get('ops', suggestionId)).toBeUndefined();
    expect(inboxRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['oldText occurring twice', { ...EDIT_OUTPUT, oldText: 'e' }],
    ['oldText equal to newText', { ...EDIT_OUTPUT, newText: 'Be helpful.' }],
    [
      'more than 15 changed lines',
      { ...EDIT_OUTPUT, newText: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') },
    ],
  ])('rejects a reply with %s and stores nothing', async (_label, output) => {
    callPassModel.mockResolvedValue(output);
    const { suggestionId } = await enqueuePromptSuggestion(deps, 'ops', 'trace-1');
    const result = await (enqueue.mock.results.at(-1)?.value as Promise<PassResult<unknown>>);
    expect(result.ok).toBe(false);
    expect(await suggestions.get('ops', suggestionId)).toBeUndefined();
  });

  it('rejects a reply whose edit would empty the instructions', async () => {
    await repo.writeSpec('ops', { ...SPEC, instructions: 'Be helpful.' });
    callPassModel.mockResolvedValue({ ...EDIT_OUTPUT, oldText: 'Be helpful.', newText: '' });
    const { suggestionId } = await enqueuePromptSuggestion(deps, 'ops', 'trace-1');
    const result = await (enqueue.mock.results.at(-1)?.value as Promise<PassResult<unknown>>);
    expect(result.ok).toBe(false);
    expect(await suggestions.get('ops', suggestionId)).toBeUndefined();
  });

  it('answers 404 for an unknown agent, 422 for file instructions and 409 while in flight', async () => {
    await expect(enqueuePromptSuggestion(deps, 'ghost', 'trace-1')).rejects.toMatchObject({
      status: 404,
      code: 'LOUSHO_AGENT_NOT_FOUND',
    });

    await repo.writeSpec('fileops', { ...SPEC, name: 'fileops', instructions: { file: 'prompt.md' } });
    await expect(enqueuePromptSuggestion(deps, 'fileops', 'trace-1')).rejects.toMatchObject({
      status: 422,
      code: 'LOUSHO_SUGGESTION_UNSUPPORTED',
    });

    // A pass that never settles keeps the trace in flight; release it at
    // the end so the module-level marker does not leak into later tests.
    let release!: () => void;
    enqueue.mockImplementation(
      () =>
        new Promise<PassResult<unknown>>((resolve) => {
          release = () => resolve({ ok: true, value: null });
        })
    );
    await enqueuePromptSuggestion(deps, 'ops', 'trace-1');
    await expect(enqueuePromptSuggestion(deps, 'ops', 'trace-1')).rejects.toMatchObject({
      status: 409,
      code: 'LOUSHO_SUGGESTION_IN_FLIGHT',
    });
    // A different trace is not blocked.
    enqueue.mockImplementation(runJob);
    callPassModel.mockResolvedValue({ noSuggestion: true, reason: 'x' });
    await expect(enqueuePromptSuggestion(deps, 'ops', 'trace-2')).resolves.toBeDefined();
    release();
    await vi.waitFor(async () => {
      // The marker clears once the pending pass settles.
      await expect(enqueuePromptSuggestion(deps, 'ops', 'trace-1')).resolves.toBeDefined();
    });
  });

  it('answers 404 for an unknown trace and 502 when the daemon is down', async () => {
    stubTraceFetch({ error: 'not found' }, 404);
    await expect(enqueuePromptSuggestion(deps, 'ops', 'missing')).rejects.toMatchObject({
      status: 404,
      code: 'LOUSHO_TRACE_NOT_FOUND',
    });

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    await expect(enqueuePromptSuggestion(deps, 'ops', 'trace-1')).rejects.toMatchObject({
      status: 502,
      code: 'LOUSHO_OBSERVE_UNAVAILABLE',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('validateSuggestion', () => {
  const out = { ...EDIT_OUTPUT };

  it('returns the rewritten instructions for a valid edit', () => {
    expect(validateSuggestion(INSTRUCTIONS, out)).toBe('Check the queues. Always cite sources.');
  });

  it('throws PassOutputError naming the failed rule', () => {
    expect(() => validateSuggestion('a b a b', { ...out, oldText: 'a b' })).toThrow(PassOutputError);
    expect(() => validateSuggestion(INSTRUCTIONS, { ...out, newText: out.oldText })).toThrow(/must differ/);
    expect(() =>
      validateSuggestion(INSTRUCTIONS, { ...out, newText: 'x\n'.repeat(20) })
    ).toThrow(/at most 15/);
    expect(() => validateSuggestion('only', { ...out, oldText: 'only', newText: '' })).toThrow(/empty/);
  });
});

describe('promptSuggestionOutputSchema', () => {
  it('accepts the noSuggestion verdict and the edit shape, clipping long fields', () => {
    expect(promptSuggestionOutputSchema.safeParse({ noSuggestion: true, reason: 'clean' }).success).toBe(true);
    const parsed = promptSuggestionOutputSchema.safeParse({
      ...EDIT_OUTPUT,
      evidence: 'x'.repeat(2000),
      validationPlan: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && 'oldText' in parsed.data) {
      expect(parsed.data.evidence.length).toBeLessThanOrEqual(1200);
      expect(parsed.data.validationPlan).toHaveLength(5);
    }
    expect(promptSuggestionOutputSchema.safeParse({ oldText: 'x' }).success).toBe(false);
  });
});

describe('applyPromptSuggestion', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let versions: VersionStore;
  let suggestions: SuggestionStore;
  let events: StudioEventBus;
  let deps: Pick<PromptSuggestionDeps, 'repo' | 'versions' | 'suggestions' | 'events'>;

  const SUGGESTION: PromptSuggestion = {
    kind: 'prompt_edit',
    id: 'sug-1',
    agentId: 'ops',
    sourceTraceId: 'trace-1',
    expectedPromptHash: promptHash(INSTRUCTIONS),
    proposedPromptHash: promptHash('Check the queues. Always cite sources.'),
    oldText: 'Be helpful.',
    newText: 'Always cite sources.',
    confidence: 'high',
    optimizationClass: 'Missing operational fact',
    evidence: 'e',
    expectedSaving: 's',
    risk: 'r',
    validationPlan: ['v'],
    status: 'open',
    createdAt: '2026-02-03T04:05:06.000Z',
    updatedAt: '2026-02-03T04:05:06.000Z',
    resolvedAt: null,
    appliedVersion: null,
  };

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r05-apply-'));
    repo = new AgentRepo(baseDir);
    versions = new VersionStore(repo);
    suggestions = new SuggestionStore(repo);
    events = new StudioEventBus();
    deps = { repo, versions, suggestions, events };
    await repo.writeSpec('ops', SPEC);
    await suggestions.save('ops', SUGGESTION);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes a source:suggestion version, rewrites the instructions and settles the record', async () => {
    const publish = vi.spyOn(events, 'publish');
    const result = await applyPromptSuggestion(deps, 'ops', 'sug-1');
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.version).toMatchObject({
      kind: 'update',
      source: 'suggestion',
      requestText: 'From run trace-1: Missing operational fact',
    });
    expect(result.version.changedFields).toContain('instructions');
    expect((await repo.readSpec('ops'))?.instructions).toBe('Check the queues. Always cite sources.');
    expect(await suggestions.get('ops', 'sug-1')).toMatchObject({
      status: 'applied',
      resolvedAt: expect.any(String),
      appliedVersion: result.version.version,
    });
    expect(publish).toHaveBeenCalledWith({ type: 'agent.changed', agentId: 'ops', reason: 'version' });
  });

  it('a second apply is not_open; an edit since suggestion is conflict; a retried apply after the rewrite landed returns the latest version', async () => {
    const first = await applyPromptSuggestion(deps, 'ops', 'sug-1');
    expect(first.status).toBe('applied');
    expect(await applyPromptSuggestion(deps, 'ops', 'sug-1')).toEqual({ status: 'not_open' });

    // A fresh open suggestion whose expected hash no longer matches.
    await repo.writeSpec('ops', { ...SPEC, instructions: 'Hand-edited instructions.' });
    await suggestions.save('ops', { ...SUGGESTION, id: 'sug-2' });
    expect(await applyPromptSuggestion(deps, 'ops', 'sug-2')).toEqual({ status: 'conflict' });
    expect(await suggestions.get('ops', 'sug-2')).toMatchObject({ status: 'conflict', resolvedAt: expect.any(String) });

    // Crash-between-write-and-settle: instructions already carry the edit,
    // the record is still open - apply settles it against the latest version.
    await repo.writeSpec('ops', { ...SPEC, instructions: 'Check the queues. Always cite sources.' });
    await suggestions.save('ops', { ...SUGGESTION, id: 'sug-3' });
    const retried = await applyPromptSuggestion(deps, 'ops', 'sug-3');
    expect(retried.status).toBe('applied');
    expect(await suggestions.get('ops', 'sug-3')).toMatchObject({ status: 'applied' });
    // No extra version was written for the retry: still just v1 from the first apply.
    expect((await versions.list('ops')).map((item) => item.version)).toEqual([1]);
  });

  it('answers not_found for a missing record and unsupported for file instructions', async () => {
    expect(await applyPromptSuggestion(deps, 'ops', 'nope')).toEqual({ status: 'not_found' });
    await repo.writeSpec('fileops', { ...SPEC, name: 'fileops', instructions: { file: 'prompt.md' } });
    await suggestions.save('fileops', { ...SUGGESTION, id: 'sug-f', agentId: 'fileops' });
    expect(await applyPromptSuggestion(deps, 'fileops', 'sug-f')).toEqual({ status: 'unsupported' });
  });
});

describe('PROMPT_SUGGESTION_SYSTEM_PROMPT', () => {
  it('is byte-stable', () => {
    expect(PROMPT_SUGGESTION_SYSTEM_PROMPT).toMatchSnapshot();
  });
});

describe('buildSuggestionPrompt', () => {
  it('lays out agent, instructions and digest sections and marks truncation', () => {
    const prompt = buildSuggestionPrompt(SPEC, 'DIGEST');
    expect(prompt).toBe(
      [
        'Agent: ops',
        'Description: (none)',
        '=== CURRENT INSTRUCTIONS ===',
        INSTRUCTIONS,
        '=== END CURRENT INSTRUCTIONS ===',
        '=== RUN TRACE ===',
        'DIGEST',
        '=== END RUN TRACE ===',
      ].join('\n')
    );
    const huge: AgentSpecV2 = { ...SPEC, instructions: 'x'.repeat(30_000) };
    expect(buildSuggestionPrompt(huge, 'D')).toContain('[… instructions truncated]');
  });
});
