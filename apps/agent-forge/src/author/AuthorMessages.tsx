import { Fragment } from 'react';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  AuthorUiEvent,
  AuthorUserMessage,
} from '../../shared/authorWire';
import type { AuthorChat } from './AuthorChatContext';
import type { ActiveTurn } from './authorChatReducer';
import { ActivityLine } from './ActivityLine';
import { AuthorText } from './AuthorText';
import { renderToolPart } from './toolRenderers';

/** The quiet end-of-turn notes keyed by `finishReason`; 'error' and normal ends show no note. */
const TURN_NOTES: Record<string, string> = {
  'max-steps': 'The Author stopped after 12 steps. Send a message to let it continue.',
  stopped: 'Stopped.',
  tool_input_cap: 'The Author stopped because a step kept failing. Try rephrasing your request.',
};

/** What an app-written `uiEvent` user message reads as in the log (never the model's words). */
function eventCopy(uiEvent: AuthorUiEvent): string {
  if (uiEvent.kind === 'save') {
    return `You applied the proposal · saved as version ${uiEvent.version}`;
  }
  return uiEvent.outcome === 'saved' ? `You saved ${uiEvent.name}` : `You skipped ${uiEvent.name}`;
}

function UserRow({ message }: { message: AuthorUserMessage }): JSX.Element {
  if (message.uiEvent !== undefined) {
    return (
      <li className="author-msg author-msg--event">
        <p className="author-event">{eventCopy(message.uiEvent)}</p>
      </li>
    );
  }
  return (
    <li className="author-msg author-msg--user">
      <div className="author-bubble">{message.text}</div>
    </li>
  );
}

function ToolPart({ message, part, chat, live }: {
  message: AuthorAssistantMessage;
  part: AuthorToolPart;
  chat: AuthorChat;
  live: boolean;
}): JSX.Element {
  // Registry first (AA16/AA17 cards): `undefined` means no card, so the
  // quiet line draws; `null` means deliberately hidden (a draft-review
  // bounce), so nothing draws.
  const rendered = renderToolPart(part, { message, chat, live });
  return rendered === undefined ? <ActivityLine part={part} /> : <Fragment>{rendered}</Fragment>;
}

function AssistantRow({ message, chat, live }: { message: AuthorAssistantMessage; chat: AuthorChat; live: boolean }): JSX.Element {
  const note = message.finishReason === undefined ? undefined : TURN_NOTES[message.finishReason];
  return (
    <li className="author-msg author-msg--assistant">
      {message.parts.map((part, i) =>
        part.type === 'text' ? (
          <AuthorText key={i} text={part.text} />
        ) : (
          <ToolPart key={part.toolCallId} message={message} part={part} chat={chat} live={live} />
        )
      )}
      {note !== undefined && (
        <p className="author-turn-note" data-reason={message.finishReason}>
          {note}
        </p>
      )}
    </li>
  );
}

/**
 * The `<ol>` of settled messages plus the live turn's in-progress
 * assistant message (its parts stream in through `active`). The live
 * message renders exactly like a settled one so a reconnecting replay and
 * a fresh stream look identical.
 */
export function AuthorMessages({
  messages,
  active,
  chat,
}: {
  messages: AuthorMessage[];
  active: ActiveTurn | null;
  chat: AuthorChat;
}): JSX.Element {
  return (
    <ol className="author-messages">
      {messages.map((message) =>
        message.role === 'user' ? (
          <UserRow key={message.id} message={message} />
        ) : (
          <AssistantRow key={message.id} message={message} chat={chat} live={false} />
        )
      )}
      {active !== null && active.assistant.parts.length > 0 && (
        <AssistantRow message={active.assistant} chat={chat} live />
      )}
    </ol>
  );
}
