/**
 * P1/P2: chat with a running agent - the Chat tab's real content, replacing
 * BottomDrawer's LOU-P placeholder. Renders `AppState.chat` (the server's
 * real `Message[]` history, reconciled and streamed over the existing
 * `WS /agents/:id/stream` channel - see runRegistry.ts/chatReconcile.ts),
 * ported from `.design-ref/agent-forge-mockup.html`'s bubble/avatar/
 * timestamp layout.
 *
 * Streaming granularity: MESSAGE-level, not token-level. Since M9 the
 * server's `AgentExecutor.execute({ onAgentEvent })` streams each model
 * call through `provider.stream()` when the provider can, so the
 * WebSocket carries several `text.delta` events per step - but this panel
 * renders the reconciled `Message[]` history, not the deltas. A message
 * appears in the thread once its run turn settles (completes, or pauses
 * for approval); the "typing" indicator below fills the gap, driven by the
 * real `status: 'running'` from LOU-N rather than a fake timeout.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import type { ChatMessage } from '../../shared/wireTypes';
import { ApprovalCard } from './ApprovalCard';
import { formatTime } from './formatTime';

function initialsFor(role: ChatMessage['role']): string {
  return role === 'user' ? 'You' : 'AI';
}

/** Tool-result messages, indexed by the toolCallId they answer, for pairing under an assistant bubble's tool-call cards. */
function toolResultsByCallId(messages: ChatMessage[]): Map<string, ChatMessage> {
  const map = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m);
  }
  return map;
}

function ToolCallCard({ toolCall, result }: { toolCall: NonNullable<ChatMessage['toolCalls']>[number]; result?: ChatMessage }) {
  let args: unknown = toolCall.function.arguments;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    // Leave as the raw string if it isn't valid JSON.
  }
  return (
    <div className="chat-tool-call">
      &rarr; {toolCall.function.name}({JSON.stringify(args)})
      {result && <div className="chat-tool-result">= {result.content}</div>}
    </div>
  );
}

/**
 * Eve DUI-F21: the user turn a top-bar Run added is shown as "Run input" in
 * a neutral bubble, not as a message the user typed.
 */
function Bubble({ message, toolResults }: { message: ChatMessage; toolResults: Map<string, ChatMessage> }) {
  const role = message.role === 'user' ? 'user' : 'agent';
  const fromRun = message.source === 'run';
  return (
    <div className={`chat-msg ${role}${fromRun ? ' run-input' : ''}`}>
      <div className="chat-avatar">{fromRun ? 'Run' : initialsFor(message.role)}</div>
      <div>
        {fromRun && <div className="chat-run-label">Run input</div>}
        {message.content && <div className="chat-bubble">{message.content}</div>}
        {message.toolCalls?.map((tc) => (
          <div className="chat-bubble" key={tc.id}>
            <ToolCallCard toolCall={tc} result={toolResults.get(tc.id)} />
          </div>
        ))}
        <div className="chat-time">{formatTime(message.timestamp)}</div>
      </div>
    </div>
  );
}

type ViewedChatSession = ReturnType<typeof useAppState>['viewedChatSession'];
type RunStatusPayload = ReturnType<typeof useAppState>['runStatus'];
type PendingApproval = NonNullable<NonNullable<RunStatusPayload>['pendingApproval']>;

interface LiveRunState {
  isRunning: boolean;
  pendingApproval: PendingApproval | undefined;
}

const IDLE_RUN_STATE: LiveRunState = { isRunning: false, pendingApproval: undefined };

function liveRunStateOf(runStatus: RunStatusPayload): LiveRunState {
  return {
    isRunning: runStatus?.status === 'running',
    pendingApproval: runStatus?.status === 'paused' ? runStatus.pendingApproval : undefined,
  };
}

function isInputDisabled(viewing: boolean, { isRunning, pendingApproval }: LiveRunState): boolean {
  return viewing || isRunning || !!pendingApproval;
}

function ChatSessionBar({ viewedChatSession }: { viewedChatSession: ViewedChatSession }) {
  const { chat, chatSessions, startNewChat, viewChatSession, returnToLiveChat } = useAppState();

  if (viewedChatSession) {
    return (
      <div className="chat-session-bar">
        <span>
          Viewing past conversation from {new Date(viewedChatSession.startedAt).toLocaleString()}
          <button className="btn btn-ghost" onClick={returnToLiveChat}>
            Back to live chat
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="chat-session-bar">
      <select
        aria-label="Past conversations"
        value=""
        onChange={(e) => {
          if (e.target.value) void viewChatSession(e.target.value);
        }}
      >
        <option value="">Past conversations ({chatSessions.length})</option>
        {chatSessions
          .filter((s) => s.sessionId !== chat.sessionId)
          .map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {new Date(s.updatedAt).toLocaleString()} - {s.preview || '(empty)'}
            </option>
          ))}
      </select>
      <button className="btn btn-ghost" onClick={() => void startNewChat()}>
        New chat
      </button>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="chat-msg agent">
      <div className="chat-avatar">AI</div>
      <div className="chat-bubble">
        <div className="chat-typing">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function ApprovalBubble({ pendingApproval }: { pendingApproval: PendingApproval }) {
  return (
    <div className="chat-msg agent">
      <div className="chat-avatar">AI</div>
      <div>
        <ApprovalCard
          className="chat-approval-card"
          toolName={pendingApproval.toolName}
          args={pendingApproval.args}
        />
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: ChatMessage[];
  isRunning: boolean;
  pendingApproval: PendingApproval | undefined;
}

function EmptyChatNotice({ count, isRunning }: { count: number; isRunning: boolean }) {
  return count === 0 && !isRunning ? (
    <div className="chat-empty">Send a message to start chatting with this agent.</div>
  ) : null;
}

function MessageList({ messages, isRunning, pendingApproval }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const renderable = messages.filter((m) => m.role !== 'system');
  const toolResults = toolResultsByCallId(messages);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [renderable.length, isRunning]);

  return (
    <div className="chat-messages" ref={listRef} role="log" aria-label="Conversation">
      <EmptyChatNotice count={renderable.length} isRunning={isRunning} />
      {renderable.map((m) => (
        <Bubble key={m.id} message={m} toolResults={toolResults} />
      ))}
      {isRunning && <TypingBubble />}
      {pendingApproval && <ApprovalBubble pendingApproval={pendingApproval} />}
    </div>
  );
}

function placeholderFor(viewing: boolean, isPausedForApproval: boolean): string {
  if (viewing) return 'Return to the live chat to send a message';
  if (isPausedForApproval) return 'Resolve the approval above to continue';
  return 'Message this agent...';
}

interface ChatInputRowProps {
  viewing: boolean;
  isPausedForApproval: boolean;
  inputDisabled: boolean;
}

function ChatInputRow({ viewing, isPausedForApproval, inputDisabled }: ChatInputRowProps) {
  const { sendChatMessage } = useAppState();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

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
    <div className="chat-input-row">
      <textarea
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
        className="btn btn-primary btn-send"
        onClick={() => void handleSend()}
        disabled={inputDisabled || sending || !input.trim()}
      >
        Send
      </button>
    </div>
  );
}

export function ChatPanel() {
  const { chat, chatActionError, viewedChatSession, runStatus } = useAppState();

  const viewing = viewedChatSession !== undefined;
  const displayedMessages = viewedChatSession ? viewedChatSession.messages : chat.messages;
  const liveRunState = viewing ? IDLE_RUN_STATE : liveRunStateOf(runStatus);
  const { isRunning, pendingApproval } = liveRunState;

  return (
    <div className="chat-panel">
      <ChatSessionBar viewedChatSession={viewedChatSession} />
      <MessageList messages={displayedMessages} isRunning={isRunning} pendingApproval={pendingApproval} />

      {chatActionError && (
        <div className="chat-action-error" role="alert">
          {chatActionError}
        </div>
      )}

      <ChatInputRow
        viewing={viewing}
        isPausedForApproval={!!pendingApproval}
        inputDisabled={isInputDisabled(viewing, liveRunState)}
      />
    </div>
  );
}
