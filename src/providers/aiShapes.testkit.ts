/**
 * Test helper (LOU-D28f): the provider contract tests run on every `ai` major,
 * so what differs between majors lives here and the tests assert one shape.
 *
 * - `mockLanguageModel()`: the right `MockLanguageModel*` for the installed
 *   `ai` (V1 on 4, V3 on 6, V4 on 7), replying with a fixed text and recording
 *   the prompt each call received, normalized by `normalizePrompt()`.
 * - `toolCallPart()` / `toolResultPart()`: the message parts `ai` takes
 *   (`args`/`result` on 4, `input`/`output` on 5+), for the payload a test
 *   expects a provider to hand `generateText()`.
 * - `parseModelMessage()`: the installed `ai`'s own message schema.
 */

import * as ai from 'ai';
import * as aiTest from 'ai/test';
import type { LanguageModel } from 'ai';
import { installedAiMajor } from './aiMajor.testkit';

/** A prompt part, in the neutral shape the contract tests assert (the v4 shape). */
export interface NeutralPart {
  type: string;
  [key: string]: unknown;
}

/** A prompt message with its parts normalized by `normalizePrompt()`. */
export interface NeutralMessage {
  role: string;
  content: string | NeutralPart[];
}

const MOCK_CLASS: Record<number, string> = { 4: 'MockLanguageModelV1', 6: 'MockLanguageModelV3', 7: 'MockLanguageModelV4' };

/** v5+ wraps part data as `{ type: 'data' | 'url', ... }`; v4 holds the bytes, base64 string or URL itself. */
function unwrapData(data: unknown): unknown {
  const wrapped = data as { type?: string; data?: unknown; url?: unknown } | null;
  if (wrapped?.type === 'data') return wrapped.data;
  return wrapped?.type === 'url' ? wrapped.url : data;
}

/** v5+ keeps image bytes base64-encoded where v4 decoded them; a URL stays a URL. */
function imageBytes(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  return /^https?:/.test(data) ? new URL(data) : new Uint8Array(Buffer.from(data, 'base64'));
}

/** v4 held a file part's bytes as base64 text; v5+ keeps the bytes. */
function base64Of(data: unknown): unknown {
  return data instanceof Uint8Array ? Buffer.from(data).toString('base64') : data;
}

/** A v5+ prompt part as the v4 prompt part it stands for: an image is a `file` part with an `image/*` type, `mediaType` is `mimeType`. */
function neutralPart(part: NeutralPart): NeutralPart {
  if (part.type !== 'file' && part.type !== 'image') return part;
  const { type, mediaType, data, image, ...rest } = part;
  const mimeType = (mediaType ?? rest.mimeType) as string | undefined;
  const isImage = type === 'image' || mimeType?.startsWith('image');
  // A URL's type is not known to the SDK ('image' or 'image/*'): the v4 part had none.
  const known = mimeType === 'image/*' || mimeType === 'image' ? undefined : mimeType;
  return isImage
    ? { ...rest, type: 'image', image: imageBytes(unwrapData(image ?? data)), mimeType: known }
    : { ...rest, type, data: base64Of(unwrapData(data)), mimeType: known };
}

/** A model prompt as the v4 prompt shape, whatever the installed major (a v4 prompt is returned as it is). */
export function normalizePrompt(prompt: ReadonlyArray<{ role: string; content: unknown }>): NeutralMessage[] {
  if (installedAiMajor === 4) return prompt as NeutralMessage[];
  return prompt.map(({ role, content }) => ({
    role,
    content: typeof content === 'string' ? content : (content as NeutralPart[]).map(neutralPart),
  }));
}

/**
 * A mock model that answers `text` and records each call's prompt (normalized).
 * `supportsImageUrls` makes it accept `https:` image URLs, as a model that
 * downloads them itself does.
 */
export function mockLanguageModel(options: { text?: string; supportsImageUrls?: boolean } = {}): {
  model: LanguageModel;
  prompts: NeutralMessage[][];
} {
  const { text = 'a cat', supportsImageUrls = false } = options;
  const prompts: NeutralMessage[][] = [];
  const record = (call: { prompt: ReadonlyArray<{ role: string; content: unknown }> }) => {
    prompts.push(normalizePrompt(call.prompt));
  };
  const Mock = (aiTest as unknown as Record<string, new (settings: object) => LanguageModel>)[MOCK_CLASS[installedAiMajor]!];
  const tokens = { promptTokens: 1, completionTokens: 2 };
  const modern = {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: undefined },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  };
  const model = new Mock(
    installedAiMajor === 4
      ? {
          supportsUrl: () => supportsImageUrls,
          doGenerate: async (call: Parameters<typeof record>[0]) => {
            record(call);
            return { text, finishReason: 'stop', usage: tokens, rawCall: { rawPrompt: null, rawSettings: {} } };
          },
        }
      : {
          supportedUrls: supportsImageUrls ? { 'image/*': [/^https:\/\//] } : {},
          doGenerate: async (call: Parameters<typeof record>[0]) => {
            record(call);
            return modern;
          },
        }
  );
  return { model, prompts };
}

/** A tool-call content part: `args` on `ai` 4, `input` on 5+. */
export function toolCallPart(toolCallId: string, toolName: string, input: unknown): NeutralPart {
  return { type: 'tool-call', toolCallId, toolName, ...(installedAiMajor === 4 ? { args: input } : { input }) };
}

/** A tool-result content part for a result as a string or JSON value: `result` on `ai` 4, a typed `output` on 5+. */
export function toolResultPart(toolCallId: string, toolName: string, result: unknown, isError = false): NeutralPart {
  if (installedAiMajor === 4) return { type: 'tool-result', toolCallId, toolName, result, ...(isError ? { isError } : {}) };
  const type = typeof result === 'string' ? (isError ? 'error-text' : 'text') : isError ? 'error-json' : 'json';
  return { type: 'tool-result', toolCallId, toolName, output: { type, value: result } };
}

/** The usage a mocked `generateText()` result carries on the installed major. */
export function mockUsage(): Record<string, number> {
  return installedAiMajor === 4
    ? { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
    : { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
}

/** A tool call in a mocked `generateText()` result: `args` on `ai` 4, `input` on 5+. */
export function mockToolCall(toolCallId: string, toolName: string, input: unknown) {
  return { toolCallId, toolName, ...(installedAiMajor === 4 ? { args: input } : { input }) };
}

/** Parse one message with the installed `ai`'s own schema (`coreMessageSchema` on 4, `modelMessageSchema` on 5+). */
export function parseModelMessage(message: unknown): unknown {
  const schemas = ai as unknown as Record<string, { parse(value: unknown): unknown } | undefined>;
  return schemas[installedAiMajor === 4 ? 'coreMessageSchema' : 'modelMessageSchema']!.parse(message);
}

/** A tool as the installed `ai`'s `tool()` builds it (`parameters` on 4, `inputSchema` on 5+). */
export function aiTool(definition: { description: string; schema: object; execute: (input: never) => Promise<unknown> }) {
  const { schema, ...rest } = definition;
  const make = (ai as unknown as { tool: (definition: object) => unknown }).tool;
  return make(installedAiMajor === 4 ? { ...rest, parameters: schema } : { ...rest, inputSchema: schema });
}
