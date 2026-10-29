/**
 * Chat with a running agent - the Chat tab's real content, replacing
 * BottomDrawer's former placeholder. Renders `AppState.chat` (the server's
 * real `Message[]` history, reconciled and streamed over the existing
 * `WS /agents/:id/stream` channel - see runRegistry.ts/chatReconcile.ts)
 * as bubbles with avatars and timestamps.
 *
 * Streaming granularity: MESSAGE-level, not token-level. The
 * server's `AgentExecutor.execute({ onAgentEvent })` streams each model
 * call through `provider.stream()` when the provider can, so the
 * WebSocket carries several `text.delta` events per step - but this panel
 * renders the reconciled `Message[]` history, not the deltas. A message
 * appears in the thread once its run turn settles (completes, or pauses
 * for approval); the "typing" indicator below fills the gap, driven by the
 * real `status: 'running'` from the runtime server rather than a fake timeout.
 */
import { useEffect, useRef } from 'react';
import { Play, Plus, Sparkles, User, Wrench, type LucideIcon } from 'lucide-react';
import { useAppState } from '../state/AppState';
import type { ChatMessage } from '../../shared/wireTypes';
import { ApprovalCard } from './ApprovalCard';
import { ChatComposer } from './ChatComposer';
import { formatTime } from './formatTime';

/** A bubble's avatar: an icon tile (the agent's sparkles, the user, or Run's play), decorative. */
function Avatar({ Icon }: { Icon: LucideIcon }) {
  return (
    <div className="chat-avatar" aria-hidden="true">
      <Icon size={14} strokeWidth={1.75} />
    </div>
  );
}

type BubbleKind = 'user' | 'agent' | 'tool';

/** Each bubble kind's avatar icon and the sender a screen reader hears (the avatar itself is decorative). */
const BUBBLE_KINDS: Record<BubbleKind, { Icon: LucideIcon; speaker: string }> = {
  user: { Icon: User, speaker: 'You' },
  agent: { Icon: Sparkles, speaker: 'Agent' },
  tool: { Icon: Wrench, speaker: 'Tool' },
};

function bubbleKindOf(message: ChatMessage): BubbleKind {
  if (message.role === 'user') return 'user';
  return message.role === 'tool' ? 'tool' : 'agent';
}

/** The sender, read before each bubble in the `role="log"` thread. */
function Speaker({ name }: { name: string }) {
  return <span className="visually-hidden">{name}: </span>;
}

/**
 * The messages the thread draws: no system turns, and no tool results whose
 * call is drawn already (the result shows under that call's tool block).
 */
function renderableMessages(messages: ChatMessage[]): ChatMessage[] {
  const shownCalls = new Set(messages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id)));
  return messages.filter((m) => m.role !== 'system' && !(m.role === 'tool' && m.toolCallId && shownCalls.has(m.toolCallId)));
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
      <div className="chat-tool-head">
        <Wrench size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="chat-tool-name">{toolCall.function.name}</span>
      </div>
      <div className="chat-tool-args">{JSON.stringify(args)}</div>
      {result && <div className="chat-tool-result">= {result.content}</div>}
    </div>
  );
}

/** A message's text: a mono tool block (Wrench header) for a tool result, else a plain bubble. */
function MessageContent({ kind, message }: { kind: BubbleKind; message: ChatMessage }) {
  if (kind !== 'tool') return <div className="chat-bubble">{message.content}</div>;
  return (
    <div className="chat-bubble chat-bubble-tool">
      <div className="chat-tool-call">
        <div className="chat-tool-head">
          <Wrench size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="chat-tool-name">{message.toolName ?? message.name ?? 'tool result'}</span>
        </div>
        <div className="chat-tool-result">= {message.content}</div>
      </div>
    </div>
  );
}

/**
 * The user turn a top-bar Run added is shown as "Run input" in
 * a neutral bubble, not as a message the user typed.
 */
function Bubble({ message, toolResults }: { message: ChatMessage; toolResults: Map<string, ChatMessage> }) {
  const kind = bubbleKindOf(message);
  const fromRun = message.source === 'run';
  const { Icon, speaker } = BUBBLE_KINDS[kind];
  return (
    <div className={`chat-msg ${kind}${fromRun ? ' run-input' : ''}`}>
      <Avatar Icon={fromRun ? Play : Icon} />
      <div className="chat-msg-body">
        {fromRun ? <div className="chat-run-label">Run input</div> : <Speaker name={speaker} />}
        {message.content && <MessageContent kind={kind} message={message} />}
        {message.toolCalls?.map((tc) => (
          <div className="chat-bubble chat-bubble-tool" key={tc.id}>
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
          <button className="btn btn-ghost btn-sm" onClick={returnToLiveChat}>
            Back to live chat
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="chat-session-bar">
      <select
        className="select chat-session-select"
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
      <button className="btn btn-ghost btn-sm" onClick={() => void startNewChat()}>
        <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        New chat
      </button>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="chat-msg agent">
      <Avatar Icon={Sparkles} />
      <div className="chat-bubble">
        <span className="visually-hidden">Agent is typing</span>
        <div className="chat-typing" aria-hidden="true">
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
    <div className="chat-msg agent chat-msg-approval">
      <Avatar Icon={Sparkles} />
      <div className="chat-msg-body">
        <Speaker name="Agent" />
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
  const renderable = renderableMessages(messages);
  const toolResults = toolResultsByCallId(messages);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [renderable.length, isRunning]);

  return (
    // Focusable, so the thread scrolls from the keyboard too.
    <div className="chat-messages" ref={listRef} role="log" aria-label="Conversation" tabIndex={0}>
      <EmptyChatNotice count={renderable.length} isRunning={isRunning} />
      {renderable.map((m) => (
        <Bubble key={m.id} message={m} toolResults={toolResults} />
      ))}
      {isRunning && <TypingBubble />}
      {pendingApproval && <ApprovalBubble pendingApproval={pendingApproval} />}
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

      <ChatComposer
        viewing={viewing}
        isPausedForApproval={!!pendingApproval}
        inputDisabled={isInputDisabled(viewing, liveRunState)}
      />
    </div>
  );
}
