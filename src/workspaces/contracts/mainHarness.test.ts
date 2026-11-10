import { describe, it, expect } from 'vitest';
import {
  crossCheckMainHarness,
  findForbiddenMainHarnessKeys,
  mainHarnessSchema,
  MAIN_HARNESS_OPTIONALITY,
  type MainHarness,
} from './mainHarness';
import { workspaceManifestSchema, type WorkspaceManifest } from './workspace';

const marketingHarness: MainHarness = {
  schema: 'lousho.main-harness/1',
  instructions: ['routing.md', 'presentation.md'],
  routes: [
    { page: 'instagram', when: 'The user wants an Instagram post or caption.' },
    { page: 'content-research', when: 'The user needs topics or competitor research first.' },
  ],
  clarify: {
    askWhen: ['The channel is not stated', 'The audience is ambiguous'],
    runImmediatelyWhen: ['The request names one channel and a topic'],
  },
  presentation: {
    style: 'Lead with the finished draft, then notes.',
    followUps: 'Offer one next step per channel.',
    revisions: 'Apply the change and show only the changed parts.',
  },
  limits: { maxConcurrentPages: 2 },
  onPageFailure: 'retry-once',
};

const manifest: WorkspaceManifest = workspaceManifestSchema.parse({
  schema: 'lousho.workspace/1',
  id: 'marketing',
  name: 'Marketing',
  version: '1.0.0',
  description: 'Plans and writes social content.',
  mainAgent: { dir: './main-agent' },
  pages: ['content-research', 'instagram'],
  defaults: { limits: { maxConcurrentPages: 3 } },
});

describe('mainHarnessSchema', () => {
  it('accepts the Marketing main harness', () => {
    const result = mainHarnessSchema.safeParse(marketingHarness);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(marketingHarness);
  });

  it('accepts a minimal main harness', () => {
    expect(mainHarnessSchema.safeParse({ schema: 'lousho.main-harness/1' }).success).toBe(true);
  });

  it('rejects unknown keys and a wrong schema id', () => {
    expect(mainHarnessSchema.safeParse({ schema: 'lousho.main-harness/1', extra: 1 }).success).toBe(false);
    expect(mainHarnessSchema.safeParse({ schema: 'lousho.harness/1' }).success).toBe(false);
  });

  it('a forbidden key is an error naming R13', () => {
    const errors = findForbiddenMainHarnessKeys({ ...marketingHarness, limits: { maxConcurrentPages: 2, tools: ['x'] } });
    expect(errors).toEqual(['harness.limits.tools: harnesses describe the task; the runtime enforces tools (R13)']);
    const result = mainHarnessSchema.safeParse({ ...marketingHarness, permissions: {} });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.message.includes('(R13)'))).toBe(true);
  });

  it('an execution key is an error naming R18', () => {
    const result = mainHarnessSchema.safeParse({
      ...marketingHarness,
      routes: [{ page: 'instagram', when: 'x', steps: ['a'] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.message.includes('routes[0].steps') && i.message.includes('(R18)'))).toBe(true);
  });

  it('each forbidden key at any depth is an error naming R13 or R18', () => {
    for (const key of ['permissions', 'tools', 'secrets', 'sandbox', 'approvals', 'mcpServers', 'hooks', 'model', 'provider', 'network']) {
      expect(findForbiddenMainHarnessKeys({ routes: [{ page: 'a', when: 'b', [key]: 1 }] })).toEqual([
        `harness.routes[0].${key}: harnesses describe the task; the runtime enforces ${key} (R13)`,
      ]);
    }
    for (const key of ['execution', 'workflow', 'goal', 'steps', 'lead', 'delegates']) {
      expect(findForbiddenMainHarnessKeys({ presentation: { [key]: 1 } })).toEqual([
        `harness.presentation.${key}: a harness says what, not how; execution lives in page.json (R18)`,
      ]);
    }
  });

  it('exposes the optionality table', () => {
    expect(MAIN_HARNESS_OPTIONALITY.map((row) => row.situation)).toEqual([
      'No main agent',
      'Main agent, no main harness',
      'Main agent and main harness',
    ]);
  });
});

describe('crossCheckMainHarness', () => {
  it('passes a harness that fits the manifest', () => {
    expect(crossCheckMainHarness(marketingHarness, manifest)).toEqual({ errors: [], warnings: [] });
  });

  it('a main harness with mainAgent null is an error', () => {
    const result = crossCheckMainHarness(marketingHarness, { ...manifest, mainAgent: null });
    expect(result.errors).toEqual(['a main harness needs a main agent, but workspace.json sets mainAgent to null']);
  });

  it("maxConcurrentPages above the workspace's is clamped with a warning", () => {
    const harness: MainHarness = { ...marketingHarness, limits: { maxConcurrentPages: 8 } };
    const result = crossCheckMainHarness(harness, manifest);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(["limits.maxConcurrentPages 8 is above the workspace's 3; it is clamped to 3"]);
  });

  it('uses the default of 3 when the workspace sets no limit', () => {
    const bare = { ...manifest, defaults: undefined };
    expect(crossCheckMainHarness({ ...marketingHarness, limits: { maxConcurrentPages: 4 } }, bare).warnings).toEqual([
      "limits.maxConcurrentPages 4 is above the workspace's 3; it is clamped to 3",
    ]);
  });

  it('gives no warning when the value equals the limit', () => {
    expect(crossCheckMainHarness({ ...marketingHarness, limits: { maxConcurrentPages: 3 } }, manifest).warnings).toEqual([]);
  });
});
