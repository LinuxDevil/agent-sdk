import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { SpecSnapshot, VersionKind, VersionListItem, VersionRecord } from '../../../shared/wireTypes';
import { AgentRepo } from '../../storage/agentRepo';
import { VersionStore } from '../../storage/versionStore';
import { StudioEventBus } from '../../events/eventBus';
import { SecretsStore } from '../../secretsStore';
import { SettingsStore } from '../../settingsStore';
import { studioPathsFor } from '../../workspace/studioPaths';
import type { PassContext, PassJob, PassResult, PassRunner } from '../passRunner';

const callPassModel = vi.hoisted(() => vi.fn());
vi.mock('../passModel', () => ({ callPassModel }));

import {
  VERSION_SUMMARY_SYSTEM_PROMPT,
  attachVersionSummaries,
  buildVersionDigest,
  fallbackSummary,
  versionSummaryOutputSchema,
} from '../versionSummary';

const SPEC_A: AgentSpecV2 = { version: 2, name: 'ops', model: 'mock/mock-1', instructions: 'Run the ops checks.' };

function snapshot(spec: AgentSpecV2, labels: string[] = []): SpecSnapshot {
  return { spec, labels };
}

function record(
  version: number,
  kind: VersionKind,
  snap: SpecSnapshot,
  changedFields: string[] = [],
  requestText: string | null = null
): VersionRecord {
  return {
    version,
    kind,
    source: 'editor',
    changedFields,
    restoredFromVersion: null,
    summary: null,
    requestText,
    authorSessionId: null,
    specHash: `sha256:${version}`,
    createdAt: '2026-02-03T04:05:06.000Z',
    snapshot: snap,
  };
}

const itemOf = (rec: VersionRecord): VersionListItem => {
  const { snapshot, ...item } = rec;
  void snapshot;
  return item;
};

const mkItem = (kind: VersionKind, changedFields: string[]): VersionListItem =>
  itemOf(record(1, kind, snapshot(SPEC_A), changedFields));

describe('buildVersionDigest', () => {
  it('a create digest lists the facts, one per line, instructions excerpted', () => {
    const spec: AgentSpecV2 = {
      ...SPEC_A,
      description: 'Keeps the lights on.',
      tools: [{ builtin: 'web_fetch', id: 'fetch' }, { builtin: 'current_date' }],
      mcpServers: { github: { command: 'npx' } } as AgentSpecV2['mcpServers'],
      skills: [{ inline: { name: 'review', instructions: 'x' } } as never],
      memory: [{ name: 'facts', scope: 'agent', provider: 'kv' } as never],
      subagents: { 'sub:research': { ref: 'research.yaml', description: 'd' } } as never,
      guardrails: [{ id: 'g1', name: 'regex', on: 'input' } as never],
      triggers: [{ type: 'cron' } as never],
    };
    const digest = buildVersionDigest(undefined, record(1, 'create', snapshot(spec, ['prod'])));
    expect(digest).toContain('Name: ops');
    expect(digest).toContain('Description: Keeps the lights on.');
    expect(digest).toContain('Model: mock/mock-1');
    expect(digest).toContain('Tools: tool:fetch, tool:current_date');
    expect(digest).toContain('MCP servers: github');
    expect(digest).toContain('Skills: skill:review');
    expect(digest).toContain('Memory: facts');
    expect(digest).toContain('Subagents: sub:research');
    expect(digest).toContain('Guardrails: g1');
    expect(digest).toContain('Triggers: cron');
    expect(digest).toContain('Labels: prod');
    expect(digest).toContain('Instructions:\nRun the ops checks.');
    // Instructions come last and nothing trails them.
    expect(digest.trimEnd().endsWith('Run the ops checks.')).toBe(true);
  });

  it('an update digest renders each changed field as Label: before → after', () => {
    const before = record(1, 'create', snapshot(SPEC_A));
    const after = record(
      2,
      'update',
      snapshot({ ...SPEC_A, model: 'mock/mock-2', description: 'Now with docs.' }),
      ['model', 'description']
    );
    const digest = buildVersionDigest(before, after);
    expect(digest).toBe('Model: mock/mock-1 → mock/mock-2\nDescription: (none) → Now with docs.');
  });

  it('a missing side renders (none) and empty-ish values collapse to it', () => {
    const before = record(1, 'create', snapshot(SPEC_A));
    const after = record(2, 'update', snapshot({ ...SPEC_A, description: undefined }), ['description']);
    expect(buildVersionDigest(before, after)).toBe('Description: (none) → (none)');
  });

  it('long string fields diff with +/- prefixes and collapsed context', () => {
    const beforeLines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const afterLines = beforeLines.map((line, i) =>
      i === 5 || i === 25 ? `changed ${i}` : line
    );
    const before = record(1, 'create', snapshot({ ...SPEC_A, instructions: beforeLines.join('\n') }));
    const after = record(2, 'update', snapshot({ ...SPEC_A, instructions: afterLines.join('\n') }), ['instructions']);
    const digest = buildVersionDigest(before, after);
    expect(digest).toContain('Instructions (diff):');
    expect(digest).toContain('- line 5');
    expect(digest).toContain('+ changed 5');
    expect(digest).toContain('- line 25');
    expect(digest).toContain('+ changed 25');
    // The 19 unchanged lines between the two edits collapse to one marker.
    expect(digest).toContain('… 17 unchanged lines');
    expect(digest.length).toBeLessThanOrEqual(4000);
  });

  it('a 10 000-line instructions edit produces a capped diff block', () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `before ${i}`).join('\n');
    const after = Array.from({ length: 10_000 }, (_, i) => `after ${i}`).join('\n');
    const prev = record(1, 'create', snapshot({ ...SPEC_A, instructions: before }));
    const next = record(2, 'update', snapshot({ ...SPEC_A, instructions: after }), ['instructions']);
    const digest = buildVersionDigest(prev, next);
    expect(digest).toContain('Instructions (diff):');
    expect(digest).toContain('further changed regions not shown');
    expect(digest.length).toBeLessThanOrEqual(4000);
    // The block itself stays under its 900-char cap.
    const block = digest.split('\n').slice(1).join('\n');
    expect(block.length).toBeLessThanOrEqual(900);
  });

  it('stops adding field blocks at the cap and counts the rest', () => {
    const spec = { ...SPEC_A, tools: [{ builtin: 'web_fetch' }] } as AgentSpecV2;
    const prev = record(1, 'create', snapshot(spec));
    const changedFields = [
      'name', 'description', 'model', 'fallbackModels', 'instructions', 'instructionsByFamily',
      'promptRef', 'modelSettings', 'reasoning', 'tools', 'mcpServers', 'skills', 'memory',
      'subagents', 'subagentOptions', 'maxSubagentDepth', 'handoffs', 'maxHandoffs', 'guardrails',
      'permissions', 'permissionMode', 'approvalTtlMs', 'askQuestion', 'hooks', 'output', 'limits',
      'maxSteps', 'compaction', 'retry', 'rateLimit', 'promptCaching', 'toolSearch', 'codeMode',
      'triggers', 'abortListeners', 'flow', 'evals', 'labels',
    ];
    // Every changed field gets a bulky after-value so the 4000-char budget
    // runs out partway through the list.
    const bigAfter: Record<string, unknown> = {};
    for (const field of changedFields) {
      bigAfter[field] = field === 'instructions' ? 'y'.repeat(500) : { blob: 'x'.repeat(400) };
    }
    const next = record(
      2,
      'update',
      { spec: { ...spec, ...bigAfter } as AgentSpecV2, labels: ['x'] },
      changedFields
    );
    const digest = buildVersionDigest(prev, next);
    expect(digest.length).toBeLessThanOrEqual(4000);
    expect(digest).toContain('more fields changed');
  });
});

describe('fallbackSummary', () => {
  it('kind phrases when nothing changed', () => {
    expect(fallbackSummary(mkItem('create', []))).toBe('Created the agent.');
    expect(fallbackSummary(mkItem('publish', []))).toBe('Published the agent.');
    expect(fallbackSummary(mkItem('update', []))).toBe('Saved without changes.');
  });

  it('one, two and many fields name the labels', () => {
    expect(fallbackSummary(mkItem('update', ['instructions']))).toBe('Changed instructions.');
    expect(fallbackSummary(mkItem('update', ['tools', 'instructions']))).toBe('Changed tools and instructions.');
    expect(fallbackSummary(mkItem('update', ['tools', 'instructions', 'model', 'triggers']))).toBe(
      'Changed tools, instructions and 2 more.'
    );
  });
});

describe('versionSummaryOutputSchema', () => {
  it('collapses whitespace, strips wrapping quotes and caps at 220 chars', () => {
    expect(versionSummaryOutputSchema.parse({ summary: '  "Added   the\nweb_fetch tool."  ' })).toEqual({
      summary: 'Added the web_fetch tool.',
    });
    const long = `word ${'x'.repeat(400)}`;
    const parsed = versionSummaryOutputSchema.parse({ summary: long });
    expect(parsed.summary.length).toBeLessThanOrEqual(220);
    expect(parsed.summary.endsWith('…')).toBe(true);
  });

  it('rejects an empty summary', () => {
    expect(versionSummaryOutputSchema.safeParse({ summary: '   ' }).success).toBe(false);
  });
});

describe('attachVersionSummaries', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let versions: VersionStore;
  let events: StudioEventBus;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let enqueue: Mock<[PassJob<{ summary: string }>], Promise<PassResult<{ summary: string }>>>;
  let passRunner: PassRunner;
  let unsubscribe: () => void;

  const ctx = (): PassContext => ({
    attempt: 1,
    signal: new AbortController().signal,
    record: vi.fn(),
  });

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l04-attach-'));
    repo = new AgentRepo(baseDir);
    versions = new VersionStore(repo);
    events = new StudioEventBus();
    settings = new SettingsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    secrets = new SecretsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    enqueue = vi.fn(async (job: PassJob<{ summary: string }>): Promise<PassResult<{ summary: string }>> => {
      try {
        return { ok: true, value: await job.run(ctx()) };
      } catch (error) {
        return { ok: false, outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    });
    passRunner = { enqueue } as unknown as PassRunner;
    unsubscribe = attachVersionSummaries({
      versions,
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

  it('a captured version enqueues version_summary and a good reply lands summary + event', async () => {
    callPassModel.mockResolvedValue({ summary: 'Created the ops agent.' });
    const published: unknown[] = [];
    events.subscribe((event) => published.push(event));
    await repo.writeSpec('ops', SPEC_A);
    const item = (await versions.capture('ops', { kind: 'create', source: 'editor' }))!;

    await vi.waitFor(async () => {
      expect((await versions.get('ops', item.version))?.summary).toBe('Created the ops agent.');
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0][0] as PassJob<{ summary: string }>;
    expect(job.kind).toBe('version_summary');
    expect(job.key).toBe(`ops:${item.version}`);
    expect(job.agentId).toBe('ops');
    expect(job.workspaceId).toBe('ws-1');
    // The prompt carries the request line only when requestText is set, and the digest.
    const prompt = callPassModel.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Saved change:\nName: ops');
    expect(prompt).not.toContain('Request:');
    expect(published).toEqual([{ type: 'version.summary', agentId: 'ops', version: item.version, summary: 'Created the ops agent.' }]);
  });

  it('requestText lands in the prompt as the Request: line', async () => {
    callPassModel.mockResolvedValue({ summary: 'Edited the agent.' });
    await repo.writeSpec('ops', SPEC_A);
    await versions.capture('ops', { kind: 'create', source: 'author', requestText: 'make it fetch pages' });
    await vi.waitFor(() => expect(callPassModel).toHaveBeenCalled());
    const prompt = callPassModel.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Request: make it fetch pages');
    expect(prompt).toContain('Saved change:');
  });

  it('a failed pass writes the fallback sentence and still publishes', async () => {
    callPassModel.mockRejectedValue(new Error('provider down'));
    const published: Array<{ summary?: string }> = [];
    events.subscribe((event) => published.push(event as { summary?: string }));
    await repo.writeSpec('ops', SPEC_A);
    const item = (await versions.capture('ops', { kind: 'create', source: 'editor' }))!;
    await vi.waitFor(async () => {
      expect((await versions.get('ops', item.version))?.summary).not.toBeNull();
    });
    // changedFields for a create are every set field: name, model, instructions.
    expect((await versions.get('ops', item.version))?.summary).toBe('Changed name, model and 1 more.');
    expect(published).toHaveLength(1);
  });

  it('a pass skipped in settings also writes the fallback', async () => {
    enqueue.mockImplementation(async (job: PassJob<{ summary: string }>) => {
      await job.run(ctx()).catch(() => {});
      return { ok: false, outcome: 'skipped', error: 'Turned off in settings' };
    });
    await repo.writeSpec('ops', SPEC_A);
    const item = (await versions.capture('ops', { kind: 'create', source: 'editor' }))!;
    await vi.waitFor(async () => {
      expect((await versions.get('ops', item.version))?.summary).toBe('Changed name, model and 1 more.');
    });
  });

  it('restore and baseline versions are never summarized', async () => {
    callPassModel.mockResolvedValue({ summary: 'Should not land.' });
    await repo.writeSpec('ops', SPEC_A);
    await versions.capture('ops', { kind: 'create', source: 'editor' });
    await versions.capture('ops', { kind: 'restore', source: 'restore' });
    const items = await versions.list('ops');
    const restore = items.find((i) => i.kind === 'restore')!;
    // Give any stray pass a beat, then assert: no second enqueue, summary stays null.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enqueue).toHaveBeenCalledTimes(1); // only the create
    expect((await versions.get('ops', restore.version))?.summary).toBeNull();
  });

  it('unsubscribe detaches the listener', async () => {
    unsubscribe();
    callPassModel.mockResolvedValue({ summary: 'Late.' });
    await repo.writeSpec('ops', SPEC_A);
    await versions.capture('ops', { kind: 'create', source: 'editor' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('VERSION_SUMMARY_SYSTEM_PROMPT', () => {
  it('matches the ticket text byte-for-byte', () => {
    expect(VERSION_SUMMARY_SYSTEM_PROMPT).toMatchSnapshot();
  });
});
