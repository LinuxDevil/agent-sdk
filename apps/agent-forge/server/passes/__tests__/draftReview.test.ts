import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { SpecChange } from '../../../shared/wireTypes';
import { AgentRepo } from '../../storage/agentRepo';
import { DraftStore, type NewDraftInput } from '../../storage/draftStore';
import { StudioEventBus } from '../../events/eventBus';
import { SecretsStore } from '../../secretsStore';
import { SettingsStore } from '../../settingsStore';
import { studioPathsFor } from '../../workspace/studioPaths';
import { draftFingerprint } from '../../lifecycle/draftFields';
import {
  PassOutputError,
  PassRefusedError,
  PassSkippedError,
  PassUnavailableError,
  type PassContext,
  type PassJob,
  type PassResult,
  type PassRunner,
} from '../passRunner';

const callPassModel = vi.hoisted(() => vi.fn());
vi.mock('../passModel', () => ({ callPassModel }));

import {
  DRAFT_REVIEW_SYSTEM_PROMPT,
  attachDraftReviews,
  buildDraftReviewInput,
  draftReviewOutputSchema,
} from '../draftReview';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  description: 'Keeps the lights on.',
  instructions: 'You are the ops agent.',
  tools: [{ builtin: 'web_fetch', id: 'fetch' }],
  triggers: [{ type: 'cron', id: 'nightly', cron: '0 3 * * *', prompt: 'run the nightly checks' } as never],
};

const NEW_DRAFT: NewDraftInput = {
  patch: { description: 'Triage faster.' },
  origin: 'author',
  reason: 'Tighter wording.',
  baseVersion: null,
  baseSpecHash: 'sha256:x',
};

/** A hand-built `SpecChange` for the input-builder tests. */
function sc(
  field: string,
  op: SpecChange['op'],
  opts: { label?: string; before?: unknown; after?: unknown; lines?: SpecChange['lines'] } = {}
): SpecChange {
  return {
    field,
    label: opts.label ?? field,
    section: 'Tools',
    op,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
    ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
  };
}

describe('buildDraftReviewInput', () => {
  const changes: SpecChange[] = [
    sc('description', 'edit', { label: 'Description', before: 'old', after: 'new' }),
    sc('tools[http]', 'add', { label: 'Tool: http', after: { builtin: 'http' } }),
    sc('instructions', 'edit', {
      label: 'Instructions',
      before: 'a\nb',
      after: 'a\nc',
      lines: [
        { kind: 'context', text: 'a' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'c' },
      ],
    }),
  ];

  it('renders every ticket section in order', () => {
    const input = buildDraftReviewInput(SPEC, SPEC, changes, 'Tighten the agent.');
    expect(typeof input).toBe('string');
    const text = input as string;
    expect(text).toContain('Agent name: ops');
    expect(text).toContain('Agent description: Keeps the lights on.');
    expect(text).toContain('Current tools: tool:fetch');
    expect(text).toContain('Current triggers: [{"type":"cron","id":"nightly","cron":"0 3 * * *","prompt":"run the nightly checks"}]');
    expect(text).toContain("=== CURRENT INSTRUCTIONS (the agent's stated purpose) ===\nYou are the ops agent.\n=== END CURRENT INSTRUCTIONS ===");
    expect(text).toContain('Reason for the draft: Tighten the agent.');
    expect(text).toContain('Changes:');
    // Plain change: capped before/after JSON, (none) for a missing side.
    expect(text).toContain('Description (edit):\n  before: "old"\n  after: "new"');
    expect(text).toContain('Tool: http (add):\n  before: (none)\n  after: {"builtin":"http"}');
    // Instructions edit renders the line diff with +/-/space prefixes.
    expect(text).toContain('Instructions (edit):\n  a\n- b\n+ c');
  });

  it('collapses gap rows to an unchanged-lines marker', () => {
    const withGap = buildDraftReviewInput(
      SPEC,
      SPEC,
      [sc('instructions', 'edit', { lines: [{ kind: 'gap', count: 42 }] })],
      'r'
    ) as string;
    expect(withGap).toContain('… 42 unchanged lines');
  });

  it('caps the triggers JSON, the instructions excerpt and each before/after value', () => {
    const spec: AgentSpecV2 = {
      ...SPEC,
      instructions: 'i'.repeat(30_000),
      triggers: [{ type: 'cron', blob: 't'.repeat(10_000) } as never],
    };
    const big = sc('modelSettings', 'edit', {
      label: 'Model settings',
      before: 'b'.repeat(5_000),
      after: 'a'.repeat(5_000),
    });
    const input = buildDraftReviewInput(spec, spec, [big], 'r') as string;
    const triggersLine = input.split('\n').find((line) => line.startsWith('Current triggers:'))!;
    expect(triggersLine.length).toBeLessThanOrEqual('Current triggers: '.length + 4_000);
    expect(triggersLine.endsWith('…')).toBe(true);
    const instrStart = input.indexOf('=== CURRENT INSTRUCTIONS');
    const instrEnd = input.indexOf('=== END CURRENT INSTRUCTIONS ===');
    expect(instrEnd - instrStart).toBeLessThanOrEqual(24_000 + 120);
    const block = input.slice(input.indexOf('Model settings (edit):'));
    expect(block).toContain('…');
    expect(block.length).toBeLessThan(5_000 * 2 + 200);
  });

  it('escalates without a model call when a single changed value exceeds 100 000 chars', () => {
    const oversized = sc('description', 'edit', { before: 'b', after: 'y'.repeat(150_000) });
    const hugeInstructions = sc('instructions', 'edit', { after: 'x'.repeat(150_000) });
    expect(buildDraftReviewInput(SPEC, SPEC, [oversized], 'r')).toEqual({ tooLarge: true });
    expect(buildDraftReviewInput(SPEC, SPEC, [hugeInstructions], 'r')).toEqual({ tooLarge: true });
  });

  it('escalates when the assembled input exceeds 400 000 chars', () => {
    // Each side clips at 4 000 chars, so crossing the cap takes many max-size changes.
    const changes = Array.from({ length: 60 }, (_, i) =>
      sc(`field${i}`, 'edit', {
        label: `Field ${i}`,
        before: 'b'.repeat(90_000),
        after: 'a'.repeat(90_000),
      })
    );
    expect(buildDraftReviewInput(SPEC, SPEC, changes, 'r')).toEqual({ tooLarge: true });
    // A long reason alone can also push the assembly over the cap.
    expect(buildDraftReviewInput(SPEC, SPEC, [], 'r'.repeat(400_000))).toEqual({ tooLarge: true });
  });
});

describe('draftReviewOutputSchema', () => {
  it('clips rationale at 800 and concern details at 400, keeps at most 10 concerns', () => {
    const parsed = draftReviewOutputSchema.parse({
      safe: true,
      rationale: `r${'x'.repeat(900)}`,
      concerns: Array.from({ length: 15 }, (_, i) => ({ area: 'coherence', detail: `d${i}${'y'.repeat(500)}` })),
    });
    expect(parsed.rationale.length).toBeLessThanOrEqual(800);
    expect(parsed.rationale.endsWith('…')).toBe(true);
    expect(parsed.concerns).toHaveLength(10);
    for (const concern of parsed.concerns) {
      expect(concern.detail.length).toBeLessThanOrEqual(400);
      expect(concern.detail.endsWith('…')).toBe(true);
    }
  });

  it('rejects an unknown concern area and a missing safe flag', () => {
    expect(draftReviewOutputSchema.safeParse({ safe: true, rationale: 'r', concerns: [{ area: 'style', detail: 'd' }] }).success).toBe(false);
    expect(draftReviewOutputSchema.safeParse({ rationale: 'r', concerns: [] }).success).toBe(false);
  });
});

describe('attachDraftReviews', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let drafts: DraftStore;
  let events: StudioEventBus;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let enqueue: Mock<[PassJob<unknown>], Promise<PassResult<unknown>>>;
  let passRunner: PassRunner;
  let unsubscribe: () => void;

  const ctx = (): PassContext => ({
    attempt: 1,
    signal: new AbortController().signal,
    record: vi.fn(),
  });

  /** The default enqueue: runs the job like the real runner's happy path, mapping settle-without-retry errors. */
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

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l11a-review-'));
    repo = new AgentRepo(baseDir);
    drafts = new DraftStore(repo);
    events = new StudioEventBus();
    settings = new SettingsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    secrets = new SecretsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    enqueue = vi.fn(runJob);
    passRunner = { enqueue } as unknown as PassRunner;
    unsubscribe = attachDraftReviews({
      drafts,
      repo,
      passRunner,
      events,
      secretsStore: secrets,
      settings,
      workspaceId: 'ws-1',
    });
    callPassModel.mockReset();
  });

  afterEach(() => {
    unsubscribe();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const writeSpec = () => repo.writeSpec('ops', SPEC);
  const current = () => drafts.current('ops');
  const waitForReview = async () => {
    await vi.waitFor(async () => {
      expect((await current())?.autoReview).not.toBeNull();
    });
    return (await current())!;
  };

  it('a created draft gets classes stamped, a review enqueued, and a clear verdict stored', async () => {
    await writeSpec();
    callPassModel.mockResolvedValue({ safe: true, rationale: 'Straightforward wording change.', concerns: [] });
    const published: Array<{ type: string; status?: string }> = [];
    events.subscribe((event) => published.push(event as { type: string; status?: string }));

    const { draft } = await drafts.create('ops', NEW_DRAFT);
    const settled = await waitForReview();

    expect(settled.classes).toEqual({ routine: ['description'], gated: [] });
    const fp = draftFingerprint(draft);
    expect(settled.autoReview).toMatchObject({
      outcome: 'clear',
      safe: true,
      rationale: 'Straightforward wording change.',
      concerns: [],
      fingerprint: fp,
      model: 'anthropic/claude-haiku-5-5',
    });
    expect(settled.autoReview!.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0];
    expect(job.kind).toBe('draft_review');
    expect(job.key).toBe(`${draft.id}:${fp}`);
    expect(job.agentId).toBe('ops');
    expect(job.workspaceId).toBe('ws-1');

    // The model call used the ticket's prompt/schema/timeout and the built input.
    const call = callPassModel.mock.calls[0][0];
    expect(call.kind).toBe('draft_review');
    expect(call.system).toBe(DRAFT_REVIEW_SYSTEM_PROMPT);
    expect(call.timeoutMs).toBe(30_000);
    expect(call.prompt).toContain('Agent name: ops');
    expect(call.prompt).toContain('Reason for the draft: Tighter wording.');
    expect(call.prompt).toContain('Description (edit):');

    // classes stamp + verdict each announce draft.changed (pending).
    expect(published.filter((e) => e.type === 'draft.changed' && e.status === 'pending')).toHaveLength(2);
  });

  it('a tool-adding draft lands the tool field in classes.gated', async () => {
    await writeSpec();
    callPassModel.mockResolvedValue({ safe: true, rationale: 'ok', concerns: [] });
    await drafts.create('ops', {
      ...NEW_DRAFT,
      // Lists replace wholesale: keep the existing tool so only 'http' diffs as an add.
      patch: { tools: [{ builtin: 'web_fetch', id: 'fetch' }, { builtin: 'http' }] },
      reason: 'Add an HTTP tool.',
    });
    const settled = await waitForReview();
    expect(settled.classes!.gated).toEqual(['tools[http]']);
    expect(settled.classes!.routine).toEqual([]);
  });

  it('a safe reply carrying a safety concern escalates; coherence-only stays clear', async () => {
    await writeSpec();
    callPassModel.mockResolvedValue({
      safe: true,
      rationale: 'Mentions ignoring prior rules.',
      concerns: [{ area: 'safety', detail: 'Tells the agent to ignore its rules.' }],
    });
    await drafts.create('ops', NEW_DRAFT);
    expect((await waitForReview()).autoReview).toMatchObject({ outcome: 'escalated', safe: true });

    // A fresh draft with only a coherence note clears.
    callPassModel.mockResolvedValue({
      safe: true,
      rationale: 'Vague but harmless.',
      concerns: [{ area: 'coherence', detail: 'Thin reason.' }],
    });
    await drafts.create('ops', { ...NEW_DRAFT, reason: 'Second try.' });
    const second = await waitForReview();
    expect(second.autoReview!.outcome).toBe('clear');
    expect(second.autoReview!.concerns).toEqual([{ area: 'coherence', detail: 'Thin reason.' }]);
  });

  it('safe:false escalates even with no concerns', async () => {
    await writeSpec();
    callPassModel.mockResolvedValue({ safe: false, rationale: 'Unsure about the wording.', concerns: [] });
    await drafts.create('ops', NEW_DRAFT);
    expect((await waitForReview()).autoReview).toMatchObject({ outcome: 'escalated', safe: false });
  });

  it.each([
    ['unavailable', 'No model key for the automatic check.'],
    ['refused', 'The model declined to check this change.'],
    ['failed', 'The automatic check could not finish.'],
    ['skipped', 'Automatic draft reviews are turned off in Settings.'],
  ] as const)('a %s pass settles as unavailable with its fixed rationale', async (outcome, rationale) => {
    await writeSpec();
    enqueue.mockImplementation(async () => ({ ok: false, outcome, error: 'settled' }));
    await drafts.create('ops', NEW_DRAFT);
    const settled = await waitForReview();
    expect(settled.status).toBe('pending');
    expect(settled.autoReview).toMatchObject({
      outcome: 'unavailable',
      safe: null,
      rationale,
      concerns: [],
      model: null,
    });
    expect(callPassModel).not.toHaveBeenCalled();
  });

  it('a missing provider key (PassUnavailableError) maps to the unavailable verdict', async () => {
    await writeSpec();
    callPassModel.mockRejectedValue(new PassUnavailableError('No API key for anthropic.'));
    await drafts.create('ops', NEW_DRAFT);
    const settled = await waitForReview();
    expect(settled.autoReview).toMatchObject({
      outcome: 'unavailable',
      safe: null,
      rationale: 'No model key for the automatic check.',
    });
    // The draft stays pending and approvable.
    expect(settled.status).toBe('pending');
  });

  it('an oversized change escalates without calling the model', async () => {
    await writeSpec();
    await drafts.create('ops', {
      ...NEW_DRAFT,
      patch: { description: 'y'.repeat(150_000) },
      reason: 'Huge.',
    });
    const settled = await waitForReview();
    expect(callPassModel).not.toHaveBeenCalled();
    expect(settled.autoReview).toMatchObject({
      outcome: 'escalated',
      safe: false,
      rationale: 'This change is too large to check automatically.',
      concerns: [{ area: 'safety', detail: 'Not checked: the change is too large. Read it before approving.' }],
      fingerprint: draftFingerprint(settled),
      model: null,
    });
    expect(settled.autoReview!.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('restating the draft clears autoReview, reruns the review, and drops the stale verdict', async () => {
    await writeSpec();
    // Hold every review job's result so verdicts can land out of order.
    const resolvers: Array<(result: PassResult<unknown>) => void> = [];
    enqueue.mockImplementation(
      () =>
        new Promise<PassResult<unknown>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const { draft } = await drafts.create('ops', NEW_DRAFT);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    const updated = await drafts.update('ops', draft.id, { reason: 'A different reason.' });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    // The restate cleared the pending verdict slot for the new fingerprint.
    expect((await current())!.autoReview).toBeNull();

    const secondFp = draftFingerprint(updated);
    expect(secondFp).not.toBe(draftFingerprint(draft));

    // The OLD fingerprint's verdict lands first: setAutoReview rejects it.
    resolvers[0]({ ok: true, value: { kind: 'model', safe: true, rationale: 'stale', concerns: [], model: 'm' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await current())!.autoReview).toBeNull();

    // The new fingerprint's verdict lands and sticks.
    resolvers[1]({ ok: true, value: { kind: 'model', safe: true, rationale: 'fresh', concerns: [], model: 'm' } });
    await vi.waitFor(async () => {
      expect((await current())!.autoReview?.rationale).toBe('fresh');
    });
    const settled = (await current())!;
    expect(settled.autoReview!.fingerprint).toBe(secondFp);
  });

  it('unsubscribe detaches the listener', async () => {
    unsubscribe();
    await writeSpec();
    callPassModel.mockResolvedValue({ safe: true, rationale: 'x', concerns: [] });
    await drafts.create('ops', NEW_DRAFT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enqueue).not.toHaveBeenCalled();
    expect((await current())!.autoReview).toBeNull();
  });
});

describe('DRAFT_REVIEW_SYSTEM_PROMPT', () => {
  it('matches the ticket text byte-for-byte', () => {
    expect(DRAFT_REVIEW_SYSTEM_PROMPT).toMatchSnapshot();
  });
});
