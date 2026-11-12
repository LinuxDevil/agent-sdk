import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpecV2, ToolCallHookContext } from 'lousho';
import { MAX_PINS, pinsProblem, pinnedResultsHook } from '../pins';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import type { ToolPin } from '../../shared/wireTypes';

/** A minimal preToolCall context - only the fields the hook reads matter. */
function ctx(toolName: string, args: Record<string, unknown> = {}): ToolCallHookContext {
  return { toolName, args, toolCallId: 'call_1', toolCall: { id: 'call_1', type: 'function', function: { name: toolName, arguments: '{}' } }, messages: [] };
}

describe('pinsProblem', () => {
  it('accepts an absent pins field and a valid pins array', () => {
    expect(pinsProblem(undefined)).toBeUndefined();
    expect(pinsProblem([])).toBeUndefined();
    expect(
      pinsProblem([{ nodeId: 'tool:http', toolName: 'http', args: { url: 'x' }, result: { ok: true } }])
    ).toBeUndefined();
    // `result` may legitimately be any JSON value, including null/false/0.
    expect(pinsProblem([{ nodeId: 'n', toolName: 't', result: null }])).toBeUndefined();
  });

  it('rejects a non-array pins field', () => {
    expect(pinsProblem('nope')).toMatch(/array/);
    expect(pinsProblem({})).toMatch(/array/);
  });

  it('rejects malformed entries', () => {
    expect(pinsProblem([{}])).toMatch(/pins\[0\]/);
    expect(pinsProblem([{ nodeId: 'n', toolName: 't' }])).toMatch(/result/);
    expect(pinsProblem([{ nodeId: 'n', toolName: 't', result: 1, args: 'x' }])).toMatch(/args/);
    expect(pinsProblem([{ toolName: 't', result: 1 }])).toMatch(/nodeId/);
    expect(pinsProblem([null])).toMatch(/pins\[0\]/);
  });

  it(`rejects more than ${MAX_PINS} pins`, () => {
    const pins = Array.from({ length: MAX_PINS + 1 }, (_, i) => ({
      nodeId: `tool:t${i}`,
      toolName: `t${i}`,
      result: i,
    }));
    expect(pinsProblem(pins)).toMatch(/at most 50/);
    expect(pinsProblem(pins.slice(0, MAX_PINS))).toBeUndefined();
  });
});

describe('pinnedResultsHook', () => {
  const pin = (over: Partial<ToolPin> = {}): ToolPin => ({
    nodeId: 'tool:current-date',
    toolName: 'current_date',
    result: 'PINNED',
    ...over,
  });

  it('returns { result } for a matching tool name', async () => {
    const hook = pinnedResultsHook([pin()]);
    // preToolCall may answer synchronously - await covers both shapes.
    await expect(await hook.preToolCall!(ctx('current_date', { a: 1 }))).toEqual({ result: 'PINNED' });
  });

  it('ignores calls of other tools', async () => {
    const hook = pinnedResultsHook([pin()]);
    await expect(await hook.preToolCall!(ctx('day_name'))).toBeUndefined();
  });

  it('applies an args-scoped pin only to canonical-equal args (key order ignored)', async () => {
    const scoped = pin({ args: { url: 'https://x', method: 'GET' } });
    const hook = pinnedResultsHook([scoped]);
    await expect(await hook.preToolCall!(ctx('current_date', { method: 'GET', url: 'https://x' }))).toEqual({
      result: 'PINNED',
    });
    await expect(await hook.preToolCall!(ctx('current_date', { url: 'https://y', method: 'GET' }))).toBeUndefined();
    await expect(await hook.preToolCall!(ctx('current_date', {}))).toBeUndefined();
  });

  it('first match wins', async () => {
    const hook = pinnedResultsHook([pin({ result: 'FIRST' }), pin({ result: 'SECOND' })]);
    await expect(await hook.preToolCall!(ctx('current_date'))).toEqual({ result: 'FIRST' });
  });
});

describe('RunManager run with pins', () => {
  // The `{ file }` tool ref resolves under the SpecHost baseDir
  // (`<baseDir>/.lousho/agents`), and the tool file imports 'lousho'/'zod' -
  // so baseDir must live inside this repo for Node's resolution to find
  // them. `.tmp-pins-*` dirs are removed in afterEach.
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  let baseDir: string;
  let runManager: RunManager;
  let markerPath: string;

  const SPEC: AgentSpecV2 = {
    version: 2,
    name: 'pin-test',
    model: 'mock/mock-1',
    instructions: 'You are a helpful agent.',
    tools: [{ file: 'tools/spy.ts' }],
  };

  function writeSpyTool(): void {
    const toolsDir = path.join(baseDir, '.lousho', 'agents', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(toolsDir, 'spy.ts'),
      [
        "import { appendFileSync } from 'node:fs';",
        "import { z } from 'zod';",
        "import { defineTool } from 'lousho';",
        `const MARKER = ${JSON.stringify(markerPath)};`,
        'export default defineTool({',
        "  name: 'spy-tool',",
        "  description: 'Writes a marker file when it actually executes.',",
        // The schema must keep `input`: args are validated (and stripped to
        // the schema shape) BEFORE preToolCall hooks see ctx.args, so a bare
        // z.object({}) would reduce every call's args to {}.
        '  input: z.object({ input: z.string().optional() }),',
        '  execute: async () => {',
        '    appendFileSync(MARKER, \'x\');',
        "    return { executed: true };",
        '  },',
        '});',
        '',
      ].join('\n')
    );
  }

  function waitForStatus(agentId: string, predicate: (s: { status: string }) => boolean, timeoutMs = 5000) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        runManager.off('status', onStatus);
        reject(new Error('Timed out waiting for status'));
      }, timeoutMs);
      function onStatus(payload: any) {
        if (payload.agentId !== agentId) return;
        if (predicate(payload)) {
          clearTimeout(timer);
          runManager.off('status', onStatus);
          resolve(payload);
        }
      }
      runManager.on('status', onStatus);
    });
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(repoRoot, '.tmp-pins-'));
    markerPath = path.join(baseDir, 'marker.txt');
    writeSpyTool();
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('a pinned tool call returns the recorded result without executing the tool', async () => {
    const pin: ToolPin = { nodeId: 'tool:spy', toolName: 'spy-tool', result: { pinned: true } };
    await runManager.run('pin-agent', 'please use spy-tool', SPEC, { pins: [pin] });
    const final = await waitForStatus('pin-agent', (s) => s.status === 'done');
    expect(final.resultText).toBe('This is a mock response.');
    // The spy tool's execute never ran - no marker file.
    expect(fs.existsSync(markerPath)).toBe(false);
    // The model still saw a tool result: the pinned value, not the tool's own.
    const toolMessage = final.result?.messages?.find((m: any) => m.role === 'tool');
    expect(JSON.stringify(toolMessage?.content)).toContain('pinned');
  });

  it('without a pin the same call executes the tool (control)', async () => {
    await runManager.run('pin-agent-ctl', 'please use spy-tool', SPEC);
    await waitForStatus('pin-agent-ctl', (s) => s.status === 'done');
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('an args-scoped pin only replays calls with equal args', async () => {
    // The mock provider always calls with { input: 'mock input' }.
    const matching: ToolPin = {
      nodeId: 'tool:spy',
      toolName: 'spy-tool',
      args: { input: 'mock input' },
      result: { pinned: true },
    };
    await runManager.run('pin-args-1', 'please use spy-tool', SPEC, { pins: [matching] });
    await waitForStatus('pin-args-1', (s) => s.status === 'done');
    expect(fs.existsSync(markerPath)).toBe(false);

    fs.rmSync(markerPath, { force: true });
    const other: ToolPin = {
      nodeId: 'tool:spy',
      toolName: 'spy-tool',
      args: { input: 'different' },
      result: { pinned: true },
    };
    await runManager.run('pin-args-2', 'please use spy-tool', SPEC, { pins: [other] });
    await waitForStatus('pin-args-2', (s) => s.status === 'done');
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
