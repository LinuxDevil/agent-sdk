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
}

/** Options for {@link improveAgent}. */
export interface ImproveOptions {
  /** The current harness. It is never changed. */
  harness: Harness;
  /** Ids of the cases editors learn from. */
  cases: readonly string[];
  /** Ids of cases that gate the result, kept away from the editors. */
  holdout?: readonly string[];
  /** Runs one case under a harness, where `repeat` goes up to `2 × repeats − 1` for the base harness. It owns side effects: use {@link createShadowHook} unless its tools are safe to run. */
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
  /** Stops the run when aborted. */
  signal?: AbortSignal;
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
  /** Which editor's harness. */
  label: 'compose' | 'invariant' | 'domain';
  /** Whether it passed the gate. */
  passed: boolean;
  /** Why, in a sentence. */
  reason: string;
}

/** What one editor session did. */
export interface ImproveStage {
  /** Which editor. */
  label: 'invariant' | 'domain' | 'compose';
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
  /** Each harness the gate judged, in order: the composite first, then any single editor's harness tried after it failed. */
  gate?: GateVerdict[];
  /** Each editor's harness from before the gate, so a person or a replay can judge one the gate rejected. */
  candidates?: {
    /** The invariant editor's harness, or the base if it changed nothing. */
    invariant: Harness;
    /** The domain editor's harness, or the base if it changed nothing. */
    domain: Harness;
    /** The composer's harness, or the base if it changed nothing. */
    compose: Harness;
  };
  /** What each editor did. */
  stages: ImproveStage[];
  /** Tokens spent in total. */
  spend: {
    /** Tokens across probes and editors. */
    tokens: number;
  };
}
