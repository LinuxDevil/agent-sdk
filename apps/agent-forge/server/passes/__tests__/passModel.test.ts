import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from 'lousho';
import type { GenerateOptions, GenerateResult } from 'lousho';
import { callPassModel } from '../passModel';
import { SettingsStore } from '../../settingsStore';
import { SecretsStore } from '../../secretsStore';
import { studioPathsFor } from '../../workspace/studioPaths';
import type { PassContext } from '../passRunner';
import {
  PassOutputError,
  PassRefusedError,
  PassSkippedError,
  PassUnavailableError,
} from '../passRunner';

const buildAgentFromSpec = vi.hoisted(() => vi.fn());
vi.mock('../../buildAgent', () => ({ buildAgentFromSpec }));

const schema = z.object({ answer: z.number() });

function reply(over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text: '{"answer": 42}',
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    ...over,
  };
}

function ctx(): PassContext & { record: ReturnType<typeof vi.fn> } {
  return {
    attempt: 1,
    signal: new AbortController().signal,
    record: vi.fn(),
  };
}

describe('callPassModel', () => {
  let dir: string;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let generate: ReturnType<typeof vi.fn<[options: GenerateOptions], Promise<GenerateResult>>>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-pass-model-'));
    settings = new SettingsStore(studioPathsFor(path.join(dir, '.lousho')));
    secrets = new SecretsStore(studioPathsFor(path.join(dir, '.lousho')));
    generate = vi.fn<[options: GenerateOptions], Promise<GenerateResult>>(async (_options) => reply());
    buildAgentFromSpec.mockReset();
    buildAgentFromSpec.mockReturnValue({ provider: { generate } });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const base = () => ({
    kind: 'version_summary' as const,
    system: 'sys',
    prompt: 'prompt',
    schema,
    timeoutMs: 5000,
    ctx: ctx(),
    secretsStore: secrets,
    settings,
  });

  it('returns the parsed value and records model, usage and cost', async () => {
    const context = ctx();
    const result = await callPassModel({ ...base(), ctx: context });
    expect(result).toEqual({ answer: 42 });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        maxTokens: 1024,
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'prompt' },
        ],
      })
    );
    expect(context.record).toHaveBeenCalledWith({ model: 'anthropic/claude-haiku-5-5' });
    expect(context.record).toHaveBeenCalledWith({
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: expect.any(Number),
    });
    // Haiku is priced in the registry, so the estimate lands a cost.
    const costCall = context.record.mock.calls.find((c) => c[0].costUsd !== undefined);
    expect(costCall?.[0].costUsd).toBeGreaterThan(0);
  });

  it('a provider-reported costUsd wins over the registry estimate', async () => {
    generate.mockResolvedValue(reply({ usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.25 } }));
    const context = ctx();
    await callPassModel({ ...base(), model: 'openai/gpt-4o-mini', ctx: context });
    expect(context.record).toHaveBeenCalledWith({
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.25,
    });
  });

  it('no usage reported records the model only', async () => {
    generate.mockResolvedValue(reply({ usage: undefined }));
    const context = ctx();
    await callPassModel({ ...base(), ctx: context });
    expect(context.record).toHaveBeenCalledTimes(1);
    expect(context.record).toHaveBeenCalledWith({ model: 'anthropic/claude-haiku-5-5' });
  });

  it('a missing provider key is PassUnavailableError', async () => {
    buildAgentFromSpec.mockImplementation(() => {
      throw new ConfigurationError('No API key for provider', 'provider', 'LOUSHO_PROVIDER_MISSING_API_KEY');
    });
    await expect(callPassModel(base())).rejects.toBeInstanceOf(PassUnavailableError);
  });

  it('content_filter is PassRefusedError', async () => {
    generate.mockResolvedValue(reply({ finishReason: 'content_filter', text: '' }));
    await expect(callPassModel(base())).rejects.toBeInstanceOf(PassRefusedError);
  });

  it('prose without a JSON object is PassOutputError', async () => {
    generate.mockResolvedValue(reply({ text: 'I cannot help with that.' }));
    await expect(callPassModel(base())).rejects.toBeInstanceOf(PassOutputError);
    await expect(callPassModel(base())).rejects.toThrow('did not return a JSON object');
  });

  it('a schema mismatch is PassOutputError naming the issue path', async () => {
    generate.mockResolvedValue(reply({ text: '{"answer": "not a number"}' }));
    await expect(callPassModel(base())).rejects.toThrow(/answer: /);
  });

  it('a kind turned off in settings is PassSkippedError and never calls the model', async () => {
    settings.setPasses({ enabled: { version_summary: false } });
    await expect(callPassModel(base())).rejects.toBeInstanceOf(PassSkippedError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('the timeout aborts the provider call signal', async () => {
    let seenSignal: AbortSignal | undefined;
    generate.mockImplementation((options: GenerateOptions) => {
      seenSignal = options.signal;
      return new Promise<GenerateResult>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    await expect(callPassModel({ ...base(), timeoutMs: 20 })).rejects.toThrow('aborted');
    expect(seenSignal?.aborted).toBe(true);
  });
});
