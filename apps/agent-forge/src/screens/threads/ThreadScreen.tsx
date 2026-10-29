/**
 * `#/threads/:sessionId` - one conversation: a header card with the thread's
 * totals, then every turn (one trace, oldest first) on a numbered timeline,
 * each a card with its meta row, input and output (long ones clamped with a
 * "Show more" toggle) and a link to the turn's trace. Reads
 * `GET /api/v1/sessions/:id` (traces capped at 500), then each turn's
 * `GET /api/v1/traces/:id` as it nears the viewport for the full root
 * input/output (the session rows only carry 200-char previews).
 */
import { useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowUpRight, CalendarClock, Coins, History, MessagesSquare, Timer, Wallet } from 'lucide-react';
import { useDaemonDown, useDaemonHealth, useSession } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { ObserveSessionRow, ObserveTraceRow } from '../../observe/types';
import { fmtAge, fmtCost, fmtDateTime, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { EmptyState } from '../../ui/EmptyState';
import { CopyLinkButton, Fact, FactUnit, HeaderCard } from '../../ui/HeaderCard';
import { MessageView } from '../../ui/MessageView';
import { Skeleton } from '../../ui/Skeleton';
import { StatusPill } from '../../ui/StatusPill';
// The shared daemon-down / error presentation is styled there.
import '../../observe/observe.css';
import { Clamped } from './Clamped';
import { threadsListPath } from './threadsUrl';
import { useNearViewport, useTurnDetail, type TurnIO } from './useTurnDetail';
import './threads.css';

/** Says when a turn shows less than its full I/O: the previews (detail loading or unavailable), or a root cut at capture. */
function TurnNote({ io, loading }: { io: TurnIO; loading: boolean }) {
  let text: string | undefined;
  if (io.source === 'preview') text = loading ? 'Preview (truncated) - loading the full turn...' : 'Preview (truncated) - the full turn is unavailable.';
  else if (io.truncated) text = 'Input/output truncated when recorded.';
  if (!text) return null;
  return (
    <p className="thread-turn-note" role="note">
      {text}
    </p>
  );
}

const tokensOf = (r: { input_tokens: number; output_tokens: number }) => r.input_tokens + r.output_tokens;
const tokensTitle = (r: { input_tokens: number; output_tokens: number }) => `${fmtInt(r.input_tokens)} in / ${fmtInt(r.output_tokens)} out`;

/** The turn card's meta row: number and time on the left; status, duration, tokens and "Open trace" on the right. */
function TurnMeta({ trace, index, now }: { trace: ObserveTraceRow; index: number; now: number }) {
  return (
    <div className="thread-turn-head">
      <span className="thread-turn-title">Turn {index + 1}</span>
      <time className="thread-turn-time" dateTime={new Date(trace.start).toISOString()} title={fmtDateTime(trace.start)}>
        {fmtStarted(trace.start, now)}
      </time>
      <span className="thread-turn-meta">
        <StatusPill status={trace.status} />
        <span className="thread-turn-stat" title="Duration">
          <Timer size={14} strokeWidth={1.75} aria-hidden="true" />
          {fmtDuration(trace.end - trace.start)}
        </span>
        <span className="thread-turn-stat" title={tokensTitle(trace)}>
          <Coins size={14} strokeWidth={1.75} aria-hidden="true" />
          {fmtInt(tokensOf(trace))} tokens
        </span>
      </span>
      <a className="btn btn-ghost btn-sm thread-turn-link" href={`#/traces/${encodeURIComponent(trace.trace_id)}`}>
        Open trace
        <ArrowUpRight aria-hidden="true" />
      </a>
    </div>
  );
}

/** The run's error, in place of the output. */
const TurnError = ({ message }: { message: string }) => (
  <p className="thread-error" role="note">
    <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
    <span>
      <span className="thread-error-label">Error</span> {message}
    </span>
  </p>
);

/** One turn on the timeline: its numbered dot, then a card with the meta row, the input and the output (or the run's error). */
function Turn({ trace, index, now }: { trace: ObserveTraceRow; index: number; now: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const near = useNearViewport(ref);
  const { query, io } = useTurnDetail(trace, near);
  const failed = trace.status === 'error' || Boolean(trace.error_message);
  return (
    <li ref={ref} className="thread-turn" aria-label={`Turn ${index + 1}`} data-status={failed ? 'error' : undefined}>
      <span className="thread-turn-dot" aria-hidden="true">
        {index + 1}
      </span>
      <article className="card thread-turn-card">
        <TurnMeta trace={trace} index={index} now={now} />
        <div className="thread-turn-body">
          <TurnNote io={io} loading={!near || query.loading} />
          <Clamped label="input">
            <MessageView label="Input" value={io.input} />
          </Clamped>
          {trace.error_message ? (
            <TurnError message={trace.error_message} />
          ) : (
            <Clamped label="output">
              <MessageView label="Output" value={io.output} />
            </Clamped>
          )}
        </div>
      </article>
    </li>
  );
}

/** The thread's header card: agent and status, copy link, then its totals as metric chips. */
function ThreadHeader({ session, now }: { session: ObserveSessionRow; now: number }) {
  const agent = session.agent_name ?? session.agent_id ?? 'Unknown agent';
  const last = session.ended_at ?? session.started_at;
  return (
    <HeaderCard
      className="thread-header"
      title={agent}
      status={<StatusPill status={session.status} />}
      actions={<CopyLinkButton />}
      facts={
        <>
          <Fact icon={MessagesSquare} label="Turns">
            {fmtInt(session.traces)}
            <FactUnit>{session.traces === 1 ? 'turn' : 'turns'}</FactUnit>
          </Fact>
          <Fact icon={Coins} label="Tokens">
            <span title={tokensTitle(session)}>{fmtInt(tokensOf(session))}</span>
            <FactUnit>tokens</FactUnit>
          </Fact>
          <Fact icon={Wallet} label="Cost">
            {fmtCost(session.cost_usd)}
          </Fact>
          {/* An active thread has no span yet: no chip rather than a dash. */}
          {session.ended_at !== null && (
            <Fact icon={Timer} label="Span">
              {fmtDuration(session.ended_at - session.started_at)}
            </Fact>
          )}
          <Fact icon={CalendarClock} label="Started">
            {fmtDateTime(session.started_at)}
          </Fact>
          <Fact icon={History} label="Last activity">
            <span title={fmtDateTime(last)}>{fmtAge(Math.max(0, now - last))}</span>
          </Fact>
        </>
      }
    />
  );
}

/** The first load: the header card and three turn cards as skeletons, announced once as "Loading thread". */
function ThreadLoading() {
  return (
    <div className="thread-loading" role="status">
      <span className="visually-hidden">Loading thread...</span>
      <div className="card header-card" aria-hidden="true">
        <Skeleton width={180} height={20} />
        <div className="thread-skeleton-chips">
          {[72, 96, 76, 70, 132, 84].map((w, i) => (
            <Skeleton key={i} width={w} height={24} radius="var(--radius-full)" />
          ))}
        </div>
      </div>
      <ol className="thread-turns" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="thread-turn">
            <span className="thread-turn-dot" />
            <div className="card thread-turn-card thread-skeleton-card">
              <Skeleton width={220} height={14} />
              <Skeleton height={72} radius="var(--radius)" />
              <Skeleton height={120} radius="var(--radius)" />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const MissingThread = ({ sessionId }: { sessionId: string }) => (
  <EmptyState
    icon={MessagesSquare}
    title="Thread not found"
    hint={`No session '${sessionId}'.`}
    action={
      <a className="btn" href={`#${threadsListPath()}`}>
        Back to threads
      </a>
    }
  />
);

/** The thread itself: header card, the cap note, then the turns timeline. */
function ThreadBody({ session, traces, now }: { session: ObserveSessionRow; traces: ObserveTraceRow[]; now: number }) {
  return (
    <>
      <ThreadHeader session={session} now={now} />
      {traces.length < session.traces && (
        <p className="thread-note">
          Showing the first {fmtInt(traces.length)} turns of {fmtInt(session.traces)}.
        </p>
      )}
      <ol className="thread-turns" aria-label="Turns">
        {traces.map((t, i) => (
          <Turn key={t.trace_id} trace={t} index={i} now={now} />
        ))}
      </ol>
    </>
  );
}

/**
 * `#/threads/:sessionId` under its page header (Threads, the session id, a
 * link back to the list with its last filters); loading shows skeletons, an
 * unknown session an empty state with the way back. A dead daemon shows the
 * shared daemon-down state and the screen re-fetches by itself once it is back.
 */
export function ThreadScreen({ sessionId }: { sessionId: string }) {
  const health = useDaemonHealth();
  // A health flip back to "up" re-fetches the thread at once.
  const thread = useSession(sessionId, health.down);
  const [now] = useState(() => Date.now());
  // Only the session query counts: one turn's detail failing is that turn's own problem, not the daemon's.
  const down = useDaemonDown(health.down, [thread]);

  const session = thread.data?.session;
  let body;
  if (down) body = <ObserveDaemonDown />;
  else if (thread.loading && !thread.data) body = <ThreadLoading />;
  else if (thread.error) body = <ObserveError error={thread.error} />;
  else if (!session) body = <MissingThread sessionId={sessionId} />;
  else body = <ThreadBody session={session} traces={thread.data?.traces ?? []} now={now} />;

  return (
    <section className="thread-screen" aria-label="Thread" data-session-id={sessionId}>
      <ScreenHeader
        title="Threads"
        description={
          <>
            Thread <code className="thread-id">{sessionId}</code>
          </>
        }
        actions={
          <a className="btn btn-ghost thread-back" href={`#${threadsListPath()}`}>
            <ArrowLeft aria-hidden="true" />
            All threads
          </a>
        }
      />
      {body}
    </section>
  );
}
