/** Stand-in for a screen that has a nav item but no content yet: what it is, what's coming, and a way back. */
export function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="screen-placeholder">
      <h2>{title}</h2>
      <p>{blurb}</p>
      <a href="#/agents">Back to Agents</a>
    </div>
  );
}
