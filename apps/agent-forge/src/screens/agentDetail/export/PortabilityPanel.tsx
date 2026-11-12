import { useCallback, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import type {
  PortabilityAnalysis,
  PortabilityFinding,
  PortabilityKind,
  PortabilityLocation,
} from '../../../../shared/wireTypes';
import { RuntimeApiError } from '../../../runtime/runtimeClient';
import './portability.css';

// fallow-ignore-next-line unused-type -- contract surface (L09b ticket); consumed by the export sheet's state narrowing
export type PortabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; analysis: PortabilityAnalysis }
  | { status: 'error'; message: string; retryable: boolean };

const LOCATION_LABELS: Record<PortabilityLocation, string> = {
  instructions: 'Instructions',
  triggers: 'Triggers',
  tools: 'Tools',
  mcpServers: 'MCP servers',
  hooks: 'Hooks',
  other: 'Other',
};

const KIND_LABELS: Record<PortabilityKind, string> = {
  repository: 'Repository',
  email_address: 'Email',
  channel: 'Channel',
  path: 'Path',
  host: 'Host',
  secret: 'Secret',
  person: 'Person',
  url: 'URL',
  other: 'Other',
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The check failed.';
}

/**
 * A failed check is retryable only when the server's model call itself
 * failed (`LOUSHO_PASS_FAILED`); schema/unavailable/refused outcomes
 * stay until something changes, so they get no Try again button.
 */
function isRetryable(error: unknown): boolean {
  return error instanceof RuntimeApiError && error.code === 'LOUSHO_PASS_FAILED';
}

function FindingCard({ finding }: { finding: PortabilityFinding }) {
  const secret = finding.kind === 'secret';
  return (
    <li className="portability-finding">
      <div className="portability-finding-tags">
        <span className="chip">{LOCATION_LABELS[finding.location]}</span>
        <span className="chip" data-tone={secret ? 'danger' : undefined}>
          {KIND_LABELS[finding.kind]}
        </span>
      </div>
      <blockquote className="portability-quote">{finding.quote}</blockquote>
      <p className="portability-explanation">{finding.explanation}</p>
      <p className="portability-suggestion">{finding.suggestion}</p>
    </li>
  );
}

function Findings({ analysis }: { analysis: PortabilityAnalysis }) {
  if (analysis.findings.length === 0) {
    return <p className="portability-none">Nothing hard-coded found. {analysis.summary}</p>;
  }
  return (
    <>
      <p className="portability-summary">{analysis.summary}</p>
      <ul className="portability-findings">
        {analysis.findings.map((finding, index) => (
          <FindingCard key={index} finding={finding} />
        ))}
      </ul>
    </>
  );
}

/**
 * L09b's "Hard-coded details" check: idle shows the run button, a click
 * runs `run()` (the export sheet's saved-agent check or the import
 * sheet's pasted-text check) and reports findings, or the adapted
 * instructions via `onAnalysis`. A new run or an error reports
 * `onAnalysis(undefined)` so the caller can hide the adapt switch.
 */
export function PortabilityPanel({
  run,
  onAnalysis,
}: {
  run(): Promise<PortabilityAnalysis>;
  onAnalysis?(a: PortabilityAnalysis | undefined): void;
}): JSX.Element {
  const [state, setState] = useState<PortabilityState>({ status: 'idle' });

  const check = useCallback(async () => {
    setState({ status: 'loading' });
    onAnalysis?.(undefined);
    try {
      const analysis = await run();
      setState({ status: 'done', analysis });
      onAnalysis?.(analysis);
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error), retryable: isRetryable(error) });
    }
  }, [run, onAnalysis]);

  return (
    <section className="portability" aria-labelledby="portability-title" aria-live="polite">
      <div className="portability-head">
        <h3 id="portability-title" className="portability-title">
          Hard-coded details
        </h3>
        {state.status === 'idle' || state.status === 'done' ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void check()}>
            {state.status === 'done' ? 'Check again' : 'Check for hard-coded details'}
          </button>
        ) : null}
      </div>
      {state.status === 'loading' ? (
        <p className="portability-loading">
          <LoaderCircle size={14} className="btn-spinner" aria-hidden="true" /> Checking…
        </p>
      ) : null}
      {state.status === 'error' ? (
        <div className="portability-error" role="alert">
          <p>{state.message}</p>
          {state.retryable ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void check()}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {state.status === 'done' ? <Findings analysis={state.analysis} /> : null}
    </section>
  );
}
