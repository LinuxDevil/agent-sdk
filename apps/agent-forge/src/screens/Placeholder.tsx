import type { ReactNode } from 'react';

/** Stand-in for a screen that has a nav item but no content yet: what it is, what's coming, and a way back; `nav` is an optional sub-navigation above it. */
export function Placeholder({ title, blurb, nav }: { title: string; blurb: string; nav?: ReactNode }) {
  return (
    <div className="screen-placeholder">
      {nav}
      <h2>{title}</h2>
      <p>{blurb}</p>
      <a href="#/agents">Back to Agents</a>
    </div>
  );
}
