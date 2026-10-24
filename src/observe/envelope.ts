/**
 * The ingest envelope: the one contract between reporters (any process that
 * emits agent telemetry) and the collector daemon, and the shape a hosted
 * collector implements later (see docs/specs/0001-observability-platform).
 *
 * `POST /api/v1/ingest` takes `{ batch: [{ type, data }] }`. Every event type
 * the platform knows is declared here once - reporter and daemon share these
 * schemas as the single source of truth, so a field rename cannot silently
 * drift between emit and store.
 *
 * The event types cover later children too (`score` for evaluators,
 * `prompt_use` for the prompt registry, `agent.heartbeat`/`agent.deregister`
 * for monitoring): the data plane accepts and stores them all even where its
 * own read surface does not serve them yet.
 */

import { z } from 'zod';
import { issueMessage, issuePath } from '../utils/zodCompat';

/** The daemon's default port; `LOUSHO_OBSERVE=1` points reporters at it. */
export const OBSERVE_DEFAULT_PORT = 7777;

/** The `service` value `GET /health` answers; `lousho observe start` probes it to tell "already running" from a real port collision. */
export const OBSERVE_SERVICE = 'lousho-observe';

/** Request bodies larger than this get a `413`; a reporter counts the batch into `dropped`. */
export const OBSERVE_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** `input`/`output` strings longer than this are cut and the row's `truncated` flag set (the flag must survive: Studio shows it). */
export const OBSERVE_TRUNCATE_CHARS = 64 * 1024;

/** One ingest call carries at most this many events; bounds the write transaction's size. */
export const OBSERVE_MAX_BATCH_EVENTS = 1000;

/** The `kind` values of an observation row (the wide table's one discriminator). */
const OBSERVATION_KINDS = ['span', 'generation', 'tool', 'event'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** A score's origin: an eval assertion, an llmJudge verdict, or human feedback. */
export const SCORE_SOURCES = ['eval', 'judge', 'human'] as const;

/** `agent.heartbeat` - one row of the fleet registry, refreshed on the reporter's interval. */
const agentHeartbeatData = z.object({
  agent_id: z.string().min(1),
  project: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  /** Milliseconds since the epoch; the daemon fills in receive time when absent. */
  ts: z.number().optional(),
  /** The reporter's heartbeat cadence, so monitoring can derive freshness without guessing. */
  heartbeat_interval_ms: z.number().optional(),
  hostname: z.string().optional(),
  pid: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
/** `agent.deregister` - a graceful exit; the registry row flips to `stopped` instead of aging into `down`. */
const agentDeregisterData = z.object({
  agent_id: z.string().min(1),
  ts: z.number().optional(),
  reason: z.string().optional(),
});
/**
 * `observation` - one finished span (`obs_id` is the SDK's `TraceLine.id`, so a
 * resent batch upserts by key and `updated_at` gives last-writer-wins). The
 * `usage_*`/`cost_*` fields carry `StepUsage` verbatim; the daemon stores them
 * and never recomputes - `cost_partial` and `usage_estimated` must reach
 * Studio untouched or cost numbers lie.
 */
const observationData = z.object({
  obs_id: z.string().min(1),
  trace_id: z.string().min(1),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  parent_obs_id: z.string().optional(),
  kind: z.enum(OBSERVATION_KINDS),
  name: z.string().optional(),
  /** Milliseconds since the epoch. */
  start: z.number(),
  end: z.number().optional(),
  status: z.enum(['ok', 'error']).optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  model: z.string().optional(),
  usage_input_tokens: z.number().nonnegative().optional(),
  usage_output_tokens: z.number().nonnegative().optional(),
  usage_cached_tokens: z.number().nonnegative().optional(),
  usage_reasoning_tokens: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  cost_partial: z.boolean().optional(),
  usage_estimated: z.boolean().optional(),
  truncated: z.boolean().optional(),
  /** The span's full attribute map (`gen_ai.*` names), kept verbatim as JSON. */
  attrs: z.record(z.string(), z.unknown()).optional(),
});
export type ObservationData = z.infer<typeof observationData>;

/** `prompt_use` - links a run's observation to the registry prompt version it ran with. */
export interface PromptUseData {
  obs_id: string;
  prompt_id: string;
  version?: number;
}
// Explicit annotation: the DTS rollup emits this const next to the public
// type, and zod 3's expanded ZodObject generics are not valid under zod 4.
const promptUseData: z.ZodType<PromptUseData> = z.object({
  obs_id: z.string().min(1),
  prompt_id: z.string().min(1),
  version: z.number().int().optional(),
});

/** `score` - one eval/judge/human verdict attached to a trace (and optionally one observation in it). */
const scoreData = z.object({
  score_id: z.string().min(1),
  trace_id: z.string().min(1),
  obs_id: z.string().optional(),
  name: z.string().min(1),
  value: z.number().optional(),
  source: z.enum(SCORE_SOURCES),
  comment: z.string().optional(),
  /** Which agent the score is about; the emitting eval harness may differ from the scored agent. */
  agent_id: z.string().optional(),
  ts: z.number().optional(),
});
/** One event of the batch. The `type` discriminator decides which `data` schema applies. */
const ingestEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent.heartbeat'), data: agentHeartbeatData }),
  z.object({ type: z.literal('agent.deregister'), data: agentDeregisterData }),
  z.object({ type: z.literal('observation'), data: observationData }),
  z.object({ type: z.literal('prompt_use'), data: promptUseData }),
  z.object({ type: z.literal('score'), data: scoreData }),
]);
export type IngestEvent = z.infer<typeof ingestEvent>;

/** The request body of `POST /api/v1/ingest`. */
const ingestEnvelope = z.object({
  batch: z.array(ingestEvent).max(OBSERVE_MAX_BATCH_EVENTS),
});
export type IngestEnvelope = z.infer<typeof ingestEnvelope>;

export type EnvelopeParseResult = { ok: true; envelope: IngestEnvelope } | { ok: false; issues: string[] };

/**
 * Validates a decoded JSON body against the envelope. Returns issues rather
 * than throwing: the daemon turns them into a `400` whose message names every
 * offending `batch[i]` path (a reporter bug must be debuggable from the
 * response alone).
 */
export function parseIngestEnvelope(value: unknown): EnvelopeParseResult {
  const parsed = ingestEnvelope.safeParse(value);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  const issues = parsed.error.issues.map((issue) => `${issuePath(issue)}: ${issueMessage(issue)}`);
  return { ok: false, issues };
}
