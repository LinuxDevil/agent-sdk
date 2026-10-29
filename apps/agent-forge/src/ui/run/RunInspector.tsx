import type { ReactNode } from 'react';
import { AlertTriangle, FileWarning, FlaskConical } from 'lucide-react';

import { fmtCost, fmtDuration, fmtInt } from '../../observe/format';
import type { ObserveObservationRow, ObserveScoreRow } from '../../observe/types';
import { JsonView } from '../JsonView';
import { MessageView } from '../MessageView';
import { StatusPill } from '../StatusPill';
import { displayName, displayStatus, elapsedMs, isRunning, playgroundHref } from './rows';
import { KindIcon } from './RunTree';
import './run.css';

/**
 * Props for {@link RunInspector}. `scores` may be the whole trace's scores:
 * the inspector keeps the ones for this observation itself (and, for a root
 * observation, the trace-level scores with `obs_id === null`). `now` is the
 * clock a running observation's duration counts to (defaults to `Date.now()`).
 * `renderFeedback` adds a control (e.g. a feedback form) under the Feedback
 * section's score list, for the observation shown. `playgroundLinks: false`
 * hides a generation's "Open in Playground" link (for steps the observe
 * daemon never received, which the Playground could not load).
 */
export interface RunInspectorProps {
  observation: ObserveObservationRow;
  scores: ObserveScoreRow[];
  now?: number;
  renderFeedback?: (observation: ObserveObservationRow) => ReactNode;
  playgroundLinks?: boolean;
}

/** `attrs.error` as a string, else `attrs.error.message`, else a generic line. */
function errorText(attrs: Record<string, unknown> | null): string {
  const error = attrs?.error;
  if (typeof error === 'string' && error !== '') return error;
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return 'This step failed.';
}

/** A value the step does not have, in a key/value grid: a faint em dash. */
const MISSING = <span className="value-missing">—</span>;

/** `format(value)`, or {@link MISSING} for null/undefined. */
function orMissing<T>(value: T | null | undefined, format: (v: T) => ReactNode): ReactNode {
  return value === null || value === undefined ? MISSING : format(value);
}

function scoresFor(row: ObserveObservationRow, scores: ObserveScoreRow[]): ObserveScoreRow[] {
  const isRoot = row.parent_obs_id === null;
  return scores.filter(
    (s) => s.obs_id === row.obs_id || (isRoot && s.obs_id === null && s.trace_id === row.trace_id),
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={`run-section run-section-${id}`} data-section={id} aria-label={title}>
      <h3 className="run-section-title">{title}</h3>
      {children}
    </section>
  );
}

function Feedback({ scores }: { scores: ObserveScoreRow[] }) {
  if (scores.length === 0) return <p className="run-empty-line">No feedback on this step yet.</p>;
  return (
    <ul className="run-scores">
      {scores.map((s) => (
        <li key={s.score_id} className="run-score">
          <span className="run-score-name">{s.name}</span>
          <span className="run-score-value">{orMissing(s.value, String)}</span>
          <span className="run-score-source">{s.source}</span>
          {s.comment && <span className="run-score-comment">{s.comment}</span>}
        </li>
      ))}
    </ul>
  );
}

function Usage({ row }: { row: ObserveObservationRow }) {
  const markers = [row.cost_partial && 'partial', row.usage_estimated && 'estimated'].filter(Boolean);
  const facts: [string, ReactNode][] = [
    ['Input tokens', orMissing(row.usage_input_tokens, fmtInt)],
    ['Output tokens', orMissing(row.usage_output_tokens, fmtInt)],
    ['Cached tokens', orMissing(row.usage_cached_tokens, fmtInt)],
    ['Reasoning tokens', orMissing(row.usage_reasoning_tokens, fmtInt)],
    [
      'Cost',
      <>
        {orMissing(row.cost_usd, fmtCost)}
        {markers.length > 0 && <span className="run-marker"> ({markers.join(', ')})</span>}
      </>,
    ],
    ['Model', row.model ? <code>{row.model}</code> : MISSING],
  ];
  return (
    <dl className="run-facts">
      {facts.map(([label, value]) => (
        <div key={label} className="run-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The selected observation in detail, under a sticky header (kind, name,
 * status, duration, "Open in Playground" for a generation). Sections, in
 * order: Error (only for a failed step: a danger `role="alert"` card with the
 * message in mono) → Input → Output (both
 * `MessageView`) → Feedback (scores) → Tokens/Cost/Model → Attributes
 * (`JsonView` of `attrs`, omitted when null). A truncated row says so.
 */
export function RunInspector({ observation: row, scores, now, renderFeedback, playgroundLinks = true }: RunInspectorProps) {
  const ms = elapsedMs(row, now ?? Date.now());
  return (
    <div className="run-inspector" data-obs-id={row.obs_id}>
      <header className="run-inspector-head">
        <div className="run-inspector-title">
          <KindIcon kind={row.kind} />
          <span className="run-inspector-kind">{row.kind}</span>
        </div>
        <div className="run-inspector-title">
          <h2 className="run-inspector-name">{displayName(row)}</h2>
          <StatusPill status={displayStatus(row)} />
          <span className="run-dur">
            {fmtDuration(ms)}
            {isRunning(row) ? ' running' : ''}
          </span>
          {playgroundLinks && row.kind === 'generation' && (
            <a className="btn btn-sm btn-ghost run-playground-link" href={playgroundHref(row.trace_id, row.obs_id)}>
              <FlaskConical aria-hidden="true" />
              Open in Playground
            </a>
          )}
        </div>
      </header>
      {row.status === 'error' && (
        <div className="run-error-banner" role="alert" data-section="error">
          <AlertTriangle className="run-error-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
          <div className="run-error-body">
            <strong>Error</strong>
            <code className="run-error-message">{errorText(row.attrs)}</code>
          </div>
        </div>
      )}
      {row.truncated && (
        <p className="run-truncated-note">
          <FileWarning size={14} strokeWidth={1.75} aria-hidden="true" />
          Truncated: this step&apos;s input or output was cut at ~64 KB by the reporter.
        </p>
      )}
      {/* MessageView brings its own labelled header, so no Section title here. */}
      <div className="run-section run-section-input" data-section="input">
        <MessageView value={row.input} label="Input" />
      </div>
      <div className="run-section run-section-output" data-section="output">
        <MessageView value={row.output} label="Output" />
      </div>
      <Section id="feedback" title="Feedback">
        <Feedback scores={scoresFor(row, scores)} />
        {renderFeedback?.(row)}
      </Section>
      <Section id="usage" title="Tokens, cost and model">
        <Usage row={row} />
      </Section>
      {row.attrs !== null && (
        <Section id="attributes" title="Attributes">
          <JsonView value={row.attrs} name="attrs" />
        </Section>
      )}
    </div>
  );
}
