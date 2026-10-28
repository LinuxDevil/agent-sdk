/**
 * Datasets (LangSmith "Datasets & Experiments", the data half): named sets
 * of `{ input, expected }` examples that evals run over.
 *
 * - `POST /api/v1/datasets` `{ name, description? }` -> `201 { dataset }`
 *   (a taken name is a 409).
 * - `GET /api/v1/datasets` -> `{ datasets, total, limit, offset }`, newest first.
 * - `GET /api/v1/datasets/:name` -> `{ dataset, examples, total, limit, offset }`,
 *   examples oldest first (eval case numbering follows this order).
 * - `POST /api/v1/datasets/:name/examples` `{ input, expected? }` or
 *   `{ from_trace_id }` (copies the trace root's input/output) -> `201 { example }`.
 * - `DELETE /api/v1/datasets/:name/examples/:id` -> `204`.
 *
 * Auth is the daemon's global API-token check; nothing per-route.
 */

import type * as http from 'node:http';
import { z } from 'zod';

import { addExample, createDataset, deleteExample, exampleFromTrace, getDataset, listDatasets, listExamples } from '../datasets';
import { badRequest, intParam, requireJsonBody, sendJson, type Route } from './httpKit';

const DATASET_BODY_LIMIT = 64 * 1024;
const EXAMPLE_BODY_LIMIT = 1024 * 1024;

/** URL-segment safe: the name is the `:name` of every dataset route. */
const DATASET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const createBody = z.object({
  name: z.string().regex(DATASET_NAME, 'must be 1-200 letters, digits, ".", "_" or "-", starting with a letter or digit'),
  description: z.string().max(10_000).optional(),
});

const exampleBody = z
  .object({
    input: z.unknown().optional(),
    expected: z.unknown().optional(),
    from_trace_id: z.string().min(1).optional(),
  })
  .refine((body) => (body.input === undefined) !== (body.from_trace_id === undefined), {
    message: 'give exactly one of input or from_trace_id',
  })
  .refine((body) => body.from_trace_id === undefined || body.expected === undefined, {
    message: 'expected is copied from the trace with from_trace_id',
  });

const notFound = (res: http.ServerResponse, error: string): void =>
  sendJson(res, 404, { error, code: 'LOUSHO_REQUEST_INVALID' });

export const datasetsRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/v1/datasets',
    handle: async ({ db, res, readBody }) => {
      const body = requireJsonBody(createBody, await readBody(DATASET_BODY_LIMIT), 'dataset');
      const dataset = createDataset(db, body.name, body.description);
      if (dataset === undefined) {
        return sendJson(res, 409, { error: `A dataset named '${body.name}' already exists.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      sendJson(res, 201, { dataset });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/datasets',
    handle: ({ db, res, query }) => {
      const limit = intParam(query, 'limit', 100, { min: 1, max: 1000 });
      const offset = intParam(query, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
      sendJson(res, 200, { ...listDatasets(db, limit, offset), limit, offset });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/datasets/:name',
    handle: ({ db, res, params, query }) => {
      const dataset = getDataset(db, params.name);
      if (dataset === undefined) return notFound(res, `No dataset '${params.name}'.`);
      const limit = intParam(query, 'limit', 1000, { min: 1, max: 10_000 });
      const offset = intParam(query, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
      sendJson(res, 200, { dataset, ...listExamples(db, dataset.dataset_id, limit, offset), limit, offset });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/datasets/:name/examples',
    handle: async ({ db, res, params, readBody }) => {
      const body = requireJsonBody(exampleBody, await readBody(EXAMPLE_BODY_LIMIT), 'dataset example');
      const dataset = getDataset(db, params.name);
      if (dataset === undefined) return notFound(res, `No dataset '${params.name}'.`);
      if (body.from_trace_id === undefined) {
        const expected = body.expected === undefined ? null : JSON.stringify(body.expected);
        const example = addExample(db, dataset.dataset_id, { input: JSON.stringify(body.input), expected, source_trace_id: null });
        return sendJson(res, 201, { example });
      }
      const copied = exampleFromTrace(db, body.from_trace_id);
      if (copied === 'no-trace') return notFound(res, `No trace '${body.from_trace_id}'.`);
      if (copied === 'no-input') {
        return badRequest(res, `Trace '${body.from_trace_id}' has no captured input (content capture was off).`);
      }
      const example = addExample(db, dataset.dataset_id, { ...copied, source_trace_id: body.from_trace_id });
      sendJson(res, 201, { example });
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/datasets/:name/examples/:id',
    handle: ({ db, res, params }) => {
      const dataset = getDataset(db, params.name);
      if (dataset === undefined) return notFound(res, `No dataset '${params.name}'.`);
      if (!deleteExample(db, dataset.dataset_id, params.id)) {
        return notFound(res, `No example '${params.id}' in dataset '${params.name}'.`);
      }
      res.writeHead(204);
      res.end();
    },
  },
];
