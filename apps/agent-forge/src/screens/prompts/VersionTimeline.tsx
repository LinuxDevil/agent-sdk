/**
 * A prompt's version history as a vertical timeline, newest first: each
 * version's badge, labels, publish time, runs and variables. The selected
 * version is `aria-current`; picking another replaces the history entry.
 */
import type { ObservePromptVersion } from '../../observe/types';
import { fmtDateTime, fmtInt } from '../../observe/format';
import { Card } from '../../ui/Card';
import { onRovingKeyDown } from '../rovingKeys';
import { LabelChips } from './LabelChips';

/** `variables` is stored verbatim; an array of names is the common shape. */
export const variablesText = (variables: unknown): string | undefined =>
  Array.isArray(variables) && variables.length > 0 ? variables.map(String).join(', ') : undefined;

const runsText = (uses: number) => `${fmtInt(uses)} ${uses === 1 ? 'run' : 'runs'}`;

function TimelineItem({ version, selected, onOpen }: { version: ObservePromptVersion; selected: boolean; onOpen: () => void }) {
  const variables = variablesText(version.variables);
  return (
    <li className="prompt-timeline-entry">
      <span className="prompt-timeline-dot" aria-hidden="true" />
      <button type="button" className="prompt-timeline-item" data-roving aria-current={selected ? 'true' : undefined} onClick={onOpen}>
        <span className="prompt-timeline-top">
          <span className="prompt-version-badge">v{version.version}</span>
          <LabelChips labels={version.labels} inline />
        </span>
        <span className="prompt-timeline-meta">
          <span>{fmtDateTime(version.created_at)}</span>
          <span aria-hidden="true">·</span>
          <span>{runsText(version.uses)}</span>
        </span>
        {variables && (
          <span className="prompt-timeline-vars">
            <span className="visually-hidden">Variables: </span>
            {variables}
          </span>
        )}
      </button>
    </li>
  );
}

export function VersionTimeline({
  versions,
  selected,
  onOpen,
}: {
  versions: readonly ObservePromptVersion[];
  selected: ObservePromptVersion;
  onOpen: (version: ObservePromptVersion) => void;
}) {
  return (
    <Card
      title="Version history"
      description={`${fmtInt(versions.length)} ${versions.length === 1 ? 'version' : 'versions'}, newest first`}
      className="prompt-history"
    >
      <ol className="prompt-timeline" onKeyDown={onRovingKeyDown}>
        {versions.map((v) => (
          <TimelineItem key={v.version} version={v} selected={v.version === selected.version} onOpen={() => onOpen(v)} />
        ))}
      </ol>
    </Card>
  );
}
