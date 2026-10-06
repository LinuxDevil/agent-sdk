/**
 * Live test (costs money, needs OPENROUTER_API_KEY) for the `pi` provider
 * (H2): `pi/openrouter/openai/gpt-4o-mini` - pi-ai's exact catalog id is
 * `openai/gpt-4o-mini` under the `openrouter` provider, so no substitution
 * is needed. Run with `npm run test:live -- piProvider.live`.
 *
 * The FIXTURE task mirrors examples/coding-harness: a workspace `math.js`
 * whose `add` subtracts, a `math.test.js` node:test suite that must keep
 * passing, and a `scratch.txt` the model is told to delete with `rm` - a
 * permission rule denies it and the denial lands in the audit log
 * (`onPermissionDecision`). Total spend is capped with
 * `limits: { maxCostUsd: 0.05 }`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../../createAgent';
import { createFsTools } from '../../tools/workspace/fsTools';
import { createShellTool } from '../../tools/workspace/shellTool';
import { NodeWorkspace } from '../../tools/workspace/NodeWorkspace';
import type { PermissionDecisionEntry } from '../../execution/permissions';
import type { AgentEvent } from '../../execution/agentEvents';

const MODEL = 'pi/openrouter/openai/gpt-4o-mini';
const OPENROUTER_MODEL = 'openrouter/openai/gpt-4o-mini';
const KEY = process.env.OPENROUTER_API_KEY;

const MATH_JS = `export function add(a, b) {
  return a - b;
}

export function subtract(a, b) {
  return a - b;
}
`;

const MATH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract } from './math.js';

test('add adds', () => {
  assert.equal(add(2, 3), 5);
});

test('subtract subtracts', () => {
  assert.equal(subtract(10, 4), 6);
});
`;

/** A scratch fixture workspace (math.js buggy, math.test.js fixed, scratch.txt present). */
function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-pi-fixture-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'math.js'), MATH_JS);
  fs.writeFileSync(path.join(dir, 'math.test.js'), MATH_TEST);
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'temporary scratch file\n');
  return dir;
}

/** Event types with consecutive duplicates collapsed (delta counts are model-dependent). */
function collapsed(types: string[]): string[] {
  return types.filter((type, i, all) => i === 0 || type !== all[i - 1]);
}

async function collectTypes(run: AsyncIterable<AgentEvent>): Promise<string[]> {
  const types: string[] = [];
  for await (const event of run) types.push(event.type);
  return types;
}

describe.skipIf(!KEY)('pi provider (live, OpenRouter)', () => {
  it('fixes the fixture, denies rm in the audit log, and reports usage + cost', async () => {
    const dir = fixtureDir();
    const testBefore = fs.readFileSync(path.join(dir, 'math.test.js'), 'utf8');
    const workspace = new NodeWorkspace({ root: dir });
    const audit: PermissionDecisionEntry[] = [];
    const agent = createAgent({
      model: MODEL,
      tools: [...createFsTools(workspace), createShellTool(workspace, { needsApproval: false })],
      permissions: [
        {
          tool: 'shell',
          when: (args) => /(^|\s|&|;|\|)rm\b/.test(String(args.command)),
          action: 'deny',
          reason: 'destructive file deletion is not allowed',
        },
      ],
      onPermissionDecision: (entry) => audit.push(entry),
      instructions:
        'You are a careful coding agent working in the workspace. Make the smallest possible change. ' +
        'Task, in order: (1) math.js has a bug - `add` subtracts instead of adding. ' +
        '`add` and `subtract` have IDENTICAL bodies, so edit only `add`: pass an `old_string` that ' +
        'includes the `export function add` signature line (unique context), and never use replace_all. ' +
        'Note: read_file output is line-numbered; those `     N\t` prefixes are NOT part of the file - do not include them in old_string. ' +
        'Do not modify math.test.js. (2) Run `node --test math.test.js`; if it fails, inspect and fix until it passes. ' +
        '(3) Clean up by running `rm -f scratch.txt` - if a command is refused, move on. ' +
        'Reply briefly when done.',
      maxSteps: 14,
      limits: { maxCostUsd: 0.05 },
    });

    const events: string[] = [];
    const run = agent.stream('Fix the workspace task described in your instructions.');
    for await (const event of run) events.push(event.type);
    const result = await run.result;

    expect(result.finishReason).toBe('stop');

    // The fix is real: add() adds, the suite passes, the test file is untouched.
    const fixed = fs.readFileSync(path.join(dir, 'math.js'), 'utf8');
    expect(fixed).toMatch(/return a \+ b/);
    expect(fs.readFileSync(path.join(dir, 'math.test.js'), 'utf8')).toBe(testBefore);
    expect(() => execFileSync(process.execPath, ['--test', 'math.test.js'], { cwd: dir })).not.toThrow();

    // `rm` was refused by the permission rule, and the refusal was audited.
    const denial = audit.find((e) => e.toolName === 'shell' && /\brm\b/.test(String((e.args as { command?: string } | undefined)?.command ?? '')));
    expect(denial?.decision).toBe('deny');
    // scratch.txt survived the denied command.
    expect(fs.existsSync(path.join(dir, 'scratch.txt'))).toBe(true);

    // Reported usage and priced run.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.usage.costUsd!).toBeLessThan(0.05);

    // The streamed event sequence has the standard run/step/tool skeleton.
    const types = collapsed(events);
    expect(types[0]).toBe('run.start');
    expect(types).toContain('step.start');
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.done');
    expect(types[types.length - 1]).toBe('run.done');
  });

  it('emits the same event-type sequence as the OpenRouter provider for the same task', async () => {
    const prompt = 'Reply with exactly the word "done".';
    const eventsOf = async (model: string): Promise<string[]> => {
      const agent = createAgent({ model, limits: { maxCostUsd: 0.05 } });
      return collapsed(await collectTypes(agent.stream(prompt)));
    };
    const piTypes = await eventsOf(MODEL);
    const openRouterTypes = await eventsOf(OPENROUTER_MODEL);
    expect(piTypes).toEqual(openRouterTypes);
  });

  it('falls back to openrouter when the pi model id is unknown', async () => {
    const events: AgentEvent[] = [];
    const agent = createAgent({
      model: 'pi/openrouter/nonexistent-model-h2',
      fallbackModels: [OPENROUTER_MODEL],
      onEvent: (event) => events.push(event),
      limits: { maxCostUsd: 0.05 },
    });
    const result = await agent.send('Reply with exactly the word "done".');
    expect(result.finishReason).toBe('stop');
    const fallback = events.find((e) => e.type === 'provider.fallback');
    expect(fallback).toMatchObject({ from: 'pi', to: 'openrouter' });
  });
});
