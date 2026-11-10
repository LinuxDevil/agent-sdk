import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from '../execution/errors';

/** Self-healing settings for one agent directory, from improve.json, the environment and flags. */
export interface ImproveSettings {
  /** `false` stops the self-healing loop for this directory, like the stop file. */
  enabled: boolean;
  /** `auto` (default) applies a proposal that passed the gate and the canary; `manual` queues it for a person. */
  approval: 'auto' | 'manual';
  /** Spend and rate caps. */
  budget: {
    /** Tokens one cycle may spend; unset means only the daily cap applies. */
    maxTokensPerCycle?: number;
    /** Tokens all cycles may spend in a UTC day (default 2,000,000). */
    maxTokensPerDay: number;
    /** Cycles per UTC day (default 4). */
    maxCyclesPerDay: number;
    /** Automatic applies per UTC day (default 1); manual approvals are not capped. */
    maxAppliesPerDay: number;
  };
  /** When a cycle starts. */
  trigger: {
    /** New failed runs since the last cycle that start one (default 3). */
    minNewFailures: number;
    /** Only failure groups that recur become cases (default `true` in auto mode, `false` in manual). */
    requireRecurring: boolean;
  };
  /** Checks after the gate and before an apply. */
  canary: {
    /** Fresh runs per case in the replay canary (default 6). */
    replayRuns: number;
    /** The opt-in live traffic canary; off when unset. */
    traffic?: {
      /** The share of new sessions that run the candidate, at most 0.25. */
      share: number;
      /** Sessions before a verdict, at most 50. */
      sessions: number;
    };
  };
  /** The post-apply monitor. */
  monitor: {
    /** Runs under a new revision before it is judged (default 20). */
    minRuns: number;
    /** Runs compared before and after (default 20). */
    window: number;
    /** The pass-rate drop that counts as a regression (default 0.05). */
    maxDrop: number;
    /** Roll back on a regression (default `true`, in both modes). */
    autoRollback: boolean;
    /** Days without enough runs before a revision is kept unverified (default 7). */
    giveUpDays: number;
  };
  /** The corpus guard. */
  guard: {
    /** Runs per corpus case (default 3). */
    runs: number;
    /** Hours between scheduled guard runs (default 24). */
    everyHours: number;
    /** The most cases the corpus keeps (default 30). */
    maxCases: number;
  };
  /** Hours without cycles after a rollback (default 24). */
  cooldownHours: number;
  /** The watcher's limit on editor and reflection model calls. */
  rateLimit: {
    /** Model calls per minute (default 20). */
    rpm: number;
  };
  /** The lesson library editors read. */
  library: {
    /** Use the library (default `true`). */
    enabled: boolean;
    /** Share entries with other agents that set the same domain; per agent when unset. */
    domain?: string;
  };
  /** The Harness² editor options each cycle passes to `improveAgent()`. */
  editors: {
    /** k invariant and k domain editors, or k rounds in `seq` mode (default 1, at most 4). */
    proposers: number;
    /** `agg` (default) proposes side by side; `seq` runs rounds that build on each other. */
    mode: 'agg' | 'seq';
    /** Gate every candidate and let the advisory selector choose among those that pass (default `false`). */
    select: boolean;
    /** Run the editors and their probes two at a time (default `true`). */
    parallel: boolean;
  };
}

/** Flags and options that win over improve.json and the environment. */
export interface ImproveSettingsOverrides {
  /** The approval mode, from `--approval`. */
  approval?: ImproveSettings['approval'];
  /** Editor options, from `--proposers`, `--mode`, `--select` and `--no-parallel-editors`. */
  editors?: Partial<ImproveSettings['editors']>;
}

const count = z.number().int().positive();
const share = z.number().gt(0).max(0.25);
const MAX_PROPOSERS = 4;
const proposers = count.max(MAX_PROPOSERS);
const editorMode = z.enum(['agg', 'seq']);

const fileSchema = z
  .object({
    $schema: z.string().optional(),
    enabled: z.boolean().optional(),
    approval: z.enum(['auto', 'manual']).optional(),
    budget: z.object({ maxTokensPerCycle: count.optional(), maxTokensPerDay: count.optional(), maxCyclesPerDay: count.optional(), maxAppliesPerDay: count.optional() }).strict().optional(),
    trigger: z.object({ minNewFailures: count.optional(), requireRecurring: z.boolean().optional() }).strict().optional(),
    canary: z
      .object({ replayRuns: count.optional(), traffic: z.object({ share, sessions: count.max(50) }).strict().optional() })
      .strict()
      .optional(),
    monitor: z
      .object({ minRuns: count.optional(), window: count.optional(), maxDrop: z.number().min(0).max(1).optional(), autoRollback: z.boolean().optional(), giveUpDays: count.optional() })
      .strict()
      .optional(),
    guard: z.object({ runs: count.optional(), everyHours: z.number().positive().finite().optional(), maxCases: count.optional() }).strict().optional(),
    cooldownHours: z.number().min(0).finite().optional(),
    rateLimit: z.object({ rpm: count.optional() }).strict().optional(),
    library: z.object({ enabled: z.boolean().optional(), domain: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional() }).strict().optional(),
    editors: z.object({ proposers: proposers.optional(), mode: editorMode.optional(), select: z.boolean().optional(), parallel: z.boolean().optional() }).strict().optional(),
  })
  .strict();

type FileSettings = z.infer<typeof fileSchema>;

const APPROVALS: readonly string[] = ['auto', 'manual'];
const FILE = 'improve.json';

function refuse(message: string, field: string): never {
  throw new ConfigurationError(`loadImproveSettings: ${message}`, field);
}

function readFile(dir: string): FileSettings {
  const file = path.join(dir, FILE);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse(`${file} is not valid JSON (${(error as Error).message}).`, FILE);
  }
  const parsed = fileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const at = issue.path.length > 0 ? issue.path.join('.') : 'the top level';
  return refuse(`${file}: ${at}: ${issue.message}.`, `${FILE}:${issue.path.join('.')}`);
}

function approvalOf(value: string | undefined, source: string): ImproveSettings['approval'] | undefined {
  if (value === undefined || value === '') return undefined;
  if (!APPROVALS.includes(value)) refuse(`${source} must be 'auto' or 'manual'.`, source);
  return value as ImproveSettings['approval'];
}

const DEFAULT_EDITORS: ImproveSettings['editors'] = { proposers: 1, mode: 'agg', select: false, parallel: true };

export function editorsOf(settings: Pick<ImproveSettings, 'editors'>): ImproveSettings['editors'] {
  return { ...DEFAULT_EDITORS, ...settings.editors };
}

function editorOverrides(editors: ImproveSettingsOverrides['editors'] = {}): Partial<ImproveSettings['editors']> {
  if (editors.proposers !== undefined && !proposers.safeParse(editors.proposers).success) refuse(`--proposers must be a whole number from 1 to ${MAX_PROPOSERS}.`, '--proposers');
  if (editors.mode !== undefined && !editorMode.safeParse(editors.mode).success) refuse("--mode must be 'agg' or 'seq'.", '--mode');
  return present(editors);
}

function present<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/** Reads improve.json beside the agent; flags win over LOUSHO_IMPROVE_* variables, which win over the file. */
export function loadImproveSettings(dir: string, overrides: ImproveSettingsOverrides = {}, env: NodeJS.ProcessEnv = process.env): ImproveSettings {
  const file = readFile(dir);
  const approval = approvalOf(overrides.approval, '--approval') ?? approvalOf(env.LOUSHO_IMPROVE_APPROVAL, 'LOUSHO_IMPROVE_APPROVAL') ?? file.approval ?? 'auto';
  return {
    enabled: file.enabled ?? true,
    approval,
    budget: { maxTokensPerDay: 2_000_000, maxCyclesPerDay: 4, maxAppliesPerDay: 1, ...present(file.budget ?? {}) },
    trigger: { minNewFailures: 3, requireRecurring: approval === 'auto', ...present(file.trigger ?? {}) },
    canary: { replayRuns: 6, ...present(file.canary ?? {}) },
    monitor: { minRuns: 20, window: 20, maxDrop: 0.05, autoRollback: true, giveUpDays: 7, ...present(file.monitor ?? {}) },
    guard: { runs: 3, everyHours: 24, maxCases: 30, ...present(file.guard ?? {}) },
    cooldownHours: file.cooldownHours ?? 24,
    rateLimit: { rpm: 20, ...present(file.rateLimit ?? {}) },
    library: { enabled: true, ...present(file.library ?? {}) },
    editors: { ...DEFAULT_EDITORS, ...present(file.editors ?? {}), ...editorOverrides(overrides.editors) },
  };
}
