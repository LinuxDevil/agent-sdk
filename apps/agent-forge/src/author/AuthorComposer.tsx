import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, Square, X } from 'lucide-react';
import type { AuthorChat } from './AuthorChatContext';
import type { AuthorChatState } from './authorChatReducer';
import type { AuthorFocus, AuthorMessage } from '../../shared/authorWire';
import { ErrorNote } from './ErrorNote';

/** The textarea never grows past this; longer drafts scroll inside it. */
const MAX_INPUT_HEIGHT = 160;
/** The longest message the composer accepts (matches the server's cap). */
const MAX_MESSAGE_CHARS = 20_000;

/** Why send is unavailable, in check order; `undefined` means it can send. */
function sendBlockReason(state: AuthorChatState, text: string): string | undefined {
  // A missing key is the deepest block - name it before the empty-text nudge.
  if (state.setup?.ready === false) return 'Add an API key in Settings first';
  if (text.trim() === '') return 'Type a message first';
  if (state.connection === 'reconnecting' || state.connection === 'closed') return 'Reconnecting to Studio…';
  return undefined;
}

/** The last text the user actually sent (uiEvent rows carry none) - the "Try again" resend. */
function lastUserText(messages: readonly AuthorMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user' && m.uiEvent === undefined && m.text.trim() !== '') return m.text;
  }
  return undefined;
}

/**
 * The ErrorNote's action for `state.error`: a mid-turn death (`retry`)
 * offers "Try again", resending the last user text; send refusals and the
 * reattach give-up get no action - the draft is already restored or the
 * note is informational only.
 */
function retryAction(chat: AuthorChat): { label: string; onClick(): void } | undefined {
  const error = chat.state.error;
  if (error === null || error.retry !== true) return undefined;
  const text = lastUserText(chat.state.messages);
  if (text === undefined) return undefined;
  return {
    label: 'Try again',
    onClick: () => {
      chat.dismissError();
      chat.send(text);
    },
  };
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
 * `disabledReason` locks the whole composer (the History view's "Close
 * history to keep chatting"): the textarea greys out with the reason and
 * send is blocked the same way.
 */
export function AuthorComposer({ chat, disabledReason }: { chat: AuthorChat; disabledReason?: string }): JSX.Element {
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

  const reason = disabledReason ?? sendBlockReason(state, value);

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
        disabled={disabledReason !== undefined || state.setup?.ready === false}
        title={disabledReason}
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
        <div className="author-error">
          <ErrorNote message={state.error.message} action={retryAction(chat)} />
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => chat.dismissError()}>
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}
    </form>
  );
}
