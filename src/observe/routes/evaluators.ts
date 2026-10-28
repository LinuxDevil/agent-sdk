/**
 * Online evaluator rules (LangSmith "online evaluators", the config half):
 * which traces to score and how (evaluatorWorker.ts runs them on new traces).
 *
 * - `GET /api/v1/evaluators?limit&offset&kind&enabled` ->
 *   `{ evaluators, total, limit, offset }`, oldest first (the runner's order).
 * - `POST /api/v1/evaluators` `{ name, kind, config, filter?, sample_rate?, enabled? }`
 *   -> `201 { evaluator }` (a taken name is a 409).
 * - `GET /api/v1/evaluators/:id` -> `{ evaluator }`.
 * - `PUT /api/v1/evaluators/:id` any subset of the create fields; the merged
 *   rule is validated as a whole -> `{ evaluator }`.
 * - `DELETE /api/v1/evaluators/:id` -> `204`.
 * - `POST /api/v1/evaluators/:id/test` `{ trace_id }` -> `{ result: { value, comment } }`:
 *   a dry run of the rule on one trace, ignoring `enabled`, `filter` and
 *   `sample_rate`; no score is written. A `judge` rule is a 409.
 *
 * - `POST /api/v1/evaluators/judge-jobs/claim` `{ max?: 1..20 (5), lease_ms?: 1000..300000 (60000) }`
 *   -> `{ jobs: [{ job_id, rule, trace }] }` (possibly empty): leases queued
 *   judge jobs to Agent Forge, which runs them with its provider keys
 *   (judgeJobs.ts). An expired lease requeues the job.
 * - `POST /api/v1/evaluators/judge-jobs/:job_id/result` `{ value: number in [0, 1] | null, comment?: string <= 1000 }`
 *   -> `201 { score_id }`, the `online` score; an unknown or expired job is a 404.
 *   These two sit before the `:id` routes so `judge-jobs` never reads as a rule id.
 *
 * Auth is the daemon's global API-token check; nothing per-route.
 */

import type * as http from 'node:http';
import { z } from 'zod';

import { SDKError } from '../../execution/errors';
import {
  createEvaluatorRule,
  deleteEvaluatorRule,
  getEvaluatorRule,
  listEvaluatorRules,
  updateEvaluatorRule,
  type EvaluatorRuleFields,
} from '../evaluators';
import { intParam, requireJsonBody, sendJson, type Route } from './httpKit';

const RULE_BODY_LIMIT = 128 * 1024;

const KINDS = ['code', 'judge'] as const;
// `{ message }` is the custom-error form zod 3 and zod 4 both accept.
const kindSchema = z.enum(KINDS, { message: `must be one of ${KINDS.map((k) => `'${k}'`).join(', ')}` });

const nonEmpty = z.string().min(1);

const filterSchema = z
  .object({ agent_id: nonEmpty.optional(), status: z.enum(['ok', 'error']).optional(), name_contains: nonEmpty.optional() })
  .strict();

const fieldShape = {
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  filter: filterSchema,
  sample_rate: z.number().finite().min(0).max(1),
  kind: kindSchema,
  config: z.unknown(),
};

const createBody = z
  .object({
    ...fieldShape,
    enabled: fieldShape.enabled.default(true),
    filter: filterSchema.default({}),
    sample_rate: fieldShape.sample_rate.default(1),
  })
  .strict();

const updateBody = z.object(fieldShape).partial().strict();

const testBody = z.object({ trace_id: nonEmpty }).strict();

const claimBody = z
  .object({
    max: z.number().int().min(1).max(20).default(5),
    lease_ms: z.number().int().min(1000).max(300_000).default(60_000),
  })
  .strict();

const resultBody = z
  .object({ value: z.number().finite().min(0).max(1).nullable(), comment: z.string().max(1000).optional() })
  .strict();

const JUDGE_BODY_LIMIT = 16 * 1024;

const configSchemas = {
  code: z.object({ source: z.string().min(1).max(65_536) }).strict(),
  judge: z.object({ model: z.string().min(1).max(200), rubric: z.string().min(1).max(20_000) }).strict(),
};

/** The rule as a whole, its `config` checked against its `kind`. */
function withConfig(rule: z.infer<typeof createBody>): EvaluatorRuleFields {
  const parsed = configSchemas[rule.kind].safeParse(rule.config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = ['config', ...(issue?.path ?? [])].join('.');
    throw new SDKError(
      `Invalid evaluator rule body: ${where}: ${issue?.message ?? 'bad shape'} (for kind '${rule.kind}').`,
      'LOUSHO_REQUEST_INVALID',
      { appendHelp: false }
    );
  }
  return { ...rule, config: parsed.data } as EvaluatorRuleFields;
}

const notFound = (res: http.ServerResponse, id: string): void =>
  sendJson(res, 404, { error: `No evaluator rule '${id}'.`, code: 'LOUSHO_REQUEST_INVALID' });

const nameTaken = (res: http.ServerResponse, name: string): void =>
  sendJson(res, 409, { error: `An evaluator rule named '${name}' already exists.`, code: 'LOUSHO_REQUEST_INVALID' });

/** The list's `kind`/`enabled` query filters; a bad value throws `LOUSHO_REQUEST_INVALID`. */
function listFilters(query: URLSearchParams): { kind?: 'code' | 'judge'; enabled?: boolean } {
  const kind = query.get('kind');
  const enabled = query.get('enabled');
  if (kind !== null && !kindSchema.safeParse(kind).success) {
    throw new SDKError(`Invalid evaluator list query: kind must be one of 'code', 'judge'.`, 'LOUSHO_REQUEST_INVALID', {
      appendHelp: false,
    });
  }
  if (enabled !== null && enabled !== 'true' && enabled !== 'false') {
    throw new SDKError(`Invalid evaluator list query: enabled must be 'true' or 'false'.`, 'LOUSHO_REQUEST_INVALID', {
      appendHelp: false,
    });
  }
  return {
    kind: kind === null ? undefined : (kind as 'code' | 'judge'),
    enabled: enabled === null ? undefined : enabled === 'true',
  };
}

/** Judge-job routes; listed before the `:id` routes. */
const judgeJobRoutes: readonly Route[] = [
  {
    method: 'POST',
    path: '/api/v1/evaluators/judge-jobs/claim',
    handle: async ({ res, readBody, evaluators }) => {
      const text = await readBody(JUDGE_BODY_LIMIT);
      const { max, lease_ms } = requireJsonBody(claimBody, text.trim() === '' ? '{}' : text, 'judge-job claim');
      sendJson(res, 200, { jobs: evaluators.claimJudgeJobs(max, lease_ms) });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/evaluators/judge-jobs/:job_id/result',
    handle: async ({ res, params, readBody, evaluators }) => {
      const { value, comment } = requireJsonBody(resultBody, await readBody(JUDGE_BODY_LIMIT), 'judge-job result');
      const score_id = evaluators.completeJudgeJob(params.job_id, { value, comment: comment ?? null });
      if (score_id === undefined) {
        return sendJson(res, 404, { error: `No leased judge job '${params.job_id}' (unknown, or its lease expired).`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      sendJson(res, 201, { score_id });
    },
  },
];

export const evaluatorsRoutes: readonly Route[] = [
  ...judgeJobRoutes,
  {
    method: 'GET',
    path: '/api/v1/evaluators',
    handle: ({ db, res, query }) => {
      const limit = intParam(query, 'limit', 100, { min: 1, max: 1000 });
      const offset = intParam(query, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
      sendJson(res, 200, { ...listEvaluatorRules(db, { limit, offset, ...listFilters(query) }), limit, offset });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/evaluators',
    handle: async ({ db, res, readBody }) => {
      const fields = withConfig(requireJsonBody(createBody, await readBody(RULE_BODY_LIMIT), 'evaluator rule'));
      const evaluator = createEvaluatorRule(db, fields);
      if (evaluator === undefined) return nameTaken(res, fields.name);
      sendJson(res, 201, { evaluator });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/evaluators/:id',
    handle: ({ db, res, params }) => {
      const evaluator = getEvaluatorRule(db, params.id);
      if (evaluator === undefined) return notFound(res, params.id);
      sendJson(res, 200, { evaluator });
    },
  },
  {
    method: 'PUT',
    path: '/api/v1/evaluators/:id',
    handle: async ({ db, res, params, readBody }) => {
      const patch = requireJsonBody(updateBody, await readBody(RULE_BODY_LIMIT), 'evaluator rule');
      const current = getEvaluatorRule(db, params.id);
      if (current === undefined) return notFound(res, params.id);
      const { name, enabled, filter, sample_rate, kind, config } = current;
      const fields = withConfig({ name, enabled, filter, sample_rate, kind, config, ...patch });
      const updated = updateEvaluatorRule(db, params.id, fields);
      if (updated === 'missing') return notFound(res, params.id);
      if (updated === 'name-taken') return nameTaken(res, fields.name);
      sendJson(res, 200, { evaluator: updated });
    },
  },
  {
    method: 'POST',
    path: '/api/v1/evaluators/:id/test',
    handle: async ({ db, res, params, readBody, evaluators }) => {
      const { trace_id } = requireJsonBody(testBody, await readBody(RULE_BODY_LIMIT), 'evaluator test');
      const rule = getEvaluatorRule(db, params.id);
      if (rule === undefined) return notFound(res, params.id);
      if (rule.kind === 'judge') {
        return sendJson(res, 409, { error: 'judge evaluators run through Agent Forge', code: 'LOUSHO_REQUEST_INVALID' });
      }
      const result = await evaluators.runOnce(rule, trace_id);
      if (result === undefined) {
        return sendJson(res, 404, { error: `No trace '${trace_id}' with a root observation.`, code: 'LOUSHO_REQUEST_INVALID' });
      }
      sendJson(res, 200, { result });
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/evaluators/:id',
    handle: ({ db, res, params }) => {
      if (!deleteEvaluatorRule(db, params.id)) return notFound(res, params.id);
      res.writeHead(204);
      res.end();
    },
  },
];
