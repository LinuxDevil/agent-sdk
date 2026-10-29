import { useLayoutEffect, useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { useAppState } from '../state/AppState';

/** The composer grows with its text up to this many lines, then scrolls. */
const MAX_LINES = 8;

function placeholderFor(viewing: boolean, isPausedForApproval: boolean): string {
  if (viewing) return 'Return to the live chat to send a message';
  if (isPausedForApproval) return 'Resolve the approval above to continue';
  return 'Message this agent...';
}

/** Fits the textarea's height to its content, capped at MAX_LINES lines. */
function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const max = lineHeight * MAX_LINES + chrome;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);
  return ref;
}

export interface ChatComposerProps {
  viewing: boolean;
  isPausedForApproval: boolean;
  inputDisabled: boolean;
}

/**
 * The Chat tab's composer: a rounded card holding a textarea that grows
 * with its text (up to eight lines), the accent Send icon button, and a
 * "Shift+Enter for newline" hint. Enter sends; Shift+Enter adds a line.
 */
export function ChatComposer({ viewing, isPausedForApproval, inputDisabled }: ChatComposerProps) {
  const { sendChatMessage } = useAppState();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useAutosize(input);

  async function handleSend() {
    const text = input.trim();
    if (!text || inputDisabled) return;
    setSending(true);
    try {
      await sendChatMessage(text);
      setInput('');
    } catch {
      // chatActionError already surfaces this - keep the draft so the user can retry.
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="chat-composer">
      <div className={`chat-input-row${inputDisabled ? ' disabled' : ''}`}>
        <textarea
          ref={textareaRef}
          aria-label="Message"
          className="chat-input"
          rows={1}
          placeholder={placeholderFor(viewing, isPausedForApproval)}
          value={input}
          disabled={inputDisabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="btn btn-primary btn-icon btn-send"
          aria-label="Send"
          title="Send (Enter)"
          onClick={() => void handleSend()}
          disabled={inputDisabled || sending || !input.trim()}
        >
          <SendHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="chat-hint">
        <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline
      </div>
    </div>
  );
}
