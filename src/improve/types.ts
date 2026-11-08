import type { LLMProvider } from '../providers';
import type { AgentHook } from '../execution/hooks';

/** The parts of an agent the improver may edit: nothing else can change, so tools, permissions and limits can't widen. */
export interface Harness {
  /** The agent's instructions. */
  instructions: string;
  /** On-demand skills, by name. */
  skills: Record<
    string,
    {
      /** When to use the skill. */
      description: string;
      /** The skill's instructions. */
      content: string;
    }
  >;
}

/** One run of a case under a candidate harness. */
export interface ProbeRun {
  /** Whether it passed; `null` when it couldn't be scored, such as a provider failure. A `null` is excluded and never counted as a failure. */
  passed: boolean | null;
  /** What happened, for the editors to read. {@link renderTranscript} makes one from a run's messages. */
  transcript: string;
  /** Tokens the run used. */
  tokens: number;
  /** How the run ended. */
  ended: string;
  /** Which check a failed run missed, for the editors to read. Name the requirement, not the fix. */
  failure?: string;
  /** Set by {@link cachedProbe} when the run was replayed from its cache rather than run; keep it when you wrap a probe, so `ledger` counts it. */
  cached?: boolean;
}

/** A retry of a training case that passed after a diagnosis was added, shown to the editors as evidence and never scored. */
export interface RecoveryEvidence {
  /** The training case it retried. */
  caseId: string;
  /** The retry's trace. It must not be a held-out case's trace, or that case would reach the editors. */
  traceId: string;
  /** The diagnosis the retry was given. */
  diagnosis: string;
  /** The retry's final answer, to score with your `CaseCheck` before you trust it. */
  answer: string;
  /** What the retry did. Build it with {@link renderTranscript}, so tool results stay marked as untrusted. */
  transcript: string;
}

/** Options for {@link improveAgent}. */
export interface ImproveOptions {
  /** The current harness. It is never changed. */
  harness: Harness;
  /** Ids of the cases editors learn from. */
  cases: readonly string[];
  /** Ids of cases that gate the result, kept away from the editors. */
  holdout?: readonly string[];
  /** Retries of training cases that passed after a diagnosis, for the editors to read. They don't count as runs, each must name a training case, and none may be a held-out case's trace. */
  recoveries?: readonly RecoveryEvidence[];
  /** Lessons from earlier attempts for the editors to read, as files under `context/library/`. Build them with {@link libraryFiles}. */
  library?: Readonly<Record<string, string>>;
  /** Runs one case under a harness, where `repeat` goes up to `2 × repeats − 1` for the base harness. It owns side effects: use {@link createShadowHook} unless its tools are safe to run. Two calls can run at once unless `parallelEditors` is `false`. */
  probe: (harness: Harness, caseId: string, repeat: number) => Promise<ProbeRun>;
  /** The editors' model. */
  editor:
    | {
        /** A provider instance. */
        provider: LLMProvider;
      }
    | {
        /** A model string, such as `openrouter/<model>`. */
        model: string;
      };
  /** Runs per case, per harness (default 3). The base harness gets twice as many on training cases, because the gate compares against fresh runs. */
  repeats?: number;
  /** Stops once this many tokens are spent, across probes and editors. */
  maxTokens?: number;
  /** Most characters of always-on instructions an edit may leave (default 8000). */
  maxAlwaysOnChars?: number;
  /** The largest rise in tokens per passing run a result may cost, as a fraction, on cases that pass under both harnesses (default 0.5). A smaller rise, or one within measured noise, is reported in `reason` and doesn't reject. */
  maxCostIncrease?: number;
  /** Most steps per editor session (default 30). */
  maxEditorSteps?: number;
  /** Runs the editors even when every case passed, to test whether they rightly change nothing. */
  alwaysPropose?: boolean;
  /** Hooks for the editor sessions, such as a rate-limit delay. */
  editorHooks?: readonly AgentHook[];
  /** What to do with an edit that quotes, word for word, a failed check of two or more words that its editor saw: `reject` (default) sends it back once with that feedback, then drops it; `flag` keeps it and flags it on the review card. Use `flag` only when a person approves every edit. */
  quotedChecks?: 'reject' | 'flag';
  /** A directory, such as `<agentDir>/.lousho/cache`, where editor sessions are cached by their prompt, evidence, model and limits, so a cycle that sees the same evidence again makes no editor calls. Entries older than 7 days, then the oldest past 200 MB, are deleted at the start of each run. */
  cacheDir?: string;
  /** Runs the invariant and domain editors, and then their probes, two at a time (default `true`). Set `false` for a rate-limited model. */
  parallelEditors?: boolean;
  /** How many invariant and how many domain editors propose from the same runs (default 1, at most 4), or in `seq` mode how many rounds run. Each proposal that changes the harness is probed, so k costs about k times the editor sessions and proposal runs. */
  proposers?: number;
  /** `agg` (default) proposes k of each editor side by side; `seq` runs k rounds, each editing the checkpoint the last round's composer wrote, and gates every checkpoint against the original harness. */
  mode?: 'agg' | 'seq';
  /** Stops the run when aborted. */
  signal?: AbortSignal;
}

/** Probe runs a cycle planned, and how each was served: `planned` is always `run + cached`, and `excluded` counts the runs that couldn't be scored. */
export interface ImproveLedger {
  /** Probe calls made. */
  planned: number;
  /** Calls that ran the agent. */
  run: number;
  /** Calls served from a {@link cachedProbe} cache. */
  cached: number;
  /** Runs that couldn't be scored. */
  excluded: number;
}

/** A harness's results over a set of runs. */
export interface ProbeSummary {
  /** Runs attempted. */
  runs: number;
  /** Runs that couldn't be scored. */
  excluded: number;
  /** Share of scored runs that passed, or `null` when none could be scored. */
  passRate: number | null;
  /** Spread in pass rate between repeats. */
  noise: number;
  /** Average tokens per run. */
  tokensPerRun: number;
}

/** Passed runs out of scored runs. */
export interface CaseCount {
  /** Runs that passed. */
  passed: number;
  /** Runs that could be scored. */
  scored: number;
}

/** How one case did under the current harness and the result, and why the gate counted it as it did. */
export interface CaseVerdict {
  /** The case id. */
  caseId: string;
  /** `training` for a case the editors saw, `holdout` for one they didn't. */
  role: 'training' | 'holdout';
  /** Its runs under the current harness. */
  base: CaseCount;
  /** Its runs under the result. */
  final: CaseCount;
  /** What the gate decided about this case, one sentence each. */
  reasons: string[];
}

/** The gate's verdict on one harness. */
export interface GateVerdict {
  /** Which editor's harness: `invariant-<n>` and `domain-<n>` when there are several proposers, and `compose-<round>` for a checkpoint in `seq` mode. */
  label: 'compose' | 'invariant' | 'domain' | `invariant-${number}` | `domain-${number}` | `compose-${number}`;
  /** Whether it passed the gate. */
  passed: boolean;
  /** Why, in a sentence. */
  reason: string;
}

/** What one editor session did. */
export interface ImproveStage {
  /** Which editor: `invariant-<n>` and `domain-<n>` when there are several proposers. */
  label: GateVerdict['label'];
  /** What came of it. `fell-back` means its edits failed validation twice and were dropped. */
  status: 'edited' | 'no-change' | 'fell-back';
  /** The editor's reasons, including its verdict on each edit. */
  notes: string;
  /** The validation error, when it fell back. */
  error?: string;
  /** Tokens the session used. */
  tokens: number;
}

/** One change a proposal makes, derived from the harness itself, with the editor's reason when it gave one. */
export interface ImproveChange {
  /** Whether the change adds, rewrites or removes text. */
  kind: 'add' | 'modify' | 'remove';
  /** The file it changes: `instructions` or `skill:<name>`. */
  target: string;
  /** The text before, for `modify` and `remove`. */
  before?: string;
  /** The text after, for `add` and `modify`. */
  after?: string;
  /** The editor's one-line reason, when one matched. Editor text: treat it as untrusted. */
  reason?: string;
}

/**
 * How an improvement run ended. Only `proposal` has an edit to review; none is ever applied.
 * - `no-failures`: every case passed, so no editor ran.
 * - `keep-base`: the editors changed nothing, or the result didn't pass the gate.
 * - `outage`: the provider failed, or no run could be scored.
 * - `budget-exceeded`: `maxTokens` ran out.
 */
export type ImproveOutcome = 'proposal' | 'keep-base' | 'no-failures' | 'outage' | 'budget-exceeded';

/** The result of {@link improveAgent}. */
export interface ImproveResult {
  /** How it ended. */
  outcome: ImproveOutcome;
  /** Why, in a sentence. */
  reason: string;
  /** The proposed harness, with `outcome: 'proposal'`. */
  harness?: Harness;
  /** The proposed changes, line by line, with `outcome: 'proposal'`. */
  diff?: string;
  /** The proposed changes one by one, instructions first and then skills by name, with `outcome: 'proposal'`. */
  changes?: ImproveChange[];
  /** The failed-check names the editors saw, so a reviewer can spot an edit that quotes one. */
  failedChecks?: string[];
  /** The current harness on the training runs the editors read. */
  base: ProbeSummary;
  /** The current harness on fresh runs of the training cases: the runs the gate compares against. */
  freshBase?: ProbeSummary;
  /** The composed harness on the training cases, when it was probed. */
  final?: ProbeSummary;
  /** Both harnesses on the held-out cases, when they were probed. */
  holdout?: {
    /** The current harness. */
    base: ProbeSummary;
    /** The composed harness. */
    final: ProbeSummary;
  };
  /** Average tokens per passing run on the cases that passed under both harnesses. Absent when none did, so cost couldn't be compared. */
  costOnPassingCases?: {
    /** How many cases were compared. */
    cases: number;
    /** The current harness. */
    base: number;
    /** The composed harness. */
    final: number;
    /** Average spread in tokens between runs of a case. A rise within this isn't rejected. */
    noise: number;
  };
  /** Each case's verdict, training cases first, when the result was gated. */
  cases?: CaseVerdict[];
  /** Each harness the gate judged, in order: the composite first, then any single editor's harness tried after it failed. In `seq` mode, each round's checkpoint, cheapest first. */
  gate?: GateVerdict[];
  /** Each editor's harness from before the gate, so a person or a replay can judge one the gate rejected. */
  candidates?: {
    /** The invariant editor's harness, or the base if it changed nothing. */
    invariant: Harness;
    /** The domain editor's harness, or the base if it changed nothing. */
    domain: Harness;
    /** The composer's harness, or the base if it changed nothing. In `seq` mode, the last round's checkpoint. */
    compose: Harness;
    /** Every proposal by label, with several proposers, and in `seq` mode each round's checkpoint as `compose-<round>`; `invariant` and `domain` then hold the first of each. */
    pool?: Record<string, Harness>;
  };
  /** How alike the proposals were, with several proposers: mean pairwise line overlap (1 means identical) and how many differed. */
  diversity?: {
    /** Mean pairwise Jaccard similarity of the proposals' non-blank lines. */
    meanJaccard: number;
    /** How many distinct proposals there were. */
    distinct: number;
  };
  /** What each editor did. */
  stages: ImproveStage[];
  /** How many probe runs were planned, run, served from a cache, or excluded. */
  ledger?: ImproveLedger;
  /** Tokens spent in total. */
  spend: {
    /** Tokens across probes and editors. */
    tokens: number;
  };
}
