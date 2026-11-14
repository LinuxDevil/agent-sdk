import { useMemo } from 'react';
import { Sparkles } from 'lucide-react';

import { fmtAge } from '../../observe/format';
import { ChangeList } from '../../ui/ChangeList';
import type { ChangeItem } from '../../ui/changeValue';
import { lineDiff } from '../prompts/lineDiff';
import { useSuggestionActions, type SuggestionBusy } from './useSuggestionActions';
import { agentTabPath } from '../agents/agentTabs';
import type { PromptSuggestion } from '../../../shared/wireTypes';

/** Props for {@link SuggestionCard}. */
export interface SuggestionCardProps {
  agentId: string;
  suggestion: PromptSuggestion;
  /** `spec.promptRef` when set - the note warns apply edits only the fallback text. */
  promptRef?: string;
  /** Called after apply/dismiss settles the record so the parent refetches the list. */
  onChanged(): void;
}

/** The four evidence facts as a definition list (contract DOM). */
function SuggestionFacts({ suggestion }: { suggestion: PromptSuggestion }): JSX.Element {
  return (
    <dl className="suggestion-card-facts">
      <dt>Evidence</dt>
      <dd>{suggestion.evidence}</dd>
      <dt>Expected saving</dt>
      <dd>{suggestion.expectedSaving}</dd>
      <dt>Risk</dt>
      <dd>{suggestion.risk}</dd>
      <dt>How to check it</dt>
      <dd>
        <ol>
          {suggestion.validationPlan.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </dd>
    </dl>
  );
}

/** The card footer per status: Apply/Dismiss on open, "Suggest again" on conflict. */
function SuggestionActions({
  status,
  busy,
  onApply,
  onDismiss,
  onSuggestAgain,
}: {
  status: 'open' | 'conflict';
  busy: SuggestionBusy;
  onApply(): void;
  onDismiss(): void;
  onSuggestAgain(): void;
}): JSX.Element {
  if (status === 'conflict') {
    return (
      <footer className="suggestion-card-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSuggestAgain} disabled={busy !== null}>
          <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
          {busy === 'again' ? 'Suggesting…' : 'Suggest again'}
        </button>
      </footer>
    );
  }
  return (
    <footer className="suggestion-card-actions">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={onApply}
        disabled={busy !== null}
        title={busy === 'apply' ? 'Applying…' : undefined}
      >
        {busy === 'apply' ? 'Applying…' : 'Apply'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss} disabled={busy !== null}>
        Dismiss
      </button>
    </footer>
  );
}

/**
 * One prompt suggestion as a review card (R06): the pass's
 * `optimizationClass` as the title, its confidence pill, the source
 * trace link, the `oldText` → `newText` line diff through `ChangeList`,
 * and the four evidence facts. The actions live in
 * {@link useSuggestionActions}; this component is presentation only.
 */
export function SuggestionCard({ agentId, suggestion, promptRef, onChanged }: SuggestionCardProps): JSX.Element | null {
  const { busy, status, appliedVersion, error, apply, dismiss, suggestAgain } = useSuggestionActions(
    agentId,
    suggestion,
    onChanged
  );

  // The diff is pure text work - memoised so a list re-render never re-diffs.
  const changes = useMemo<ChangeItem[]>(
    () => [
      {
        field: 'instructions',
        label: 'Instructions',
        op: 'edit',
        lines: lineDiff(suggestion.oldText, suggestion.newText).lines,
      },
    ],
    [suggestion.id, suggestion.oldText, suggestion.newText]
  );

  if (suggestion.status === 'dismissed') return null;

  const titleId = `sg-${suggestion.id}-title`;
  const appliedAs = appliedVersion ?? suggestion.appliedVersion;

  return (
    <article className="suggestion-card" data-status={status} aria-labelledby={titleId}>
      <header className="suggestion-card-header">
        <h3 id={titleId} className="suggestion-card-title">
          {suggestion.optimizationClass}
        </h3>
        <span className={`status-pill ${suggestion.confidence === 'high' ? 'pill-ok' : 'pill-neutral'}`}>
          {suggestion.confidence === 'high' ? 'High confidence' : 'Low confidence'}
        </span>
        <a className="suggestion-card-source" href={`#/traces/${encodeURIComponent(suggestion.sourceTraceId)}`}>
          From run {suggestion.sourceTraceId.slice(0, 8)}
        </a>
        <time className="suggestion-card-time" dateTime={suggestion.createdAt}>
          {fmtAge(Date.now() - Date.parse(suggestion.createdAt))}
        </time>
      </header>

      {promptRef !== undefined && (
        <p className="suggestion-card-note">
          This agent loads its instructions from the prompt registry ({promptRef}); applying edits the fallback text only.
        </p>
      )}

      {status === 'applied' ? (
        <p className="suggestion-card-applied">
          <a href={`#${agentTabPath(agentId, 'versions')}`}>
            {appliedAs !== null ? `Applied as v${appliedAs}` : 'Applied'}
          </a>
        </p>
      ) : (
        <>
          {status === 'conflict' && (
            <div className="suggestion-card-conflict" role="alert">
              <p>
                The instructions changed since this was suggested. Run the suggestion again from the run to get a fresh one.
              </p>
            </div>
          )}
          <ChangeList changes={changes} title="Suggested change" />
          <SuggestionFacts suggestion={suggestion} />
          {error !== undefined && (
            <p className="suggestion-card-error" role="alert">
              {error}
            </p>
          )}
          <SuggestionActions
            status={status}
            busy={busy}
            onApply={() => void apply()}
            onDismiss={() => void dismiss()}
            onSuggestAgain={() => void suggestAgain()}
          />
        </>
      )}
    </article>
  );
}
