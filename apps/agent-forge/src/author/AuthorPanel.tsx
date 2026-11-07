import './authorPanel.css';
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type UIEvent,
} from 'react';
import { ArrowUpRight, History, Sparkles, SquarePen, X } from 'lucide-react';
import type { AuthorFocus } from '../../shared/authorWire';
import { navigate } from '../router/router';
import { useAuthorChat } from './AuthorChatContext';
import { onOpenPage } from './authorEvents';
import { useAuthorDock } from './authorDock';
import { AuthorComposer } from './AuthorComposer';
import { AuthorMessages } from './AuthorMessages';

/** Past this many px from the bottom, autoscroll leaves the user alone. */
const SCROLL_PIN_PX = 80;

const CREATE_SUGGESTIONS = [
  'Create an agent that triages new GitHub issues and labels them',
  'Create an agent that answers questions from our docs',
  'Create an agent that summarises my inbox every morning',
];

const EDIT_SUGGESTIONS = [
  'What does this agent do?',
  'Add a guardrail that keeps personal data out of replies',
  'Why did the last run fail?',
];

/** The blank slate: a mark, one line of intent, and three focus-appropriate starts that send on click. */
function EmptyConversation({ focus, onSuggest }: { focus: AuthorFocus; onSuggest: (text: string) => void }): JSX.Element {
  return (
    <div className="author-empty">
      <div className="author-empty-mark">
        <Sparkles size={24} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <p className="author-empty-title">What should we build?</p>
      <p className="author-empty-hint">
        Describe an agent, or ask for a change to this one. Every change is a proposal you review before anything is
        saved.
      </p>
      <ul className="author-suggestions">
        {(focus.mode === 'edit' ? EDIT_SUGGESTIONS : CREATE_SUGGESTIONS).map((suggestion) => (
          <li key={suggestion}>
            <button type="button" className="author-suggestion" onClick={() => onSuggest(suggestion)}>
              {suggestion}
              <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keeps the log pinned to the newest content unless the user scrolled up more than SCROLL_PIN_PX. */
function usePinnedScroll(): { bodyRef: RefObject<HTMLDivElement>; onScroll(e: UIEvent<HTMLDivElement>): void; pin(): void } {
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  return {
    bodyRef,
    onScroll(e) {
      const el = e.currentTarget;
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_PX;
    },
    pin() {
      const el = bodyRef.current;
      if (el !== null && pinnedRef.current) el.scrollTop = el.scrollHeight;
    },
  };
}

/**
 * The docked Agent Author panel: header (title, connection, actions), the
 * conversation log (blank slate or messages + live turn), and the
 * composer. State lives in `useAuthorChat` above the dock, so closing the
 * panel pauses nothing. Esc stops a streaming reply; otherwise it bubbles
 * to the Dock, which closes the panel and returns focus to the opener.
 */
export function AuthorPanel(): JSX.Element {
  const chat = useAuthorChat();
  const dock = useAuthorDock();
  const { state } = chat;
  const { bodyRef, onScroll, pin } = usePinnedScroll();

  // A live openPage tool.result moves the app; replays never reach this
  // (the provider only fires `onOpenPage` outside reattach passes).
  useEffect(() => onOpenPage(navigate), []);

  useEffect(pin);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && chat.isStreaming) {
      e.preventDefault(); // the Dock sees defaultPrevented and stays open
      chat.stop();
    }
  };

  const conn = state.connection === 'reconnecting' || state.connection === 'closed' ? state.connection : null;
  const empty = state.messages.length === 0 && (state.active === null || state.active.assistant.parts.length === 0);

  return (
    <section className="author-panel" aria-label="Agent Author" onKeyDown={onKeyDown}>
      <header className="author-header">
        <Sparkles className="author-header-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
        <h2 className="author-title" title={state.title}>
          {state.title}
        </h2>
        {conn !== null && (
          <span className="author-conn" data-state={conn} role="status">
            {conn === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
          </span>
        )}
        <div className="author-header-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="New chat"
            title={state.saving !== null ? 'Wait for the save to finish' : 'New chat'}
            disabled={state.saving !== null}
            onClick={() => chat.newChat(state.focus)}
          >
            <SquarePen size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn author-history-btn"
            aria-label="Chat history"
            aria-pressed={false}
            hidden
          >
            <History size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close Agent Author"
            title="Close (Ctrl+J)"
            onClick={() => dock.setOpen(false)}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div ref={bodyRef} className="author-body" role="log" aria-live="polite" aria-label="Conversation" onScroll={onScroll}>
        {empty ? (
          <EmptyConversation focus={state.focus} onSuggest={(text) => chat.send(text)} />
        ) : (
          <AuthorMessages messages={state.messages} active={state.active} chat={chat} />
        )}
      </div>
      <AuthorComposer chat={chat} />
    </section>
  );
}
