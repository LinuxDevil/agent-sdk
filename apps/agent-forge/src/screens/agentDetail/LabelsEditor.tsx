/**
 * The detail header's labels fact (A09): up to three label chips plus a
 * "+N" overflow, a "No labels" fallback and an Edit button opening the
 * labels dialog. The dialog edits a draft chip list (Enter/comma adds through
 * `addLabels`, Backspace on an empty input removes the last chip, paste with
 * commas adds all) and Save PATCHes `meta.labels`.
 */
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Pencil, Tag, X } from 'lucide-react';

import type { AgentRecord } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { useAgentDetail } from './AgentDetailContext';
import { addLabels } from './labels';

const MAX_SHOWN_LABELS = 3;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Props for {@link HeaderLabels}. */
export interface HeaderLabelsProps {
  record: AgentRecord;
}

/**
 * The last `ul.agent-detail-facts` item: the `Labels:` fact with up to three
 * chips, a "+N" chip for the rest and the Edit labels button + dialog.
 */
export function HeaderLabels({ record }: HeaderLabelsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const labels = record.meta.labels;
  const shown = labels.slice(0, MAX_SHOWN_LABELS);
  const rest = labels.slice(MAX_SHOWN_LABELS);

  return (
    <li className="agent-detail-fact agent-detail-fact-labels">
      <Tag size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="visually-hidden">Labels: </span>
      {labels.length > 0 ? (
        <ul className="agent-detail-labels">
          {shown.map((label) => (
            <li key={label} className="agent-detail-label">
              {label}
            </li>
          ))}
          {rest.length > 0 ? (
            <li className="agent-detail-label-more" title={rest.join(', ')}>
              {`+${rest.length}`}
            </li>
          ) : null}
        </ul>
      ) : (
        <span className="value-missing">No labels</span>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label="Edit labels"
        title="Edit labels"
        onClick={() => setOpen(true)}
      >
        <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <LabelsDialog record={record} open={open} onClose={() => setOpen(false)} />
    </li>
  );
}

/** Props for the labels dialog inside {@link HeaderLabels}. */
interface LabelsDialogProps {
  record: AgentRecord;
  open: boolean;
  onClose(): void;
}

/** The "Edit labels" dialog: a chip input over a draft list plus Cancel/Save. */
function LabelsDialog({ record, open, onClose }: LabelsDialogProps): JSX.Element {
  const { setRecord } = useAgentDetail();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const [draft, setDraft] = useState<string[]>(() => [...record.meta.labels]);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const saved = record.meta.labels;

  // Re-seed the draft each time the dialog opens.
  const wasOpen = useRef(open);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) {
      setDraft([...saved]);
      setText('');
      setProblem(undefined);
      setSaving(false);
    }
  }

  const unchanged = draft.length === saved.length && draft.every((label, i) => label === saved[i]);

  const focusInput = () => inputRef.current?.focus();

  const commit = (raw: string) => {
    const result = addLabels(draft, raw);
    setDraft(result.labels);
    setProblem(result.problem);
    setText('');
    focusInput();
  };

  const remove = (label: string) => setDraft((prev) => prev.filter((l) => l !== label));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(text);
    } else if (event.key === 'Backspace' && text === '') {
      setDraft((prev) => prev.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!pasted.includes(',')) return;
    event.preventDefault();
    commit(pasted);
  };

  const onInputClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget || (event.target as HTMLElement).closest('.labels-input-field') === null) {
      focusInput();
    }
  };

  const save = async () => {
    if (saving || unchanged) return;
    setSaving(true);
    try {
      const meta = await runtimeClient.patchAgentMeta(record.id, { labels: draft });
      setRecord({ ...record, meta });
      toast.show({ message: 'Labels saved', tone: 'success' });
      onClose();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit labels"
      description="Labels group agents on the list and in filters. Lowercase, up to 20."
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={unchanged || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="labels-input" role="group" aria-label="Labels" onClick={onInputClick}>
        {draft.map((label) => (
          <span key={label} className="labels-chip">
            {label}
            <button
              type="button"
              className="labels-chip-remove"
              aria-label={`Remove label ${label}`}
              onClick={() => remove(label)}
            >
              <X size={12} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="labels-input-field"
          type="text"
          value={text}
          placeholder={draft.length > 0 ? '' : 'Add a label'}
          aria-label="Add a label"
          aria-describedby={problem !== undefined ? problemId : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(undefined);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      {problem !== undefined ? (
        <p className="hint field-error" id={problemId} role="alert">
          {problem}
        </p>
      ) : null}
    </Dialog>
  );
}
