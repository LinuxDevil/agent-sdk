/**
 * The `requestSecret` card (AA14, research §1.7): the one place a secret
 * value is ever typed, and the reason the Author can ask for credentials
 * without ever seeing them. The input is UNCONTROLLED - the value lives
 * only in the DOM node until submit pulls it into the `POST
 * /assistant/sessions/:id/secret` body (`chat.submitSecret`), which writes
 * it straight into Studio's encrypted secrets store. It never lands in
 * React state, the transcript, the WS stream, or localStorage.
 *
 * The part's output picks the render: a `status:'pending'` output on a
 * still-pending part draws the form; `saved`/`exists`/`DECLINED` outputs
 * draw the one-line result. Busy parts and real failures never reach the
 * component - the renderer falls back to the ActivityLine for those.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Check, KeyRound } from 'lucide-react';
import type { AuthorToolPart, RequestSecretOutput } from '../../shared/authorWire';
import { RuntimeApiError } from '../runtime/runtimeClient';
import { Input } from '../ui/controls';
import type { AuthorChat } from './AuthorChatContext';
import './authorCards.css';

/** Props for {@link SecretCard}. */
export interface SecretCardProps {
  /** The `requestSecret` tool part: `input` is `{ name, why }`, `output` decides form vs done line. */
  part: AuthorToolPart;
  chat: AuthorChat;
}

/** The card's id base: `secret-{toolCallId}-title` / `-value`. */
function idBase(part: AuthorToolPart): string {
  return `secret-${part.toolCallId}`;
}

/** The secret's name from the request input (the tool schema guarantees it; '' when absent). */
function nameOf(part: AuthorToolPart): string {
  const name = (part.input as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
}

/** What a rejected `POST .../secret` says on the card; NOT_PENDING means the card went stale. */
function errorCopy(cause: unknown): string {
  if (cause instanceof RuntimeApiError) {
    if (cause.code === 'NOT_PENDING') return 'This card has expired. Ask the Author to request it again.';
    return cause.message;
  }
  return cause instanceof Error ? cause.message : 'The secret could not be saved. Try again.';
}

/**
 * The settled outcomes, as the card's one-line states. `undefined` means
 * "not a settled output the card owns" - the caller falls back to the
 * activity line.
 */
function doneLine(part: AuthorToolPart): { text: string; skipped: boolean } | undefined {
  const output = part.output as RequestSecretOutput | undefined;
  if (output === undefined) return undefined;
  const name = typeof output.name === 'string' && output.name !== '' ? output.name : nameOf(part);
  if (output.ok === true && output.status === 'saved') return { text: `${name} saved`, skipped: false };
  if (output.ok === true && output.status === 'exists') return { text: `${name} is already set`, skipped: false };
  if (output.ok === false && output.code === 'DECLINED') return { text: `Skipped ${name}`, skipped: true };
  return undefined;
}

/** Why Save is unavailable, in check order; `undefined` means it can submit. */
function saveBlockReason(hasValue: boolean, streaming: boolean): string | undefined {
  if (!hasValue) return 'Enter a value first';
  if (streaming) return 'Wait for the Author to finish replying';
  return undefined;
}

/**
 * One secure card: the settled outcomes read as one-line states and a
 * still-pending part draws {@link SecretForm}.
 */
export function SecretCard({ part, chat }: SecretCardProps): JSX.Element {
  const done = doneLine(part);
  if (done === undefined) return <SecretForm part={part} chat={chat} />;
  return (
    <p className={done.skipped ? 'secret-card-done secret-card-done--skipped' : 'secret-card-done'}>
      {!done.skipped && <Check size={16} strokeWidth={1.75} aria-hidden="true" />}
      {done.text}
    </p>
  );
}

/**
 * The pending card's form. Save posts the input's current value and
 * clears the field BEFORE the request resolves; Skip answers the card
 * with `null` (the server's `declined`). Save and Skip are disabled with
 * a reason (`title`) while the field is empty or a reply streams - the
 * route refuses submits mid-turn with BUSY.
 */
function SecretForm({ part, chat }: SecretCardProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  // `hasValue` tracks only whether the field is non-empty - never the value.
  const [hasValue, setHasValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streaming = chat.isStreaming;
  const name = nameOf(part);
  const why = (part.input as { why?: unknown } | undefined)?.why;
  const base = idBase(part);
  const saveBlock = saveBlockReason(hasValue, streaming);
  const waitReason = streaming ? 'Wait for the Author to finish replying' : undefined;

  async function answer(value: string | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await chat.submitSecret(part.toolCallId, name, value);
    } catch (cause) {
      setError(errorCopy(cause));
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const el = inputRef.current;
    if (saving || el === null || el.value.trim() === '' || streaming) return;
    // Read the value, then blank the field before awaiting: the value
    // exists in this frame and in the POST body, nowhere else.
    const value = el.value;
    el.value = '';
    setHasValue(false);
    void answer(value);
  }

  return (
    <form className="secret-card" aria-labelledby={`${base}-title`} autoComplete="off" onSubmit={onSubmit}>
      <p className="secret-card-title" id={`${base}-title`}>
        <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
        Enter {name}
      </p>
      {typeof why === 'string' && why !== '' && <p className="secret-card-why">{why}</p>}
      <label className="field-label" htmlFor={`${base}-value`}>
        Value
      </label>
      <Input
        ref={inputRef}
        id={`${base}-value`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setHasValue(e.currentTarget.value.trim() !== '')}
      />
      <p className="secret-card-note">
        Stored encrypted in Studio's secrets store on this machine. The Author never sees the value.
      </p>
      <div className="secret-card-actions">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={saving || saveBlock !== undefined}
          title={saveBlock}
        >
          {saving ? 'Saving…' : 'Save secret'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={saving || streaming}
          title={waitReason}
          onClick={() => void answer(null)}
        >
          Skip
        </button>
      </div>
      {error !== null && (
        <p className="secret-card-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
