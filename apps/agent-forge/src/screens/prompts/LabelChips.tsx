/** A prompt version's labels as chips; nothing when it has none. */
export function LabelChips({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="prompt-labels" aria-label="Labels">
      {labels.map((label) => (
        <li key={label} className="prompt-label">
          {label}
        </li>
      ))}
    </ul>
  );
}
