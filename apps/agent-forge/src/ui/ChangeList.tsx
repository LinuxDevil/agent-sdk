import { Fragment, useId, useState } from 'react';
import { GitCompareArrows, Minus, Pencil, Plus } from 'lucide-react';

import { changeView, type ChangeItem, type ChangeLine, type ChangeView } from './changeValue';
import './changeList.css';

/** Props for {@link ChangeList}. */
export interface ChangeListProps {
  /** The field changes to draw (a server's `SpecChange[]` is assignable). */
  changes: ChangeItem[];
  /** Heading text; default 'Changes'. */
  title?: string;
  /** Section heading per row (e.g. 'Model', 'Tools'); groups keep first-appearance order. */
  groupBy?: (change: ChangeItem) => string;
  /** Shown when `changes` is empty; default 'No changes.'. */
  emptyText?: string;
  /** Start text diffs expanded; default false (collapsed behind the Show diff toggle). */
  expandText?: boolean;
}

/** The lucide icon and spoken prefix of each chip tone, so colour is never the only signal. */
const CHIP_TONE = {
  add: { Icon: Plus, spoken: 'Added: ' },
  remove: { Icon: Minus, spoken: 'Removed: ' },
  edit: { Icon: Pencil, spoken: 'Changed: ' },
} as const;

/** The gutter mark of each diff line kind, aria-hidden because the row's class and text carry it. */
const LINE_MARK = { same: ' ', removed: '−', added: '+' } as const;

/** A missing before/after: a faint em dash in place of a value. */
function Missing() {
  return <span className="value-missing">—</span>;
}

/** One collection chip: the tone icon, a spoken "Added: "/etc prefix, then the item key. */
function Chip({ tone, text }: { tone: keyof typeof CHIP_TONE; text: string }) {
  const { Icon, spoken } = CHIP_TONE[tone];
  return (
    <li>
      <span className={`change-chip change-chip-${tone}`}>
        <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="visually-hidden">{spoken}</span>
        {text}
      </span>
    </li>
  );
}

/** A scalar change: "before → after" for edits, a lone chip for adds and removes. */
function ScalarValue({ op, view }: { op: ChangeItem['op']; view: Extract<ChangeView, { kind: 'scalar' }> }) {
  if (op === 'add') {
    return (
      <span className="change-chip change-chip-add">
        <Plus size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="visually-hidden">Added: </span>
        {view.after ?? <Missing />}
      </span>
    );
  }
  if (op === 'remove') {
    return (
      <span className="change-chip change-chip-remove">
        <Minus size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="visually-hidden">Removed: </span>
        <del>{view.before ?? <Missing />}</del>
      </span>
    );
  }
  return (
    <>
      <span className="visually-hidden">from </span>
      <del className="change-before">{view.before ?? <Missing />}</del>
      <span className="change-arrow" aria-hidden="true">
        →
      </span>
      <span className="visually-hidden"> to </span>
      <ins className="change-after">{view.after ?? <Missing />}</ins>
    </>
  );
}

/** A collection change: added, then removed, then edited chips (only what changed). */
function CollectionValue({ view }: { view: Extract<ChangeView, { kind: 'collection' }> }) {
  return (
    <ul className="change-chips">
      {view.added.map((key, i) => (
        <Chip key={`a-${i}`} tone="add" text={key} />
      ))}
      {view.removed.map((key, i) => (
        <Chip key={`r-${i}`} tone="remove" text={key} />
      ))}
      {view.edited.map((key, i) => (
        <Chip key={`e-${i}`} tone="edit" text={key} />
      ))}
    </ul>
  );
}

/** One expanded diff line: a +/−/space gutter mark then the text. */
function DiffLineRow({ line }: { line: ChangeLine }) {
  return (
    <span className={`change-line change-line-${line.kind}`}>
      <span className="change-mark" aria-hidden="true">
        {LINE_MARK[line.kind]}
      </span>
      {line.text}
      {'\n'}
    </span>
  );
}

/** A text change: `+N −M` counts and a toggle that expands into the line diff. */
function TextValue({ view, expandText }: { view: Extract<ChangeView, { kind: 'text' }>; expandText: boolean }) {
  const [open, setOpen] = useState(expandText);
  const panelId = useId();
  return (
    <>
      <span className="change-counts">
        <span className="change-count-add">+{view.added}</span>
        <span className="change-count-remove">−{view.removed}</span>
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm change-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide diff' : 'Show diff'}
      </button>
      {open && (
        <pre className="change-diff" id={panelId}>
          {view.lines.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
        </pre>
      )}
    </>
  );
}

/** One change row: the field label, then its scalar / collection / text value. */
function ChangeRow({ change, expandText }: { change: ChangeItem; expandText: boolean }) {
  const view = changeView(change);
  return (
    <li className={`change-row change-row-${change.op}`} data-field={change.field}>
      <span className="change-label">{change.label}</span>
      <div className="change-value">
        {view.kind === 'scalar' && <ScalarValue op={change.op} view={view} />}
        {view.kind === 'collection' && <CollectionValue view={view} />}
        {view.kind === 'text' && <TextValue view={view} expandText={expandText} />}
      </div>
    </li>
  );
}

/** `changes` bucketed by `groupBy` into (heading, rows) pairs, first-appearance order. */
function grouped(changes: ChangeItem[], groupBy: (change: ChangeItem) => string): [string, ChangeItem[]][] {
  const groups = new Map<string, ChangeItem[]>();
  for (const change of changes) {
    const name = groupBy(change);
    const bucket = groups.get(name);
    if (bucket) bucket.push(change);
    else groups.set(name, [change]);
  }
  return [...groups];
}

/**
 * The shared diff of spec field changes (proposal cards, version diff sheet,
 * draft cards): scalar rows as struck "before → after", collections as
 * added/removed/edited chips, long text as `+N −M` counts with an expandable
 * line diff. Presentational only - the only control is the diff toggle.
 */
export function ChangeList({
  changes,
  title = 'Changes',
  groupBy,
  emptyText = 'No changes.',
  expandText = false,
}: ChangeListProps): JSX.Element {
  const titleId = useId();
  const groups: [string | undefined, ChangeItem[]][] = groupBy ? grouped(changes, groupBy) : [[undefined, changes]];
  return (
    <section className="change-list" aria-labelledby={titleId}>
      <h3 className="change-list-title" id={titleId}>
        <GitCompareArrows size={14} strokeWidth={1.75} className="change-list-icon" aria-hidden="true" />
        {title}
        <span className="change-list-count tabular-nums">{changes.length}</span>
      </h3>
      {changes.length === 0 ? (
        <p className="change-list-empty">{emptyText}</p>
      ) : (
        groups.map(([name, items]) => (
          <Fragment key={name ?? 'rows'}>
            {name !== undefined && <h4 className="change-list-group overline">{name}</h4>}
            <ul className="change-list-rows">
              {items.map((change, i) => (
                <ChangeRow key={i} change={change} expandText={expandText} />
              ))}
            </ul>
          </Fragment>
        ))
      )}
    </section>
  );
}
