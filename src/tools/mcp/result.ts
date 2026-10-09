/**
 * MCP `CallToolResult` handling (LOU-Z2)
 *
 * Turns the raw result of `client.callTool()` into what the SDK hands the
 * model: an `McpToolError` for `isError` results (so the normal tool-error
 * path reports it), otherwise a JSON-serializable result that keeps every
 * content part.
 */

/** A content part of an MCP tool result, in a typed, JSON-serializable form. */
export type McpContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  | {
      type: 'resource_link';
      uri: string;
      name?: string;
      mimeType?: string;
      description?: string;
    }
  /** A part type this SDK version does not know; the raw part is preserved. */
  | { type: 'unknown'; raw: unknown };

/**
 * Result of a successful MCP tool call that has no `structuredContent`.
 *
 * `text` is every text part joined with newlines; `content` keeps all parts
 * (including image/audio/resource) in order. When every part is text,
 * `content` is non-enumerable: still readable, but left out of the JSON the
 * model gets, which would otherwise carry the text twice.
 */
export interface McpToolResult {
  text: string;
  content: McpContentPart[];
}

/**
 * Result when the server returned `structuredContent` alongside non-text
 * parts (images, audio, resources). With only text parts the
 * `structuredContent` object itself is returned.
 */
export interface McpStructuredToolResult {
  structuredContent: Record<string, unknown>;
  text: string;
  /** The non-text parts, so media is never dropped. */
  content: McpContentPart[];
}

/**
 * Thrown from a loaded MCP tool when the server reports `isError: true`.
 * The model sees `{ error: 'McpToolError', toolName, message, kind: 'mcp' }`,
 * where `message` is the server's text content.
 */
export class McpToolError extends Error {
  /** Read by the executor's shared tool-error shape (LOU-U14). */
  readonly toolErrorKind = 'mcp' as const;

  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function definedProps<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Eve TOOLS-F8: `part` with its base64 `field` replaced by a short placeholder in
 * its JSON (what the model gets), so an image is not sent as hundreds of KB of
 * text. The part itself keeps the data for code that reads it.
 */
function withBinaryPlaceholder<T extends McpContentPart>(part: T, field: 'data' | 'blob'): T {
  const value = (part as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value === '') return part;
  const kind = part.type === 'resource' ? 'resource' : part.type;
  const mimeType = 'mimeType' in part && part.mimeType ? `${part.mimeType}, ` : '';
  const placeholder = `[${kind}: ${mimeType}${value.length} base64 characters, not sent to the model]`;
  return Object.defineProperty(part, 'toJSON', {
    value: () => ({ ...part, [field]: placeholder }),
    enumerable: false,
    configurable: true,
  });
}

function convertResource(part: Record<string, unknown>): McpContentPart {
  const resource = isRecord(part.resource) ? part.resource : {};
  return withBinaryPlaceholder(definedProps({
    type: 'resource' as const,
    uri: str(resource.uri) ?? '',
    mimeType: str(resource.mimeType),
    text: str(resource.text),
    blob: str(resource.blob),
  }), 'blob');
}

function convertPart(part: unknown): McpContentPart {
  if (!isRecord(part)) return { type: 'unknown', raw: part };
  switch (part.type) {
    case 'text':
      return { type: 'text', text: str(part.text) ?? '' };
    case 'image':
    case 'audio':
      return withBinaryPlaceholder({ type: part.type, data: str(part.data) ?? '', mimeType: str(part.mimeType) ?? '' }, 'data');
    case 'resource':
      return convertResource(part);
    case 'resource_link':
      return definedProps({
        type: 'resource_link' as const,
        uri: str(part.uri) ?? '',
        name: str(part.name),
        mimeType: str(part.mimeType),
        description: str(part.description),
      });
    default:
      return { type: 'unknown', raw: part };
  }
}

function joinText(parts: McpContentPart[]): string {
  return parts
    .filter((part): part is Extract<McpContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Convert the raw value returned by `client.callTool()`.
 *
 * - `isError: true` throws an {@link McpToolError} carrying the joined text.
 * - `structuredContent` is preferred as the result object.
 * - Otherwise `{ text, content }` is returned with all parts preserved
 *   (`content` non-enumerable when every part is text, so it is not serialized).
 * - A result without a `content` array (legacy `toolResult` protocol shape)
 *   is returned unchanged.
 */
export function handleCallToolResult(
  raw: unknown,
  toolName: string
): McpToolResult | McpStructuredToolResult | Record<string, unknown> {
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    return isRecord(raw) ? raw : { text: String(raw ?? ''), content: [] };
  }
  const content = raw.content.map(convertPart);
  const text = joinText(content);

  if (raw.isError === true) {
    throw new McpToolError(text || `MCP tool '${toolName}' reported an error without a message`);
  }
  if (isRecord(raw.structuredContent)) {
    const media = content.filter((part) => part.type !== 'text');
    if (media.length === 0) return raw.structuredContent;
    return { structuredContent: raw.structuredContent, text, content: media };
  }
  if (content.every((part) => part.type === 'text')) {
    return Object.defineProperty({ text }, 'content', { value: content, writable: true, configurable: true, enumerable: false }) as McpToolResult;
  }
  return { text, content };
}
