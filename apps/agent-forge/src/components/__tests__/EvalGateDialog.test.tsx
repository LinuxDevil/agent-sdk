import { describe, expect, it, vi } from 'vitest';

import type { EvalGateResult } from '../../../shared/wireTypes';
import { render } from '../../ui/__tests__/render';
import { EvalGateDialog } from '../EvalGateDialog';

function result(over: Partial<EvalGateResult> = {}): EvalGateResult {
  return {
    passed: false,
    ranAt: '2026-01-02T03:04:05.000Z',
    gates: [
      {
        dataset: 'support-regressions',
        passRate: 0.6,
        minPassRate: 0.8,
        passed: false,
        examples: [
          { exampleId: 'abcdef123456', passed: true, failures: [] },
          { exampleId: 'fedcba654321', passed: false, failures: ['Did not call tool \'search\'', 'Took 9 steps, limit 5'], traceId: 'trace-1' },
        ],
      },
      {
        dataset: 'empty-set',
        passRate: 0,
        minPassRate: 1,
        passed: false,
        examples: [],
        error: "Dataset 'empty-set' has no examples",
      },
      {
        dataset: 'clean-set',
        passRate: 1,
        minPassRate: 0.5,
        passed: true,
        examples: [{ exampleId: 'aaaabbbbcccc', passed: true, failures: [] }],
      },
    ],
    ...over,
  };
}

function renderDialog(res: EvalGateResult = result(), version = 4) {
  return render(<EvalGateDialog open onClose={vi.fn()} version={version} result={res} />);
}

describe('EvalGateDialog', () => {
  it('titles the dialog and names the version that was not published', () => {
    renderDialog();
    expect(document.querySelector('.dialog-title')?.textContent).toBe('Eval gate failed');
    expect(document.querySelector('.dialog-description')?.textContent).toBe(
      'v4 was not published. Fix the failures or change the gate, then publish again.'
    );
  });

  it('lists each set with its rate vs floor and Failed/Passed badge', () => {
    renderDialog();
    const sets = [...document.querySelectorAll<HTMLElement>('.eval-gate-set')];
    expect(sets).toHaveLength(3);
    expect(sets[0].dataset.passed).toBe('false');
    expect(sets[0].querySelector('.eval-gate-set-name')?.textContent).toBe('support-regressions');
    expect(sets[0].querySelector('.eval-gate-set-rate')?.textContent).toBe('60% passed, needs 80%');
    expect(sets[0].querySelector('.status-badge-label')?.textContent).toBe('Failed');
    expect(sets[2].dataset.passed).toBe('true');
    expect(sets[2].querySelector('.eval-gate-set-rate')?.textContent).toBe('100% passed, needs 50%');
    expect(sets[2].querySelector('.status-badge-label')?.textContent).toBe('Passed');
  });

  it('shows the set error instead of the rate when the dataset could not run', () => {
    renderDialog();
    const errored = document.querySelectorAll<HTMLElement>('.eval-gate-set')[1];
    expect(errored.querySelector('.eval-gate-set-error')?.textContent).toBe("Dataset 'empty-set' has no examples");
    expect(errored.querySelector('.eval-gate-set-rate')).toBeNull();
    expect(errored.querySelector('.eval-gate-examples')).toBeNull();
  });

  it('lists failing examples with short ids, failure lines and the trace link', () => {
    renderDialog();
    const examples = document.querySelectorAll('.eval-gate-example');
    expect(examples).toHaveLength(1);
    expect(examples[0].querySelector('.eval-gate-example-id')?.textContent).toBe('Example fedcba65');
    const failures = [...examples[0].querySelectorAll('.eval-gate-example-failures li')].map((li) => li.textContent);
    expect(failures).toEqual(["Did not call tool 'search'", 'Took 9 steps, limit 5']);
    expect(examples[0].querySelector<HTMLAnchorElement>('.eval-gate-trace')?.getAttribute('href')).toBe('#/traces/trace-1');
  });

  it('caps failing examples at 10 per set with a +n more line', () => {
    const many = Array.from({ length: 13 }, (_, index) => ({
      exampleId: `example-${index}`,
      passed: false,
      failures: ['nope'],
    }));
    renderDialog(
      result({
        gates: [{ dataset: 'big', passRate: 0, minPassRate: 1, passed: false, examples: many }],
      })
    );
    expect(document.querySelectorAll('.eval-gate-example')).toHaveLength(10);
    expect(document.querySelector('.eval-gate-more')?.textContent).toBe('+3 more');
  });

  it('renders only a Close button in the footer', () => {
    renderDialog();
    const footer = document.querySelector('.dialog-footer')!;
    const buttons = [...footer.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Close']);
  });
});
