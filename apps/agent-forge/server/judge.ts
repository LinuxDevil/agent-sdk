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
 *   jobs from `observeTarget()` for `leaseMs` (default 60 s; with
 *   `LOUSHO_OBSERVE_TOKEN` as the bearer when set), run them one at a time,
 *   post each result. Each judge call is capped at `judgeTimeoutMs` (default
 *   20 s) and at what is left of the lease; a job whose lease has run out
 *   locally is not run (it expires and requeues). Ticks never overlap. A daemon that is down or answers non-2xx only skips the tick,
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
import type { AgentSpec } from 'lousho';
import { evaluatorTraceFrom, type EvaluatorTrace, type ObservationRow } from 'lousho/traces';
import { buildAgentFromSpec } from './buildAgent';
import { daemonHeaders, observeTarget } from './observeProxy';
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

/**
 * Runs one judge rule on one trace; the default is {@link modelJudge}.
 * `signal` aborts when the call's time is up (the result is then a
 * `judge_error` whether or not the judge honours it).
 */
export type JudgeFn = (rule: JudgeRule, trace: EvaluatorTrace, signal: AbortSignal) => Promise<JudgeResult>;

export interface JudgeLoopOptions {
  secretsStore: SecretsStore;
  /** Pause between ticks; default 2000 ms. */
  intervalMs?: number;
  /** The lease asked for on each claim (`lease_ms`); default 60000 ms. */
  leaseMs?: number;
  /** Cap on one judge call (also cut to what is left of the job's lease); default 20000 ms. */
  judgeTimeoutMs?: number;
  /** The clock lease deadlines run on (tests); default `Date.now`. */
  now?: () => number;
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
const LEASE_MS_DEFAULT = 60_000;
const JUDGE_TIMEOUT_MS_DEFAULT = 20_000;
/** Time kept back from a lease to post the result before it runs out. */
const POST_MARGIN_MS = 1000;
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
  return async (rule, trace, signal) => {
    try {
      const spec: AgentSpec = { name: 'judge', prompt: '', provider: providerOf(rule.config.model) };
      const { provider } = buildAgentFromSpec(spec, 'judge', undefined, { secretsStore });
      const reply = await provider.generate({
        messages: [
          { role: 'system', content: GRADER_INSTRUCTION + rule.config.rubric },
          { role: 'user', content: judgePrompt(trace) },
        ],
        temperature: 0,
        signal,
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

/**
 * One judge call bounded by `timeoutMs` (its signal aborts then, and a judge
 * that ignores the signal is no longer waited for). Never throws: a throw or
 * the timeout becomes a `judge_error` result; never returns what the daemon
 * would 400.
 */
async function runJudge(judge: JudgeFn, rule: JudgeRule, trace: EvaluatorTrace, timeoutMs: number): Promise<JudgeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs} ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const run = Promise.resolve().then(() => judge(rule, trace, controller.signal));
  // A judge that settles after the timeout must not surface as an unhandled rejection.
  run.catch(() => undefined);
  try {
    return acceptable(await Promise.race([run, timedOut]));
  } catch (error) {
    return judgeError(error);
  } finally {
    clearTimeout(timer);
  }
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
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? LEASE_MS_DEFAULT;
  const judgeTimeoutMs = options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS_DEFAULT;
  let stopped = false;
  let down = false;
  let inFlight: Promise<void> | undefined;

  /** The first failure of an outage is logged; the rest stay quiet until a healthy answer. */
  const outage = (why: string): void => {
    if (down) return;
    down = true;
    warn(`[lousho studio] judge evaluators paused: the observe daemon at ${observeTarget()} ${why}; retrying.`);
  };

  /** A daemon answer: `true` when it was a 2xx. */
  const healthy = (response: globalThis.Response | undefined): response is globalThis.Response => {
    if (response?.ok) {
      down = false;
      return true;
    }
    outage(response === undefined ? 'is unreachable' : `answered HTTP ${response.status}`);
    return false;
  };

  /** The claimed jobs, or `undefined` (an outage) when the daemon did not answer with them. */
  const claim = async (): Promise<ClaimedJob[] | undefined> => {
    const claimed = await callDaemon(fetchFn, '/api/v1/evaluators/judge-jobs/claim', { max: CLAIM_MAX, lease_ms: leaseMs });
    if (claimed === undefined || !claimed.ok) {
      healthy(claimed);
      return undefined;
    }
    const body = (await claimed.json().catch(() => undefined)) as { jobs?: unknown } | undefined;
    if (!Array.isArray(body?.jobs)) {
      outage('answered a claim without a jobs array');
      return undefined;
    }
    down = false;
    return body.jobs as ClaimedJob[];
  };

  const runTick = async (): Promise<void> => {
    // Measured before the claim, so the local deadline never trails the daemon's.
    const deadline = now() + leaseMs;
    const jobs = await claim();
    for (const job of jobs ?? []) {
      // What is left of the lease after keeping time back to post; a job out of time is left to expire and requeue.
      const budget = deadline - now() - POST_MARGIN_MS;
      if (stopped || budget <= 0) return;
      const result = await runJudge(judge, job.rule, job.trace, Math.min(judgeTimeoutMs, budget));
      const posted = await callDaemon(fetchFn, `/api/v1/evaluators/judge-jobs/${encodeURIComponent(job.job_id)}/result`, result);
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
  /** Cap on the dry run's judge call; default 20000 ms. */
  judgeTimeoutMs?: number;
}

const UNREACHABLE = 'The observe daemon is unreachable - run `lousho observe start` to collect agent data.';

/** Answer with the daemon's response as it is (status, content type, body). */
async function passThrough(res: Response, upstream: globalThis.Response): Promise<void> {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

/** An id the daemon would read as something other than one plain path segment. */
const unsafeId = (id: string): boolean => id === '.' || id === '..' || /[/\\]/.test(id);

const invalid = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error, code: 'LOUSHO_REQUEST_INVALID' });
};

/** A judge already bounded by its timeout (see {@link runJudge}). */
type BoundJudge = (rule: JudgeRule, trace: EvaluatorTrace) => Promise<JudgeResult>;

/** The judge dry run: the trace from the daemon, built as the daemon builds it, then the judge. */
async function testJudgeRule(req: Request, res: Response, rule: JudgeRule, judge: BoundJudge, fetchFn: typeof fetch): Promise<void> {
  const traceId: unknown = (req.body as { trace_id?: unknown } | undefined)?.trace_id;
  if (typeof traceId !== 'string' || traceId === '' || unsafeId(traceId)) {
    return invalid(res, 400, 'Invalid evaluator test body: trace_id: must be a non-empty trace id.');
  }
  const detail = await callDaemon(fetchFn, `/api/v1/traces/${encodeURIComponent(traceId)}`);
  if (detail === undefined) return void res.status(502).json({ error: UNREACHABLE });
  if (!detail.ok) return passThrough(res, detail);
  const { observations } = (await detail.json()) as { observations: ObservationRow[] };
  const trace = evaluatorTraceFrom(traceId, observations);
  if (trace === undefined) return invalid(res, 404, `No trace '${traceId}' with a root observation.`);
  res.status(200).json({ result: await judge(rule, trace) });
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
  const judgeFn = options.judge ?? modelJudge(options.secretsStore);
  const timeoutMs = options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS_DEFAULT;
  const judge: BoundJudge = (rule, trace) => runJudge(judgeFn, rule, trace, timeoutMs);
  const fetchFn = options.fetch ?? fetch;
  app.post('/observe/api/v1/evaluators/:id/test', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (unsafeId(id)) return invalid(res, 400, 'Invalid evaluator rule id.');
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
