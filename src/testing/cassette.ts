/**
 * Cassette file format for `recordReplay`: a versioned, reviewable JSON file
 * holding every recorded `generate()` / `stream()` exchange.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SDKError } from '../execution/errors';

/** The cassette format version this SDK reads and writes. */
const CASSETTE_VERSION = 1;

const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  /** Optional, so cassettes recorded before they were kept still read. */
  cachedInputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

/** LOU-V13: one block of the model's reasoning, as `GenerateResult.reasoning` holds it. */
const reasoningSchema = z.object({ text: z.string(), signature: z.string().optional(), redactedData: z.string().optional() });

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const errorSchema = z.object({ name: z.string(), message: z.string() });

/** N1a: a call the provider ran (a hosted tool), as `GenerateResult.hostedToolCalls` holds it. */
const hostedToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
  sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional(),
});

const chunkSchema = z.object({
  type: z.enum(['text-delta', 'reasoning-delta', 'reasoning-end', 'tool-call', 'hosted-tool-call', 'hosted-tool-result', 'tool-result', 'finish', 'error']),
  textDelta: z.string().optional(),
  reasoning: z.object({ signature: z.string().optional(), redactedData: z.string().optional() }).optional(),
  toolCall: toolCallSchema.optional(),
  hostedToolCall: hostedToolCallSchema.optional(),
  toolResult: z.object({ toolCallId: z.string(), result: z.unknown() }).optional(),
  finishReason: z.string().optional(),
  usage: usageSchema.optional(),
  error: errorSchema.optional(),
});

const requestSchema = z.object({
  model: z.string().nullable(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
      name: z.string().optional(),
      toolName: z.string().optional(),
      isError: z.boolean().optional(),
      attachments: z.array(z.string()).optional(),
      toolCalls: z.array(z.object({ name: z.string(), arguments: z.string() })).optional(),
    })
  ),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.unknown() })),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
});

const responseSchema = z.object({
  text: z.string(),
  finishReason: z.string(),
  /** Absent when the provider reported no usage for the call. */
  usage: usageSchema.optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  hostedToolCalls: z.array(hostedToolCallSchema).optional(),
  /** `generate()` reasoning blocks (a stream keeps its reasoning in its chunks). */
  reasoning: z.array(reasoningSchema).optional(),
  /** Present for `stream()` entries: the chunks and the delay before each. */
  chunks: z.array(z.object({ delayMs: z.number(), chunk: chunkSchema })).optional(),
});

const entrySchema = z.object({
  kind: z.enum(['generate', 'stream']),
  request: requestSchema,
  response: responseSchema.optional(),
  error: errorSchema.optional(),
});

const cassetteSchema = z.object({
  version: z.literal(CASSETTE_VERSION),
  sdkVersion: z.string(),
  recordedAt: z.string(),
  provider: z.object({ name: z.string(), defaultModel: z.string().optional() }),
  entries: z.array(entrySchema),
});

/** The normalized, redacted request stored (and matched) for each call. */
export type CassetteRequest = z.infer<typeof requestSchema>;
/** A recorded response (for `stream()` entries also the chunk list). */
export type CassetteResponse = z.infer<typeof responseSchema>;
/** A serialized error: name and message only. */
export type CassetteError = z.infer<typeof errorSchema>;
/** One recorded exchange. */
export type CassetteEntry = z.infer<typeof entrySchema>;
/** The parsed cassette file. */
export type Cassette = z.infer<typeof cassetteSchema>;

export const RERECORD_HINT =
  "If the change is intentional, re-record the cassette (run with LOUSHO_RECORD=1, or set mode: 'record').";

/** Start a fresh cassette for a recording session. */
export function newCassette(provider: Cassette['provider']): Cassette {
  return {
    version: CASSETTE_VERSION,
    sdkVersion: readSdkVersion(),
    recordedAt: new Date().toISOString(),
    provider,
    entries: [],
  };
}

/** Read and validate a cassette; every failure explains how to fix it. */
export function readCassette(file: string): Cassette {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SDKError(
        `recordReplay: cassette not found at ${file}. Record it first by running the test once ` +
          "with a real provider in record mode (LOUSHO_RECORD=1 or mode: 'record'), then commit the file.",
        'LOUSHO_CASSETTE_INVALID'
      );
    }
    throw error;
  }
  return parseCassette(file, raw);
}

function parseCassette(file: string, raw: string): Cassette {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SDKError(`recordReplay: cassette ${file} is not valid JSON. Delete it and re-record.`, 'LOUSHO_CASSETTE_INVALID');
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (version !== CASSETTE_VERSION) {
    throw new SDKError(
      `recordReplay: cassette ${file} has format version ${String(version)}, but this SDK reads version ` +
        `${CASSETTE_VERSION}. Re-record it with this SDK version.`,
      'LOUSHO_CASSETTE_INVALID'
    );
  }
  const parsed = cassetteSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SDKError(
      `recordReplay: cassette ${file} is malformed at ${issue.path.join('.') || '(root)'}: ${issue.message}. ` +
        'Delete it and re-record.',
      'LOUSHO_CASSETTE_INVALID'
    );
  }
  return parsed.data;
}

/**
 * Write the cassette atomically: a temp file in the same directory, then a
 * rename. A crash mid-write leaves the previous cassette untouched.
 */
export async function writeCassette(file: string, cassette: Cassette): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(temp, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
    await fs.promises.rename(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The directory holding this module, in both build formats (LOU-R10):
 * `__dirname` in the CJS build (and under vitest), `import.meta.url` in the
 * `.mjs` build where `__dirname` does not exist. `undefined` when neither is
 * available (the CJS build compiles `import.meta` to an empty object, so the
 * fallback can throw - it is caught).
 */
function moduleDir(): string | undefined {
  if (typeof __dirname === 'string') return __dirname;
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

/** Find this package's version for the cassette header ("unknown" if it cannot be found). */
function readSdkVersion(): string {
  let dir = moduleDir();
  for (let depth = 0; dir !== undefined && depth < 5; depth++) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === '@lousho/build-ai-agent' && manifest.version) return manifest.version;
    } catch {
      // keep walking up
    }
    dir = path.dirname(dir);
  }
  return 'unknown';
}
