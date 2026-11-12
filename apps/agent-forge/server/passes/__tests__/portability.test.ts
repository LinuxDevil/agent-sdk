/**
 * L09a portability check pass: the prompt input builder (secret-ref
 * masking, section caps, `{ file }` instructions), the reply schema's
 * truncate-don't-reject contract, and `checkPortability`'s specHash
 * caching + pass-outcome error mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { AgentRepo } from '../../storage/agentRepo';
import { SuggestionStore } from '../../storage/suggestionStore';
import { specHash } from '../../storage/specHash';
import { SecretsStore } from '../../secretsStore';
import { SettingsStore } from '../../settingsStore';
import { studioPathsFor } from '../../workspace/studioPaths';
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
  PORTABILITY_SYSTEM_PROMPT,
  buildPortabilityInput,
  checkPortability,
  portabilityOutputSchema,
  type PortabilityDeps,
} from '../portability';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'ops',
  model: 'mock/mock-1',
  description: 'Keeps the lights on.',
  instructions: 'Ping #ops-alerts in the acme workspace when the deploy fails.',
  tools: [{ builtin: 'web_fetch', id: 'fetch' }],
  triggers: [{ type: 'cron', id: 'nightly', cron: '0 3 * * *', prompt: 'run checks' } as never],
};

const MODEL_REPLY = {
  summary: 'Mostly portable; one Slack channel is hard-wired.',
  findings: [
    {
      location: 'instructions',
      kind: 'channel',
      quote: '#ops-alerts',
      explanation: 'Owner-specific channel.',
      suggestion: 'Use [YOUR CHANNEL].',
    },
  ],
  adaptedInstructions: 'Ping [YOUR CHANNEL] when the deploy fails.',
};

describe('buildPortabilityInput', () => {
  it('renders every ticket section in order with masked refs', () => {
    const spec: AgentSpecV2 = {
      ...SPEC,
      tools: [{ builtin: 'http', id: 'notify', headers: { authorization: { secret: 'SLACK_TOKEN' } } } as never],
      mcpServers: { docs: { command: 'npx', args: ['-y', '@acme/mcp'], env: { KEY: { env: 'MCP_KEY' } } } } as never,
      hooks: [
        { id: 'audit', file: 'hooks/audit.ts' },
        { id: 'notify', inline: { name: 'slackPing', point: 'preToolCall', code: 'postToSlack()' } },
      ] as never,
    };
    const input = buildPortabilityInput(spec);
    expect(input).toContain('Agent name: ops');
    expect(input).toContain('Agent description: Keeps the lights on.');
    expect(input).toContain('=== INSTRUCTIONS ===\nPing #ops-alerts');
    expect(input).toContain('=== END INSTRUCTIONS ===');
    expect(input).toContain('Triggers (JSON):\n[{"type":"cron"');
    expect(input).toContain('Tools (JSON):');
    expect(input).toContain('MCP servers (JSON):');
    // Secret/env refs render as placeholders, never resolved values.
    expect(input).toContain('<secret ref SLACK_TOKEN>');
    expect(input).toContain('<env ref MCP_KEY>');
    expect(input).not.toContain('SLACK_TOKEN"');
    expect(input).toContain('Hooks:\n- audit: hooks/audit.ts\n- notify: slackPing (preToolCall)\npostToSlack()');
  });

  it('marks a { file } instructions spec instead of inlining contents', () => {
    const input = buildPortabilityInput({ ...SPEC, instructions: { file: 'prompts/ops.md' } });
    expect(input).toContain('(instructions are read from the file prompts/ops.md; not checked)');
  });

  it('caps the instructions excerpt at 24 000 chars with the ticket marker', () => {
    const input = buildPortabilityInput({ ...SPEC, instructions: 'i'.repeat(30_000) });
    const start = input.indexOf('=== INSTRUCTIONS ===\n') + '=== INSTRUCTIONS ===\n'.length;
    const end = input.indexOf('\n=== END INSTRUCTIONS ===');
    expect(end - start).toBe(24_000 + '\n[... instructions truncated for the check ...]'.length);
    expect(input.slice(start, end)).toContain('[... instructions truncated for the check ...]');
  });

  it('caps each JSON section at 8 000 chars with the truncation marker', () => {
    const input = buildPortabilityInput({
      ...SPEC,
      triggers: [{ type: 'cron', blob: 't'.repeat(20_000) } as never],
    });
    const line = input.split('\n').find((l) => l.startsWith('[{"type":"cron"'))!;
    expect(line.length).toBeLessThanOrEqual(8_000);
    expect(line.endsWith('… (truncated)')).toBe(true);
  });

  it('clips inline hook code at 2 000 chars', () => {
    const input = buildPortabilityInput({
      ...SPEC,
      hooks: [{ id: 'h', inline: { name: 'n', point: 'preToolCall', code: 'c'.repeat(5_000) } }] as never,
    });
    const codeLine = input.split('\n').find((l) => l.startsWith('c'.repeat(100)))!;
    expect(codeLine.length).toBeLessThanOrEqual(2_000);
  });
});

describe('portabilityOutputSchema', () => {
  it('clips summary/quote/explanation/suggestion and caps findings at 20', () => {
    const parsed = portabilityOutputSchema.parse({
      summary: `s${'x'.repeat(600)}`,
      findings: Array.from({ length: 25 }, (_, i) => ({
        location: 'instructions',
        kind: 'path',
        quote: `q${i}${'y'.repeat(300)}`,
        explanation: `e${'z'.repeat(400)}`,
        suggestion: `g${'w'.repeat(400)}`,
      })),
      adaptedInstructions: null,
    });
    expect(parsed.summary.length).toBeLessThanOrEqual(500);
    expect(parsed.findings).toHaveLength(20);
    for (const f of parsed.findings) {
      expect(f.quote.length).toBeLessThanOrEqual(200);
      expect(f.explanation.length).toBeLessThanOrEqual(300);
      expect(f.suggestion.length).toBeLessThanOrEqual(300);
    }
  });

  it('falls back to "other" for unknown location/kind values', () => {
    const parsed = portabilityOutputSchema.parse({
      summary: 's',
      findings: [{ location: 'nowhere', kind: 'vibes', quote: 'q', explanation: 'e', suggestion: 'g' }],
      adaptedInstructions: 'a',
    });
    expect(parsed.findings[0]).toMatchObject({ location: 'other', kind: 'other' });
  });
});

describe('checkPortability', () => {
  let baseDir: string;
  let repo: AgentRepo;
  let suggestions: SuggestionStore;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let enqueue: Mock<[PassJob<unknown>], Promise<PassResult<unknown>>>;
  let passRunner: PassRunner;
  let deps: PortabilityDeps;

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

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l09a-port-'));
    repo = new AgentRepo(baseDir);
    suggestions = new SuggestionStore(repo);
    settings = new SettingsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    secrets = new SecretsStore(studioPathsFor(path.join(baseDir, '.lousho-studio')));
    enqueue = vi.fn(runJob);
    passRunner = { enqueue } as unknown as PassRunner;
    deps = { passRunner, suggestions, secretsStore: secrets, settings, workspaceId: 'ws-1' };
    callPassModel.mockReset();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('runs the pass once, caches by specHash, and serves the second call from cache', async () => {
    callPassModel.mockResolvedValue(MODEL_REPLY);
    const first = await checkPortability(SPEC, 'ops', deps);
    expect(first).toMatchObject({
      kind: 'portability',
      agentId: 'ops',
      specHash: specHash(SPEC),
      summary: MODEL_REPLY.summary,
      findings: MODEL_REPLY.findings,
      adaptedInstructions: MODEL_REPLY.adaptedInstructions,
      model: 'anthropic/claude-haiku-5-5',
    });
    expect(first.id).toMatch(/^portability-[0-9a-f]{16}$/);

    const second = await checkPortability(SPEC, 'ops', deps);
    expect(second).toStrictEqual(first);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(callPassModel).toHaveBeenCalledTimes(1);

    // A spec edit changes the hash: cache misses and the pass re-runs.
    callPassModel.mockResolvedValue(MODEL_REPLY);
    await checkPortability({ ...SPEC, instructions: 'Different.' }, 'ops', deps);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('passes the ticket prompt contract to callPassModel', async () => {
    callPassModel.mockResolvedValue(MODEL_REPLY);
    await checkPortability(SPEC, 'ops', deps);
    const call = callPassModel.mock.calls[0][0];
    expect(call.kind).toBe('portability_check');
    expect(call.system).toBe(PORTABILITY_SYSTEM_PROMPT);
    expect(call.schema).toBe(portabilityOutputSchema);
    expect(call.timeoutMs).toBe(60_000);
    expect(call.maxOutputTokens).toBe(8192);
    expect(call.prompt).toContain('Agent name: ops');
    expect(call.prompt).toContain('#ops-alerts');
    const job = enqueue.mock.calls[0][0];
    expect(job.kind).toBe('portability_check');
    expect(job.key).toBe(specHash(SPEC));
    expect(job.agentId).toBe('ops');
    expect(job.workspaceId).toBe('ws-1');
  });

  it('normalizes an unchanged adaptation and a { file } instructions spec to null', async () => {
    callPassModel.mockResolvedValue({ ...MODEL_REPLY, adaptedInstructions: `  ${SPEC.instructions}  ` });
    const unchanged = await checkPortability(SPEC, 'ops', deps);
    expect(unchanged.adaptedInstructions).toBeNull();

    const fileSpec: AgentSpecV2 = { ...SPEC, instructions: { file: 'prompts/ops.md' } };
    callPassModel.mockResolvedValue({ ...MODEL_REPLY, adaptedInstructions: 'anything' });
    const file = await checkPortability(fileSpec, 'ops', deps);
    expect(file.adaptedInstructions).toBeNull();
  });

  it('agentId null caches in memory, not the suggestion store', async () => {
    callPassModel.mockResolvedValue(MODEL_REPLY);
    const first = await checkPortability(SPEC, null, deps);
    expect(first.agentId).toBeNull();
    const second = await checkPortability(SPEC, null, deps);
    expect(second).toStrictEqual(first);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // Nothing was written under any agent's suggestions folder.
    expect(await suggestions.findPortability('ops', specHash(SPEC))).toBeUndefined();
  });

  it.each([
    ['unavailable', 503, 'LOUSHO_PASS_UNAVAILABLE'],
    ['refused', 422, 'LOUSHO_PASS_REFUSED'],
    ['skipped', 409, 'LOUSHO_PASS_SKIPPED'],
    ['failed', 502, 'LOUSHO_PASS_FAILED'],
  ] as const)('maps a %s pass outcome to %i %s and caches nothing', async (outcome, status, code) => {
    enqueue.mockImplementation(async () => ({ ok: false, outcome, error: 'settled' }));
    await expect(checkPortability(SPEC, 'ops', deps)).rejects.toMatchObject({
      name: 'PortabilityError',
      status,
      code,
    });
    // Errors are never cached: a retry reaches the runner again.
    await expect(checkPortability(SPEC, 'ops', deps)).rejects.toMatchObject({ code });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(await suggestions.findPortability('ops', specHash(SPEC))).toBeUndefined();
  });

  it('maps a PassUnavailableError thrown by the job to 503', async () => {
    callPassModel.mockRejectedValue(new PassUnavailableError('No API key for anthropic.'));
    await expect(checkPortability(SPEC, 'ops', deps)).rejects.toMatchObject({
      status: 503,
      code: 'LOUSHO_PASS_UNAVAILABLE',
    });
  });
});

describe('PORTABILITY_SYSTEM_PROMPT', () => {
  it('matches the ticket text byte-for-byte', () => {
    expect(PORTABILITY_SYSTEM_PROMPT).toMatchSnapshot();
  });
});
