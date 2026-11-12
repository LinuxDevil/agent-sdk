import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpec, AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import type { LegacyAgentStore } from '../../src/persistence/AgentStore';
import { promptHash, SuggestionStore } from '../storage/suggestionStore';
import type { PortabilityAnalysis, PromptSuggestion, StoredSuggestion } from '../../shared/wireTypes';

const INSTRUCTIONS = 'Check the queues. Be helpful.';

const V1_SPEC: AgentSpec = {
  name: 'ops',
  prompt: INSTRUCTIONS,
  provider: { type: 'mock', model: 'mock-1' },
};

/** The suggestion whose apply rewrites `'Be helpful.'` to `'Always cite sources.'` in INSTRUCTIONS. */
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
  evidence: 'Two runs retried fetch calls for the same page.',
  expectedSaving: '~800 tokens per run',
  risk: 'Citations may lengthen answers.',
  validationPlan: ['Re-run the friction trace'],
  status: 'open',
  createdAt: '2026-02-03T04:05:06.000Z',
  updatedAt: '2026-02-03T04:05:06.000Z',
};

const SPEC_HASH = 'sha256:0123456789abcdef0123456789abcdef';

const ANALYSIS: PortabilityAnalysis = {
  kind: 'portability',
  id: `portability-${SPEC_HASH.slice('sha256:'.length, 'sha256:'.length + 16)}`,
  agentId: 'ops',
  specHash: SPEC_HASH,
  summary: 'One sender-specific reference found.',
  findings: [
    {
      location: 'instructions',
      kind: 'email_address',
      quote: 'email sam@example.com',
      explanation: 'Hard-coded recipient tied to the author.',
      suggestion: 'Replace with [YOUR EMAIL].',
    },
  ],
  adaptedInstructions: null,
  model: null,
  createdAt: '2026-02-03T04:05:07.000Z',
};

/**
 * The suggestion routes: `GET /agents/:id/suggestions` (prompt_edit
 * records, open first) and the `apply`/`dismiss` settlements. Apply is
 * CAS-guarded by `expectedPromptHash` plus a single-occurrence `oldText`
 * anchor; a landed apply writes one `source: 'suggestion'` version.
 */
describe('suggestion routes', () => {
  let baseDir: string;
  let agentStore: LegacyAgentStore;
  let runManager: RunManager;
  let repo: AgentRepo;
  let store: SuggestionStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d08b-suggestions-'));
    agentStore = createFsAgentStore(baseDir);
    repo = new AgentRepo(baseDir);
    store = new SuggestionStore(repo);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const app = () => createApp({ agentStore, runManager, baseDir });

  /** Saves the agent through the real v1 PUT route (the file on disk is v2). */
  const saveAgent = async (spec: AgentSpec = V1_SPEC, id = 'ops') => {
    const res = await request(app()).put(`/agents/${id}`).send(spec);
    expect(res.status).toBe(204);
  };

  const seed = (record: StoredSuggestion) => store.save(record.agentId ?? 'ops', record);
  const seedSuggestion = (overrides: Partial<PromptSuggestion> = {}) => seed({ ...SUGGESTION, ...overrides });
  const instructions = async (id = 'ops') => (await repo.readSpec(id))?.instructions;

  it('GET lists only prompt_edit records - open first, then createdAt desc - and 404s an unknown agent', async () => {
    await saveAgent();
    const olderOpen: PromptSuggestion = { ...SUGGESTION, id: 'sug-old', createdAt: '2026-02-01T00:00:00.000Z' };
    const settled: PromptSuggestion = {
      ...SUGGESTION,
      id: 'sug-done',
      status: 'dismissed',
      createdAt: '2026-02-04T00:00:00.000Z',
    };
    await seed(olderOpen);
    await seed(SUGGESTION);
    await seed(settled);
    await seed(ANALYSIS);

    const res = await request(app()).get('/agents/ops/suggestions');
    expect(res.status).toBe(200);
    // Portability analyses never appear; opens (newest first) lead, settled ones follow.
    expect((res.body as PromptSuggestion[]).map((item) => item.id)).toEqual(['sug-1', 'sug-old', 'sug-done']);
    expect(res.body.every((item: PromptSuggestion) => item.kind === 'prompt_edit')).toBe(true);

    const missing = await request(app()).get('/agents/ghost/suggestions');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_AGENT_NOT_FOUND');
  });

  it('apply rewrites the instructions once, writes a source:suggestion version and marks the record applied', async () => {
    await saveAgent();
    await seedSuggestion();

    const res = await request(app()).post('/agents/ops/suggestions/sug-1/apply');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      version: 1,
      kind: 'update',
      source: 'suggestion',
      requestText: 'From run trace-1: Missing operational fact',
    });
    expect(res.body.changedFields).toContain('instructions');

    expect(await instructions()).toBe('Check the queues. Always cite sources.');
    const settled = await store.get('ops', 'sug-1');
    expect(settled).toMatchObject({ status: 'applied', updatedAt: expect.any(String) });
  });

  it('apply after a PUT changed the instructions is 409 conflict and marks the record conflict', async () => {
    await saveAgent();
    await seedSuggestion();
    await saveAgent({ ...V1_SPEC, prompt: 'Rewritten instructions.' });

    const res = await request(app()).post('/agents/ops/suggestions/sug-1/apply');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'The instructions changed since this suggestion was made.',
      code: 'LOUSHO_SUGGESTION_CONFLICT',
    });
    expect(await store.get('ops', 'sug-1')).toMatchObject({ status: 'conflict' });
    expect(await instructions()).toBe('Rewritten instructions.');
  });

  it('apply when oldText occurs twice is 409 conflict', async () => {
    const twice = 'Be helpful. Be helpful.';
    await saveAgent({ ...V1_SPEC, prompt: twice });
    await seedSuggestion({
      expectedPromptHash: promptHash(twice),
      proposedPromptHash: promptHash('Always cite sources. Be helpful.'),
      newText: 'Always cite sources.',
    });

    const res = await request(app()).post('/agents/ops/suggestions/sug-1/apply');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOUSHO_SUGGESTION_CONFLICT');
    expect(await store.get('ops', 'sug-1')).toMatchObject({ status: 'conflict' });
    expect(await instructions()).toBe(twice);
  });

  it('oldText containing $& or .* is matched literally and newText is inserted literally', async () => {
    const literal = 'Pattern a.*b end.';
    await saveAgent({ ...V1_SPEC, prompt: literal });
    // '.*' is not a wildcard and the replacement's '$&' must not expand to
    // the matched text: a plain replace(old, new) would produce 'Xa.*bY'.
    await seedSuggestion({
      expectedPromptHash: promptHash(literal),
      proposedPromptHash: promptHash('Pattern X$&Y end.'),
      oldText: 'a.*b',
      newText: 'X$&Y',
    });
    expect((await request(app()).post('/agents/ops/suggestions/sug-1/apply')).status).toBe(201);
    expect(await instructions()).toBe('Pattern X$&Y end.');

    // '$&' as the anchor is literal too: it occurs exactly once, inside 'X$&Y'.
    await seedSuggestion({
      id: 'sug-2',
      expectedPromptHash: promptHash('Pattern X$&Y end.'),
      proposedPromptHash: promptHash('Pattern Xthe matchY end.'),
      oldText: '$&',
      newText: 'the match',
    });
    expect((await request(app()).post('/agents/ops/suggestions/sug-2/apply')).status).toBe(201);
    expect(await instructions()).toBe('Pattern Xthe matchY end.');
  });

  it('applying twice: the second is 409 LOUSHO_SUGGESTION_NOT_OPEN', async () => {
    await saveAgent();
    await seedSuggestion();
    expect((await request(app()).post('/agents/ops/suggestions/sug-1/apply')).status).toBe(201);

    const again = await request(app()).post('/agents/ops/suggestions/sug-1/apply');
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      error: 'This suggestion was already applied or dismissed.',
      code: 'LOUSHO_SUGGESTION_NOT_OPEN',
    });
  });

  it('apply on instructions stored in a file is 409 LOUSHO_SUGGESTION_UNSUPPORTED', async () => {
    const v2: AgentSpecV2 = {
      version: 2,
      name: 'ops',
      model: 'mock/mock-1',
      instructions: { file: 'prompt.md' },
    };
    const res = await request(app()).put('/agents/ops').send({ spec: v2 });
    expect(res.status).toBe(204);
    await seedSuggestion();

    const apply = await request(app()).post('/agents/ops/suggestions/sug-1/apply');
    expect(apply.status).toBe(409);
    expect(apply.body).toEqual({
      error: 'The instructions are stored in a file, so this suggestion cannot be applied here.',
      code: 'LOUSHO_SUGGESTION_UNSUPPORTED',
    });
  });

  it('apply a missing or non-prompt_edit suggestion is 404; an invalid sid is 400', async () => {
    await saveAgent();
    await seed(ANALYSIS);

    const missing = await request(app()).post('/agents/ops/suggestions/nope/apply');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_SUGGESTION_NOT_FOUND');

    // The portability record exists but is not a prompt suggestion.
    const portability = await request(app()).post(`/agents/ops/suggestions/${ANALYSIS.id}/apply`);
    expect(portability.status).toBe(404);
    expect(portability.body.code).toBe('LOUSHO_SUGGESTION_NOT_FOUND');

    const invalid = await request(app()).post('/agents/ops/suggestions/bad.id/apply');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('LOUSHO_SUGGESTION_ID_INVALID');
  });

  it('dismiss is 204, the list then shows the record dismissed, and settling again is 409', async () => {
    await saveAgent();
    await seedSuggestion();

    const res = await request(app()).post('/agents/ops/suggestions/sug-1/dismiss');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const list = await request(app()).get('/agents/ops/suggestions');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: 'sug-1', status: 'dismissed' });

    const again = await request(app()).post('/agents/ops/suggestions/sug-1/dismiss');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LOUSHO_SUGGESTION_NOT_OPEN');

    // A dismissed suggestion cannot be applied either.
    const apply = await request(app()).post('/agents/ops/suggestions/sug-1/apply');
    expect(apply.status).toBe(409);
    expect(apply.body.code).toBe('LOUSHO_SUGGESTION_NOT_OPEN');
    expect(await instructions()).toBe(INSTRUCTIONS);
  });

  it('dismiss a missing or non-prompt_edit suggestion is 404; an invalid sid is 400', async () => {
    await saveAgent();
    await seed(ANALYSIS);

    const missing = await request(app()).post('/agents/ops/suggestions/nope/dismiss');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LOUSHO_SUGGESTION_NOT_FOUND');

    const portability = await request(app()).post(`/agents/ops/suggestions/${ANALYSIS.id}/dismiss`);
    expect(portability.status).toBe(404);
    expect(portability.body.code).toBe('LOUSHO_SUGGESTION_NOT_FOUND');

    const invalid = await request(app()).post('/agents/ops/suggestions/bad.id/dismiss');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('LOUSHO_SUGGESTION_ID_INVALID');
  });
});
