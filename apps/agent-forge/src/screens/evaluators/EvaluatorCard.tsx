/**
 * One online evaluator rule as a card in the Evaluators grid: the kind icon,
 * the name (the link to the rule's edit view, stretched over the card), the
 * enabled switch (outside the link), the target filter, the sample rate and
 * the last-run counts.
 */
import { Activity, Clock, Code2, Sparkles } from 'lucide-react';
import { useId } from 'react';
import type { ObserveEvaluator } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { filterSummary, type RuleRuns } from './evaluatorsUrl';

/** The visible label per rule kind. */
export const KIND_LABEL: Record<ObserveEvaluator['kind'], string> = { code: 'Code', judge: 'LLM judge' };

/** The icon per rule kind: a code function, or an LLM judge. */
export const KIND_ICON = { code: Code2, judge: Sparkles } as const;

/** The enabled switch: a native checkbox with `role="switch"`, named "<rule> enabled". */
function EnabledSwitch({ rule, on, onFlip }: { rule: ObserveEvaluator; on: boolean; onFlip: (next: boolean) => void }) {
  return (
    <label className="ev-switch-field">
      <span className="ev-switch-state" aria-hidden="true">
        {on ? 'On' : 'Off'}
      </span>
      <input
        className="ev-switch"
        type="checkbox"
        role="switch"
        aria-label={`${rule.name} enabled`}
        checked={on}
        onChange={(e) => onFlip(e.target.checked)}
      />
    </label>
  );
}

interface EvaluatorCardProps {
  rule: ObserveEvaluator;
  /** The edit view's hash path (carrying the list's filters). */
  href: string;
  runs: RuleRuns | undefined;
  /** The online-score read hit its cap: the 24h count is a floor (`N+`). */
  capped: boolean;
  on: boolean;
  onFlip: (next: boolean) => void;
}

/** One rule card; the name is the link, and its hit area covers the card (except the switch). */
export function EvaluatorCard({ rule, href, runs, capped, on, onFlip }: EvaluatorCardProps) {
  const id = useId();
  const Icon = KIND_ICON[rule.kind];
  const target = filterSummary(rule.filter);
  const count = runs?.runs24h ?? 0;
  return (
    <li className="ds-card">
      <div className={on ? 'ds-card-surface ev-card' : 'ds-card-surface ev-card ev-card-off'}>
        <div className="ds-card-top">
          <span className={`ds-card-icon ev-icon ev-icon-${rule.kind}`} aria-hidden="true">
            <Icon size={16} strokeWidth={1.75} />
          </span>
          <span className="ev-card-heading">
            <a className="ev-card-name" href={`#${href}`} title={rule.name} aria-describedby={`${id}-kind ${id}-facts`}>
              {rule.name}
            </a>
            <span className="ev-card-kind" id={`${id}-kind`}>
              {KIND_LABEL[rule.kind]}
            </span>
          </span>
          <EnabledSwitch rule={rule} on={on} onFlip={onFlip} />
        </div>
        <dl className="ev-card-facts" id={`${id}-facts`}>
          <div className="ev-card-fact ev-card-target">
            <dt className="overline">Target</dt>
            <dd title={target}>{target}</dd>
          </div>
          <div className="ev-card-fact ev-card-sample">
            <dt className="overline">Sample rate</dt>
            <dd>{String(rule.sample_rate)}</dd>
          </div>
        </dl>
        <div className="ds-card-meta">
          <span className="ds-card-stat ev-card-runs">
            <span className={count > 0 ? 'ev-dot ev-dot-on' : 'ev-dot'} aria-hidden="true" />
            <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="ev-runs-count">{`${fmtInt(count)}${capped ? '+' : ''}`}</span> runs (24h)
          </span>
          <span className="ds-card-stat ev-card-last">
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            {runs ? `Last run ${fmtDateTime(runs.lastRun)}` : 'Never run'}
          </span>
        </div>
      </div>
    </li>
  );
}
