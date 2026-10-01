/**
 * The reference channel (LOU-P7): a plain JSON API. No runtime `node:*` import.
 */
import type { AgentInput } from '../providers/content';
import { defineChannel, type Channel, type ChannelRequest } from './defineChannel';

/** Options of {@link httpChannel}. */
export interface HttpChannelOptions {
  /** Route segment. Default `http`. */
  name?: string;
  /** Authenticates each request (e.g. checks a bearer token). Default: accept every request. */
  verify?: (req: ChannelRequest) => Promise<boolean>;
}

/**
 * A JSON channel: `POST <basePath>/http` with `{ sessionKey, input }` (input
 * a string or content parts) answers `200 { sessionId, text, finishReason }`.
 * When the turn paused, `approval` is the pending request and `text` its
 * prompt; decide it with `POST <basePath>/http/approvals/<id>`. A body without
 * `sessionKey` and `input` gets a 400.
 *
 * @example
 * ```ts
 * import { httpChannel } from '@loushy/build-ai-agent';
 *
 * const api = httpChannel({ verify: async (req) => req.headers.authorization === `Bearer ${process.env.API_TOKEN}` });
 * ```
 */
export function httpChannel(options: HttpChannelOptions = {}): Channel {
  return defineChannel({
    name: options.name ?? 'http',
    verify: options.verify,
    async parse(req) {
      const { sessionKey, input } = (JSON.parse(req.text || '{}') ?? {}) as Record<string, unknown>;
      if (typeof sessionKey !== 'string' || !sessionKey || (typeof input !== 'string' && !Array.isArray(input))) {
        throw new SyntaxError("Request body must be JSON with a 'sessionKey' string and an 'input' (a string or content parts)");
      }
      return { sessionKey, input: input as AgentInput, replyTo: null };
    },
    async reply({ sessionId, text, result, approval, respond }) {
      respond?.(200, { sessionId, text, finishReason: result?.finishReason, approval });
    },
  });
}
