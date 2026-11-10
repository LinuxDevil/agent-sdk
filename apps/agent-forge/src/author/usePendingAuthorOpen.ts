import { useEffect, useRef, type RefObject } from 'react';
import type { AuthorChat } from './AuthorChatContext';
import type { AuthorComposerHandle } from './AuthorComposer';
import { takePendingOpen, usePendingOpenVersion } from './authorEntry';

/**
 * AA19's pending opens, consumed by the docked panel. Every `openAuthor`
 * bumps the store version, so an entry point clicked while the panel is
 * already open still lands here. The request is taken once: an optional new
 * chat (the chat itself refuses while a save runs), the focus, a draft into
 * an *empty* composer only (never sent), then composer focus unless the
 * request opted out.
 */
export function usePendingAuthorOpen(chat: AuthorChat, composerRef: RefObject<AuthorComposerHandle | null>): void {
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const openVersion = usePendingOpenVersion();
  useEffect(() => {
    const request = takePendingOpen();
    if (request === null) return;
    const current = chatRef.current;
    const hasConversation = current.state.messages.length > 0 || current.state.active !== null;
    if (request.newChat === true && hasConversation) current.newChat(request.focus);
    if (request.focus !== undefined) current.setFocus(request.focus);
    if (request.draft !== undefined) composerRef.current?.placeDraft(request.draft);
    if (request.focusComposer !== false) composerRef.current?.focusInput();
  }, [openVersion, composerRef]);
}
