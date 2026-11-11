/**
 * Scrolls the proposal card `data-proposal-id="{id}"` to centre and moves
 * focus to its title (the heading takes `tabIndex=-1` for the visit).
 * Reduced motion swaps the smooth scroll for a jump. Shared by the
 * save-error "Show the newer proposal" escape hatch (proposalRenderers)
 * and AA18's canvas pill / dashed-node clicks - the card only exists in
 * the DOM while the Author dock is open, so callers open the dock first
 * and retry on the next tick when needed.
 */
export function focusProposalCard(id: string): boolean {
  const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"');
  const el = document.querySelector(`[data-proposal-id="${esc}"]`);
  if (el === null) return false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  const heading = el.querySelector('h3');
  if (heading !== null) {
    heading.tabIndex = -1;
    heading.focus();
  }
  return true;
}
