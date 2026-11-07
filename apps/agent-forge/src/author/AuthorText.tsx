import { Fragment, type ReactNode } from 'react';

type Block = { type: 'text' | 'code'; text: string };

/**
 * Splits model text on ``` fences. Odd segments are fenced code; the
 * fence's optional language tag (everything to the first newline) is
 * dropped. An unclosed trailing fence - normal mid-stream - still opens a
 * code block, so partial code renders as code instead of swallowing text.
 */
function blocks(text: string): Block[] {
  const segments = text.split('```');
  const out: Block[] = [];
  for (const [i, seg] of segments.entries()) {
    if (i % 2 === 0) {
      if (seg.trim() !== '') out.push({ type: 'text', text: seg });
      continue;
    }
    const nl = seg.indexOf('\n');
    out.push({ type: 'code', text: nl === -1 ? seg : seg.slice(nl + 1) });
  }
  return out;
}

/**
 * One paragraph of plain text with `backtick` spans as <code>. Every
 * segment is a React text child - model output is never treated as HTML.
 */
function inlineCode(text: string): ReactNode[] {
  return text.split('`').map((seg, i) => {
    if (i % 2 === 1) return <code key={i}>{seg}</code>;
    return seg === '' ? null : <Fragment key={i}>{seg}</Fragment>;
  });
}

/**
 * Renders assistant text as plain markup: paragraphs on blank lines,
 * fenced blocks as `pre.author-code`, `inline code` as `code`. Deliberately
 * not markdown - no HTML injection path, no new dependency. Single
 * newlines inside a paragraph render via `white-space: pre-wrap`.
 */
export function AuthorText({ text }: { text: string }): JSX.Element {
  return (
    <div className="author-text">
      {blocks(text).map((block, i) =>
        block.type === 'code' ? (
          <pre key={i} className="author-code">
            <code>{block.text}</code>
          </pre>
        ) : (
          block.text
            .split(/\n\s*\n/)
            .filter((p) => p.trim() !== '')
            .map((p, j) => <p key={`${i}-${j}`}>{inlineCode(p)}</p>)
        )
      )}
    </div>
  );
}
