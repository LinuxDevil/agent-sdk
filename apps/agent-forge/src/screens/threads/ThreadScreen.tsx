/**
 * `#/threads/:sessionId` - one conversation: every turn (one trace, oldest
 * first) as its input and output messages, with a header line and a link to
 * the turn's trace. Reads `GET /api/v1/sessions/:id` (traces capped at 500).
 */
import { useState } from 'react';
import { useSession } from '../../observe/useObserve';
import { ObserveError } from '../../observe/chrome';
import type { ObserveTraceRow } from '../../observe/types';
import { fmtCost, fmtDuration, fmtInt, fmtStarted } from '../../observe/format';
import { EmptyState } from '../../ui/EmptyState';
import { MessageView } from '../../ui/MessageView';
import { StatusPill } from '../../ui/StatusPill';
import { threadsListPath } from './threadsUrl';

const BackLink = () => <a href={`#${threadsListPath()}`}>Back to threads</a>;

/** One turn: time, status, duration and tokens, then the input and the output (or the run's error). */
function Turn({ trace, index, now }: { trace: ObserveTraceRow; index: number; now: number }) {
  return (
    <li className="thread-turn" aria-label={`Turn ${index + 1}`}>
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
      <MessageView label="Input" value={trace.input_preview} />
      {trace.error_message ? (
        <p className="thread-error" role="note">
          <span className="thread-error-label">Error</span> {trace.error_message}
        </p>
      ) : (
        <MessageView label="Output" value={trace.output_preview} />
      )}
    </li>
  );
}

/** `#/threads/:sessionId`; an unknown session shows an empty state with the way back. */
export function ThreadScreen({ sessionId }: { sessionId: string }) {
  const thread = useSession(sessionId);
  const [now] = useState(() => Date.now());

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
