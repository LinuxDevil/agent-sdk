/**
 * One selected Context Hub entry: its full value (JSON through JsonView, any
 * other string preformatted) and, for a fleet entry, the "Edit" inline editor.
 *
 * Saving republishes the entry as its writer (`POST /api/v1/hub` with the
 * entry's own `agent_id`, scope `fleet` and original `ttl`) through the studio
 * proxy's write allowlist. The daemon resets `created_at` on every publish, so
 * an edit restarts the TTL clock - the editor says so next to the TTL.
 */
import { useState } from 'react';
import { observeClient } from '../../observe/observeClient';
import type { ObserveHubEntry } from '../../observe/types';
import { JsonView } from '../../ui/JsonView';
import { useToast } from '../../ui/Toast';
import { editableText, fmtSpan, parseEditedValue, parseValue } from './hubModel';

function ValueView({ value }: { value: string | null }) {
  const parsed = parseValue(value);
  return (
    <div className="hub-value">
      {parsed.json ? <JsonView value={parsed.parsed} /> : <pre className="hub-value-text">{parsed.text}</pre>}
    </div>
  );
}

function Editor({
  entry,
  writer,
  onClose,
  onSaved,
}: {
  entry: ObserveHubEntry & { agent_id: string };
  writer: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const wasJson = parseValue(entry.value).json;
  const [text, setText] = useState(() => editableText(entry.value));
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsed = parseEditedValue(text, wasJson);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setSaving(true);
    try {
      await observeClient.publishHubEntry({
        agent_id: entry.agent_id,
        namespace: entry.namespace,
        key: entry.key,
        value: parsed.value,
        scope: 'fleet',
        ...(entry.ttl === null ? {} : { ttl: entry.ttl }),
      });
      toast.show({ tone: 'success', message: `Saved ${entry.key}.` });
      onSaved();
      onClose();
    } catch (error) {
      toast.show({ tone: 'error', message: `Could not save ${entry.key}: ${(error as Error).message}` });
      setSaving(false);
    }
  };

  const ttlNote =
    entry.ttl === null
      ? 'No TTL: the entry does not expire.'
      : `TTL ${fmtSpan(entry.ttl)}. Saving restarts the TTL clock: the entry expires ${fmtSpan(entry.ttl)} after the save.`;

  return (
    <form
      className="hub-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="hub-editor-label" htmlFor={`hub-edit-${entry.entry_id}`}>
        Value (republished as {writer}, scope fleet)
      </label>
      <textarea
        id={`hub-edit-${entry.entry_id}`}
        className="hub-editor-text"
        value={text}
        rows={Math.min(16, Math.max(4, text.split('\n').length + 1))}
        aria-invalid={invalid || undefined}
        aria-describedby={`hub-edit-${entry.entry_id}-note`}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
      />
      <p className="hub-note" id={`hub-edit-${entry.entry_id}-note`}>
        {invalid && <span className="hub-invalid" role="alert">This entry holds JSON; the text does not parse. </span>}
        {ttlNote}
      </p>
      <div className="hub-editor-actions">
        <button type="submit" className="btn" disabled={saving}>
          Save
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The selected entry's value and, for a fleet entry with a known writer, the Edit affordance. */
export function HubEntryDetail({ entry, writer, onSaved }: { entry: ObserveHubEntry; writer: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const editable = entry.scope === 'fleet' && entry.agent_id !== null;
  return (
    <section className="hub-entry" aria-label={`Entry ${entry.key}`}>
      <div className="hub-entry-head">
        <h3 className="hub-section-title">
          <code>{entry.key}</code>
        </h3>
        {editable && !editing && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing && editable ? (
        <Editor entry={{ ...entry, agent_id: entry.agent_id! }} writer={writer} onClose={() => setEditing(false)} onSaved={onSaved} />
      ) : (
        <ValueView value={entry.value} />
      )}
    </section>
  );
}
