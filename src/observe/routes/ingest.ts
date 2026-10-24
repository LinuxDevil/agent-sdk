/**
 * `POST /api/v1/ingest` - the only write endpoint, and the contract a hosted
 * collector implements later. Validates the envelope (`400` names every bad
 * `batch[i]` path), enforces the ~5MB body cap (`413` via the bounded
 * `readBody`), then runs the whole batch - upserts plus rollup recompute - in
 * one transaction and acks `202` fast.
 */

import { OBSERVE_MAX_BODY_BYTES, parseIngestEnvelope } from '../envelope';
import { ingestBatch } from '../store';
import { sendJson, parseJsonBody, type Route } from './httpKit';

export const ingestRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/v1/ingest',
    handle: async (ctx) => {
      const body = await ctx.readBody(OBSERVE_MAX_BODY_BYTES);
      const parsed = parseIngestEnvelope(parseJsonBody(body));
      if (!parsed.ok) {
        return sendJson(ctx.res, 400, { error: `Invalid ingest envelope: ${parsed.issues.join('; ')}`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      const result = ingestBatch(ctx.db, parsed.envelope.batch);
      sendJson(ctx.res, 202, { received: result.received });
    },
  },
];
