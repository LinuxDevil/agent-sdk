/**
 * A thread turn's message, clamped to about 12 lines with a "Show more" /
 * "Show less" toggle once its body overflows. The full text always stays in
 * the DOM (find-in-page and copy see all of it); only the height is capped.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/** True while `el`'s content is taller than its (clamped) box. */
const overflows = (el: HTMLElement | null): boolean => (el ? el.scrollHeight > el.clientHeight + 1 : false);

/**
 * Watches the clamped body (`.mv-body`) inside `ref` for overflow while
 * collapsed: on resize and on any content swap (the preview giving way to
 * the full turn, a Raw/JSON mode switch). Expanded, the last verdict sticks
 * so "Show less" stays.
 */
function useOverflow(ref: React.RefObject<HTMLDivElement>, expanded: boolean): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const root = ref.current;
    if (expanded || !root) return undefined;
    const measure = () => setOver(overflows(root.querySelector<HTMLElement>('.mv-body')));
    measure();
    const mo = new MutationObserver(measure);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    ro?.observe(root);
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, [ref, expanded]);
  return over;
}

/** Wraps one MessageView; `label` names the toggle for assistive tech ("Show more of the output"). */
export function Clamped({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const over = useOverflow(ref, expanded);
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <div ref={ref} className="thread-clamp" data-expanded={expanded} data-overflowing={over}>
      {children}
      {over && (
        <button
          type="button"
          className="btn btn-ghost btn-sm thread-clamp-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Show less' : 'Show more'} of the ${label}`}
          onClick={() => setExpanded((e) => !e)}
        >
          <Icon aria-hidden="true" />
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
