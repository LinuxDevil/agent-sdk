import { describe, it, expect } from 'vitest';
import type { EvalResult } from '../evals/evalResult';
import { failsRun, parseResults, renderJson, renderJunit, renderTable, summarize } from './evalReport';

const passing: EvalResult = {
  name: 'refund flow',
  case: 'Refund order 42',
  tags: ['smoke'],
  passed: true,
  assertions: [
    { name: 'completed()', kind: 'gate', passed: true, score: 1, threshold: 1 },
    { name: 'tone', kind: 'soft', passed: true, score: 0.85, threshold: 0.7 },
  ],
  durationMs: 12,
  steps: 2,
  toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }],
};

const softFail: EvalResult = {
  ...passing,
  case: 'polite',
  assertions: [
    { name: 'brevity', kind: 'soft', passed: false, score: 0.5, threshold: 0.9, message: "soft check 'brevity' failed: score 0.5 is below the threshold 0.9" },
  ],
  durationMs: 1500,
};

const gateFail: EvalResult = {
  name: 'broken <flow> & "co"',
  tags: [],
  passed: false,
  assertions: [
    {
      name: "calledTool('lookup_order')",
      kind: 'gate',
      passed: false,
      score: 0,
      threshold: 1,
      message: "calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]",
    },
  ],
  durationMs: 7,
  steps: 1,
  toolCalls: [],
};

const errored: EvalResult = {
  name: 'errored',
  tags: [],
  passed: false,
  assertions: [],
  durationMs: 3,
  steps: 0,
  toolCalls: [],
  error: 't.judge() needs a judge provider.\u0007',
};

const all = [passing, softFail, gateFail, errored];

describe('aggregation', () => {
  it('summarizes totals, treating soft failures as passing unless strict', () => {
    expect(summarize(all, false)).toEqual({ total: 4, passed: 2, failed: 2, softFailed: 1, strict: false, durationMs: 1522 });
    expect(summarize(all, true)).toMatchObject({ passed: 1, failed: 3, softFailed: 1, strict: true });
  });

  it('failsRun covers gate failures, errors and strict soft failures', () => {
    expect(failsRun(passing, true)).toBe(false);
    expect(failsRun(softFail, false)).toBe(false);
    expect(failsRun(softFail, true)).toBe(true);
    expect(failsRun(gateFail, false)).toBe(true);
    expect(failsRun(errored, false)).toBe(true);
  });

  it('parses JSON lines and skips blank or truncated ones', () => {
    const text = `${JSON.stringify(passing)}\n\n{"name": "cut off\n${JSON.stringify(gateFail)}\r\n`;
    expect(parseResults(text).map((r) => r.name)).toEqual(['refund flow', gateFail.name]);
    expect(parseResults('')).toEqual([]);
  });
});

describe('renderTable', () => {
  it('lists every case, totals, and separates gate from soft failures', () => {
    expect(renderTable(all, false)).toMatchInlineSnapshot(`
      "EVAL                  CASE             RESULT            SCORES        DURATION
      refund flow           Refund order 42  PASS              tone=0.85     12ms
      refund flow           polite           PASS (soft fail)  brevity=0.50  1.50s
      broken <flow> & "co"  -                FAIL              -             7ms
      errored               -                FAIL              -             3ms

      4 eval(s): 2 passed, 2 failed, 1 with soft failures (1.52s)

      Gate failures:
        broken <flow> & "co": calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]
        errored: t.judge() needs a judge provider.

      Soft failures (not failing the run):
        refund flow [polite]: soft check 'brevity' failed: score 0.5 is below the threshold 0.9"
    `);
  });

  it('marks soft failures as failing under --strict', () => {
    expect(renderTable([passing, softFail], true)).toMatchInlineSnapshot(`
      "EVAL         CASE             RESULT  SCORES        DURATION
      refund flow  Refund order 42  PASS    tone=0.85     12ms
      refund flow  polite           FAIL    brevity=0.50  1.50s

      2 eval(s): 1 passed, 1 failed, 1 with soft failures (1.51s)

      Soft failures (failing the run: --strict):
        refund flow [polite]: soft check 'brevity' failed: score 0.5 is below the threshold 0.9"
    `);
  });
});

describe('renderJunit', () => {
  it('writes testsuites/testsuite/testcase with diagnostic failures and escapes XML', () => {
    expect(renderJunit(all, false)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <testsuites name="lousho eval" tests="4" failures="1" errors="1" time="1.522">
        <testsuite name="refund flow" tests="2" failures="0" errors="0" skipped="0" time="1.512">
          <testcase classname="refund flow" name="Refund order 42" time="0.012" />
          <testcase classname="refund flow" name="polite" time="1.500">
            <system-out>soft failure: soft check 'brevity' failed: score 0.5 is below the threshold 0.9</system-out>
          </testcase>
        </testsuite>
        <testsuite name="broken &lt;flow&gt; &amp; &quot;co&quot;" tests="1" failures="1" errors="0" skipped="0" time="0.007">
          <testcase classname="broken &lt;flow&gt; &amp; &quot;co&quot;" name="broken &lt;flow&gt; &amp; &quot;co&quot;" time="0.007">
            <failure message="calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]" type="AssertionError">calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]</failure>
          </testcase>
        </testsuite>
        <testsuite name="errored" tests="1" failures="0" errors="1" skipped="0" time="0.003">
          <testcase classname="errored" name="errored" time="0.003">
            <error message="t.judge() needs a judge provider." type="EvalError">t.judge() needs a judge provider.</error>
          </testcase>
        </testsuite>
      </testsuites>
      "
    `);
  });

  it('turns soft failures into failures under --strict', () => {
    expect(renderJunit([softFail], true)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <testsuites name="lousho eval" tests="1" failures="1" errors="0" time="1.500">
        <testsuite name="refund flow" tests="1" failures="1" errors="0" skipped="0" time="1.500">
          <testcase classname="refund flow" name="polite" time="1.500">
            <failure message="soft check 'brevity' failed: score 0.5 is below the threshold 0.9" type="AssertionError">soft check 'brevity' failed: score 0.5 is below the threshold 0.9</failure>
          </testcase>
        </testsuite>
      </testsuites>
      "
    `);
  });

  it('is an empty but valid document without results', () => {
    expect(renderJunit([], false)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <testsuites name="lousho eval" tests="0" failures="0" errors="0" time="0.000">
      </testsuites>
      "
    `);
  });
});

describe('renderJson', () => {
  it('contains the summary and every structured result', () => {
    expect(renderJson([gateFail], false)).toMatchInlineSnapshot(`
      "{
        "summary": {
          "total": 1,
          "passed": 0,
          "failed": 1,
          "softFailed": 0,
          "strict": false,
          "durationMs": 7
        },
        "results": [
          {
            "name": "broken <flow> & \\"co\\"",
            "tags": [],
            "passed": false,
            "assertions": [
              {
                "name": "calledTool('lookup_order')",
                "kind": "gate",
                "passed": false,
                "score": 0,
                "threshold": 1,
                "message": "calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]"
              }
            ],
            "durationMs": 7,
            "steps": 1,
            "toolCalls": []
          }
        ]
      }
      "
    `);
    const parsed = JSON.parse(renderJson(all, true)) as { summary: { failed: number }; results: EvalResult[] };
    expect(parsed.summary.failed).toBe(3);
    expect(parsed.results).toHaveLength(4);
  });
});
