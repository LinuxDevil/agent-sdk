/**
 * `POST /api/v1/ingest` - the only write endpoint, and the contract a hosted
 * collector implements later. Validates the envelope (`400` names every bad
 * `batch[i]` path), enforces the ~5MB body cap (`413` via the bounded
 * `readBody`), then runs the whole batch - upserts plus rollup recompute - in
 * one transaction and acks `202` fast. The trace ids of roots the batch
 * ended go to the evaluator worker, which never fails or delays the ack.
 */

import { OBSERVE_MAX_BODY_BYTES, parseIngestEnvelope } from '../envelope';
import { rootsEndedIn, type EvaluatorWorker } from '../evaluatorWorker';
import type { IngestEvent } from '../envelope';
import { ingestBatch } from '../store';
import { sendJson, parseJsonBody, type Route } from './httpKit';

/** Hand the worker the batch's ended roots; a worker fault never reaches the response. */
function notifyEvaluators(worker: EvaluatorWorker, batch: readonly IngestEvent[]): void {
  try {
    worker.notifyRootsEnded(rootsEndedIn(batch));
  } catch {
    // online evaluation is best effort; ingest must stay infallible
  }
}

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
      notifyEvaluators(ctx.evaluators, parsed.envelope.batch);
      sendJson(ctx.res, 202, { received: result.received });
    },
  },
];
