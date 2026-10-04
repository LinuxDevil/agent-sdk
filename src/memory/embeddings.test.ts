/**
 * N15: aiSdkEmbedder over a fake AI SDK embedding model, on the installed
 * `ai` and on the aliased `ai` 6 and 7 (each with the model spec version that
 * pairs with it).
 */
import { describe, expect, it, vi } from 'vitest';
import * as aiV6 from 'ai-v6';
import * as aiV7 from 'ai-v7';
import { ConfigurationError } from '../execution/errors';
import { installedAiMajor } from '../providers/aiMajor.testkit';
import { MissingPeerDependencyError } from '../providers/optionalPeer';
import { aiSdkEmbedder, createAiSdkEmbedder, type AiEmbedModule } from './embeddings';

const SPEC = { 4: 'v1', 6: 'v3', 7: 'v3' } as const;

/** An embedding model whose vector for a text is `[text length, batch call number]`. */
function fakeModel(spec: string, extra: Record<string, unknown> = {}) {
  const batches: string[][] = [];
  const signals: unknown[] = [];
  const model = {
    specificationVersion: spec,
    provider: 'fake.provider',
    modelId: 'fake-embed',
    maxEmbeddingsPerCall: 1000,
    supportsParallelCalls: false,
    async doEmbed({ values, abortSignal }: { values: string[]; abortSignal?: AbortSignal }) {
      signals.push(abortSignal);
      batches.push([...values]);
      return { embeddings: values.map((v) => [v.length, batches.length]), usage: { tokens: values.length }, warnings: [] };
    },
    ...extra,
  };
  return { model, batches, signals };
}

const majors: Array<[number, () => Promise<AiEmbedModule>]> = [
  [installedAiMajor, async () => (await import('ai')) as unknown as AiEmbedModule],
  [6, async () => aiV6 as unknown as AiEmbedModule],
  [7, async () => aiV7 as unknown as AiEmbedModule],
];

describe.each(majors)('aiSdkEmbedder on ai %i', (major, loadAi) => {
  const spec = SPEC[major as 4 | 6 | 7];

  it('batches by maxBatch, keeps the order and uses the model as default id', async () => {
    const { model, batches } = fakeModel(spec);
    const embedder = createAiSdkEmbedder(model, { maxBatch: 2 }, loadAi);
    expect(embedder.id).toBe('fake.provider:fake-embed');
    const vectors = await embedder.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
    expect(batches).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(vectors.map((v) => v[1])).toEqual([1, 1, 2, 2, 3]);
  });

  it('makes no call for no texts', async () => {
    const { model, batches } = fakeModel(spec);
    expect(await createAiSdkEmbedder(model, {}, loadAi).embed([])).toEqual([]);
    expect(batches).toEqual([]);
  });
});

describe('aiSdkEmbedder', () => {
  it('takes an explicit id, and the model id alone when the model has no provider name', () => {
    expect(createAiSdkEmbedder(fakeModel('v1').model, { id: 'mine' }, async () => aiV7 as unknown as AiEmbedModule).id).toBe('mine');
    expect(aiSdkEmbedder(fakeModel('v1', { provider: undefined }).model).id).toBe('fake-embed');
  });

  it('runs on the installed ai without a loader', async () => {
    const { model } = fakeModel(SPEC[installedAiMajor as 4 | 6 | 7]);
    expect(await aiSdkEmbedder(model).embed(['abc'])).toEqual([[3, 1]]);
  });

  it('passes the abort signal to the model', async () => {
    const { model, signals } = fakeModel(SPEC[installedAiMajor as 4 | 6 | 7]);
    const controller = new AbortController();
    await aiSdkEmbedder(model).embed(['abc'], { signal: controller.signal });
    expect(signals).toEqual([controller.signal]);
  });

  it.each([
    ['a language model', { modelId: 'gpt', doGenerate: () => undefined }, /language model/],
    ['a model id string', 'text-embedding-3-small', /not the string/],
    ['null', null, /embedding model/],
    ['an object without doEmbed', { modelId: 'x' }, /modelId and doEmbed/],
  ])('rejects %s with a ConfigurationError', (_label, model, message) => {
    expect(() => aiSdkEmbedder(model)).toThrow(ConfigurationError);
    expect(() => aiSdkEmbedder(model)).toThrow(message);
  });

  it('rejects a bad maxBatch', () => {
    expect(() => aiSdkEmbedder(fakeModel('v1').model, { maxBatch: 0 })).toThrow(ConfigurationError);
  });

  it('fails clearly when the model returns too few vectors', async () => {
    const loadAi = async () => ({ embedMany: async () => ({ embeddings: [[1]] }) }) as unknown as AiEmbedModule;
    await expect(createAiSdkEmbedder(fakeModel('v1').model, {}, loadAi).embed(['a', 'b'])).rejects.toThrow(/asked for 2 embeddings, got 1/);
  });

  it('retries loading ai after a failure, and reports a missing ai with the install command', async () => {
    vi.resetModules();
    const loadAi = vi
      .fn<[], Promise<AiEmbedModule>>()
      .mockRejectedValueOnce(new MissingPeerDependencyError('ai', 'npm install ai'))
      .mockResolvedValue({ embedMany: async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1]) }) });
    const embedder = createAiSdkEmbedder(fakeModel('v1').model, {}, loadAi);
    await expect(embedder.embed(['a'])).rejects.toBeInstanceOf(MissingPeerDependencyError);
    expect(await embedder.embed(['a'])).toEqual([[1]]);
  });
});
