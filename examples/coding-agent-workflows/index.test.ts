import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { mockModel } from '../../src/testing';
import { defineTool } from '../../src';
import { ToolRegistry } from '../../src/tools';
import { codingTools, memoryWorkspace, runCodingAgent, triage } from './index';

const decision = (route: string, confidence: number) =>
  JSON.stringify({ route, confidence, reason: 'test' });

function run(request: string, decisionJson: string, workflowTurns: string[], floor?: number) {
  const ws = memoryWorkspace();
  const model = mockModel([{ text: decisionJson }, ...workflowTurns.map((t) => ({ text: t }))]);
  return {
    ws,
    model,
    result: runCodingAgent({
      provider: model,
      model: 'mock',
      request,
      ...(floor === undefined ? {} : { confidenceFloor: floor }),
      toolRegistry: codingTools(ws.applyEdits),
    }),
  };
}

describe('examples/coding-agent-workflows', () => {
  it('triage returns a typed decision via result.object', async () => {
    const model = mockModel([{ text: decision('fix', 0.9) }]);
    const d = await triage('rename x', model, 'mock');
    expect(d).toEqual({ route: 'fix', confidence: 0.9, reason: 'test' });
  });

  it('an unparseable triage reply degrades to the careful route at 0 confidence', async () => {
    // output schemas get one repair retry, so a broken reply needs two turns.
    const model = mockModel([{ text: 'I cannot decide' }, { text: 'still not json' }]);
    const d = await triage('???', model, 'mock');
    expect(d.route).toBe('refactor');
    expect(d.confidence).toBe(0);
    expect(d.reason).toContain('no parseable');
  });

  it('a confident fix runs the fix workflow: edit + verify, no plan phase', async () => {
    const { ws, model, result } = run('add param', decision('fix', 0.9), ['the edit']);
    const r = await result;
    expect(r.effectiveRoute).toBe('fix');
    expect(r.flow.success).toBe(true);
    expect(ws.files.has('src/index.ts')).toBe(true);
    // triage + 1 change llmCall (no plan phase on the fix route)
    expect(model.calls).toHaveLength(2);
    model.assertExhausted();
  });

  it('a confident refactor runs plan -> edit -> verify', async () => {
    const { model, result } = run('restructure', decision('refactor', 0.95), ['the plan', 'the edit']);
    const r = await result;
    expect(r.effectiveRoute).toBe('refactor');
    expect(r.flow.success).toBe(true);
    expect(model.calls).toHaveLength(3); // triage + plan + change
  });

  it('low confidence escalates ANY route to the careful workflow', async () => {
    // 'fix' at 0.4 < 0.7 floor must run the refactor (careful) path.
    const { model, result } = run('tricky', decision('fix', 0.4), ['the plan', 'the edit']);
    const r = await result;
    expect(r.effectiveRoute).toBe('refactor');
    expect(model.calls).toHaveLength(3); // plan phase ran = careful path
  });

  it('a confident explain answers read-only with no tools', async () => {
    const { ws, result } = run('what does greet() do?', decision('explain', 0.9), ['It says hi.']);
    const r = await result;
    expect(r.effectiveRoute).toBe('explain');
    expect(r.flow.output).toBe('It says hi.');
    expect(ws.files.size).toBe(0); // nothing was applied
  });

  it('a failing verify throws inside the workflow, not a silent pass', async () => {
    const ws = memoryWorkspace();
    const tr = new ToolRegistry();
    tr.register(
      defineTool({
        name: 'apply_edit',
        description: 'x',
        input: z.object({ file: z.string(), content: z.string() }),
        execute: async ({ file, content }) => ws.applyEdits(file, content),
      })
    );
    tr.register(
      defineTool({
        name: 'verify',
        description: 'x',
        input: z.object({ note: z.string() }),
        execute: async () => 'FAIL: tests red',
      })
    );
    const model = mockModel([{ text: decision('fix', 0.9) }, { text: 'edit' }]);
    const r = await runCodingAgent({
      provider: model,
      model: 'mock',
      request: 'x',
      toolRegistry: tr,
    });
    expect(r.flow.success).toBe(false);
    expect(String(r.flow.error)).toContain('verify failed');
  });
});

