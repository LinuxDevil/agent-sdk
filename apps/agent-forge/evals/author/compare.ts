/**
 * The Author eval's baseline compare (PLAN §17: "eval baseline must not
 * regress more than 5 points"): `baseline.json` records the last known
 * good pass rate and a run fails when its pass rate drops more than
 * {@link BASELINE_TOLERANCE} below it.
 */
/** The committed `evals/author/baseline.json` shape. */
export interface AuthorEvalBaseline {
  passRate: number;
  date: string;
  model: string;
}

/** How far below the baseline a run may land before it fails (5 points). */
const BASELINE_TOLERANCE = 0.05;

/** The compare's answer: `ok` when the run is inside the tolerance. */
export interface CompareOutcome {
  ok: boolean;
  /** `baseline.passRate - passRate` (negative when the run improved). */
  regression: number;
  detail: string;
}

/**
 * Compares one run's pass rate against the baseline. A missing baseline
 * passes (nothing to regress against - `--update-baseline` writes the
 * first one); anything within 5 points passes; below that fails.
 */
export function comparePassRate(passRate: number, baseline: AuthorEvalBaseline | undefined): CompareOutcome {
  if (baseline === undefined) {
    return { ok: true, regression: 0, detail: 'no baseline.json - nothing to compare against' };
  }
  const regression = baseline.passRate - passRate;
  // 1e-9 swallows float noise at the boundary (0.8 - 0.75 === 0.05000000000000004).
  const ok = regression <= BASELINE_TOLERANCE + 1e-9;
  return {
    ok,
    regression,
    detail: ok
      ? `pass rate ${(passRate * 100).toFixed(1)}% is within 5 points of baseline ${(baseline.passRate * 100).toFixed(1)}%`
      : `pass rate ${(passRate * 100).toFixed(1)}% regressed more than 5 points below baseline ${(baseline.passRate * 100).toFixed(1)}%`,
  };
}
