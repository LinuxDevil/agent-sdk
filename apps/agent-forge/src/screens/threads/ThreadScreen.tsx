/**
 * `#/threads/:sessionId` - one conversation: every turn (one trace, oldest
 * first) as its input and output messages, with a header line and a link to
 * the turn's trace. Reads `GET /api/v1/sessions/:id` (traces capped at 500),
 * then each turn's `GET /api/v1/traces/:id` as it nears the viewport for the
 * full root input/output (the session rows only carry 200-char previews).
 */
import { useRef, useState } from 'react';
import { useDaemonDown, useSession } from '../../observe/useObserve';
import { ObserveDaemonDown, ObserveError } from '../../observe/chrome';
import type { ObserveTraceRow } from '../../observe/types';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { EmptyState } from '../../ui/EmptyState';
import { MessageView } from '../../ui/MessageView';
import { StatusPill } from '../../ui/StatusPill';
import { threadsListPath } from './threadsUrl';
import { useNearViewport, useTurnDetail, type TurnIO } from './useTurnDetail';

const BackLink = () => <a href={`#${threadsListPath()}`}>Back to threads</a>;

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

/** One turn: time, status, duration and tokens, then the input and the output (or the run's error). */
function Turn({ trace, index, now }: { trace: ObserveTraceRow; index: number; now: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const near = useNearViewport(ref);
  const { query, io } = useTurnDetail(trace, near);
  return (
    <li ref={ref} className="thread-turn" aria-label={`Turn ${index + 1}`}>
      <div className="thread-turn-head">
        <span className="thread-turn-index">#{index + 1}</span>
        <time dateTime={new Date(trace.start).toISOString()}>{fmtStarted(trace.start, now)}</time>
        <StatusPill status={trace.status} />
        <span>{fmtDuration(trace.end - trace.start)}</span>
        <span title={`${fmtInt(trace.input_tokens)} in / ${fmtInt(trace.output_tokens)} out`}>
          {fmtInt(trace.input_tokens + trace.output_tokens)} tokens
        </span>
        <a className="thread-turn-link" href={`#/traces/${encodeURIComponent(trace.trace_id)}`}>
          Open trace
        </a>
      </div>
      <TurnNote io={io} loading={!near || query.loading} />
      <MessageView label="Input" value={io.input} />
      {trace.error_message ? (
        <p className="thread-error" role="note">
          <span className="thread-error-label">Error</span> {trace.error_message}
        </p>
      ) : (
        <MessageView label="Output" value={io.output} />
      )}
    </li>
  );
}

/** `#/threads/:sessionId`; an unknown session shows an empty state with the way back. */
export function ThreadScreen({ sessionId }: { sessionId: string }) {
  const thread = useSession(sessionId);
  const [now] = useState(() => Date.now());
  // Only the session query counts: one turn's detail failing is that turn's own problem, not the daemon's.
  const down = useDaemonDown(false, [thread]);
  if (down) return <ObserveDaemonDown />;

  const session = thread.data?.session;
  const traces = thread.data?.traces ?? [];
  let body;
  if (thread.loading && !thread.data) body = <p className="thread-loading">Loading thread...</p>;
  else if (thread.error) body = <ObserveError error={thread.error} />;
  else if (!session) body = <EmptyState title="Thread not found" hint={`No session '${sessionId}'.`} action={<BackLink />} />;
  else
    body = (
      <>
        <p className="thread-summary">
          <StatusPill status={session.status} />
          <span>{session.agent_name ?? session.agent_id ?? 'unknown agent'}</span>
          <span>
            {fmtInt(session.traces)} {session.traces === 1 ? 'turn' : 'turns'}
          </span>
          <span>started {fmtStarted(session.started_at, now)}</span>
          <span>{fmtInt(session.input_tokens + session.output_tokens)} tokens</span>
          <span>{fmtCost(session.cost_usd)}</span>
        </p>
        {traces.length < session.traces && (
          <p className="thread-note">Showing the first {fmtInt(traces.length)} turns of {fmtInt(session.traces)}.</p>
        )}
        <ol className="thread-turns">
          {traces.map((t, i) => (
            <Turn key={t.trace_id} trace={t} index={i} now={now} />
          ))}
        </ol>
      </>
    );

  return (
    <section className="thread-screen" aria-label="Thread">
      <nav className="thread-nav" aria-label="Breadcrumb">
        <BackLink />
      </nav>
      <h2 className="thread-title">
        Thread <code title={sessionId}>{sessionId}</code>
      </h2>
      {body}
    </section>
  );
}
