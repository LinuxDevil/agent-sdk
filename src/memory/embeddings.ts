/**
 * Embedding providers for semantic memory: text in, vectors out.
 *
 * `aiSdkEmbedder` wraps any AI SDK embedding model. It imports no provider
 * package (the caller built the model) and loads `embedMany` from the
 * installed `ai` on first use. This file stays free of `node:*` imports so a
 * Worker can use it.
 */
import { ConfigurationError, SDKError } from '../execution/errors';
import { loadOptionalPeer, lazyValue } from '../providers/optionalPeer';

/** Turns text into vectors. Vectors of one provider all have the same length. */
export interface EmbeddingProvider {
  /** Stable id of the model and settings, stored with each vector (e.g. `'openai:text-embedding-3-small'`). */
  readonly id: string;
  /** One vector per text, in the order of `texts`. */
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

/** Options of {@link aiSdkEmbedder}. */
export interface AiSdkEmbedderOptions {
  /** Id stored with each vector. Default: `<model.provider>:<model.modelId>`. Change it when you change the model or its settings. */
  id?: string;
  /** Most texts sent in one `embedMany` call. Default 96. */
  maxBatch?: number;
}

/** The part of the `ai` module the embedder calls; v4, v6 and v7 all fit. */
export interface AiEmbedModule {
  embedMany(options: { model: never; values: string[]; abortSignal?: AbortSignal }): PromiseLike<{ embeddings: number[][] }>;
}

interface EmbeddingModelFields {
  provider?: unknown;
  modelId: string;
  doEmbed: unknown;
}

function checkModel(model: unknown): asserts model is EmbeddingModelFields {
  const hint = "Pass an embedding model, e.g. aiSdkEmbedder(openai.embedding('text-embedding-3-small')).";
  if (typeof model === 'string') {
    throw new ConfigurationError(`aiSdkEmbedder() takes an embedding model object, not the string '${model}'. ${hint}`, 'model');
  }
  const fields = model as Partial<EmbeddingModelFields> | null;
  if (typeof fields !== 'object' || fields === null || typeof fields.modelId !== 'string' || typeof fields.doEmbed !== 'function') {
    const language = typeof (fields as { doGenerate?: unknown } | null)?.doGenerate === 'function';
    throw new ConfigurationError(
      `aiSdkEmbedder() needs an AI SDK embedding model (an object with modelId and doEmbed)${language ? '; this is a language model' : ''}. ${hint}`,
      'model'
    );
  }
}

/**
 * Internal: {@link aiSdkEmbedder} against a given `ai` module (a function
 * loading it), so tests can run it on the aliased `ai` 6 and 7.
 */
export function createAiSdkEmbedder(model: unknown, options: AiSdkEmbedderOptions, loadAi: () => Promise<AiEmbedModule>): EmbeddingProvider {
  checkModel(model);
  const maxBatch = options.maxBatch ?? 96;
  if (!Number.isInteger(maxBatch) || maxBatch < 1) {
    throw new ConfigurationError(`aiSdkEmbedder(): maxBatch must be a positive integer, got ${maxBatch}.`, 'maxBatch');
  }
  const provider = typeof model.provider === 'string' && model.provider !== '' ? `${model.provider}:` : '';
  const id = options.id ?? `${provider}${model.modelId}`;
  const ai = lazyValue(loadAi);
  return {
    id,
    async embed(texts, { signal } = {}) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += maxBatch) {
        const values = texts.slice(start, start + maxBatch);
        const { embeddings } = await (await ai()).embedMany({ model: model as never, values, abortSignal: signal });
        if (embeddings.length !== values.length) {
          throw new SDKError(`aiSdkEmbedder(${id}): asked for ${values.length} embeddings, got ${embeddings.length}.`, 'LOUSHO_PROVIDER_REQUEST_FAILED');
        }
        vectors.push(...embeddings);
      }
      return vectors;
    },
  };
}

/**
 * Any AI SDK embedding model as an {@link EmbeddingProvider}, through
 * `embedMany` from the installed `ai` (4, 6 or 7; build the model with the
 * provider package that pairs with it). Throws `LOUSHO_CONFIG_INVALID` for a
 * model id string or a language model.
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 * const embedder = aiSdkEmbedder(openai.embedding('text-embedding-3-small'));
 * ```
 */
export function aiSdkEmbedder(model: unknown, options: AiSdkEmbedderOptions = {}): EmbeddingProvider {
  return createAiSdkEmbedder(model, options, () => loadOptionalPeer('ai', () => import('ai') as Promise<AiEmbedModule>));
}
