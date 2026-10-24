/**
 * The observe daemon's wire shapes, mirrored from `src/observe/store.ts`'s
 * read models (TraceRow, ObservationRow, ScoreRow, AgentRow, AgentInsights,
 * RollupRow). Kept as local declarations rather than importing the SDK's
 * internals: the panels' contract is the daemon's HTTP JSON, not its TS
 * modules - the same contract a hosted collector implements later.
 */

/** `GET /health` - the `service` marker is how the panels tell "the daemon" apart from whatever else grabbed the port. */
export interface ObserveHealth {
  service: string;
  ok: boolean;
  version?: string;
}

/** One row of `GET /api/v1/traces`: an aggregated trace header (status comes from the root observation). */
export interface ObserveTraceRow {
  trace_id: string;
  name: string | null;
  agent_id: string | null;
  session_id: string | null;
  start: number;
  end: number;
  status: string;
  observations: number;
  generations: number;
  tools: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** The agent's registered name, or null. */
  agent_name: string | null;
  /** The first generation's model (by start), or null. */
  model: string | null;
  /** The first failed observation's error text, or null. */
  error_message: string | null;
  /** The root observation's input, first 200 chars. */
  input_preview: string | null;
  /** The root observation's output, first 200 chars. */
  output_preview: string | null;
}

export interface ObserveTraceList {
  traces: ObserveTraceRow[];
  total: number;
  limit: number;
  offset: number;
}

/** One row of `GET /api/v1/sessions`: a conversation thread with its run totals (`traces` = turns). */
export interface ObserveSessionRow {
  session_id: string;
  agent_id: string | null;
  /** The agent's registered name, or null. */
  agent_name: string | null;
  /** `active` until the agent's crash sweep marks it `interrupted`. */
  status: string;
  started_at: number;
  /** The latest observation end seen in the session, or null while nothing has finished. */
  ended_at: number | null;
  /** Distinct traces (turns) in the session. */
  traces: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** The latest turn's root input, first 200 chars. */
  last_input_preview: string | null;
}

export interface ObserveSessionList {
  sessions: ObserveSessionRow[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /api/v1/sessions/:id`: the thread and its traces, oldest first (capped at 500). */
export interface ObserveSessionDetail {
  session: ObserveSessionRow;
  traces: ObserveTraceRow[];
}

/** One flat observation row of `GET /api/v1/traces/:id` - the client nests them by `parent_obs_id`. */
export interface ObserveObservationRow {
  obs_id: string;
  trace_id: string;
  session_id: string | null;
  agent_id: string | null;
  parent_obs_id: string | null;
  kind: string;
  name: string | null;
  start: number;
  end: number | null;
  status: string | null;
  input: string | null;
  output: string | null;
  model: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cached_tokens: number | null;
  usage_reasoning_tokens: number | null;
  cost_usd: number | null;
  cost_partial: boolean | null;
  usage_estimated: boolean | null;
  truncated: boolean;
  attrs: Record<string, unknown> | null;
}

export interface ObserveScoreRow {
  score_id: string;
  trace_id: string;
  obs_id: string | null;
  name: string;
  value: number | null;
  source: string;
  comment: string | null;
  agent_id: string | null;
  created_at: number;
}

/** One row of `GET /api/v1/scores?aggregate=eval`: every score whose name is `<eval>` or `<eval>/*`, folded. */
export interface ObserveScorePassRate {
  /** The eval name (the score-name prefix before the first '/'). */
  name: string;
  /** Score rows in the group (the eval-level row of each case plus its per-check rows). */
  count: number;
  /** Rows that passed: no failure comment, or a perfect 1. */
  passed: number;
  /** `passed / count`. */
  pass_rate: number;
  /** Mean value over the group's non-null values; null when every value is null. */
  avg_value: number | null;
  /** Newest row's `created_at`. */
  last_ts: number;
}

export interface ObserveTraceDetail {
  trace_id: string;
  observations: ObserveObservationRow[];
  scores: ObserveScoreRow[];
}

/** `GET /api/v1/agents` row - `status`/`heartbeat_age_ms` are the daemon's read-time freshness derivation. */
export interface ObserveAgentRow {
  agent_id: string;
  project: string | null;
  name: string | null;
  version: string | null;
  first_seen: number;
  last_heartbeat: number | null;
  status: string;
  heartbeat_age_ms: number | null;
  heartbeat_interval_ms: number | null;
  hostname: string | null;
  pid: number | null;
  /** Cumulative telemetry events the agent's reporter dropped (latest heartbeat); `null` from an older SDK. */
  dropped: number | null;
  /** Root runs in today's UTC day rollup bucket. */
  runs_today: number;
  /** Errors / runs in today's UTC day bucket (0 with no runs). */
  error_rate_today: number;
}

export interface ObserveAgentInsights {
  agent_id: string;
  project: string | null;
  name: string | null;
  runs: number;
  runs_per_day: number;
  errors: number;
  error_rate: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
}

export interface ObserveRollupRow {
  bucket_start: number;
  granularity: string;
  agent_id: string;
  metric: string;
  value: number;
}

/** `GET /api/v1/insights`. */
export interface ObserveInsights {
  window: { since: number; until: number };
  agents: ObserveAgentInsights[];
  series: ObserveRollupRow[];
}

/** One version of a registry prompt (`GET /api/v1/prompts/:name` rows; `labels` = the labels pointing at it, sorted). */
export interface ObservePromptVersion {
  prompt_id: string;
  name: string;
  version: number;
  labels: string[];
  variables: unknown;
  hash: string | null;
  text: string | null;
  created_at: number;
  /** Observations linked (`prompt_use`) to this version. */
  uses: number;
}

/** One row of `GET /api/v1/prompts`: the latest version of a name, with its version count and run uses across versions. */
export interface ObservePromptRow extends ObservePromptVersion {
  versions: number;
}

/** `GET /api/v1/prompts/:name`: the version history, newest first, text included. */
export interface ObservePromptHistory {
  name: string;
  versions: ObservePromptVersion[];
}

/** `PUT /api/v1/prompts/:name/labels/:label` answer: where the label points now and where it pointed before (null = new label). */
export interface ObservePromptLabelMove {
  name: string;
  label: string;
  version: number;
  previous_version: number | null;
}
