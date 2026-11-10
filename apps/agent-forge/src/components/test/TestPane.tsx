import type { ReactNode } from 'react';
import { ChatPanel } from '../ChatPanel';
import { TestRunBar } from './TestRunBar';
import './test.css';

export interface TestPaneSlots {
  /** Right side of the run bar (T06 puts Stop here). */
  runActions?: ReactNode;
  /** Between the thread and the composer (T05 steer box, T07 pending question). */
  aboveComposer?: ReactNode;
}

/**
 * The builder drawer's Test tab: a run bar (status, model, elapsed time, Open
 * trace) above the chat thread and composer. Later P6 tickets fill the two
 * slots - T05's steer box and T07's pending question go `aboveComposer`, T06's
 * Stop goes `runActions`.
 */
export function TestPane({ runActions, aboveComposer }: TestPaneSlots) {
  return (
    <div className="test-pane">
      <TestRunBar actions={runActions} />
      <ChatPanel aboveComposer={aboveComposer} />
    </div>
  );
}
