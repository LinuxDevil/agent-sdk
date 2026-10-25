import { MessageView } from '../../ui/MessageView';
import { StatusPill } from '../../ui/StatusPill';
import type { RunState } from './runState';

/**
 * The run's output: status pill, tool calls, the reply and an "Open trace"
 * link. While streaming the reply is plain text that grows per delta; once
 * the run ends it is a `MessageView` (chunked, so a huge reply stays responsive).
 */
export function RunOutput({ run }: { run: RunState }) {
  if (run.status === 'idle') {
    return (
      <section className="pg-panel pg-output" aria-labelledby="pg-output-title">
        <h3 id="pg-output-title" className="pg-panel-title">
          Output
        </h3>
        <p className="pg-hint">Run the messages to see the reply here.</p>
      </section>
    );
  }
  return (
    <section className="pg-panel pg-output" aria-labelledby="pg-output-title" aria-busy={run.status === 'running'}>
      <div className="pg-output-head">
        <h3 id="pg-output-title" className="pg-panel-title">
          Output
        </h3>
        <StatusPill status={run.status} />
        {run.traceId && (
          <a className="pg-trace-link" href={`#/traces/${encodeURIComponent(run.traceId)}`}>
            Open trace
          </a>
        )}
      </div>
      {run.error && (
        <div className="pg-error" role="alert">
          {run.error}
        </div>
      )}
      {run.toolCalls.length > 0 && (
        <ul className="pg-tool-calls" aria-label="Tool calls">
          {run.toolCalls.map((call) => (
            <li key={call.id} className="pg-tool-call" title={JSON.stringify(call.args)}>
              {call.name}
            </li>
          ))}
        </ul>
      )}
      {run.status === 'running' ? (
        <pre className="pg-stream">{run.text}</pre>
      ) : (
        run.text && <MessageView value={run.text} label="Reply" />
      )}
    </section>
  );
}
