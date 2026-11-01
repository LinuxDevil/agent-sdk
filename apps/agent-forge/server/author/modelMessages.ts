/**
 * Stored Author transcript -> the SDK `Message[]` the Author model sees
 * (PLAN 8.1). Pure: no I/O, no session lookup - the turn runner (AA02b)
 * hands in the persisted `AuthorSession.transcript` and gets back the
 * history to send.
 *
 * Two things make the replay prompt-cache friendly: the transcript never
 * carries a system message (createAgent adds the byte-stable instructions),
 * and a stored user message replays its `turnContext` block verbatim, so a
 * re-rendered history is byte-identical across turns. App-written `uiEvent`
 * messages (button saves, secret cards) arrive as user text starting with
 * `[UI event]` so the model never mistakes them for its own tool calls.
 */
import type { Message, ToolCall } from 'lousho';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  AuthorUiEvent,
  AuthorUserMessage,
} from '../../shared/authorWire';

/** The tool result text a `pending` part replays as: the card is still open and the user is answering it. */
const PENDING_TOOL_CONTENT = JSON.stringify({
  status: 'pending',
  note: 'Waiting for the user to answer the card.',
});

/** The error payload a tool part with `state: 'error'` and no stored output replays as. */
const TOOL_FAILED = { error: 'Tool failed.' };

/** The assistant message being assembled plus the tool parts whose results follow it. */
interface PendingAssistant {
  content: string;
  toolCalls: ToolCall[];
  toolParts: AuthorToolPart[];
}

/** One tool part -> the `{ role: 'tool' }` message answering its call. */
function toolResultMessage(part: AuthorToolPart): Message {
  if (part.state === 'error') {
    return {
      role: 'tool',
      toolCallId: part.toolCallId,
      toolName: part.name,
      content: JSON.stringify(part.output ?? TOOL_FAILED),
      isError: true,
    };
  }
  const content =
    part.state === 'done' ? JSON.stringify(part.output ?? null) : PENDING_TOOL_CONTENT;
  return { role: 'tool', toolCallId: part.toolCallId, toolName: part.name, content };
}

/** Push the current assistant message followed by one tool message per call, in call order. */
function flushToolResults(out: Message[], pending: PendingAssistant): void {
  out.push({ role: 'assistant', content: pending.content, toolCalls: pending.toolCalls });
  for (const part of pending.toolParts) {
    out.push(toolResultMessage(part));
  }
}

/**
 * The ordered parts of one assistant turn -> assistant/tool messages.
 * Consecutive `text` parts join with `''` into the next assistant message's
 * content; a `tool` part appends a `ToolCall` to the current assistant
 * message (created when needed); a `text` part after tool parts first
 * flushes that message plus one tool message per call, then starts a new
 * assistant message.
 */
function assistantToMessages(parts: AuthorAssistantMessage['parts']): Message[] {
  const out: Message[] = [];
  let pendingText = '';
  let current: PendingAssistant | undefined;
  for (const part of parts) {
    if (part.type === 'text') {
      if (current !== undefined) {
        flushToolResults(out, current);
        current = undefined;
      }
      pendingText += part.text;
      continue;
    }
    if (current === undefined) {
      current = { content: pendingText, toolCalls: [], toolParts: [] };
      pendingText = '';
    }
    current.toolCalls.push({
      id: part.toolCallId,
      type: 'function',
      function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
    });
    current.toolParts.push(part);
  }
  if (current !== undefined) {
    flushToolResults(out, current);
  } else if (pendingText !== '') {
    out.push({ role: 'assistant', content: pendingText });
  }
  return out;
}

/**
 * The text a stored user message is sent as: `turnContext + '\n\n' + text`
 * when a turn context block was stored with it (so the replay is
 * byte-identical to what the model saw), else `text`. A `uiEvent` message
 * becomes its `[UI event]` rendering instead.
 */
export function userMessageText(message: AuthorUserMessage): string {
  if (message.uiEvent !== undefined) return uiEventText(message.uiEvent);
  return message.turnContext === undefined ? message.text : `${message.turnContext}\n\n${message.text}`;
}

/**
 * The `[UI event]` user text for an app-written event. `names.agentName`
 * (when the caller knows it) names the saved agent instead of repeating its
 * id. Never carries a secret value - the saved-secret copy tells the model
 * the `SecretRef` to cite instead.
 */
export function uiEventText(event: AuthorUiEvent, names?: { agentName?: string }): string {
  switch (event.kind) {
    case 'save': {
      const agentName = names?.agentName ?? event.agentId;
      return (
        `[UI event] User applied proposal ${event.proposalId}. Studio saved agent "${agentName}" ` +
        `(id "${event.agentId}") as version ${event.version}. This was the user's action, not a tool ` +
        'call of yours. Treat the saved spec as the new baseline and do not save it again.'
      );
    }
    case 'secret': {
      return event.outcome === 'saved'
        ? `[UI event] The user saved the secret ${event.name} in Studio's secrets store. You cannot see its value. Refer to it as { "secret": "${event.name}" }.`
        : `[UI event] The user skipped entering the secret ${event.name}. Do not ask for it again in this turn. Carry on without it and say it is still missing.`;
    }
  }
}

/**
 * A stored transcript -> the SDK messages the Author model sees, in order.
 * Never includes a system message (createAgent adds the instructions). An
 * assistant message with no parts is skipped; user messages and uiEvents
 * map one-to-one to `{ role: 'user' }`.
 */
export function toModelMessages(transcript: readonly AuthorMessage[]): Message[] {
  const messages: Message[] = [];
  for (const message of transcript) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: userMessageText(message) });
    } else {
      messages.push(...assistantToMessages(message.parts));
    }
  }
  return messages;
}
