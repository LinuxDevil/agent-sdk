/**
 * The side-by-side diff between two prompt versions: version A on the left,
 * B on the right. Removed and added lines carry a `-`/`+` marker and an
 * aria-label as well as the danger/success tint, so colour is never the only
 * signal.
 */
import { useMemo } from 'react';
import type { ObservePromptVersion } from '../../observe/types';
import { lineDiff, sideBySide, type DiffCell } from './lineDiff';

const MARK = { same: ' ', removed: '-', added: '+' } as const;
const SPOKEN = { same: 'Unchanged', removed: 'Removed', added: 'Added' } as const;

function Cell({ cell }: { cell: DiffCell | undefined }) {
  if (!cell) {
    return (
      <>
        <td className="prompt-diff-num" />
        <td className="prompt-diff-pad" />
      </>
    );
  }
  return (
    <>
      <td className="prompt-diff-num">{cell.n}</td>
      <td
        className={`prompt-diff-line prompt-diff-${cell.kind}`}
        aria-label={cell.kind === 'same' ? undefined : `${SPOKEN[cell.kind]} line ${cell.n}: ${cell.text}`}
      >
        <span className="prompt-diff-mark" aria-hidden="true">
          {MARK[cell.kind]}
        </span>
        {cell.text}
      </td>
    </>
  );
}

export function PromptDiff({ a, b }: { a: ObservePromptVersion; b: ObservePromptVersion }) {
  const { rows, wholeBlock, changed } = useMemo(() => {
    const diff = lineDiff(a.text ?? '', b.text ?? '');
    return { rows: sideBySide(diff.lines), wholeBlock: diff.wholeBlock, changed: diff.lines.some((l) => l.kind !== 'same') };
  }, [a, b]);

  return (
    <div className="prompt-diff-wrap">
      {wholeBlock && <p className="prompt-note">These versions are too long to diff line by line; showing the whole changed block.</p>}
      {!changed && <p className="prompt-note">Version {a.version} and version {b.version} have the same text.</p>}
      <table className="prompt-diff">
        <caption className="visually-hidden">
          Diff of version {a.version} against version {b.version}
        </caption>
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
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <Cell cell={row.left} />
              <Cell cell={row.right} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
