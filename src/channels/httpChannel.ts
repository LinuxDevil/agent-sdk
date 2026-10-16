/**
 * The reference channel: a plain JSON API. No runtime `node:*` import.
 */
import type { AgentInput } from '../providers/content';
import { defineChannel, type Channel, type ChannelRequest } from './defineChannel';
import { isJsonContentType } from '../server/requestGuard';

/** Options of {@link httpChannel}. */
export interface HttpChannelOptions {
  /** Route segment. Default `http`. */
  name?: string;
  /**
   * Authenticates each request (e.g. checks a bearer token). Default: accept
   * every request that is not a browser's cross-site one (`403`) and has a
   * JSON `Content-Type` (else `415`), so a web page cannot post to it with a
   * form; under `lousho dev` its `Host` is checked like the dev routes'.
   */
  verify?: (req: ChannelRequest) => Promise<boolean>;
}

/**
 * A JSON channel: `POST <basePath>/http` with `{ sessionKey, input }` (input
 * a string or content parts) answers `200 { sessionId, text, finishReason }`.
 * When the turn paused, `approval` is the pending request and `text` its
 * prompt; decide it with `POST <basePath>/http/approvals/<id>`. A step paused
 * on several calls also lists them all in `approvals` (decide each). A body without
 * `sessionKey` and `input` gets a 400.
 *
 * @example
 * ```ts
 * import { httpChannel } from '@lousho/build-ai-agent';
 *
 * const api = httpChannel({ verify: async (req) => req.headers.authorization === `Bearer ${process.env.API_TOKEN}` });
 * ```
 */
export function httpChannel(options: HttpChannelOptions = {}): Channel {
  return defineChannel({
    name: options.name ?? 'http',
    verify: options.verify,
    async parse(req, respond) {
      // Without `verify`, nothing but the body type tells this from a form or `text/plain` post another site's page can send.
      if (!options.verify && !isJsonContentType(typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined)) {
        respond(415, { error: "Request body must be JSON: send 'Content-Type: application/json'.", code: 'LOUSHO_UNSUPPORTED_MEDIA_TYPE' });
        return null;
      }
      const { sessionKey, input } = (JSON.parse(req.text || '{}') ?? {}) as Record<string, unknown>;
      if (typeof sessionKey !== 'string' || !sessionKey || (typeof input !== 'string' && !Array.isArray(input))) {
        throw new SyntaxError("Request body must be JSON with a 'sessionKey' string and an 'input' (a string or content parts)");
      }
      return { sessionKey, input: input as AgentInput, replyTo: null };
    },
    async reply({ sessionId, text, result, approval, approvals, respond }) {
      // A step paused on several calls lists all of them.
      respond?.(200, { sessionId, text, finishReason: result?.finishReason, approval, ...(approvals && { approvals }) });
    },
  });
}
