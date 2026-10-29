/**
 * The diff between two prompt versions, unified (one column, old and new line
 * numbers in the gutter) or side by side (version A left, B right). Removed
 * and added lines carry a `−`/`+` marker and an aria-label as well as the
 * danger/success tint, so colour is never the only signal.
 */
import { useMemo } from 'react';
import { Columns2, Rows3 } from 'lucide-react';
import type { ObservePromptVersion } from '../../observe/types';
import { lineDiff, sideBySide, type DiffCell, type DiffLine } from './lineDiff';

/** How the diff is laid out; local view state, never in the URL. */
export type DiffLayout = 'unified' | 'split';

const MARK = { same: ' ', removed: '−', added: '+' } as const;
const SPOKEN = { same: 'Unchanged', removed: 'Removed', added: 'Added' } as const;

/** The text cell of one diff line: the marker, then the text; a changed line names its change. */
function LineCell({ kind, n, text }: { kind: DiffLine['kind']; n: number; text: string }) {
  return (
    <td
      className={`prompt-diff-line prompt-diff-${kind}`}
      aria-label={kind === 'same' ? undefined : `${SPOKEN[kind]} line ${n}: ${text}`}
    >
      <span className="prompt-diff-mark" aria-hidden="true">
        {MARK[kind]}
      </span>
      {text}
    </td>
  );
}

function SplitCell({ cell }: { cell: DiffCell | undefined }) {
  if (!cell) {
    return (
      <>
        <td className="prompt-diff-num prompt-diff-pad" />
        <td className="prompt-diff-pad" />
      </>
    );
  }
  return (
    <>
      <td className={`prompt-diff-num prompt-diff-num-${cell.kind}`}>{cell.n}</td>
      <LineCell kind={cell.kind} n={cell.n} text={cell.text} />
    </>
  );
}

function SplitBody({ lines }: { lines: readonly DiffLine[] }) {
  const rows = useMemo(() => sideBySide(lines), [lines]);
  return (
    <tbody>
      {rows.map((row, i) => (
        <tr key={i}>
          <SplitCell cell={row.left} />
          <SplitCell cell={row.right} />
        </tr>
      ))}
    </tbody>
  );
}

function UnifiedBody({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <tbody>
      {lines.map((line, i) => (
        <tr key={i} className={`prompt-diff-row-${line.kind}`}>
          <td className={`prompt-diff-num prompt-diff-num-${line.kind}`}>{line.a ?? ''}</td>
          <td className={`prompt-diff-num prompt-diff-num-${line.kind}`}>{line.b ?? ''}</td>
          <LineCell kind={line.kind} n={(line.kind === 'added' ? line.b : line.a) ?? 0} text={line.text} />
        </tr>
      ))}
    </tbody>
  );
}

/** The Unified / Side by side switch: two toggle buttons in a segmented group. */
export function DiffLayoutToggle({ value, onChange }: { value: DiffLayout; onChange: (next: DiffLayout) => void }) {
  const option = (layout: DiffLayout, label: string, Icon: typeof Rows3) => (
    <button type="button" className="seg-btn" aria-pressed={value === layout} onClick={() => onChange(layout)}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div className="segmented" role="group" aria-label="Diff layout">
      {option('unified', 'Unified', Rows3)}
      {option('split', 'Side by side', Columns2)}
    </div>
  );
}

export function PromptDiff({ a, b, layout }: { a: ObservePromptVersion; b: ObservePromptVersion; layout: DiffLayout }) {
  const { lines, wholeBlock, changed } = useMemo(() => {
    const diff = lineDiff(a.text ?? '', b.text ?? '');
    return { lines: diff.lines, wholeBlock: diff.wholeBlock, changed: diff.lines.some((l) => l.kind !== 'same') };
  }, [a, b]);

  return (
    <div className="prompt-diff-wrap">
      {wholeBlock && <p className="prompt-note">These versions are too long to diff line by line; showing the whole changed block.</p>}
      {!changed && <p className="prompt-note">Version {a.version} and version {b.version} have the same text.</p>}
      <table className={`prompt-diff prompt-diff-${layout}`}>
        <caption className="visually-hidden">
          Diff of version {a.version} against version {b.version}
        </caption>
        {layout === 'split' ? (
          <>
            <colgroup>
              <col className="prompt-diff-numcol" />
              <col />
              <col className="prompt-diff-numcol" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" colSpan={2}>
                  Version {a.version}
                </th>
                <th scope="col" colSpan={2}>
                  Version {b.version}
                </th>
              </tr>
            </thead>
            <SplitBody lines={lines} />
          </>
        ) : (
          <>
            <colgroup>
              <col className="prompt-diff-numcol" />
              <col className="prompt-diff-numcol" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">v{a.version}</th>
                <th scope="col">v{b.version}</th>
                <th scope="col">
                  Changes from version {a.version} to version {b.version}
                </th>
              </tr>
            </thead>
            <UnifiedBody lines={lines} />
          </>
        )}
      </table>
    </div>
  );
}
