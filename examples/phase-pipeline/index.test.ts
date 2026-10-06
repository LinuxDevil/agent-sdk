import { describe, expect, it } from 'vitest';
import { defineTool } from '../../src';
import { ToolRegistry } from '../../src/tools';
import { mockModel } from '../../src/testing';
import { z } from 'zod';
import { buildPhaseFlow, runPhasePipeline, scriptedPhases } from './index';

/** A gate tool cycling through 'PASS:...'/'FAIL:...' verdict strings. */
function gate(verdicts: string[]) {
  const calls = { i: 0 };
  const toolRegistry = new ToolRegistry();
  const tool = defineTool({
    name: 'run_check',
    description: 'x',
    input: z.object({ implementation: z.string() }),
    execute: async ({ implementation }) => {
      calls.i++;
      const v = verdicts[calls.i - 1] ?? verdicts.at(-1)!;
      return v.replace('{impl}', implementation.slice(0, 30));
    },
  });
  toolRegistry.register(tool);
  return { toolName: 'run_check', toolRegistry, calls };
}

const OPTS = { model: 'mock', task: 'add greet()' };

describe('examples/phase-pipeline', () => {
  it('runs discuss -> spec -> plan -> implement -> gate -> report -> return', async () => {
    // phases: requirements, spec, plan, implement, report
    const model = mockModel([
      'reqs', 'spec', 'plan',
      'export function greet(n){return `hi ${n}`}',
      'DELIVERABLE: greet() added',
    ]);
    const g = gate(['PASS: ok']);
    const result = await runPhasePipeline({ provider: model, gate: g, ...OPTS });
    expect(result.success).toBe(true);
    expect(result.output).toBe('DELIVERABLE: greet() added');
    expect(g.calls.i).toBe(1); // gate ran once, ladder stopped
    model.assertExhausted();
  });

  it('a failing check re-runs implement with the FAIL string in the prompt', async () => {
    const model = mockModel(['reqs', 'spec', 'plan', 'broken v1', 'fixed v2', 'DELIVERABLE']);
    const g = gate(['FAIL: missing export', 'PASS: ok']);
    const result = await runPhasePipeline({ provider: model, gate: g, ...OPTS });
    expect(result.success).toBe(true);
    expect(g.calls.i).toBe(2);
    // The second implement call (5th model call) saw the FAIL verdict.
    const impl2 = String(model.calls[4].messages.at(-1)?.content);
    expect(impl2).toContain('FAIL: missing export');
    model.assertExhausted();
  });

  it('a skipped attempt does not call the model again after PASS', async () => {
    // First attempt passes; the ladder's remaining attempts must not run.
    const model = mockModel(['reqs', 'spec', 'plan', 'impl', 'DELIVERABLE']);
    const g = gate(['PASS: ok']);
    const result = await runPhasePipeline({ provider: model, gate: g, maxRetries: 2, ...OPTS });
    expect(result.success).toBe(true);
    expect(g.calls.i).toBe(1);
    model.assertExhausted(); // proves attempts 2-3 were skipped
  });

  it('exhausted retries throw rather than report success', async () => {
    const model = mockModel(['reqs', 'spec', 'plan', 'v1', 'v2', 'v3']);
    const g = gate(['FAIL: a', 'FAIL: b', 'FAIL: c']);
    const result = await runPhasePipeline({ provider: model, gate: g, maxRetries: 2, ...OPTS });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('proof gate still failing');
    expect(g.calls.i).toBe(3);
    model.assertExhausted(); // no report call after a failed ladder
  });

  it('a gate-free flow still completes (gate is opt-in)', async () => {
    const model = mockModel(['reqs', 'spec', 'plan', 'impl', 'DELIVERABLE']);
    const result = await runPhasePipeline({ provider: model, ...OPTS });
    expect(result.success).toBe(true);
    expect(result.output).toBe('DELIVERABLE');
    model.assertExhausted();
  });

  it('builds a valid flow definition', () => {
    const flow = buildPhaseFlow(gate(['PASS: ok']));
    expect(flow.code).toBe('phase-pipeline');
    expect(flow.inputs[0].name).toBe('task');
  });

  it('scriptedPhases() supplies one turn per phase call', () => {
    const m = scriptedPhases(['i1', 'i2']);
    expect(m).toBeDefined(); // smoke: helper builds; turns asserted by callers
  });
});
