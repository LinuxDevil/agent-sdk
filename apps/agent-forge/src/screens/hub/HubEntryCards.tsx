/**
 * One namespace's entries as cards: the key (mono), its scope, a one-line
 * value preview (full preview in the tooltip), and the writer, last publish
 * and TTL. A card opens the entry; j/k move between cards.
 */
import { KeyRound } from 'lucide-react';
import type { ObserveHubEntry } from '../../observe/types';
import { fmtStarted } from '../../observe/format';
import { StatusPill } from '../../ui/StatusPill';
import { onRovingKeyDown } from '../rovingKeys';
import { ttlText, valuePreview } from './hubModel';

function EntryCard({
  entry,
  writer,
  now,
  selected,
  onOpen,
}: {
  entry: ObserveHubEntry;
  writer: string;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const preview = valuePreview(entry.value);
  return (
    <li>
      <button type="button" className="hub-card" data-roving aria-current={selected ? 'true' : undefined} onClick={onOpen}>
        <span className="hub-card-top">
          <KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="hub-card-key" title={entry.key}>
            {entry.key}
          </span>
          <StatusPill status={entry.scope} />
        </span>
        <span className="hub-card-value" title={preview}>
          {preview}
        </span>
        <span className="hub-card-meta">
          <span className="hub-card-writer">{writer}</span>
          <span aria-hidden="true">·</span>
          <span>Updated {fmtStarted(entry.created_at, now)}</span>
          <span aria-hidden="true">·</span>
          <span>TTL {ttlText(entry, now)}</span>
        </span>
      </button>
    </li>
  );
}

/** The card list; `selectedId` is the open entry. */
export function HubEntryCards({
  entries,
  selectedId,
  writerName,
  now,
  onOpen,
}: {
  entries: readonly ObserveHubEntry[];
  selectedId: string | undefined;
  writerName: (id: string | null) => string;
  now: number;
  onOpen: (entry: ObserveHubEntry) => void;
}) {
  return (
    <ul className="hub-cards" aria-label="Entries" onKeyDown={onRovingKeyDown}>
      {entries.map((e) => (
        <EntryCard
          key={e.entry_id}
          entry={e}
          writer={writerName(e.agent_id)}
          now={now}
          selected={e.entry_id === selectedId}
          onOpen={() => onOpen(e)}
        />
      ))}
    </ul>
  );
}
