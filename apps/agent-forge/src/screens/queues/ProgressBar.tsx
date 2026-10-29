/**
 * A queue's progress as one thin bar: the reviewed (done) share in the accent,
 * then the skipped share in a quiet tone, over the remaining track.
 */
interface ProgressBarProps {
  done: number;
  skipped: number;
  total: number;
  /** With a label the bar is a `role="progressbar"` (finished = done + skipped); without one it is decorative. */
  label?: string;
}

const pct = (part: number, total: number) => `${total > 0 ? (part / total) * 100 : 0}%`;

/** The bar; it reads as complete only once nothing is pending. */
export function ProgressBar({ done, skipped, total, label }: ProgressBarProps) {
  const a11y = label
    ? { role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done + skipped }
    : { 'aria-hidden': true };
  const complete = total > 0 && done + skipped >= total;
  return (
    <span className={complete ? 'qu-bar qu-bar-complete' : 'qu-bar'} {...a11y}>
      <span className="qu-bar-done" style={{ width: pct(done, total) }} />
      <span className="qu-bar-skipped" style={{ width: pct(skipped, total) }} />
    </span>
  );
}
