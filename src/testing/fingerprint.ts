/**
 * Request fingerprinting, normalization and redaction for `recordReplay`.
 *
 * A request is reduced to the fields that decide what the model says (model,
 * messages, tools, temperature, maxTokens), volatile values are replaced by
 * placeholders and secrets are redacted, so the same logical request always
 * produces the same canonical JSON.
 */

import type { FileContentPart, GenerateOptions, ImageContentPart, Message, ToolDefinition } from '../providers/llm';
import { textOf } from '../providers/content';
import type { CassetteRequest } from './cassette';
import { isZod4Schema, schemaToJsonSchema } from '../utils/zodCompat';

const MAX_DEPTH = 24;

/** Volatile value patterns replaced by a placeholder before matching. */
const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>'],
  [/\b1[6-9]\d{11}\b/g, '<timestamp>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  [
    /\b(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,? )?(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},? \d{4}\b/g,
    '<date>',
  ],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b(?:call|toolu|chatcmpl|msg|run|sess|session|req)_[A-Za-z0-9]{8,}\b/g, '<id>'],
];

/** Secret patterns redacted from everything written to a cassette. */
const SECRETS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const REDACTED = '[REDACTED]';

/** Zod `_def` keys copied into a fingerprint, with the name they get in it. */
const ZOD_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['description', 'description'],
  ['shape', 'properties'],
  ['innerType', 'inner'],
  ['schema', 'inner'],
  ['type', 'items'],
  ['valueType', 'values'],
  ['keyType', 'keys'],
  ['options', 'options'],
  ['items', 'items'],
  ['values', 'enum'],
  ['value', 'const'],
  ['checks', 'checks'],
];

type ZodDef = Record<string, unknown> & { typeName: string };

function zodDefOf(value: object): ZodDef | undefined {
  const def = (value as { _def?: unknown })._def;
  if (typeof def !== 'object' || def === null) return undefined;
  return typeof (def as ZodDef).typeName === 'string' ? (def as ZodDef) : undefined;
}

function zodFingerprint(def: ZodDef, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { type: def.typeName.replace(/^Zod/, '').toLowerCase() };
  for (const [from, to] of ZOD_KEYS) {
    let child = def[from];
    if (child === undefined) continue;
    if (from === 'shape' && typeof child === 'function') child = (child as () => unknown)();
    if (from === 'checks' && Array.isArray(child)) {
      child = child.map((check: { kind: string; value?: unknown }) => ({ kind: check.kind, value: check.value }));
    }
    out[to] = canonicalize(child, depth + 1);
  }
  return sortKeys(out);
}

function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) sorted[key] = record[key];
  }
  return sorted;
}

/**
 * Reduce any value to plain, key-sorted JSON. Zod schemas become a
 * JSON-schema-ish fingerprint (zod 4 ones their JSON Schema); functions and
 * `undefined` are dropped.
 */
function canonicalize(value: unknown, depth = 0): unknown {
  if (value === undefined || typeof value === 'function') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (depth > MAX_DEPTH) return '[max depth]';
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1) ?? null);
  const zodDef = zodDefOf(value);
  if (zodDef) return zodFingerprint(zodDef, depth);
  // A zod 4 schema (LOU-D29): its JSON Schema.
  if (isZod4Schema(value)) return canonicalize(schemaToJsonSchema(value), depth + 1);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = canonicalize(child, depth + 1);
  return sortKeys(out);
}

/** Deterministic JSON text of any value (used to compare requests). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Apply `fn` to every string inside a JSON-like value (keys are left alone). */
function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = mapStrings(child, fn);
    return out as T;
  }
  return value;
}

function replaceAll(text: string, patterns: ReadonlyArray<RegExp | readonly [RegExp, string]>): string {
  let result = text;
  for (const pattern of patterns) {
    result = Array.isArray(pattern)
      ? result.replace(pattern[0] as RegExp, pattern[1] as string)
      : result.replace(pattern as RegExp, REDACTED);
  }
  return result;
}

function normalizeArguments(argumentsJson: string): string {
  try {
    return stableStringify(JSON.parse(argumentsJson));
  } catch {
    return argumentsJson;
  }
}

/** 32-bit FNV-1a of a part's data, so a cassette tells images apart without storing them. */
function digest(data: string | Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of typeof data === 'string' ? new TextEncoder().encode(data) : data) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** An image or file part (LOU-V11) as a short line: kind, type, name, and its URL or a digest of its data. */
function describePart(part: ImageContentPart | FileContentPart): string {
  const data = part.type === 'image' ? part.image : part.data;
  const source = typeof data === 'string' && /^https?:\/\//i.test(data) ? data : `fnv1a:${digest(data)}`;
  const name = part.type === 'file' ? part.filename : undefined;
  return [part.type, part.mimeType, name, source].filter(Boolean).join(' ');
}

function toCassetteMessage(message: Message): CassetteRequest['messages'][number] {
  const attachments = Array.isArray(message.content)
    ? message.content.flatMap((part) => (part.type === 'text' ? [] : [describePart(part)]))
    : [];
  return {
    role: message.role,
    content: textOf(message),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
    ...(message.toolCalls?.length
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            name: call.function.name,
            arguments: normalizeArguments(call.function.arguments),
          })),
        }
      : {}),
  };
}

function toCassetteTool(tool: ToolDefinition): CassetteRequest['tools'][number] {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: canonicalize(tool.function.parameters) ?? {},
  };
}

/** Options a sanitizer is built from. */
export interface SanitizerOptions {
  normalize?: (request: GenerateOptions) => GenerateOptions;
  redact?: (text: string) => string;
  defaultModel?: string;
}

/** Turns live requests/responses into what is stored in, and matched against, a cassette. */
export interface Sanitizer {
  /** Canonical request: reduced to match fields, normalized and redacted. */
  request(options: GenerateOptions): CassetteRequest;
  /** Redact secrets (and apply the user's `redact`) throughout a response value. */
  redact<T>(value: T): T;
}

/** Build the request/response sanitizer shared by record and replay. */
export function createSanitizer(options: SanitizerOptions): Sanitizer {
  const redactText = (text: string): string => {
    const clean = replaceAll(text, SECRETS);
    return options.redact ? options.redact(clean) : clean;
  };
  const cleanText = (text: string): string => redactText(replaceAll(text, VOLATILE));
  return {
    request(request) {
      const source = options.normalize ? options.normalize(request) : request;
      const canonical: CassetteRequest = {
        model: source.model || options.defaultModel || null,
        messages: source.messages.map(toCassetteMessage),
        tools: (source.tools ?? []).map(toCassetteTool),
        temperature: source.temperature ?? null,
        maxTokens: source.maxTokens ?? null,
      };
      return JSON.parse(JSON.stringify(mapStrings(canonical, cleanText))) as CassetteRequest;
    },
    redact: (value) => mapStrings(value, redactText),
  };
}

export interface Difference {
  /** Path of the first differing value, e.g. `request.messages[1].content`. */
  path: string;
  expected: string;
  actual: string;
}

function show(value: unknown): string {
  if (value === undefined) return '(missing)';
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function showStrings(expected: string, actual: string): [string, string] {
  let at = 0;
  while (at < expected.length && expected[at] === actual[at]) at++;
  const window = (text: string): string => {
    const start = Math.max(0, at - 30);
    const slice = text.slice(start, at + 60);
    return `${start > 0 ? '...' : ''}${JSON.stringify(slice)}${text.length > at + 60 ? '...' : ''}`;
  };
  return expected.length > 100 || actual.length > 100
    ? [`${window(expected)} (first differs at char ${at})`, window(actual)]
    : [show(expected), show(actual)];
}

function childPaths(a: unknown, b: unknown): Array<string | number> {
  if (Array.isArray(a) && Array.isArray(b)) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => index);
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].sort();
}

function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function childDifference(expected: unknown, actual: unknown, path: string): Difference | undefined {
  for (const key of childPaths(expected, actual)) {
    const child = (value: unknown): unknown => (value as Record<string | number, unknown>)[key];
    const where = typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    const found = firstDifference(child(expected), child(actual), where);
    if (found) return found;
  }
  return undefined;
}

function leafDifference(expected: unknown, actual: unknown, path: string): Difference | undefined {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return undefined;
  const [shownExpected, shownActual] =
    typeof expected === 'string' && typeof actual === 'string'
      ? showStrings(expected, actual)
      : [show(expected), show(actual)];
  return { path: path || '(root)', expected: shownExpected, actual: shownActual };
}

/** The first place two canonical JSON values differ, or `undefined` if equal. */
export function firstDifference(expected: unknown, actual: unknown, path = ''): Difference | undefined {
  const comparable =
    isContainer(expected) && isContainer(actual) && Array.isArray(expected) === Array.isArray(actual);
  return comparable ? childDifference(expected, actual, path) : leafDifference(expected, actual, path);
}
