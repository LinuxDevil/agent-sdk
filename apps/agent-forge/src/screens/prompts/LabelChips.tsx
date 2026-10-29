import { Tag } from 'lucide-react';

/** The chip tone of a label: `production` is violet, `latest` neutral, every other label the accent. */
const toneOf = (label: string): 'violet' | 'neutral' | 'accent' =>
  label === 'production' ? 'violet' : label === 'latest' ? 'neutral' : 'accent';

/**
 * A prompt version's labels as chips; nothing when it has none. A labelled
 * list by default; `inline` renders plain spans, for use inside a button.
 */
export function LabelChips({ labels, inline = false }: { labels: readonly string[]; inline?: boolean }) {
  if (labels.length === 0) return null;
  const List = inline ? 'span' : 'ul';
  const Item = inline ? 'span' : 'li';
  return (
    <List className="prompt-labels" aria-label={inline ? undefined : 'Labels'}>
      {labels.map((label) => (
        <Item key={label} className={`prompt-label prompt-label-${toneOf(label)}`}>
          <Tag size={12} strokeWidth={1.75} aria-hidden="true" />
          {label}
        </Item>
      ))}
    </List>
  );
}
