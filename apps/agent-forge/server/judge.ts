/**
 * LLM-judge online evaluators, the Studio half. The observe daemon holds no
 * provider keys, so it queues a job per (judge rule, trace) and this server
 * pulls them (`POST /api/v1/evaluators/judge-jobs/claim`), runs each with
 * the keys it already has (secretsStore.ts: a stored key beats the env var),
 * and posts the score back (`POST .../judge-jobs/:job_id/result`). Judges
 * therefore run only while Studio is up; until then the jobs wait in the
 * daemon's bounded queue (500), and a job whose lease runs out is requeued.
 *
 * - {@link startJudgeLoop}: every `intervalMs` (default 2000) claim up to 5
 *   jobs from `observeTarget()` (with `LOUSHO_OBSERVE_TOKEN` as the bearer
 *   when set), run them one at a time, post each result. Ticks never
 *   overlap. A daemon that is down or answers non-2xx only skips the tick,
 *   logged once per outage.
 * - The judge itself ({@link modelJudge}) is one `provider.generate()` call,
 *   with the provider resolved exactly as the playground resolves it
 *   (`buildAgentFromSpec`). It goes straight to the provider, not through
 *   AgentExecutor, so it makes no spans and reports nothing to the daemon: a
 *   judge trace would itself trigger evaluators.
 * - {@link registerJudgeTestRoute}: `POST /observe/api/v1/evaluators/:id/test`
 *   handled here (the daemon answers 409 for a judge rule): a judge rule is
 *   dry-run on the trace with the same judge; a code rule is forwarded to the
 *   daemon unchanged.
 */
import type { Express, Request, Response } from 'express';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { evaluatorTraceFrom, type EvaluatorTrace, type ObservationRow } from '@lousho/build-ai-agent/traces';
import { buildAgentFromSpec } from './buildAgent';
import { observeTarget } from './observeProxy';
import { providerOf } from './playground';
import type { SecretsStore } from './secretsStore';

/** A judge rule as the daemon serves it (`EvaluatorRuleRow` with `kind: 'judge'`). */
export interface JudgeRule {
  rule_id: string;
  name: string;
  kind: 'judge';
  config: { model: string; rubric: string };
}

/** What a judge run produced: the score's value in [0, 1] (or null) and its comment. */
export interface JudgeResult {
  value: number | null;
  comment: string | null;
}

/** Runs one judge rule on one trace; the default is {@link modelJudge}. */
export type JudgeFn = (rule: JudgeRule, trace: EvaluatorTrace) => Promise<JudgeResult>;

export interface JudgeLoopOptions {
  secretsStore: SecretsStore;
  /** The project dir; the default judge makes no reporter, so nothing is written under it. */
  baseDir: string;
  /** Pause between ticks; default 2000 ms. */
  intervalMs?: number;
  /** The fetch daemon calls go through (tests). */
  fetch?: typeof fetch;
  /** The judge; default {@link modelJudge} over `secretsStore`. */
  judge?: JudgeFn;
  /** Where the once-per-outage note goes; default `console.warn`. */
  warn?: (message: string) => void;
}

export interface JudgeLoop {
  stop(): void;
  /** Run one tick now, or wait for the one in flight (tests). */
  tick(): Promise<void>;
}

const CLAIM_MAX = 5;
const DAEMON_TIMEOUT_MS = 8000;
const FIELD_LIMIT = 8 * 1024;
const MAX_COMMENT = 1000;
const MAX_ERROR = 200;
const INVALID_OUTPUT: JudgeResult = { value: null, comment: 'invalid_judge_output' };

const GRADER_INSTRUCTION =
  'You are an evaluator grading one run of an AI agent against a rubric. Read the rubric and the run, then reply with ' +
  'only a JSON object: {"score": <a number from 0 to 1, where 1 fully meets the rubric>, "comment": "<one short reason>"}.\n\nRubric:\n';

const clip = (text: string | null): string =>
  text === null ? '(none)' : text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}... [truncated]` : text;

/** The user message a judge sees: the trace's name, status, input, output and error. */
export function judgePrompt(trace: EvaluatorTrace): string {
  return [
    `Name: ${clip(trace.name)}`,
    `Status: ${clip(trace.status)}`,
    `Input:\n${clip(trace.input)}`,
    `Output:\n${clip(trace.output)}`,
    `Error:\n${clip(trace.error_message)}`,
  ].join('\n\n');
}

/** How many `{` (and, per `{`, how many `}`) the reply scan tries before it gives up on a long prose reply. */
const MAX_BRACES = 50;

/** A JSON object, or `undefined` when `slice` is not one. */
function objectOf(slice: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(slice);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Indexes of `char` in `text` from `from` on, at most {@link MAX_BRACES}. */
function indexesOf(text: string, char: string, from = 0): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(char, from); i !== -1 && found.length < MAX_BRACES; i = text.indexOf(char, i + 1)) found.push(i);
  return found;
}

/**
 * The first JSON object in `text`: from the earliest `{`, the shortest
 * `{...}` that parses (so braces inside strings or prose are tolerated).
 */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (const start of indexesOf(text, '{')) {
    for (const end of indexesOf(text, '}', start)) {
      const object = objectOf(text.slice(start, end + 1));
      if (object !== undefined) return object;
    }
  }
  return undefined;
}

/**
 * A judge model's reply as a result: the first JSON object in it, which must
 * carry a `score` in [0, 1] (`comment` optional). Anything else is
 * `{ value: null, comment: 'invalid_judge_output' }`.
 */
export function parseJudgeReply(text: string): JudgeResult {
  const reply = firstJsonObject(text);
  const score = reply?.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return INVALID_OUTPUT;
  const comment = reply?.comment;
  return { value: score, comment: typeof comment === 'string' ? comment.slice(0, MAX_COMMENT) : null };
}

const judgeError = (error: unknown): JudgeResult => ({
  value: null,
  comment: `judge_error: ${(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR)}`,
});

/** The real judge: one model call with the rule's `provider/model`, resolved like the playground's. */
function modelJudge(secretsStore: SecretsStore): JudgeFn {
  return async (rule, trace) => {
    try {
      const spec: AgentSpec = { name: 'judge', prompt: '', provider: providerOf(rule.config.model) };
      const { provider } = buildAgentFromSpec(spec, 'judge', undefined, { secretsStore });
      const reply = await provider.generate({
        messages: [
          { role: 'system', content: GRADER_INSTRUCTION + rule.config.rubric },
          { role: 'user', content: judgePrompt(trace) },
        ],
        temperature: 0,
      });
      return parseJudgeReply(reply.text);
    } catch (error) {
      // Unknown provider, missing key, or the call failed.
      return judgeError(error);
    }
  };
}

/** A result the daemon accepts: a value in [0, 1] or null, a comment of at most 1000 chars. */
function acceptable(result: JudgeResult): JudgeResult {
  const { value, comment } = result;
  if (value !== null && !(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return INVALID_OUTPUT;
  return { value, comment: typeof comment === 'string' ? comment.slice(0, MAX_COMMENT) : null };
}

/** `judge` never throws (a throw becomes a `judge_error` result) and never returns what the daemon would 400. */
async function runJudge(judge: JudgeFn, rule: JudgeRule, trace: EvaluatorTrace): Promise<JudgeResult> {
  try {
    return acceptable(await judge(rule, trace));
  } catch (error) {
    return judgeError(error);
  }
}

/** Headers for a server-side daemon call: JSON, plus the bearer `LOUSHO_OBSERVE_TOKEN` names. */
function daemonHeaders(): Record<string, string> {
  const token = process.env.LOUSHO_OBSERVE_TOKEN;
  return { accept: 'application/json', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

/** POST/GET the daemon at `path`; the response, or `undefined` when it is unreachable. */
async function callDaemon(fetchFn: typeof fetch, path: string, body?: unknown): Promise<globalThis.Response | undefined> {
  try {
    return await fetchFn(`${observeTarget()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: daemonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

interface ClaimedJob {
  job_id: string;
  rule: JudgeRule;
  trace: EvaluatorTrace;
}

/** Start pulling judge jobs from the daemon; `stop()` on server close. */
export function startJudgeLoop(options: JudgeLoopOptions): JudgeLoop {
  const fetchFn = options.fetch ?? fetch;
  const judge = options.judge ?? modelJudge(options.secretsStore);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let stopped = false;
  let down = false;
  let inFlight: Promise<void> | undefined;

  /** A daemon answer: `true` when it was a 2xx; the first failure of an outage is logged. */
  const healthy = (response: globalThis.Response | undefined): response is globalThis.Response => {
    if (response?.ok) {
      down = false;
      return true;
    }
    if (!down) {
      down = true;
      const why = response === undefined ? 'unreachable' : `HTTP ${response.status}`;
      warn(`[lousho studio] judge evaluators paused: the observe daemon at ${observeTarget()} is ${why}; retrying.`);
    }
    return false;
  };

  const runTick = async (): Promise<void> => {
    const claimed = await callDaemon(fetchFn, '/api/v1/evaluators/judge-jobs/claim', { max: CLAIM_MAX });
    if (!healthy(claimed)) return;
    const { jobs } = (await claimed.json()) as { jobs: ClaimedJob[] };
    for (const job of jobs) {
      if (stopped) return;
      const result = await runJudge(judge, job.rule, job.trace);
      const body = { value: result.value, ...(result.comment === null ? {} : { comment: result.comment }) };
      const posted = await callDaemon(fetchFn, `/api/v1/evaluators/judge-jobs/${encodeURIComponent(job.job_id)}/result`, body);
      // A 404 is a lease that ran out (the job was requeued): not an outage.
      if (posted?.status !== 404 && !healthy(posted)) return;
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= runTick()
      .catch((error: unknown) => warn(`[lousho studio] judge tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => (inFlight = undefined));
    return inFlight;
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? 2000);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

export interface JudgeTestRouteOptions {
  secretsStore: SecretsStore;
  /** The judge; default {@link modelJudge} over `secretsStore`. */
  judge?: JudgeFn;
  /** The fetch daemon calls go through (tests). */
  fetch?: typeof fetch;
}

const UNREACHABLE = 'The observe daemon is unreachable - run `lousho observe start` to collect agent data.';

/** Answer with the daemon's response as it is (status, content type, body). */
async function passThrough(res: Response, upstream: globalThis.Response): Promise<void> {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

const invalid = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error, code: 'LOUSHO_REQUEST_INVALID' });
};

/** The judge dry run: the trace from the daemon, built as the daemon builds it, then the judge. */
async function testJudgeRule(req: Request, res: Response, rule: JudgeRule, judge: JudgeFn, fetchFn: typeof fetch): Promise<void> {
  const traceId: unknown = (req.body as { trace_id?: unknown } | undefined)?.trace_id;
  if (typeof traceId !== 'string' || traceId === '') {
    return invalid(res, 400, 'Invalid evaluator test body: trace_id: must be a non-empty string.');
  }
  const detail = await callDaemon(fetchFn, `/api/v1/traces/${encodeURIComponent(traceId)}`);
  if (detail === undefined) return void res.status(502).json({ error: UNREACHABLE });
  if (!detail.ok) return passThrough(res, detail);
  const { observations } = (await detail.json()) as { observations: ObservationRow[] };
  const trace = evaluatorTraceFrom(traceId, observations);
  if (trace === undefined) return invalid(res, 404, `No trace '${traceId}' with a root observation.`);
  res.status(200).json({ result: await runJudge(judge, rule, trace) });
}

/**
 * `POST /observe/api/v1/evaluators/:id/test` `{ trace_id }`, registered
 * before the observe proxy (and behind the Studio's API auth like every
 * `/observe` path). The rule comes from the daemon: a `judge` rule runs here
 * as a dry run (`200 { result: { value, comment } }`, no score written); any
 * other rule is forwarded to the daemon's own `/test` unchanged. The
 * daemon's 404s (unknown rule or trace) pass through; a daemon that is down
 * is a 502.
 */
export function registerJudgeTestRoute(app: Express, options: JudgeTestRouteOptions): void {
  const judge = options.judge ?? modelJudge(options.secretsStore);
  const fetchFn = options.fetch ?? fetch;
  app.post('/observe/api/v1/evaluators/:id/test', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (id === '.' || id === '..') return invalid(res, 400, 'Invalid evaluator rule id.');
      const rulePath = `/api/v1/evaluators/${encodeURIComponent(id)}`;
      const found = await callDaemon(fetchFn, rulePath);
      if (found === undefined) return void res.status(502).json({ error: UNREACHABLE });
      if (!found.ok) return passThrough(res, found);
      const { evaluator } = (await found.json()) as { evaluator: JudgeRule | { kind: string } };
      if (evaluator.kind === 'judge') return testJudgeRule(req, res, evaluator as JudgeRule, judge, fetchFn);
      const forwarded = await callDaemon(fetchFn, `${rulePath}/test`, req.body ?? {});
      if (forwarded === undefined) return void res.status(502).json({ error: UNREACHABLE });
      return passThrough(res, forwarded);
    } catch (error) {
      next(error);
    }
  });
}
