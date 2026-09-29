/**
 * P1/P2: chat with a running agent - the Chat tab's real content, replacing
 * BottomDrawer's LOU-P placeholder. Renders `AppState.chat` (the server's
 * real `Message[]` history, reconciled and streamed over the existing
 * `WS /agents/:id/stream` channel - see runRegistry.ts/chatReconcile.ts),
 * ported from `.design-ref/agent-forge-mockup.html`'s bubble/avatar/
 * timestamp layout.
 *
 * Streaming granularity: MESSAGE-level, not token-level. AgentExecutor's
 * execution loop (src/execution/AgentExecutor.ts) only ever calls
 * `provider.generate()` - never `provider.stream()` - so there is no
 * per-token event to render incrementally even for a provider (like
 * MockLLMProvider) that DOES implement `.stream()`. A message appears in
 * the thread once its run turn settles (completes, or pauses for
 * approval); the "typing" indicator below fills the gap, driven by the
 * real `status: 'running'` from LOU-N rather than a fake timeout.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import type { ChatMessage } from '../runtime/runtimeClient';
import { ApprovalCard } from './ApprovalCard';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

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

function Bubble({ message, toolResults }: { message: ChatMessage; toolResults: Map<string, ChatMessage> }) {
  const role = message.role === 'user' ? 'user' : 'agent';
  return (
    <div className={`chat-msg ${role}`}>
      <div className="chat-avatar">{initialsFor(message.role)}</div>
      <div>
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

export function ChatPanel() {
  const {
    chat,
    sendChatMessage,
    chatActionError,
    chatSessions,
    startNewChat,
    viewedChatSession,
    viewChatSession,
    returnToLiveChat,
    runStatus,
  } = useAppState();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const viewing = viewedChatSession !== undefined;
  const displayedMessages = viewing ? viewedChatSession!.messages : chat.messages;
  const renderable = displayedMessages.filter((m) => m.role !== 'system');
  const toolResults = toolResultsByCallId(displayedMessages);
  const isRunning = !viewing && runStatus?.status === 'running';
  const isPausedForApproval = !viewing && runStatus?.status === 'paused' && !!runStatus.pendingApproval;
  const inputDisabled = viewing || isRunning || isPausedForApproval;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [renderable.length, isRunning]);

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
    <div className="chat-panel">
      <div className="chat-session-bar">
        {viewing ? (
          <span>
            Viewing past conversation from {new Date(viewedChatSession!.startedAt).toLocaleString()}
            <button className="btn btn-ghost" onClick={returnToLiveChat}>
              Back to live chat
            </button>
          </span>
        ) : (
          <>
            <select
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
          </>
        )}
      </div>

      <div className="chat-messages" ref={listRef}>
        {renderable.length === 0 && !isRunning && <div className="chat-empty">Send a message to start chatting with this agent.</div>}
        {renderable.map((m) => (
          <Bubble key={m.id} message={m} toolResults={toolResults} />
        ))}
        {isRunning && (
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
        )}
        {isPausedForApproval && runStatus?.pendingApproval && (
          <div className="chat-msg agent">
            <div className="chat-avatar">AI</div>
            <div>
              <ApprovalCard
                className="chat-approval-card"
                toolName={runStatus.pendingApproval.toolName}
                args={runStatus.pendingApproval.args}
              />
            </div>
          </div>
        )}
      </div>

      {chatActionError && <div className="chat-action-error">{chatActionError}</div>}

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={1}
          placeholder={
            viewing
              ? 'Return to the live chat to send a message'
              : isPausedForApproval
                ? 'Resolve the approval above to continue'
                : 'Message this agent...'
          }
          value={input}
          disabled={inputDisabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="btn btn-primary btn-send" onClick={() => void handleSend()} disabled={inputDisabled || sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
