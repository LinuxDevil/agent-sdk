/**
 * Live test for permission modes (N4): the examples/plan-mode flow with a real
 * model (openai/gpt-4o-mini on OpenRouter), `maxSteps: 6`.
 *
 * - Replay (default): the model is served from
 *   `__fixtures__/cassettes/n4-plan-mode.json`, so the test costs nothing.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.10 USD).
 *   Grep the cassette for `sk-or-` and `Authorization` before committing it.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { createFsTools } from '../tools/workspace/fsTools';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import type { PermissionDecisionEntry } from './permissions';

const CASSETTE = path.join(__dirname, '__fixtures__', 'cassettes', 'n4-plan-mode.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(CASSETTE);

describe.skipIf(!runnable)('permission modes live (N4)', () => {
  it('plan mode leaves the workspace unchanged; after the switch to acceptEdits the agent writes the file', async () => {
    const workspace = new MemoryWorkspace({ files: { 'greet.ts': "export const greet = (name: string) => 'Hello ' + name;\n" } });
    const entries: PermissionDecisionEntry[] = [];
    const provider = recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette: CASSETTE, mode: recording ? 'record' : 'replay' });
    const agent = createAgent({
      provider,
      maxSteps: 6,
      instructions: 'You are a coding agent. Use the tools on the workspace files. Keep answers short.',
      tools: createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
      onPermissionDecision: (entry) => entries.push(entry),
    });
    const before = workspace.snapshot();
    const session = agent.session({ permissionMode: 'plan' });

    const plan = await session.send('Read greet.ts and plan how to make it return a template literal `Hello, ${name}!`.');
    expect(plan.finishReason).toBe('stop');
    expect(workspace.snapshot()).toEqual(before);
    expect(entries.filter((e) => e.toolName === 'write_file' || e.toolName === 'edit_file').every((e) => e.decision === 'deny' && e.mode === 'plan')).toBe(true);

    session.setPermissionMode('acceptEdits');
    const applied = await session.send('Apply the plan now: change greet.ts.');
    expect(applied.finishReason).toBe('stop');
    expect(workspace.snapshot()['greet.ts']).not.toBe(before['greet.ts']);
  });
});
