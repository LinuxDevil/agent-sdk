/**
 * Harness 3 (pi-coder) acceptance: a Lousho lead agent delegates a real
 * coding task to a Pi coding-agent sub-agent (`piAgent()`) in process.
 * Offline runs use pi-ai's faux provider; the lead uses `mockModel`.
 *
 * The fixture mirrors the coding-harness scenario: `math.js` implements
 * `add()`/`subtract()` swapped, and `node --test` must pass once Pi edits it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Message as PiMessage,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAgent, type SimpleAgent } from '../createAgent';
import { allow, ask, type PermissionRule } from '../execution/permissions';
import { mockModel, type MockTurn } from '../testing';
import { SqliteStore } from '../storage/sqlite';
import { piAgent, type PiAgentOptions } from './piAgent';
import type { Message } from '../providers';

const BROKEN_MATH = `export function add(a, b) {
  return a - b;
}

export function subtract(a, b) {
  return a + b;
}
`;

const MATH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract } from './math.js';

test('add', () => assert.equal(add(1, 2), 3));
test('subtract', () => assert.equal(subtract(5, 3), 2));
`;

const FIX_EDIT_ARGS = {
  path: 'math.js',
  edits: [
    { oldText: 'export function add(a, b) {\n  return a - b;\n}', newText: 'export function add(a, b) {\n  return a + b;\n}' },
    { oldText: 'export function subtract(a, b) {\n  return a + b;\n}', newText: 'export function subtract(a, b) {\n  return a - b;\n}' },
  ],
};

const TASK = 'Fix math.js in the workspace: add() and subtract() are swapped, then run node --test.';

const toolMessages = (messages: readonly Message[]) => messages.filter((m) => m.role === 'tool');
const toolContent = (message: Message) => JSON.parse(message.content as string) as unknown;
/** The `task` call's string result (the sub-agent answer plus its footer). */
const taskResult = (message: Message) => String(toolContent(message));
/** The message of a `task` tool error result. */
const taskError = (message: Message) => (toolContent(message) as { message: string }).message;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-h3-fixture-'));
  writeFileSync(join(dir, 'math.js'), BROKEN_MATH);
  writeFileSync(join(dir, 'math.test.js'), MATH_TEST);
  return dir;
}

/** Runs `node --test` in `dir`; true when the fixture suite passes. */
function testsPass(dir: string): boolean {
  try {
    execFileSync('node', ['--test'], { cwd: dir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const textOf = (message: PiMessage | undefined): string => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return '';
};

/**
 * The scripted Pi model of the happy path: issue the fixing edit, run
 * `node --test`, report done. An approval turn re-issues the approved edit;
 * a rejection answers without editing. Follow-up turns after the fix reply
 * in text, so the same script serves task resumes.
 */
const fixer: FauxResponseStep = (context) => {
  const messages = context.messages;
  const last = messages.at(-1);
  if (last?.role === 'toolResult') {
    if (last.toolName === 'edit') {
      return last.isError
        ? fauxAssistantMessage('The edit was refused; math.js is unchanged.')
        : fauxAssistantMessage(fauxToolCall('bash', { command: 'node --test' }));
    }
    return fauxAssistantMessage('Fixed add() and subtract(); node --test passes.');
  }
  const userText = textOf(last);
  if (userText.includes('rejected the blocked tool call')) {
    return fauxAssistantMessage('Understood - I will not run that edit; math.js stays unchanged.');
  }
  if (userText.includes('approved the blocked tool call')) {
    return fauxAssistantMessage(fauxToolCall('edit', FIX_EDIT_ARGS));
  }
  const alreadyFixed = messages.some((m) => m.role === 'toolResult' && m.toolName === 'edit' && !m.isError);
  if (alreadyFixed) return fauxAssistantMessage('I swapped the operators in add() and subtract(); node --test passed.');
  return fauxAssistantMessage(fauxToolCall('edit', FIX_EDIT_ARGS));
};

/** A script for a coder that first tries to delete the file. */
const deleter: FauxResponseStep = (context) => {
  const last = context.messages.at(-1);
  if (last?.role === 'toolResult') return fauxAssistantMessage('The delete was refused.');
  return fauxAssistantMessage(fauxToolCall('bash', { command: 'rm -f math.js' }));
};

const repeat = (step: FauxResponseStep, count = 8): FauxResponseStep[] => Array.from({ length: count }, () => step);

type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

interface PiTestSetup {
  dir: string;
  agentDir: string;
  sessionDir: string;
  runtime: ModelRuntime;
  faux: FauxProviderHandle;
  model: PiModel;
  coder: (overrides?: Partial<PiAgentOptions>) => ReturnType<typeof piAgent>;
  cleanup: () => void;
}

async function piSetup(responses: FauxResponseStep[], permissions?: readonly PermissionRule[]): Promise<PiTestSetup> {
  const dir = fixture();
  const agentDir = mkdtempSync(join(tmpdir(), 'lousho-h3-pi-'));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsStorePath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel('faux', 'faux-1')!;
  faux.setResponses(responses);
  const sessionDir = join(agentDir, 'sessions');
  const coder = (overrides: Partial<PiAgentOptions> = {}) =>
    piAgent({
      cwd: dir,
      model,
      modelRuntime: runtime,
      agentDir,
      sessionDir,
      description: 'Edits files and runs tests in the workspace',
      permissions,
      ...overrides,
    });
  return {
    dir,
    agentDir,
    sessionDir,
    runtime,
    faux,
    model,
    coder,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

const delegate = (prompt = TASK, extra: Record<string, unknown> = {}): MockTurn => ({
  text: 'delegating',
  toolCalls: [{ name: 'task', args: { agent: 'coder', prompt, description: 'fix the maths', ...extra } }],
});

function lead(coder: ReturnType<typeof piAgent>, turns: MockTurn[] = [delegate(), 'done']): { model: ReturnType<typeof mockModel>; agent: SimpleAgent } {
  const model = mockModel(turns);
  return { model, agent: createAgent({ provider: model, instructions: 'lead', subagents: { coder } }) };
}

describe('piAgent (Harness 3, pi-coder)', () => {
  it('delegates the fixture task to Pi, which fixes math.js so node --test passes', async () => {
    const setup = await piSetup(repeat(fixer));
    try {
      const { agent } = lead(setup.coder());
      const result = await agent.send('go');

      expect(result.text).toBe('done');
      expect(testsPass(setup.dir)).toBe(true);
      const text = taskResult(toolMessages(result.messages)[0]);
      expect(text).toContain('node --test passes');
      expect(text).toMatch(/\[pi sub-agent 'coder': session 'task_[\w-]+', taskId 'task_1'\]$/);
    } finally {
      setup.cleanup();
    }
  });

  it('rolls the Pi session usage into the lead result', async () => {
    const setup = await piSetup(repeat(fixer));
    try {
      const { agent } = lead(setup.coder(), [delegate(), { text: 'done', usage: { inputTokens: 40, outputTokens: 10 } }]);
      const result = await agent.send('go');

      // The faux provider estimates tokens, so delegated usage is measured, not zero.
      expect(result.usage.delegated).toMatchObject({ runs: 1 });
      expect(result.usage.delegated!.inputTokens).toBeGreaterThan(0);
      // Totals include the delegated sub-agent's spend plus the lead's own calls.
      expect(result.usage.inputTokens).toBeGreaterThan(result.usage.delegated!.inputTokens);
      expect(result.usage.modelCalls).toBeGreaterThanOrEqual(3);
    } finally {
      setup.cleanup();
    }
  });

  it('pauses the lead on a gated Pi edit and approves it exactly once', async () => {
    const setup = await piSetup(repeat(fixer), [ask(['edit', 'write']), allow('*')]);
    try {
      const { agent } = lead(setup.coder());
      const paused = await agent.send('go');

      expect(paused.finishReason).toBe('awaiting-approval');
      const [pending] = await agent.approvals.list();
      expect(pending).toMatchObject({
        id: paused.approvalId,
        toolName: 'edit',
        args: FIX_EDIT_ARGS,
        subagentPath: ['coder'],
      });
      expect(readFileSync(join(setup.dir, 'math.js'), 'utf8')).toBe(BROKEN_MATH);

      const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
      expect(result.text).toBe('done');
      expect(testsPass(setup.dir)).toBe(true);
      expect(taskResult(toolMessages(result.messages)[0])).toContain('node --test passes');
    } finally {
      setup.cleanup();
    }
  });

  it('survives a restart: a fresh agent on the same SqliteStore resolves the durable approval', async () => {
    const setup = await piSetup(repeat(fixer), [ask(['edit', 'write']), allow('*')]);
    const dbDir = mkdtempSync(join(tmpdir(), 'lousho-h3-db-'));
    const file = join(dbDir, 'agent.db');
    let pausedApprovalId: string | undefined;
    try {
      const first = new SqliteStore(file);
      try {
        const paused = await createAgent({
          provider: mockModel([delegate()]),
          instructions: 'lead',
          store: first,
          subagents: { coder: setup.coder() },
        })
          .session({ id: 'chat' })
          .send('go');
        pausedApprovalId = paused.approvalId;
        expect(paused.finishReason).toBe('awaiting-approval');
      } finally {
        first.close();
      }
      expect(readFileSync(join(setup.dir, 'math.js'), 'utf8')).toBe(BROKEN_MATH);

      // A new agent instance on the same store sees the pending approval...
      const second = new SqliteStore(file);
      try {
        const fresh = createAgent({
          provider: mockModel(['done']),
          instructions: 'lead',
          store: second,
          subagents: { coder: setup.coder() },
        });
        // `list()` covers this process's pauses; a pause saved before a
        // restart is read back through the store with `get(id)`.
        const pending = await fresh.approvals.get(pausedApprovalId!);
        expect(pending).toMatchObject({ id: pausedApprovalId, toolName: 'edit', subagentPath: ['coder'], args: FIX_EDIT_ARGS });

        // ...and resolving it reopens the Pi session and re-issues the edit once.
        const result = await fresh.approvals.resolve({ id: pausedApprovalId!, approved: true });
        expect(result.text).toBe('done');
      } finally {
        second.close();
      }
      expect(testsPass(setup.dir)).toBe(true);
    } finally {
      setup.cleanup();
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('sends the rejection note to Pi and leaves math.js untouched', async () => {
    const setup = await piSetup(repeat(fixer), [ask('edit'), allow('*')]);
    try {
      const { agent } = lead(setup.coder());
      const paused = await agent.send('go');
      expect(paused.finishReason).toBe('awaiting-approval');

      const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'do not touch math.js' });

      expect(result.text).toBe('done');
      expect(readFileSync(join(setup.dir, 'math.js'), 'utf8')).toBe(BROKEN_MATH);
      // Pi answered the rejection turn without re-running the edit.
      expect(taskResult(toolMessages(result.messages)[0])).toContain('math.js stays unchanged');
    } finally {
      setup.cleanup();
    }
  });

  it('denies a Pi rm attempt through the adapter permission rules', async () => {
    const setup = await piSetup(repeat(deleter, 4), [
      { tool: 'bash', when: (args) => /\brm\b/.test(String(args.command)), action: 'deny', reason: 'no deletes' },
      allow('*'),
    ]);
    try {
      const { agent } = lead(setup.coder());
      const result = await agent.send('go');

      expect(result.text).toBe('done');
      expect(taskResult(toolMessages(result.messages)[0])).toContain('refused');
      expect(existsSync(join(setup.dir, 'math.js'))).toBe(true);
      expect(readFileSync(join(setup.dir, 'math.js'), 'utf8')).toBe(BROKEN_MATH);
    } finally {
      setup.cleanup();
    }
  });

  it('resuming a taskId continues the same Pi session', async () => {
    const setup = await piSetup(repeat(fixer));
    try {
      const followUp: MockTurn = { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'What did you change?', description: 'follow-up', taskId: 'task_1' } }] };
      const { agent } = lead(setup.coder(), [delegate(), followUp, 'done']);

      const result = await agent.send('go');

      const [first, second] = toolMessages(result.messages).map(taskResult);
      const firstSession = /session '(task_[\w-]+)'/.exec(first)?.[1];
      expect(firstSession).toBeDefined();
      expect(/session '(task_[\w-]+)'/.exec(second)?.[1]).toBe(firstSession);
      expect(second).toContain('swapped the operators');
    } finally {
      setup.cleanup();
    }
  });

  it("documents 'fork' as unsupported: the task call fails with a copy error", async () => {
    const setup = await piSetup(repeat(fixer));
    try {
      const fork: MockTurn = { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'same task', description: 'fork it', taskId: 'task_1', mode: 'fork' } }] };
      const { agent } = lead(setup.coder(), [delegate(), fork, 'done']);

      const result = await agent.send('go');

      expect(result.text).toBe('done');
      expect(taskError(toolMessages(result.messages).at(-1)!)).toContain('cannot be copied');
    } finally {
      setup.cleanup();
    }
  });

  it('a gated call of a non-pausable run is refused, not paused', async () => {
    const setup = await piSetup(repeat(fixer), [ask('edit'), allow('*')]);
    try {
      const out = await setup.coder().run(TASK, { name: 'coder', pausable: false });
      expect(out).toContain('unchanged');
      expect(readFileSync(join(setup.dir, 'math.js'), 'utf8')).toBe(BROKEN_MATH);
    } finally {
      setup.cleanup();
    }
  });
});

const OPENROUTER = process.env.OPENROUTER_API_KEY;

describe.skipIf(!OPENROUTER)('piAgent live (OpenRouter)', () => {
  it('completes the fixture task end to end under $0.05', async () => {
    const dir = fixture();
    const agentDir = mkdtempSync(join(tmpdir(), 'lousho-h3-live-'));
    try {
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsStorePath: join(agentDir, 'models.json') });
      const coder = piAgent({
        cwd: dir,
        model: runtime.getModel('openrouter', 'openai/gpt-4o-mini'),
        modelRuntime: runtime,
        agentDir,
        description: 'Edits files and runs tests in the workspace',
        permissions: [allow('*')],
      });
      const agent = createAgent({
        model: 'openrouter/openai/gpt-4o-mini',
        instructions: 'Delegate the coding task to the coder sub-agent.',
        limits: { maxCostUsd: 0.05 },
        subagents: { coder },
      });
      const result = await agent.send(`Delegate: ${TASK}`);
      expect(testsPass(dir)).toBe(true);
      expect(result.usage.costUsd ?? 0).toBeLessThanOrEqual(0.05);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 120_000);
});
