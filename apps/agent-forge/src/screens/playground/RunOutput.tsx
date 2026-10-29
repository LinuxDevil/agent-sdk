import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, Coins, ExternalLink, Sparkles, Timer, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react';

import { fmtCost, fmtDuration, fmtInt } from '../../observe/format';
import { EmptyState } from '../../ui/EmptyState';
import { JsonView } from '../../ui/JsonView';
import { MessageView } from '../../ui/MessageView';
import { StatusPill } from '../../ui/StatusPill';
import type { RunState, RunToolCall } from './runState';

const ARGS_PREVIEW = 64;

/** One compact `args` line for a collapsed tool call. */
function argsPreview(args: Record<string, unknown>): string {
  const text = JSON.stringify(args) ?? '';
  return text.length > ARGS_PREVIEW ? `${text.slice(0, ARGS_PREVIEW - 1)}…` : text;
}

/** A tool call as a collapsible card: the name and an args preview, opening to the args tree. */
function ToolCallCard({ call }: { call: RunToolCall }) {
  return (
    <details className="pg-tool-call">
      <summary>
        <ChevronRight className="pg-tool-chevron" aria-hidden="true" size={14} strokeWidth={1.75} />
        <span className="pg-tool-icon" aria-hidden="true">
          <Wrench size={14} strokeWidth={1.75} />
        </span>
        <span className="pg-tool-call-name">{call.name}</span>
        <span className="pg-tool-args" title={JSON.stringify(call.args)}>
          {argsPreview(call.args)}
        </span>
      </summary>
      <div className="pg-tool-body">
        <JsonView value={call.args} name="args" />
      </div>
    </details>
  );
}

interface Metric {
  icon: LucideIcon;
  label: string;
  value: string;
}

/** The finished run's numbers: tokens in/out, latency and cost, each when known. */
function metricsOf(run: RunState): Metric[] {
  const { usage, durationMs } = run;
  const approx = usage?.estimated ? '~' : '';
  const list: (Metric | false)[] = [
    !!usage && { icon: ArrowUpFromLine, label: 'Tokens in', value: approx + fmtInt(usage.inputTokens) },
    !!usage && { icon: ArrowDownToLine, label: 'Tokens out', value: approx + fmtInt(usage.outputTokens) },
    durationMs !== undefined && run.status !== 'error' && { icon: Timer, label: 'Latency', value: fmtDuration(durationMs) },
    usage?.costUsd !== undefined && { icon: Coins, label: 'Cost', value: fmtCost(usage.costUsd) },
  ];
  return list.filter((m): m is Metric => m !== false);
}

function RunMetrics({ run }: { run: RunState }) {
  const metrics = metricsOf(run);
  if (metrics.length === 0) return null;
  return (
    <ul className="pg-metrics" aria-label="Run metrics">
      {metrics.map(({ icon: Icon, label, value }) => (
        <li key={label} className="pg-metric">
          <Icon aria-hidden="true" size={14} strokeWidth={1.75} />
          <span className="pg-metric-label">{label}</span>
          <span className="pg-metric-value tabular-nums">{value}</span>
        </li>
      ))}
    </ul>
  );
}

function RunError({ message }: { message: string }) {
  return (
    <div className="pg-error" role="alert">
      <TriangleAlert className="pg-error-icon" aria-hidden="true" size={16} strokeWidth={1.75} />
      <div className="pg-error-body">
        <p className="pg-error-title">The run failed</p>
        <p className="pg-error-message">{message}</p>
      </div>
    </div>
  );
}

/** The reply: plain text with a typing caret while it streams, then a `MessageView` (chunked, so a huge reply stays responsive). */
function RunReply({ run }: { run: RunState }) {
  if (run.status === 'running') {
    return (
      <div className="pg-stream-card">
        <pre className="pg-stream">{run.text}</pre>
      </div>
    );
  }
  return run.text ? <MessageView value={run.text} label="Reply" /> : null;
}

function RunOutputHead({ run }: { run: RunState }) {
  return (
    <div className="pg-card-head">
      <h2 id="pg-output-title" className="pg-card-title">
        Output
      </h2>
      {run.status !== 'idle' && <StatusPill status={run.status} />}
      {run.traceId && (
        <a className="btn btn-ghost btn-sm pg-trace-link" href={`#/traces/${encodeURIComponent(run.traceId)}`}>
          <ExternalLink aria-hidden="true" />
          Open trace
        </a>
      )}
    </div>
  );
}

/**
 * The run's output card: status pill and "Open trace", the error banner, tool
 * calls as collapsible cards, the streamed reply and the token/latency metrics.
 */
export function RunOutput({ run }: { run: RunState }) {
  return (
    <section className="card pg-card pg-output" aria-labelledby="pg-output-title" aria-busy={run.status === 'running'}>
      <RunOutputHead run={run} />
      <div className="pg-card-body pg-output-body">
        {run.status === 'idle' ? (
          <EmptyState icon={Sparkles} title="No output yet" hint="Run the messages to see the reply, its tool calls and token usage here." />
        ) : (
          <>
            {run.error && <RunError message={run.error} />}
            {run.toolCalls.length > 0 && (
              <ul className="pg-tool-calls" aria-label="Tool calls">
                {run.toolCalls.map((call) => (
                  <li key={call.id}>
                    <ToolCallCard call={call} />
                  </li>
                ))}
              </ul>
            )}
            <RunReply run={run} />
            <RunMetrics run={run} />
          </>
        )}
      </div>
    </section>
  );
}
