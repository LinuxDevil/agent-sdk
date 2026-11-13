import type { JSX } from 'react';

import type { EvalGateResult, EvalGateSetResult } from '../../shared/wireTypes';
import { Dialog } from '../ui/Dialog';
import { StatusBadge } from '../ui/StatusBadge';
import './evalGateDialog.css';

/** Failing examples listed per set before the `+<n> more` line (X01b). */
const MAX_EXAMPLES = 10;

/** Props for {@link EvalGateDialog}: the 409 eval-gate failure's full result. */
export interface EvalGateDialogProps {
  open: boolean;
  onClose(): void;
  /** The version that was not published (`v<n>` in the description). */
  version: number;
  /** The gate's `EvalGateResult` - the 409 body's `details`. */
  result: EvalGateResult;
}

/** `0.6` → `60%`, `0.6667` → `67%` (ticket: `Math.round(rate * 100)` + `%`). */
function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** The first 8 chars of an example id, per the ticket's `Example <id short 8>`. */
function shortId(exampleId: string): string {
  return exampleId.slice(0, 8);
}

/** One failing example's line: id, its failure sentences, and the trace link when present. */
function ExampleRow({ exampleId, failures, traceId }: { exampleId: string; failures: string[]; traceId?: string }): JSX.Element {
  return (
    <li className="eval-gate-example">
      <span className="eval-gate-example-id">Example {shortId(exampleId)}</span>
      <ul className="eval-gate-example-failures">
        {failures.map((failure) => (
          <li key={failure}>{failure}</li>
        ))}
      </ul>
      {traceId !== undefined && (
        <a className="eval-gate-trace" href={`#/traces/${traceId}`}>
          Open trace
        </a>
      )}
    </li>
  );
}

/** One dataset's gate row: name, pass rate vs floor, badge - or the set-level error. */
function GateSetRow({ gate }: { gate: EvalGateSetResult }): JSX.Element {
  const failing = gate.examples.filter((example) => !example.passed);
  const shown = failing.slice(0, MAX_EXAMPLES);
  return (
    <li className="eval-gate-set" data-passed={gate.passed}>
      <div className="eval-gate-set-head">
        <span className="eval-gate-set-name">{gate.dataset}</span>
        {gate.error !== undefined ? (
          <span className="eval-gate-set-error">{gate.error}</span>
        ) : (
          <>
            <span className="eval-gate-set-rate tabular-nums">
              {percent(gate.passRate)} passed, needs {percent(gate.minPassRate)}
            </span>
            <StatusBadge status={gate.passed ? 'done' : 'error'} label={gate.passed ? 'Passed' : 'Failed'} />
          </>
        )}
      </div>
      {gate.error === undefined && failing.length > 0 && (
        <ul className="eval-gate-examples">
          {shown.map((example) => (
            <ExampleRow key={example.exampleId} exampleId={example.exampleId} failures={example.failures} traceId={example.traceId} />
          ))}
          {failing.length > MAX_EXAMPLES && <li className="eval-gate-more">+{failing.length - MAX_EXAMPLES} more</li>}
        </ul>
      )}
    </li>
  );
}

/**
 * The "Eval gate failed" dialog (X01b): opened when `POST .../publish`
 * answers 409 `LOUSHO_EVAL_GATE_FAILED`. Lists every gate set's pass rate
 * against its floor, each failing example (first 10, then `+<n> more`)
 * with its failure sentences and `Open trace` link, and a set-level error
 * in place of the rate when the dataset could not run. Footer is `Close`
 * only - there is no "publish anyway".
 */
export function EvalGateDialog({ open, onClose, version, result }: EvalGateDialogProps): JSX.Element | null {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Eval gate failed"
      description={`v${version} was not published. Fix the failures or change the gate, then publish again.`}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="eval-gate-dialog">
        <ul className="eval-gate-sets">
          {result.gates.map((gate) => (
            <GateSetRow key={gate.dataset} gate={gate} />
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
