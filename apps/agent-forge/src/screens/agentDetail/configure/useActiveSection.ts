import { useEffect } from 'react';

import { CONFIGURE_SECTIONS } from './sections';

/**
 * `aria-current` follows the section card nearest the top of the viewport
 * (A07): an IntersectionObserver over the `configure-<id>` anchors picks
 * the intersecting card with the smallest top offset. Without
 * IntersectionObserver (jsdom, old browsers) the last index click wins and
 * this hook does nothing.
 */
export function useActiveSection(setActiveId: (id: string) => void): void {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const targets = CONFIGURE_SECTIONS.map((section) =>
      document.getElementById(`configure-${section.id}`),
    ).filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const tops = new Map<Element, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) tops.set(entry.target, entry.boundingClientRect.top);
          else tops.delete(entry.target);
        }
        let best: Element | undefined;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const [el, top] of tops) {
          if (top < bestTop) {
            bestTop = top;
            best = el;
          }
        }
        if (best !== undefined) setActiveId(best.id.slice('configure-'.length));
      },
      { rootMargin: '-64px 0px -75% 0px', threshold: 0 },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [setActiveId]);
}
