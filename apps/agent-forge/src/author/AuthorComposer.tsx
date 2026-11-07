import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, Square, X } from 'lucide-react';
import type { AuthorChat } from './AuthorChatContext';
import type { AuthorChatState } from './authorChatReducer';
import type { AuthorFocus } from '../../shared/authorWire';

/** The textarea never grows past this; longer drafts scroll inside it. */
const MAX_INPUT_HEIGHT = 160;
/** The longest message the composer accepts (matches the server's cap). */
const MAX_MESSAGE_CHARS = 20_000;

/** Why send is unavailable, in check order; `undefined` means it can send. */
function sendBlockReason(state: AuthorChatState, text: string): string | undefined {
  if (text.trim() === '') return 'Type a message first';
  if (state.connection === 'reconnecting' || state.connection === 'closed') return 'Reconnecting to Studio…';
  if (state.setup?.ready === false) return 'Add an API key in Settings first';
  return undefined;
}

/** The "what am I working on" chip above the input: the session focus or "New agent". */
function FocusChip({ focus, onClear }: { focus: AuthorFocus; onClear: () => void }): JSX.Element {
  if (focus.mode !== 'edit') {
    return (
      <div className="author-focus">
        <span className="author-focus-chip author-focus-chip--create">New agent</span>
      </div>
    );
  }
  return (
    <div className="author-focus">
      <span className="author-focus-chip">
        Editing: <strong>{focus.agentId}</strong>
        <button type="button" className="author-focus-clear" aria-label="Start a new agent instead" onClick={onClear}>
          <X size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

/**
 * The composer's card: focus chip, auto-growing textarea (Enter sends,
 * Shift+Enter adds a line), the hint/send-stop bar and the error strip. A
 * refused send's text comes back through `restoreDraft`. Draft state is
 * local to the card - it is typing, not conversation state.
 */
export function AuthorComposer({ chat }: { chat: AuthorChat }): JSX.Element {
  const { state } = chat;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A refused send (offline, busy, no provider key) puts its text back.
  useEffect(() => {
    if (state.restoreDraft !== null) setValue(state.restoreDraft);
  }, [state.restoreDraft]);

  function grow(): void {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }

  const reason = sendBlockReason(state, value);

  function trySend(): void {
    const text = value.trim();
    if (chat.isStreaming || reason !== undefined || text === '') return;
    setValue('');
    const el = inputRef.current;
    if (el !== null) el.style.height = 'auto';
    chat.send(text);
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    trySend();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      trySend();
    }
  }

  return (
    <form className="author-composer" onSubmit={onSubmit}>
      <FocusChip focus={state.focus} onClear={() => chat.setFocus({ mode: 'create' })} />
      <textarea
        ref={inputRef}
        className="author-input"
        rows={1}
        maxLength={MAX_MESSAGE_CHARS}
        aria-label="Message the Agent Author"
        placeholder="Describe an agent or a change…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          grow();
        }}
        onKeyDown={onKeyDown}
      />
      <div className="author-composer-bar">
        <span className="author-hint">Enter to send · Shift+Enter for a new line</span>
        {chat.isStreaming ? (
          <button type="button" className="author-stop" aria-label="Stop the reply" onClick={() => chat.stop()}>
            <Square size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="author-send" aria-label="Send" disabled={reason !== undefined} title={reason}>
            <ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
      {state.error !== null && (
        <div className="author-error" role="alert">
          <span>{state.error.message}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => chat.dismissError()}>
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
    </form>
  );
}
